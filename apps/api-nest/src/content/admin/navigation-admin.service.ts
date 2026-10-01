import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type AuditActor, type AuditContext, recordAudit } from '../../common/audit';
import { type AwareMoment, dateTimeField } from '../../common/datetime-field';
import { localIso } from '../../common/datetime';
import {
  booleanField,
  charField,
  choiceField,
  EMPTY,
  errorMessages,
  type Field,
  type Fields,
  imageField,
  integerField,
  Invalid,
  pkRelatedField,
  runSerializer,
  SKIP,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import {
  applyFilters,
  booleanFilter,
  choiceFilter,
  modelFilter,
  orderingFrom,
} from '../../common/filtering';
import { mediaUrl } from '../../common/media';
import { pyStr } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { MediaStorage } from '../../common/storage';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, type Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { HtmlInput, type UploadedFile } from '../../http/multipart';
import { dataGet } from '../../http/request-body';
import { NAVIGATION_TAGS, Revalidation } from '../../jobs/revalidation';
import { checkImageUpload } from '../../catalog/admin/product-images.service';
import { validateLinkUrl } from '../validators';
import { moveRun } from './site-admin.service';
import {
  type Bound,
  boundIso,
  boundParam,
  checkWindow,
  cleanError,
  storedImage,
} from './scheduled';

/**
 * `NavigationItemViewSet`: the merchandiser's overrides of the navbar and
 * the footer's columns and links (ADR-0009, ADR-0012). A `ModelViewSet`,
 * unpaginated, ordered by placement, position and label, plus `move`.
 *
 * Validation is `NavigationItemSerializer`'s: the fields, `validate_parent`
 * (two levels at most), then `ScheduledContentSerializer.validate` -- the
 * publish window, and `NavigationItem.clean()` run on a copy of the item, so
 * the link it checks is saved as it was sent. Every save and delete asks the
 * storefront to drop its navigation, categories and footer at once (the
 * model's signals, which do not wait for a commit); a move, which saves
 * through `bulk_update` and so sends no signal, asks for navigation and
 * footer itself.
 */

const PLACEMENTS = ['HEADER', 'FOOTER'] as const;
const TYPES = ['CATEGORY', 'LINK', 'PROMO', 'PAGE', 'GROUP', 'CATEGORY_LIST'] as const;
const LAYOUTS = ['AUTO', 'DROPDOWN', 'MEGA'] as const;
const TYPE_LABELS: Record<string, string> = {
  CATEGORY: 'Category',
  LINK: 'Link',
  PROMO: 'Promo card',
  PAGE: 'Site page',
  GROUP: 'Footer column',
  CATEGORY_LIST: 'Top categories (automatic)',
};
const FOOTER_ONLY_TYPES = ['GROUP', 'CATEGORY_LIST'];
const MAX_FOOTER_COLUMNS = 4;

export interface NavRow {
  id: string;
  created_at: string;
  updated_at: string;
  placement: string;
  type: string;
  parent_id: string | null;
  category_id: string | null;
  page_id: string | null;
  label: string;
  url: string;
  badge: string;
  image: string | null;
  description: string;
  layout: string;
  position: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  /** `parent.parent_id`, `parent.placement`, `parent.type`, through the join. */
  parent_parent_id: string | null;
  parent_placement: string | null;
  parent_type: string | null;
  category_name: string | null;
  page_slug: string | null;
  page_title: string | null;
}

const NAV_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'placement',
  'type',
  'parent_id',
  'category_id',
  'page_id',
  'label',
  'url',
  'badge',
  'image',
  'description',
  'layout',
  'position',
  'is_active',
  'starts_at',
  'ends_at',
];
const CATEGORY_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'parent_id',
  'name',
  'slug',
  'description',
  'image',
  'position',
  'is_active',
  'show_in_navigation',
  'tax_rate',
  'seo_title',
  'seo_description',
];
const PAGE_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'slug',
  'title',
  'meta_description',
  'body',
  'is_published',
  'is_system',
  'updated_by_id',
];
const N = '"content_navigationitem"';

