import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type AuditActor, type AuditContext, recordAudit } from '../../common/audit';
import { localIso } from '../../common/datetime';
import {
  booleanField,
  charField,
  emailField,
  errorMessages,
  type Field,
  Invalid,
  InvalidNested,
  listField,
  runSerializer,
} from '../../common/drf';
import { NotFound, ValidationError } from '../../common/errors';
import { orderingPlan, type OrderingTerm } from '../../common/filtering';
import { PyFloat, pySlice, pySplit, pyStr, pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { dataGet, parsePythonJson } from '../../http/request-body';
import { Revalidation } from '../../jobs/revalidation';
import {
  fail,
  normalizeMapEmbed,
  normalizeMapLink,
  normalizeSocialUrl,
  PLATFORM_EXAMPLES,
  PLATFORM_LABELS,
} from '../validators';

/**
 * `SiteSettingsView` and `SocialLinkViewSet` with `content.services`: the
 * footer's brand block and contact details, and the social profiles. Every
 * save is audited with only what changed, and asks the storefront to drop its
 * `site` cache once the change has committed.
 */

type SettingsField =
  | 'tagline'
  | 'address'
  | 'phone'
  | 'email'
  | 'opening_hours'
  | 'show_address'
  | 'map_embed_url'
  | 'map_link_url'
  | 'copyright_text'
  | 'bottom_note'
  | 'whatsapp_float';

interface SettingsRow {
  id: string;
  created_at: string;
  updated_at: string;
  key: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  opening_hours: unknown;
  show_address: boolean;
  map_embed_url: string;
  map_link_url: string;
  copyright_text: string;
  bottom_note: string;
  whatsapp_float: boolean;
  updated_by_id: string | null;
}

const SETTINGS_SELECT = `SELECT id, created_at, updated_at, key, tagline, address, phone, email,
  opening_hours::text AS opening_hours, show_address, map_embed_url, map_link_url, copyright_text,
  bottom_note, whatsapp_float, updated_by_id FROM content_sitesettings WHERE key = 'default'`;

const MAX_OPENING_HOURS_ROWS = 7;

/** Python `==` between two JSON-ish values: dicts by content, `True == 1`. */
export function pyEquals(a: unknown, b: unknown): boolean {
  const num = (value: unknown) =>
    typeof value === 'boolean'
      ? Number(value)
      : value instanceof PyFloat
        ? value.value
        : typeof value === 'bigint'
          ? Number(value)
          : typeof value === 'number'
            ? value
            : null;
  const left = num(a);
  const right = num(b);
  if (left !== null || right !== null) return left !== null && right !== null && left === right;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => pyEquals(item, b[index]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key) =>
          Object.hasOwn(b, key) &&
          pyEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return a === b;
}

/** `audit.diff(before, after)`: only what changed, in `after`'s order. */
export function auditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] {
  const old: Record<string, unknown> = {};
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!pyEquals(before[key] ?? null, after[key] ?? null)) {
      old[key] = before[key] ?? null;
      changed[key] = after[key] ?? null;
    }
  }
  return [old, changed];
}

/** `OpeningHoursRowSerializer` as the list's child: a dict with both columns. */
const openingHoursRow: Field<Record<string, unknown>> = {
  async run(item, partial) {
    if (item === null) throw Invalid.of('This field may not be null.', 'null');
    const result = await runSerializer(
      {
        days: charField({ maxLength: 60, allowBlank: true }),
        hours: charField({ maxLength: 60, allowBlank: true }),
      },
      item,
      { partial },
    );
    if (!result.ok) throw new InvalidNested(result.errors);
    return result.values;
  },
};

/** `ListField(child=OpeningHoursRowSerializer(), max_length=7)`: the rows, then the count. */
const openingHoursField: Field<unknown> = {
  async run(data, partial) {
    const rows = await listField(openingHoursRow, { required: false }).run(data, partial);
    if (Array.isArray(rows) && rows.length > MAX_OPENING_HOURS_ROWS) {
      throw Invalid.of(
        `Ensure this field has no more than ${MAX_OPENING_HOURS_ROWS} elements.`,
        'max_length',
      );
    }
    return rows;
  },
};

