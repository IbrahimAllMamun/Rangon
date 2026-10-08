import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type AuditActor, type AuditContext, recordAudit } from '../../common/audit';
import { type AwareMoment, dateTimeField } from '../../common/datetime-field';
import { localIso } from '../../common/datetime';
import {
  booleanField,
  charField,
  choiceField,
  errorMessages,
  type Fields,
  imageField,
  integerField,
  runSerializer,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { applyFilters, booleanFilter, choiceFilter, orderingFrom } from '../../common/filtering';
import { mediaUrl } from '../../common/media';
import type { QueryDict } from '../../common/query-dict';
import { type MediaStorage, mediaStorage } from '../../common/storage';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import type { UploadedFile } from '../../http/multipart';
import { Revalidation } from '../../jobs/revalidation';
import { checkImageUpload } from '../../catalog/admin/product-images.service';
import {
  type Bound,
  boundIso,
  boundParam,
  checkWindow,
  cleanError,
  storedImage,
} from './scheduled';

/**
 * `StorefrontBannerViewSet`: the announcement bar and the homepage hero. A
 * `ModelViewSet`, unpaginated, highest priority first, then newest. Its
 * serializer is `ScheduledContentSerializer` -- the window, then
 * `StorefrontBanner.clean()` (an announcement needs its message, a hero its
 * title). Every save and delete asks the storefront to drop its navigation
 * and homepage at once (the model's signals).
 */

const PLACEMENTS = ['ANNOUNCEMENT', 'HOME_HERO'] as const;
const PLACEMENT_LABELS: Record<string, string> = {
  ANNOUNCEMENT: 'Announcement bar',
  HOME_HERO: 'Homepage hero',
};
const B = '"content_storefrontbanner"';
const COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'placement',
  'message',
  'title',
  'subtitle',
  'cta_label',
  'url',
  'image',
  'dismissible',
  'priority',
  'is_active',
  'starts_at',
  'ends_at',
];
const SELECT = `SELECT ${COLUMNS.map((c) => `${B}."${c}"`).join(', ')} FROM ${B}`;
const FILTERS = [
  choiceFilter('placement', `${B}."placement"`, PLACEMENTS),
  booleanFilter('is_active', `${B}."is_active"`),
];
const ORDERING = { priority: `${B}."priority"`, created_at: `${B}."created_at"` };
const DEFAULT_ORDER = [`${B}."priority" DESC`, `${B}."created_at" DESC`];
const TRACKED = ['message', 'title', 'url', 'is_active', 'priority'] as const;

interface BannerRow {
  id: string;
  created_at: string;
  updated_at: string;
  placement: string;
  message: string;
  title: string;
  subtitle: string;
  cta_label: string;
  url: string;
  image: string | null;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

type BannerData = Partial<{
  placement: string;
  message: string;
  title: string;
  subtitle: string;
  cta_label: string;
  url: string;
  image: UploadedFile | null;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
  starts_at: AwareMoment | null;
  ends_at: AwareMoment | null;
}>;

/** `str(banner)`: `get_placement_display()` -- the stored value when it is no choice -- and the copy. */
function bannerLabel(row: { placement: string; message: string; title: string }): string {
  return `${PLACEMENT_LABELS[row.placement] ?? row.placement}: ${row.message || row.title}`;
}

@Injectable()
export class BannersAdminService {
  private readonly storage: MediaStorage;

  constructor(
    private readonly db: Database,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.storage = mediaStorage(env);
  }

  /** `StorefrontBannerSerializer(banner).data`. */
  serialise(row: BannerRow, bounds: { startsAt?: Bound; endsAt?: Bound } = {}) {
    const tz = this.env.DJANGO_TIME_ZONE;
    return {
      id: row.id,
      placement: row.placement,
      message: row.message,
      title: row.title,
      subtitle: row.subtitle,
      cta_label: row.cta_label,
      url: row.url,
      image: mediaUrl(row.image, this.env.mediaBase),
      dismissible: row.dismissible,
      priority: row.priority,
      is_active: row.is_active,
      starts_at: boundIso(bounds.startsAt !== undefined ? bounds.startsAt : row.starts_at, tz),
      ends_at: boundIso(bounds.endsAt !== undefined ? bounds.endsAt : row.ends_at, tz),
      created_at: localIso(row.created_at, tz),
      updated_at: localIso(row.updated_at, tz),
    };
  }

  private async queryset(query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    return { where, order: (orderingFrom(query, ORDERING) ?? DEFAULT_ORDER).join(', ') };
  }