/**
 * The queryset's statement as Django sends it -- the item, its parent (T2),
 * its category and its page through `select_related` -- so rows an ordering
 * leaves tied come back in the same order. Read positionally: names repeat.
 */
const SELECT = `SELECT ${NAV_COLUMNS.map((c) => `${N}."${c}"`).join(', ')},
    ${NAV_COLUMNS.map((c) => `T2."${c}"`).join(', ')},
    ${CATEGORY_COLUMNS.map((c) => `"catalog_category"."${c}"`).join(', ')},
    ${PAGE_COLUMNS.map((c) => `"content_sitepage"."${c}"`).join(', ')}
  FROM ${N}
  LEFT OUTER JOIN ${N} T2 ON (${N}."parent_id" = T2."id")
  LEFT OUTER JOIN "catalog_category" ON (${N}."category_id" = "catalog_category"."id")
  LEFT OUTER JOIN "content_sitepage" ON (${N}."page_id" = "content_sitepage"."id")`;

const FILTERS = [
  choiceFilter('placement', `${N}."placement"`, PLACEMENTS),
  choiceFilter('type', `${N}."type"`, TYPES),
  booleanFilter('is_active', `${N}."is_active"`),
  modelFilter('parent', `${N}."parent_id"`, 'content_navigationitem'),
];
const ORDERING = {
  position: `${N}."position"`,
  label: `${N}."label"`,
  created_at: `${N}."created_at"`,
};
const DEFAULT_ORDER = [`${N}."placement" ASC`, `${N}."position" ASC`, `${N}."label" ASC`];

function rowFrom(values: unknown[]): NavRow {
  const nav = Object.fromEntries(NAV_COLUMNS.map((c, i) => [c, values[i]])) as Record<
    string,
    unknown
  >;
  const parent = NAV_COLUMNS.length;
  const category = parent + NAV_COLUMNS.length;
  const page = category + CATEGORY_COLUMNS.length;
  return {
    ...(nav as unknown as NavRow),
    parent_parent_id: values[parent + 5] as string | null,
    parent_placement: values[parent + 3] as string | null,
    parent_type: values[parent + 4] as string | null,
    category_name: values[category + 4] as string | null,
    page_slug: values[page + 3] as string | null,
    page_title: values[page + 4] as string | null,
  };
}

/** `NavigationItem.display_label`. */
function displayLabel(row: {
  label: string;
  type: string;
  category_id: string | null;
  category_name: string | null;
  page_id: string | null;
  page_title: string | null;
}): string {
  if (row.label) return row.label;
  if (row.category_id) return row.category_name ?? '';
  if (row.page_id) return row.page_title ?? '';
  if (row.type === 'CATEGORY_LIST') return TYPE_LABELS.CATEGORY_LIST as string;
  return '';
}

/** What a write changes, as the serializer validated it. */
type NavData = Partial<{
  placement: string;
  type: string;
  parent: NavRow | null;
  category: { id: string; name: string } | null;
  page: { id: string; slug: string; title: string } | null;
  label: string;
  url: string;
  badge: string;
  image: UploadedFile | null;
  description: string;
  layout: string;
  position: number;
  is_active: boolean;
  starts_at: AwareMoment | null;
  ends_at: AwareMoment | null;
}>;

const TRACKED = ['label', 'url', 'badge', 'position', 'is_active', 'layout'] as const;

@Injectable()
export class NavigationAdminService {
  private readonly storage: MediaStorage;

  constructor(
    private readonly db: Database,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.storage = new MediaStorage(env.MEDIA_ROOT, env.DJANGO_TIME_ZONE);
  }