/** `_clean_hours`: rows of days and hours, blank ones dropped, whitespace collapsed. */
function cleanHours(rows: unknown): { days: string; hours: string }[] {
  if (!Array.isArray(rows)) throw fail('opening_hours', 'Opening hours must be a list of rows.');
  const cleaned: { days: string; hours: string }[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const days = pySlice(pySplit(pyStr(row.days ?? '')).join(' '), 60);
    const hours = pySlice(pySplit(pyStr(row.hours ?? '')).join(' '), 60);
    if (days || hours) cleaned.push({ days, hours });
  }
  if (cleaned.length > MAX_OPENING_HOURS_ROWS)
    throw fail('opening_hours', `Use at most ${MAX_OPENING_HOURS_ROWS} rows of opening hours.`);
  return cleaned;
}

/** `user.full_name`: first and last name, else the email. */
function fullName(first: string | null, last: string | null, email: string | null): string {
  if (email === null) return '';
  return pyStrip(`${first ?? ''} ${last ?? ''}`) || email;
}

interface LinkRow {
  id: string;
  platform: string;
  url: string;
  is_visible: boolean;
  position: number;
}

const LINK_ORDERING: Record<string, OrderingTerm> = {
  id: '"content_sociallink"."id"',
  platform: '"content_sociallink"."platform"',
  url: '"content_sociallink"."url"',
  is_visible: '"content_sociallink"."is_visible"',
  position: '"content_sociallink"."position"',
};

@Injectable()
export class SiteAdminService {
  constructor(
    private readonly db: Database,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `selectors.site_settings()`: the one row, made on first read. Making it
   * is a save, whose signal asks for `site` once the transaction commits.
   */
  private async settingsRow(q: Queryable, lock = false): Promise<[SettingsRow, boolean]> {
    const read = async () => {
      const row = await q.one<SettingsRow>(`${SETTINGS_SELECT}${lock ? ' FOR UPDATE' : ''}`);
      if (row) row.opening_hours = parsePythonJson(row.opening_hours as string);
      return row;
    };
    const existing = await read();
    if (existing) return [existing, false];
    const inserted = await q.query(
      `INSERT INTO content_sitesettings
              (id, created_at, updated_at, key, tagline, address, phone, email, opening_hours,
               show_address, map_embed_url, map_link_url, copyright_text, bottom_note, whatsapp_float,
               updated_by_id)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), 'default', '', '', '', '', '[]'::jsonb,
               true, '', '', '', '', true, NULL)
       ON CONFLICT (key) DO NOTHING RETURNING id`,
      [randomUUID()],
    );
    return [(await read()) as SettingsRow, inserted.length > 0];
  }

  /** `SiteSettingsSerializer(settings, context={"organization": ...}).data`. */
  async settings() {
    const [row, created] = await this.settingsRow(this.db);
    if (created) await this.revalidation.request('site');
    const organization = await this.db.one<{
      name: string;
      address: string;
      phone: string;
      email: string;
    }>(
      `SELECT name, address, phone, email FROM accounts_organization WHERE status = 'ACTIVE'
        ORDER BY created_at ASC LIMIT 1`,
    );
    const user = row.updated_by_id
      ? await this.db.one<{ first_name: string; last_name: string; email: string }>(
          `SELECT first_name, last_name, email FROM accounts_user WHERE id = $1::uuid`,
          [row.updated_by_id],
        )
      : null;
    return {
      tagline: row.tagline,
      address: row.address,
      phone: row.phone,
      email: row.email,
      opening_hours: row.opening_hours,
      show_address: row.show_address,
      map_embed_url: row.map_embed_url,
      map_link_url: row.map_link_url,
      copyright_text: row.copyright_text,
      bottom_note: row.bottom_note,
      whatsapp_float: row.whatsapp_float,
      fallbacks: organization
        ? {
            name: organization.name,
            address: organization.address,
            phone: organization.phone,
            email: organization.email,
          }
        : { name: '', address: '', phone: '', email: '' },
      updated_at: localIso(row.updated_at, this.env.DJANGO_TIME_ZONE),
      updated_by_name: user ? fullName(user.first_name, user.last_name, user.email) : '',
    };
  }

  /** `SiteSettingsWriteSerializer(partial=True)` then `update_site_settings`. */
  async updateSettings(data: unknown, actor: AuditActor, context: AuditContext) {
    const text = (maxLength: number) => charField({ maxLength, allowBlank: true, required: false });
    const validated = await runSerializer<Partial<Record<SettingsField, unknown>>>(
      {
        tagline: text(200),
        address: text(500),
        phone: text(32),
        email: emailField({ allowBlank: true, required: false }),
        opening_hours: openingHoursField,
        show_address: booleanField({ required: false }),
        map_embed_url: text(4000),
        map_link_url: text(500),
        copyright_text: text(200),
        bottom_note: text(200),
        whatsapp_float: booleanField({ required: false }),
      },
      data,
      { partial: true },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });

    const normalised: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(validated.values)) {
      let value = raw;
      if (field === 'map_embed_url') value = normalizeMapEmbed(raw as string);
      else if (field === 'map_link_url') value = normalizeMapLink(raw as string);
      else if (field === 'opening_hours') value = cleanHours(raw);
      else if (typeof raw === 'string') value = pyStrip(raw);
      normalised[field] = value;
    }

