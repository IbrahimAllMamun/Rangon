import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { Dec } from '../../common/decimal';
import {
  booleanField,
  charField,
  decimalField,
  errorMessages,
  Fields,
  imageField,
  integerField,
  Invalid,
  pkRelatedField,
  runSerializer,
  slugField,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { applyFilters, booleanFilter, modelFilter, orderingFrom } from '../../common/filtering';
import { mediaUrl } from '../../common/media';
import { compareCodePoints } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { uniqueSlug } from '../../common/slugs';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { NAVIGATION_TAGS, Revalidation } from '../../jobs/revalidation';
import { refuseIfReferenced } from './deletion';

/**
 * `catalog.api.views.CategoryViewSet`: the category tree's admin.
 *
 * Unpaginated. `?tree=true` narrows the list to the roots and nests each
 * one's *active* children under it, recursively; without it every category
 * is listed flat with `children: []`. Each row counts its published products
 * -- except rows that were never annotated (a new category, and every nested
 * child), where DRF leaves `product_count` out altogether.
 *
 * Saving or deleting a category asks the storefront to drop its navigation
 * (`content.signals`), and so does every navigation item a delete takes with it.
 */

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  description: string;
  image: string | null;
  position: number;
  is_active: boolean;
  show_in_navigation: boolean;
  tax_rate: string | null;
  seo_title: string;
  seo_description: string;
  /** `parent.name`, read through the join Django's `select_related("parent")` makes. */
  parent_name: string | null;
  /** The list's annotation; absent on a row read without it. */
  product_count?: number;
}

const COLUMNS = [
  'id',
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
] as const;
const SELECT = COLUMNS.map((column) => `"catalog_category"."${column}"`).join(', ');

const FILTERS = [
  booleanFilter('is_active', '"catalog_category"."is_active"'),
  modelFilter('parent', '"catalog_category"."parent_id"', 'catalog_category'),
];
const ORDERING = {
  position: '"catalog_category"."position"',
  name: '"catalog_category"."name"',
  created_at: '"catalog_category"."created_at"',
};
const DEFAULT_ORDER = ['"catalog_category"."position" ASC', '"catalog_category"."name" ASC'];