  /**
   * `NavigationItemSerializer(item).data`. After a partial update DRF does
   * not fall back to a field's default, so an item with no category (or
   * page) has no `category_name` (or `page_title`) at all.
   */
  serialise(
    row: NavRow,
    options: { partial?: boolean; startsAt?: Bound; endsAt?: Bound } = {},
  ): Record<string, unknown> {
    const tz = this.env.DJANGO_TIME_ZONE;
    const out: Record<string, unknown> = {
      id: row.id,
      placement: row.placement,
      type: row.type,
      parent: row.parent_id,
      category: row.category_id,
      category_name: row.category_id ? row.category_name : '',
      page: row.page_id ? row.page_slug : null,
      page_title: row.page_id ? row.page_title : '',
      label: row.label,
      display_label: displayLabel(row),
      url: row.url,
      badge: row.badge,
      image: mediaUrl(row.image, this.env.MEDIA_URL),
      description: row.description,
      layout: row.layout,
      position: row.position,
      is_active: row.is_active,
      starts_at: boundIso(options.startsAt !== undefined ? options.startsAt : row.starts_at, tz),
      ends_at: boundIso(options.endsAt !== undefined ? options.endsAt : row.ends_at, tz),
      created_at: localIso(row.created_at, tz),
      updated_at: localIso(row.updated_at, tz),
    };
    if (options.partial) {
      if (!row.category_id) delete out.category_name;
      if (!row.page_id) delete out.page_title;
    }
    return out;
  }

  private async queryset(query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const order = orderingFrom(query, ORDERING) ?? DEFAULT_ORDER;
    return { where, order: order.join(', ') };
  }