    let changed = false;
    let created = false;
    await this.db.transaction(async (tx) => {
      const [row, made] = await this.settingsRow(tx, true);
      created = made;
      const before: Record<string, unknown> = {};
      for (const field of Object.keys(normalised)) before[field] = row[field as SettingsField];
      const [old, after] = auditDiff(before, normalised);
      if (!Object.keys(after).length) return;
      const next = { ...row, ...normalised };
      // `settings.save()`: every column written back.
      await tx.query(
        `UPDATE content_sitesettings SET created_at = $2, updated_at = clock_timestamp(), key = $3,
                tagline = $4, address = $5, phone = $6, email = $7, opening_hours = $8::jsonb,
                show_address = $9, map_embed_url = $10, map_link_url = $11, copyright_text = $12,
                bottom_note = $13, whatsapp_float = $14, updated_by_id = $15::uuid
          WHERE id = $1::uuid`,
        [
          row.id,
          row.created_at,
          row.key,
          next.tagline,
          next.address,
          next.phone,
          next.email,
          JSON.stringify(next.opening_hours),
          next.show_address,
          next.map_embed_url,
          next.map_link_url,
          next.copyright_text,
          next.bottom_note,
          next.whatsapp_float,
          actor.id,
        ],
      );
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'SiteSettings', id: row.id, label: 'Site settings' },
        actor,
        oldValues: old,
        newValues: after,
      });
      changed = true;
    });
    if (created) await this.revalidation.request('site');
    if (changed) await this.revalidation.request('site');
    return this.settings();
  }

  // --- social links -------------------------------------------------------------------

  private link(row: LinkRow) {
    return {
      id: row.id,
      platform: row.platform,
      label: PLATFORM_LABELS[row.platform] ?? row.platform,
      url: row.url,
      is_visible: row.is_visible,
      position: row.position,
      example: PLATFORM_EXAMPLES[row.platform] ?? '',
    };
  }

  /**
   * `filter_queryset`: no `ordering_fields`, so every serializer field may
   * order -- `label` reads `get_platform_display`, a method the database
   * cannot order by: Django's `FieldError`, a 500.
   */
  private order(query: QueryDict | null): string[] {
    const requested = query?.get('ordering') ?? '';
    if (
      requested
        .split(',')
        .map((term) => pyStrip(term).replace(/^-/, ''))
        .includes('get_platform_display')
    ) {
      throw new Error("FieldError: Cannot resolve keyword 'get_platform_display' into field.");
    }
    return (
      (query && orderingPlan(query, LINK_ORDERING)?.order) ?? [
        '"content_sociallink"."position" ASC',
        '"content_sociallink"."platform" ASC',
      ]
    );
  }

  async links(query: QueryDict) {
    const rows = await this.db.query<LinkRow>(
      `SELECT "id", "platform", "url", "is_visible", "position" FROM "content_sociallink"
        ORDER BY ${this.order(query).join(', ')}`,
    );
    return rows.map((row) => this.link(row));
  }

  /** `get_object`. */
  async findLink(pk: string, query: QueryDict): Promise<LinkRow> {
    this.order(query);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    const row = await this.db.one<LinkRow>(
      `SELECT "id", "platform", "url", "is_visible", "position" FROM "content_sociallink"
        WHERE "id" = $1::uuid LIMIT 21`,
      [id],
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieveLink(pk: string, query: QueryDict) {
    return this.link(await this.findLink(pk, query));
  }

  /** `SocialLinkWriteSerializer(partial=True)`, `get_object()`, then `update_social_link`. */
  async updateLink(
    pk: string,
    query: QueryDict,
    data: unknown,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{ url?: string; is_visible?: boolean }>(
      {
        url: charField({ maxLength: 300, allowBlank: true, required: false }),
        is_visible: booleanField({ required: false }),
      },
      data,
      { partial: true },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const target = await this.findLink(pk, query);
    let saved = false;
    const row = await this.db.transaction(async (tx) => {
      const link = await tx.one<LinkRow>(
        `SELECT "id", "platform", "url", "is_visible", "position" FROM "content_sociallink"
          WHERE "id" = $1::uuid ORDER BY "position" ASC, "platform" ASC LIMIT 1 FOR UPDATE`,
        [target.id],
      );
      if (!link) throw new NotFound();
      const before = { url: link.url, is_visible: link.is_visible };
      if (validated.values.url !== undefined)
        link.url = normalizeSocialUrl(link.platform, validated.values.url);
      if (validated.values.is_visible !== undefined) link.is_visible = validated.values.is_visible;
      if (link.is_visible && !link.url) {
        throw fail(
          'is_visible',
          `Add the ${PLATFORM_LABELS[link.platform]} address before showing it.`,
        );
      }
      const [old, after] = auditDiff(before, { url: link.url, is_visible: link.is_visible });
      if (Object.keys(after).length) {
        await tx.query(
          `UPDATE "content_sociallink" SET "url" = $2, "is_visible" = $3, "updated_at" = clock_timestamp()
            WHERE "id" = $1::uuid`,
          [link.id, link.url, link.is_visible],
        );
        await recordAudit(tx, context, {
          action: 'SETTINGS_CHANGED',
          entity: { type: 'SocialLink', id: link.id, label: PLATFORM_LABELS[link.platform] ?? '' },
          actor,
          oldValues: old,
          newValues: after,
        });
        saved = true;
      }
      return link;
    });
    if (saved) await this.revalidation.request('site');
    return this.link(row);
  }

  /** `move`: `move_social_link`, then the `site` revalidation the view always asks for. */
  async moveLink(
    pk: string,
    query: QueryDict,
    data: unknown,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const link = await this.findLink(pk, query);
    const direction = pyStr(dataGet(data, 'direction') ?? '').toLowerCase();
    const moved = await moveRun(
      this.db,
      'content_sociallink',
      '"position", "platform"',
      link.id,
      direction,
    );
    const after = (await this.db.one<LinkRow>(
      `SELECT "id", "platform", "url", "is_visible", "position" FROM "content_sociallink"
        WHERE "id" = $1::uuid LIMIT 21`,
      [link.id],
    )) as LinkRow;
    if (moved) {
      await recordAudit(this.db, context, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'SocialLink', id: after.id, label: PLATFORM_LABELS[after.platform] ?? '' },
        actor,
        newValues: { moved: direction, position: after.position },
      });
    }
    await this.revalidation.request('site');
    return this.link(after);
  }
}