type CategoryData = Partial<{
  parent: string | null;
  name: string;
  slug: string;
  description: string;
  image: null;
  position: number;
  is_active: boolean;
  show_in_navigation: boolean;
  tax_rate: string | null;
  seo_title: string;
  seo_description: string;
}>;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly db: Database,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `CategorySerializer(category, context={"tree": tree}).data`. After a
   * partial update DRF will not fall back to a field's default, so a
   * category without a parent has no `parent_name` at all.
   */
  async serialise(
    row: CategoryRow,
    tree: boolean,
    partial = false,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      id: row.id,
      parent: row.parent_id,
      parent_name: row.parent_name ?? '',
      name: row.name,
      slug: row.slug,
      description: row.description,
      image: mediaUrl(row.image, this.env.MEDIA_URL),
      position: row.position,
      is_active: row.is_active,
      show_in_navigation: row.show_in_navigation,
      tax_rate: row.tax_rate,
      seo_title: row.seo_title,
      seo_description: row.seo_description,
    };
    if (row.parent_name === null && partial) delete out.parent_name;
    if (row.product_count !== undefined) out.product_count = row.product_count;
    out.children = tree ? await this.children(row) : [];
    return out;
  }

  /** `get_children`: the active children, each with theirs, none of them annotated. */
  private async children(parent: CategoryRow): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<CategoryRow>(
      `SELECT ${SELECT} FROM "catalog_category"
        WHERE ("catalog_category"."parent_id" = $1 AND "catalog_category"."is_active")
        ORDER BY "catalog_category"."position" ASC, "catalog_category"."name" ASC`,
      [parent.id],
    );
    const out: Record<string, unknown>[] = [];
    for (const row of rows)
      out.push(await this.serialise({ ...row, parent_name: parent.name }, true));
    return out;
  }

  /** The annotated, filtered queryset's SQL, before the primary key or the order. */
  private async queryset(
    query: QueryDict,
    sql: SqlParams,
  ): Promise<{ where: string[]; order: string }> {
    const where: string[] = [];
    if (query.get('tree') === 'true') where.push(`"catalog_category"."parent_id" IS NULL`);
    await applyFilters(this.db, query, FILTERS, sql, where);
    const order = orderingFrom(query, ORDERING) ?? DEFAULT_ORDER;
    return { where, order: order.join(', ') };
  }

  private annotated(where: string[], order: string, limit = ''): string {
    return `SELECT ${SELECT}, T3."name" AS "parent_name",
        COUNT("catalog_product"."id") FILTER (WHERE "catalog_product"."published")::int AS "product_count"
      FROM "catalog_category"
      LEFT OUTER JOIN "catalog_product" ON ("catalog_category"."id" = "catalog_product"."category_id")
      LEFT OUTER JOIN "catalog_category" T3 ON ("catalog_category"."parent_id" = T3."id")
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY "catalog_category"."id", T3."id"
      ORDER BY ${order}${limit}`;
  }

  async list(query: QueryDict): Promise<Record<string, unknown>[]> {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const rows = await this.db.query<CategoryRow>(this.annotated(where, order), sql.values);
    const tree = query.get('tree') === 'true';
    const out: Record<string, unknown>[] = [];
    for (const row of rows) out.push(await this.serialise(row, tree));
    return out;
  }

  /** `get_object()`: the filtered queryset (roots only under `?tree=true`), then the key. */
  async find(pk: string, query: QueryDict): Promise<CategoryRow> {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`"catalog_category"."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<CategoryRow>(
      this.annotated(where, order, ' LIMIT 21'),
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  /** `CategorySerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  async validate(
    data: unknown,
    instance: CategoryRow | null,
    partial: boolean,
  ): Promise<CategoryData> {
    const categoryExists = async (id: string) =>
      (await this.db.one(`SELECT 1 FROM "catalog_category" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
    const exclude = instance?.id ?? null;
    const fields: Fields = {
      parent: pkRelatedField(categoryExists, { required: false, allowNull: true }),
      name: charField({ maxLength: 120 }),
      slug: slugField({
        maxLength: 140,
        required: false,
        unique: {
          message: 'category with this slug already exists.',
          exists: async (value) =>
            (await this.db.one(
              `SELECT 1 AS "a" FROM "catalog_category" WHERE ("catalog_category"."slug" = $1${
                exclude ? ` AND NOT ("catalog_category"."id" = $2)` : ''
              }) LIMIT 1`,
              exclude ? [value, exclude] : [value],
            )) !== null,
        },
      }),
      description: charField({ allowBlank: true, required: false }),
      image: imageField({ required: false, allowNull: true }),
      position: integerField({ maxValue: 2147483647, minValue: 0, required: false }),
      is_active: booleanField({ required: false }),
      show_in_navigation: booleanField({ required: false }),
      tax_rate: decimalField(6, 4, { required: false, allowNull: true }),
      seo_title: charField({ allowBlank: true, maxLength: 200, required: false }),
      seo_description: charField({ allowBlank: true, maxLength: 320, required: false }),
    };
    const result = await runSerializer<CategoryData>(fields, data, {
      partial,
      hooks: {
        parent: (value: string | null) => this.checkParent(value, instance),
        tax_rate: (value: string | null) => {
          // A category's rate replaces the organisation's, and a mixed basket
          // takes the highest present: one impossible rate overcharges every order.
          if (value === null) return null;
          if (new Dec(value).lt(0) || new Dec(value).gt(1))
            throw Invalid.of('The VAT rate must be between 0 and 1 (0.15 is 15%).');
          return value;
        },
      },
      validate: async (attrs) => {
        // Create only: a slug is a URL, and a rename must not break the old one.
        if (instance === null && !attrs.slug && attrs.name) {
          attrs.slug = await uniqueSlug(this.db, 'catalog_category', 'category', attrs.name, 140);
        }
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  /** `validate_parent`: no category may become its own ancestor. */
  private async checkParent(
    value: string | null,
    instance: CategoryRow | null,
  ): Promise<string | null> {
    if (value === null || instance === null) return value;
    if (value === instance.id) throw Invalid.of('A category cannot be its own parent.');
    const seen = new Set([instance.id]);
    let ancestor: string | null = value;
    while (ancestor !== null) {
      if (seen.has(ancestor))
        throw Invalid.of(`That would put “${instance.name}” underneath itself.`);
      seen.add(ancestor);
      const row: { parent_id: string | null } | null = await this.db.one(
        `SELECT "catalog_category"."parent_id" FROM "catalog_category" WHERE "catalog_category"."id" = $1 LIMIT 21`,
        [ancestor],
      );
      ancestor = row?.parent_id ?? null;
    }
    return value;
  }

  private async parentName(id: string | null): Promise<string | null> {
    if (id === null) return null;
    const row = await this.db.one<{ name: string }>(
      `SELECT "catalog_category"."name" FROM "catalog_category" WHERE "catalog_category"."id" = $1`,
      [id],
    );
    return row?.name ?? null;
  }

  async create(data: CategoryData): Promise<CategoryRow> {
    const row: CategoryRow = {
      id: randomUUID(),
      parent_id: data.parent ?? null,
      name: data.name as string,
      slug: data.slug ?? '',
      description: data.description ?? '',
      // `FileField` stores an absent file as "", never NULL.
      image: '',
      position: data.position ?? 0,
      is_active: data.is_active ?? true,
      show_in_navigation: data.show_in_navigation ?? true,
      tax_rate: data.tax_rate ?? null,
      seo_title: data.seo_title ?? '',
      seo_description: data.seo_description ?? '',
      parent_name: null,
    };
    if (!row.slug)
      row.slug = await uniqueSlug(this.db, 'catalog_category', 'category', row.name, 140);
    await this.db.query(
      `INSERT INTO "catalog_category" ("id", "created_at", "updated_at", ${COLUMNS.slice(1)
        .map((column) => `"${column}"`)
        .join(', ')})
       VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      this.values(row),
    );
    row.parent_name = await this.parentName(row.parent_id);
    await this.revalidation.request(...NAVIGATION_TAGS);
    return row;
  }

  private values(row: CategoryRow): unknown[] {
    return [
      row.id,
      row.parent_id,
      row.name,
      row.slug,
      row.description,
      row.image,
      row.position,
      row.is_active,
      row.show_in_navigation,
      row.tax_rate,
      row.seo_title,
      row.seo_description,
    ];
  }

  /** `serializer.save()` on the instance: every column written back. */
  async update(instance: CategoryRow, data: CategoryData): Promise<CategoryRow> {
    const { parent, ...rest } = data;
    const row: CategoryRow = { ...instance, ...rest };
    // Setting the file to None stores "": `str()` of an empty `FieldFile`.
    if (rest.image === null) row.image = '';
    if (parent !== undefined) {
      row.parent_id = parent;
      row.parent_name = await this.parentName(parent);
    }
    if (!row.slug)
      row.slug = await uniqueSlug(this.db, 'catalog_category', 'category', row.name, 140);
    await this.db.query(
      `UPDATE "catalog_category" SET "updated_at" = clock_timestamp(), ${COLUMNS.slice(1)
        .map((column, index) => `"${column}" = $${index + 2}`)
        .join(', ')}
       WHERE "catalog_category"."id" = $1`,
      this.values(row),
    );
    await this.revalidation.request(...NAVIGATION_TAGS);
    return row;
  }

  /**
   * `category.delete()`: refused while it has children or products
   * (`PROTECT`); otherwise its navigation items go with it, their children
   * too, and its attribute links and coupon restrictions.
   */
  async destroy(instance: CategoryRow): Promise<void> {
    const removedItems = await this.db.transaction(async (tx: Queryable) => {
      await refuseIfReferenced(
        tx,
        [
          `SELECT 1 FROM "catalog_category" WHERE "catalog_category"."parent_id" = $1 LIMIT 1`,
          `SELECT 1 FROM "catalog_product" WHERE "catalog_product"."category_id" = $1 LIMIT 1`,
        ],
        instance.id,
      );
      const items: string[] = [];
      let frontier = (
        await tx.query<{ id: string }>(
          `SELECT "id" FROM "content_navigationitem" WHERE "category_id" = $1`,
          [instance.id],
        )
      ).map((row) => row.id);
      while (frontier.length) {
        const fresh = frontier.filter((id) => !items.includes(id));
        items.push(...fresh);
        frontier = fresh.length
          ? (
              await tx.query<{ id: string }>(
                `SELECT "id" FROM "content_navigationitem" WHERE "parent_id" = ANY($1::uuid[])`,
                [fresh],
              )
            ).map((row) => row.id)
          : [];
      }
      await tx.query(`DELETE FROM "catalog_categoryattribute" WHERE "category_id" = $1`, [
        instance.id,
      ]);
      await tx.query(`DELETE FROM "promotions_coupon_categories" WHERE "category_id" = $1`, [
        instance.id,
      ]);
      if (items.length) {
        await tx.query(`DELETE FROM "content_navigationitem" WHERE "id" = ANY($1::uuid[])`, [
          items,
        ]);
      }
      await tx.query(`DELETE FROM "catalog_category" WHERE "id" = $1`, [instance.id]);
      return items.length;
    });
    // One `post_delete` per navigation item, then the category's own.
    for (let i = 0; i < removedItems; i++) await this.revalidation.request(...NAVIGATION_TAGS);
    await this.revalidation.request(...NAVIGATION_TAGS);
  }

  /**
   * `GET /categories/<pk>/attributes/` (`catalog.services.category_attributes`):
   * the attributes the category uses, inherited down the tree -- the nearest
   * category's link wins -- sorted by the attribute's position and name.
   */
  async attributes(category: CategoryRow): Promise<Record<string, unknown>[]> {
    const chain: { id: string; name: string }[] = [{ id: category.id, name: category.name }];
    let parent = category.parent_id;
    while (parent !== null) {
      const row: { id: string; name: string; parent_id: string | null } | null = await this.db.one(
        `SELECT "id", "name", "parent_id" FROM "catalog_category" WHERE "id" = $1`,
        [parent],
      );
      if (!row) break;
      chain.unshift({ id: row.id, name: row.name });
      parent = row.parent_id;
    }
    const depth = new Map(chain.map((node, index) => [node.id, index]));
    const names = new Map(chain.map((node) => [node.id, node.name]));
    const links = await this.db.query<{
      category_id: string;
      attribute_id: string;
      is_required: boolean;
      code: string;
      name: string;
      kind: string;
      is_variant_defining: boolean;
      position: number;
    }>(
      `SELECT l."category_id", l."attribute_id", l."is_required", a."code", a."name", a."kind",
              a."is_variant_defining", a."position"
         FROM "catalog_categoryattribute" l
         INNER JOIN "catalog_attribute" a ON (l."attribute_id" = a."id")
        WHERE l."category_id" = ANY($1::uuid[])
        ORDER BY l."position" ASC`,
      [chain.map((node) => node.id)],
    );
    const nearest = new Map<string, (typeof links)[number]>();
    for (const link of links) {
      const current = nearest.get(link.attribute_id);
      if (
        current === undefined ||
        (depth.get(link.category_id) ?? 0) >= (depth.get(current.category_id) ?? 0)
      )
        nearest.set(link.attribute_id, link);
    }
    const chosen = [...nearest.values()].sort((a, b) =>
      a.position !== b.position ? a.position - b.position : compareCodePoints(a.name, b.name),
    );
    const values = await this.db.query<{
      id: string;
      attribute_id: string;
      value: string;
      label: string;
      swatch: string;
      position: number;
    }>(
      `SELECT v."id", v."attribute_id", v."value", v."label", v."swatch", v."position"
         FROM "catalog_attributevalue" v
        WHERE v."attribute_id" = ANY($1::uuid[])
        ORDER BY v."position" ASC, v."value" ASC`,
      [chosen.map((link) => link.attribute_id)],
    );
    return chosen.map((link) => ({
      id: link.attribute_id,
      code: link.code,
      name: link.name,
      kind: link.kind,
      is_variant_defining: link.is_variant_defining,
      is_required: link.is_required,
      declared_by: names.get(link.category_id) ?? '',
      values: values
        .filter((value) => value.attribute_id === link.attribute_id)
        .map((value) => ({
          id: value.id,
          attribute: value.attribute_id,
          attribute_code: link.code,
          value: value.value,
          label: value.label,
          display: value.label || value.value,
          swatch: value.swatch,
          position: value.position,
        })),
    }));
  }
}