  async list(query: QueryDict) {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const rows = await this.db.arrays(
      `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
      sql.values,
    );
    return rows.map((values) => this.serialise(rowFrom(values)));
  }

  /** `get_object()`: the filtered queryset, then the primary key. */
  async find(pk: string, query: QueryDict): Promise<NavRow> {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${N}."id" = ${sql.add(id, 'uuid')}`);
    const rows = await this.db.arrays(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 21`,
      sql.values,
    );
    if (!rows[0]) throw new NotFound();
    return rowFrom(rows[0]);
  }

  async retrieve(pk: string, query: QueryDict) {
    return this.serialise(await this.find(pk, query));
  }

  private async readById(id: string): Promise<NavRow> {
    const rows = await this.db.arrays(`${SELECT} WHERE ${N}."id" = $1::uuid LIMIT 21`, [id]);
    return rowFrom(rows[0] as unknown[]);
  }

  /** `NavigationItemSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validate(
    data: unknown,
    instance: NavRow | null,
    partial: boolean,
  ): Promise<NavData> {
    const tz = this.env.DJANGO_TIME_ZONE;
    const text = (maxLength: number) => charField({ maxLength, allowBlank: true, required: false });
    const fields: Fields = {
      placement: choiceField(PLACEMENTS, { required: false }),
      type: choiceField(TYPES, { required: false }),
      parent: pkRelatedField(
        async (id) =>
          (await this.db.one(`SELECT 1 AS "a" FROM ${N} WHERE ${N}."id" = $1::uuid LIMIT 21`, [
            id,
          ])) !== null,
        { required: false, allowNull: true },
      ),
      category: pkRelatedField(
        async (id) =>
          (await this.db.one(
            `SELECT 1 AS "a" FROM "catalog_category" WHERE "catalog_category"."id" = $1::uuid LIMIT 21`,
            [id],
          )) !== null,
        { required: false, allowNull: true },
      ),
      page: this.pageField(),
      label: text(120),
      url: text(300),
      badge: text(24),
      image: imageField({ required: false, allowNull: true }),
      description: text(200),
      layout: choiceField(LAYOUTS, { required: false }),
      position: integerField({ required: false, minValue: 0, maxValue: 2147483647 }),
      is_active: booleanField({ required: false }),
      starts_at: dateTimeField(tz, { required: false, allowNull: true }),
      ends_at: dateTimeField(tz, { required: false, allowNull: true }),
    };
    const result = await runSerializer<NavData>(fields, data, {
      partial,
      hooks: {
        parent: async (id: string | null) => {
          if (id === null) return null;
          const parent = await this.readById(id);
          if (instance !== null && parent.id === instance.id)
            throw Invalid.of('An item cannot be its own parent.');
          if (parent.parent_id !== null)
            throw Invalid.of(
              'Navigation overrides are two levels deep; nest under a top-level item.',
            );
          return parent;
        },
        category: async (id: string | null) => {
          if (id === null) return null;
          const category = await this.db.one<{ id: string; name: string }>(
            `SELECT "id", "name" FROM "catalog_category" WHERE "id" = $1::uuid`,
            [id],
          );
          return category;
        },
        // `validate_image`: `validate_image_upload`.
        image: (value: UploadedFile | null) => checkImageUpload(value),
      },
      validate: async (attrs) => {
        checkWindow(
          attrs.starts_at !== undefined ? attrs.starts_at : (instance?.starts_at ?? null),
          attrs.ends_at !== undefined ? attrs.ends_at : (instance?.ends_at ?? null),
        );
        await this.clean(instance, attrs);
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `SlugRelatedField(slug_field="slug", queryset=SitePage.objects.all())`. */
  private pageField(): Field<{ id: string; slug: string; title: string } | null> {
    return {
      html: { required: false, allowNull: true, allowBlank: false },
      run: async (input: unknown) => {
        // `RelatedField.run_validation`: "" is forced to None first.
        const data = input === '' ? null : input;
        if (data === EMPTY || data === undefined) return SKIP;
        if (data === null) return null;
        const slug = pyStr(data);
        const page = await this.db.one<{ id: string; slug: string; title: string }>(
          `SELECT "id", "slug", "title" FROM "content_sitepage" WHERE "content_sitepage"."slug" = $1 LIMIT 21`,
          [slug],
        );
        if (!page) throw Invalid.of(`Object with slug=${slug} does not exist.`, 'does_not_exist');
        return page;
      },
    };
  }

  /**
   * `NavigationItem.clean()` on a copy of the item with the request's values
   * set: the type's rules, the link, then the placement's.
   */
  private async clean(instance: NavRow | null, attrs: NavData): Promise<void> {
    const pick = <K extends keyof NavData>(key: K, fallback: NavData[K]): NavData[K] =>
      attrs[key] !== undefined ? attrs[key] : fallback;
    const type = pick('type', instance?.type ?? 'CATEGORY') as string;
    const placement = pick('placement', instance?.placement ?? 'HEADER') as string;
    const categoryId =
      attrs.category !== undefined ? (attrs.category?.id ?? null) : (instance?.category_id ?? null);
    const pageId =
      attrs.page !== undefined ? (attrs.page?.id ?? null) : (instance?.page_id ?? null);
    const parent: { id: string; parent_id: string | null; placement: string; type: string } | null =
      attrs.parent !== undefined
        ? attrs.parent
          ? {
              id: attrs.parent.id,
              parent_id: attrs.parent.parent_id,
              placement: attrs.parent.placement,
              type: attrs.parent.type,
            }
          : null
        : instance?.parent_id
          ? {
              id: instance.parent_id,
              parent_id: instance.parent_parent_id,
              placement: instance.parent_placement as string,
              type: instance.parent_type as string,
            }
          : null;
    const label = pick('label', instance?.label ?? '') as string;
    const url = pick('url', instance?.url ?? '') as string;
    // A new item's primary key is made when the model is built.
    const pk = instance?.id ?? randomUUID();

    if (type === 'CATEGORY' && categoryId === null)
      throw cleanError('category', 'A CATEGORY item needs a category.');
    if (type !== 'CATEGORY' && categoryId !== null)
      throw cleanError('category', 'Only a CATEGORY item may reference a category.');
    if (type === 'PAGE' && pageId === null) throw cleanError('page', 'A PAGE item needs a page.');
    if (type !== 'PAGE' && pageId !== null)
      throw cleanError('page', 'Only a PAGE item may reference a page.');
    if (type === 'LINK' && !url) throw cleanError('url', 'A LINK item needs a URL.');
    if (type === 'LINK' && !label) throw cleanError('label', 'A LINK item needs a label.');
    if (parent && parent.id === pk) throw cleanError('parent', 'An item cannot be its own parent.');
    if (url) {
      try {
        validateLinkUrl(url);
      } catch (error) {
        if (error instanceof ValidationError) throw cleanError('url', error.message);
        throw error;
      }
    }

    // `_clean_placement`: the footer is columns of links; the header has neither.
    if (placement !== 'FOOTER') {
      if (FOOTER_ONLY_TYPES.includes(type))
        throw cleanError(
          'type',
          `A ${(TYPE_LABELS[type] as string).toLowerCase()} belongs in the footer.`,
        );
      return;
    }
    if (type === 'GROUP') {
      if (parent) throw cleanError('parent', 'A footer column cannot be nested.');
      if (!label) throw cleanError('label', 'A footer column needs a heading.');
      if (url) throw cleanError('url', 'A footer column heading is not a link.');
      const columns = await this.db.one<{ __count: string }>(
        `SELECT COUNT(*) AS "__count" FROM ${N}
          WHERE (${N}."placement" = 'FOOTER' AND ${N}."type" = 'GROUP' AND NOT (${N}."id" = $1::uuid))`,
        [pk],
      );
      if (Number(columns?.__count ?? 0) >= MAX_FOOTER_COLUMNS)
        throw cleanError(
          'type',
          `The footer has room for ${MAX_FOOTER_COLUMNS} columns. Remove one before adding another.`,
        );
      return;
    }
    if (!parent) throw cleanError('parent', 'Choose the footer column this link goes in.');
    if (parent.placement !== 'FOOTER' || parent.type !== 'GROUP')
      throw cleanError('parent', 'A footer link must sit in a footer column.');
  }

  /** `perform_create`: save, then the audit entry. */
  async create(data: unknown, actor: AuditActor, context: AuditContext) {
    const values = await this.validate(data, null, false);
    const id = randomUUID();
    const image = await storedImage(this.storage, 'navigation/', values.image, '');
    await this.db.query(
      `INSERT INTO ${N} ("id", "created_at", "updated_at", "placement", "type", "parent_id",
         "category_id", "page_id", "label", "url", "badge", "image", "description", "layout",
         "position", "is_active", "starts_at", "ends_at")
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4::uuid, $5::uuid, $6::uuid,
         $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16::timestamptz)`,
      [
        id,
        values.placement ?? 'HEADER',
        values.type ?? 'CATEGORY',
        values.parent?.id ?? null,
        values.category?.id ?? null,
        values.page?.id ?? null,
        values.label ?? '',
        values.url ?? '',
        values.badge ?? '',
        image,
        values.description ?? '',
        values.layout ?? 'AUTO',
        values.position ?? 0,
        values.is_active ?? true,
        boundParam(values.starts_at ?? null),
        boundParam(values.ends_at ?? null),
      ],
    );
    // `post_save`: the storefront's caches, at once.
    await this.revalidation.request(...NAVIGATION_TAGS);
    const row = await this.readById(id);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      entity: { type: 'NavigationItem', id, label: displayLabel(row) || `${row.type} item` },
      actor,
      newValues: { label: displayLabel(row), placement: row.placement },
    });
    return this.serialise(row, {
      startsAt: values.starts_at ?? null,
      endsAt: values.ends_at ?? null,
    });
  }

  /** `perform_update`: every column saved, the tracked fields' changes audited. */
  async update(
    pk: string,
    query: QueryDict,
    data: unknown,
    partial: boolean,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const instance = await this.find(pk, query);
    const values = await this.validate(data, instance, partial);
    const next = {
      placement: values.placement ?? instance.placement,
      type: values.type ?? instance.type,
      parent_id: values.parent !== undefined ? (values.parent?.id ?? null) : instance.parent_id,
      category_id:
        values.category !== undefined ? (values.category?.id ?? null) : instance.category_id,
      page_id: values.page !== undefined ? (values.page?.id ?? null) : instance.page_id,
      label: values.label ?? instance.label,
      url: values.url ?? instance.url,
      badge: values.badge ?? instance.badge,
      image: await storedImage(this.storage, 'navigation/', values.image, instance.image ?? ''),
      description: values.description ?? instance.description,
      layout: values.layout ?? instance.layout,
      position: values.position ?? instance.position,
      is_active: values.is_active ?? instance.is_active,
      starts_at: values.starts_at !== undefined ? values.starts_at : instance.starts_at,
      ends_at: values.ends_at !== undefined ? values.ends_at : instance.ends_at,
    };
    await this.db.query(
      `UPDATE ${N} SET "created_at" = $2, "updated_at" = clock_timestamp(), "placement" = $3,
         "type" = $4, "parent_id" = $5::uuid, "category_id" = $6::uuid, "page_id" = $7::uuid,
         "label" = $8, "url" = $9, "badge" = $10, "image" = $11, "description" = $12,
         "layout" = $13, "position" = $14, "is_active" = $15, "starts_at" = $16::timestamptz,
         "ends_at" = $17::timestamptz
       WHERE ${N}."id" = $1::uuid`,
      [
        instance.id,
        instance.created_at,
        next.placement,
        next.type,
        next.parent_id,
        next.category_id,
        next.page_id,
        next.label,
        next.url,
        next.badge,
        next.image,
        next.description,
        next.layout,
        next.position,
        next.is_active,
        boundParam(next.starts_at),
        boundParam(next.ends_at),
      ],
    );
    await this.revalidation.request(...NAVIGATION_TAGS);
    const row = await this.readById(instance.id);
    const old: Record<string, unknown> = {};
    const changed: Record<string, unknown> = {};
    for (const field of TRACKED) {
      if (instance[field] !== row[field]) {
        old[field] = instance[field];
        changed[field] = row[field];
      }
    }
    if (Object.keys(changed).length) {
      await recordAudit(this.db, context, {
        action: 'SETTINGS_CHANGED',
        entity: {
          type: 'NavigationItem',
          id: row.id,
          label: displayLabel(row) || `${row.type} item`,
        },
        actor,
        oldValues: old,
        newValues: changed,
      });
    }
    return this.serialise(row, {
      partial,
      startsAt: next.starts_at,
      endsAt: next.ends_at,
    });
  }

  /** `perform_destroy`: audited, then deleted with every item nested under it. */
  async destroy(pk: string, query: QueryDict, actor: AuditActor, context: AuditContext) {
    const instance = await this.find(pk, query);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      entity: {
        type: 'NavigationItem',
        id: instance.id,
        label: displayLabel(instance) || `${instance.type} item`,
      },
      actor,
      oldValues: { label: displayLabel(instance) },
      reason: 'Navigation item removed.',
    });
    const deleted = await this.db.transaction((tx) => deleteItems(tx, [instance.id]));
    for (let i = 0; i < deleted; i++) await this.revalidation.request(...NAVIGATION_TAGS);
  }

  /** `move`: one place among its siblings, then the navigation and footer revalidated. */
  async move(pk: string, query: QueryDict, data: unknown) {
    const item = await this.find(pk, query);
    const direction = pyStr(requestGet(data, 'direction') ?? '').toLowerCase();
    await moveRun(
      this.db,
      'content_navigationitem',
      '"position" ASC, "label" ASC',
      item.id,
      direction,
      `WHERE ("parent_id" ${item.parent_id ? '= $2::uuid' : 'IS NULL'} AND "placement" = $1)`,
      item.parent_id ? [item.placement, item.parent_id] : [item.placement],
    );
    await this.revalidation.request('navigation', 'site');
    return this.serialise(await this.find(pk, query));
  }
}

/**
 * `request.data.get(key)`: a form's last value (a file reads as its name), a
 * JSON object's value, and a 500 for a JSON body that is not an object.
 */
export function requestGet(data: unknown, key: string): unknown {
  if (data instanceof HtmlInput) {
    const value = data.get(key);
    return value === undefined || typeof value === 'string' ? value : value.name;
  }
  return dataGet(data, key);
}

/**
 * `item.delete()`: Django's collector takes the items nested under it
 * (`parent`, `on_delete=CASCADE`) level by level and deletes them all in
 * one statement. Answers how many went -- each sent `post_delete`.
 */
export async function deleteItems(tx: Queryable, ids: string[]): Promise<number> {
  const all = [...ids];
  let level = ids;
  while (level.length) {
    const children = await tx.query<{ id: string }>(
      `SELECT ${N}."id" FROM ${N} WHERE ${N}."parent_id" = ANY($1::uuid[])
        ORDER BY ${N}."position" ASC, ${N}."label" ASC`,
      [level],
    );
    level = children.map((row) => row.id).filter((id) => !all.includes(id));
    all.push(...level);
  }
  await tx.query(`DELETE FROM ${N} WHERE ${N}."id" = ANY($1::uuid[])`, [all]);
  return all.length;
}