/**
 * `content.services.move`: one row of an ordered run up or down by one place.
 * The whole run is locked in its order and renumbered 0..n (a swap of two
 * equal positions would not show), with `bulk_update`'s single statement.
 * Answers whether anything moved.
 */
export async function moveRun(
  db: Database,
  table: string,
  orderBy: string,
  id: string,
  direction: string,
  where = '',
  values: unknown[] = [],
): Promise<boolean> {
  if (direction !== 'up' && direction !== 'down')
    throw new ValidationError("Direction must be 'up' or 'down'.");
  return db.transaction(async (tx) => {
    const ordered = await tx.query<{ id: string }>(
      `SELECT "id" FROM "${table}" ${where} ORDER BY ${orderBy} FOR UPDATE`,
      values,
    );
    const index = ordered.findIndex((row) => row.id === id);
    if (index === -1) throw new NotFound();
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) return false;
    [ordered[index], ordered[target]] = [
      ordered[target] as { id: string },
      ordered[index] as { id: string },
    ];
    const cases = ordered.map(
      (_, offset) => `WHEN "id" = $${offset * 2 + 1}::uuid THEN $${offset * 2 + 2}::integer`,
    );
    const params = ordered.flatMap((row, offset) => [row.id, offset]);
    await tx.query(
      `UPDATE "${table}" SET "position" = (CASE ${cases.join(' ')} ELSE NULL END)::integer
        WHERE "id" IN (${ordered.map((_, offset) => `$${offset * 2 + 1}::uuid`).join(', ')})`,
      params,
    );
    return true;
  });
}