  async list(query: QueryDict) {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const rows = await this.db.query<BannerRow>(
      `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
      sql.values,
    );
    return rows.map((row) => this.serialise(row));
  }

  /** `get_object()`. */
  async find(pk: string, query: QueryDict): Promise<BannerRow> {
    const sql = new SqlParams();
    const { where, order } = await this.queryset(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${B}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<BannerRow>(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(pk: string, query: QueryDict) {
    return this.serialise(await this.find(pk, query));
  }

  private async read(id: string): Promise<BannerRow> {
    return (await this.db.one<BannerRow>(`${SELECT} WHERE ${B}."id" = $1::uuid`, [
      id,
    ])) as BannerRow;
  }

  /** `StorefrontBannerSerializer(instance, data, partial).is_valid(raise_exception=True)`. */
  private async validate(
    data: unknown,
    instance: BannerRow | null,
    partial: boolean,
  ): Promise<BannerData> {
    const tz = this.env.DJANGO_TIME_ZONE;
    const text = (maxLength: number) => charField({ maxLength, allowBlank: true, required: false });
    const fields: Fields = {
      placement: choiceField(PLACEMENTS),
      message: text(200),
      title: text(120),
      subtitle: text(200),
      cta_label: text(40),
      url: text(300),
      image: imageField({ required: false, allowNull: true }),
      dismissible: booleanField({ required: false }),
      priority: integerField({ required: false, minValue: -2147483648, maxValue: 2147483647 }),
      is_active: booleanField({ required: false }),
      starts_at: dateTimeField(tz, { required: false, allowNull: true }),
      ends_at: dateTimeField(tz, { required: false, allowNull: true }),
    };
    const result = await runSerializer<BannerData>(fields, data, {
      partial,
      hooks: { image: (value: UploadedFile | null) => checkImageUpload(value) },
      validate: (attrs) => {
        checkWindow(
          attrs.starts_at !== undefined ? attrs.starts_at : (instance?.starts_at ?? null),
          attrs.ends_at !== undefined ? attrs.ends_at : (instance?.ends_at ?? null),
        );
        // `StorefrontBanner.clean()` on a copy with the request's values.
        const placement = attrs.placement ?? instance?.placement ?? '';
        const message = attrs.message ?? instance?.message ?? '';
        const title = attrs.title ?? instance?.title ?? '';
        if (placement === 'ANNOUNCEMENT' && !message)
          throw cleanError('message', 'An announcement needs a message.');
        if (placement === 'HOME_HERO' && !title)
          throw cleanError('title', 'A hero banner needs a title.');
        return attrs;
      },
    });
    if (!result.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(result.errors) });
    return result.values;
  }

  async create(data: unknown, actor: AuditActor, context: AuditContext) {
    const values = await this.validate(data, null, false);
    const id = randomUUID();
    const image = await storedImage(this.storage, 'banners/', values.image, '');
    await this.db.query(
      `INSERT INTO ${B} ("id", "created_at", "updated_at", "placement", "message", "title",
         "subtitle", "cta_label", "url", "image", "dismissible", "priority", "is_active",
         "starts_at", "ends_at")
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12::timestamptz, $13::timestamptz)`,
      [
        id,
        values.placement,
        values.message ?? '',
        values.title ?? '',
        values.subtitle ?? '',
        values.cta_label ?? '',
        values.url ?? '',
        image,
        values.dismissible ?? true,
        values.priority ?? 0,
        values.is_active ?? true,
        boundParam(values.starts_at ?? null),
        boundParam(values.ends_at ?? null),
      ],
    );
    await this.revalidation.request('navigation', 'home');
    const row = await this.read(id);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      entity: { type: 'StorefrontBanner', id, label: bannerLabel(row) },
      actor,
      newValues: { placement: row.placement, message: row.message },
    });
    return this.serialise(row, {
      startsAt: values.starts_at ?? null,
      endsAt: values.ends_at ?? null,
    });
  }

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
    const next: BannerRow = {
      ...instance,
      placement: values.placement ?? instance.placement,
      message: values.message ?? instance.message,
      title: values.title ?? instance.title,
      subtitle: values.subtitle ?? instance.subtitle,
      cta_label: values.cta_label ?? instance.cta_label,
      url: values.url ?? instance.url,
      image: await storedImage(this.storage, 'banners/', values.image, instance.image ?? ''),
      dismissible: values.dismissible ?? instance.dismissible,
      priority: values.priority ?? instance.priority,
      is_active: values.is_active ?? instance.is_active,
    };
    const startsAt = values.starts_at !== undefined ? values.starts_at : instance.starts_at;
    const endsAt = values.ends_at !== undefined ? values.ends_at : instance.ends_at;
    await this.db.query(
      `UPDATE ${B} SET "created_at" = $2, "updated_at" = clock_timestamp(), "placement" = $3,
         "message" = $4, "title" = $5, "subtitle" = $6, "cta_label" = $7, "url" = $8, "image" = $9,
         "dismissible" = $10, "priority" = $11, "is_active" = $12, "starts_at" = $13::timestamptz,
         "ends_at" = $14::timestamptz
       WHERE ${B}."id" = $1::uuid`,
      [
        instance.id,
        instance.created_at,
        next.placement,
        next.message,
        next.title,
        next.subtitle,
        next.cta_label,
        next.url,
        next.image,
        next.dismissible,
        next.priority,
        next.is_active,
        boundParam(startsAt),
        boundParam(endsAt),
      ],
    );
    await this.revalidation.request('navigation', 'home');
    const row = await this.read(instance.id);
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
        entity: { type: 'StorefrontBanner', id: row.id, label: bannerLabel(row) },
        actor,
        oldValues: old,
        newValues: changed,
      });
    }
    return this.serialise(row, { startsAt, endsAt });
  }

  async destroy(pk: string, query: QueryDict, actor: AuditActor, context: AuditContext) {
    const instance = await this.find(pk, query);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      entity: { type: 'StorefrontBanner', id: instance.id, label: bannerLabel(instance) },
      actor,
      oldValues: { placement: instance.placement, message: instance.message },
      reason: 'Banner removed.',
    });
    await this.db.query(`DELETE FROM ${B} WHERE ${B}."id" IN ($1::uuid)`, [instance.id]);
    await this.revalidation.request('navigation', 'home');
  }
}
