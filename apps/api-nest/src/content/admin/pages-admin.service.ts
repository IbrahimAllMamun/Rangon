import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type AuditActor, type AuditContext, recordAudit } from '../../common/audit';
import { localIso } from '../../common/datetime';
import { booleanField, charField, errorMessages, runSerializer } from '../../common/drf';
import { Conflict, NotFound, ValidationError } from '../../common/errors';
import { orderingFrom } from '../../common/filtering';
import { pySlice, pySplit, pyStr, pyStrip } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { slugify } from '../../common/slugs';
import { ENV, Env } from '../../config/env';
import { Database, Queryable } from '../../database/database.service';
import { NAVIGATION_TAGS, Revalidation } from '../../jobs/revalidation';
import { pagePath } from '../content.service';
import { MAX_BODY_CHARS, sanitize, tooLong } from '../rich-text';
import { fail } from '../validators';

/**
 * `SitePageViewSet` with `content.services`: About, Contact, the policies and
 * the shop's own pages, addressed by slug. Every body is cleaned by the page
 * sanitiser (`content/rich-text.ts`) before it is stored; every change is
 * audited and, once committed, asks the storefront to drop `site`, `pages`
 * and the page's own cache (the `SitePage` signals).
 */

const SYSTEM_PAGE_SLUGS = new Set(['about', 'contact', 'shipping', 'returns', 'privacy', 'terms']);

interface PageRow {
  id: string;
  created_at: string;
  updated_at: string;
  slug: string;
  title: string;
  meta_description: string;
  body: string;
  is_published: boolean;
  is_system: boolean;
  updated_by_id: string | null;
}

type PageFields = Pick<PageRow, 'title' | 'meta_description' | 'body' | 'is_published'>;

const PAGE_COLUMNS = `"content_sitepage"."id", "content_sitepage"."created_at",
  "content_sitepage"."updated_at", "content_sitepage"."slug", "content_sitepage"."title",
  "content_sitepage"."meta_description", "content_sitepage"."body", "content_sitepage"."is_published",
  "content_sitepage"."is_system", "content_sitepage"."updated_by_id"`;

/**
 * The account `select_related("updated_by")` joins, every column, as Django
 * selects it. Nothing here reads them: with nothing selected from the join
 * PostgreSQL drops it, and pages that tie in the order asked for then come
 * back in another order than Django's statement gives.
 */
const EDITOR_COLUMNS = [
  'password',
  'last_login',
  'is_superuser',
  'id',
  'created_at',
  'updated_at',
  'email',
  'first_name',
  'last_name',
  'phone',
  'organization_id',
  'branch_id',
  'role_id',
  'status',
  'is_staff',
  'is_active',
  'date_joined',
  'last_login_ip',
]
  .map((name) => `"accounts_user"."${name}" AS "editor_${name}"`)
  .join(', ');
const PAGE_WITH_EDITOR = `SELECT ${PAGE_COLUMNS}, ${EDITOR_COLUMNS} FROM "content_sitepage"
  LEFT OUTER JOIN "accounts_user" ON ("content_sitepage"."updated_by_id" = "accounts_user"."id")`;

/** `OrderingFilter` with no `ordering_fields`: every serializer field the database holds. */
const PAGE_ORDERING: Record<string, string> = Object.fromEntries(
  [
    'id',
    'slug',
    'title',
    'meta_description',
    'body',
    'is_published',
    'is_system',
    'created_at',
    'updated_at',
  ].map((field) => [field, `"content_sitepage"."${field}"`]),
);

const DEFAULT_ORDER = ['"content_sitepage"."is_system" DESC', '"content_sitepage"."title" ASC'];

const text = (maxLength: number, extra: { allowBlank?: boolean; required?: boolean } = {}) =>
  charField({ maxLength, allowBlank: extra.allowBlank ?? true, required: extra.required ?? false });

/** `SitePageWriteSerializer`, in DRF's field order. */
const WRITE_FIELDS = {
  title: text(120, { allowBlank: false }),
  meta_description: text(300),
  body: charField({
    maxLength: MAX_BODY_CHARS * 2,
    allowBlank: true,
    required: false,
    trimWhitespace: false,
  }),
  is_published: booleanField({ required: false }),
};

/**
 * `SitePageCreateSerializer(SitePageWriteSerializer)`: the parent's fields
 * first, those it redeclares left out, then its own in the order declared.
 */
const CREATE_FIELDS = {
  meta_description: WRITE_FIELDS.meta_description,
  body: WRITE_FIELDS.body,
  is_published: WRITE_FIELDS.is_published,
  slug: text(64),
  title: text(120, { allowBlank: false, required: true }),
};

/** `user.full_name`: first and last name, else the email. */
function fullName(user: { first_name: string; last_name: string; email: string } | null): string {
  if (!user) return '';
  return pyStrip(`${user.first_name} ${user.last_name}`) || user.email;
}

/** `_clean_page_fields`: the body sanitised and bounded, the titles' whitespace collapsed. */
function cleanPageFields(changes: Partial<Record<keyof PageFields, unknown>>): Partial<PageFields> {
  const cleaned: Partial<Record<keyof PageFields, unknown>> = {};
  for (const [field, value] of Object.entries(changes) as [keyof PageFields, unknown][]) {
    if (field === 'body') {
      const body = sanitize(value as string);
      if (tooLong(body)) throw fail('body', 'This page is too long. Split it into two pages.');
      cleaned.body = body;
    } else if (field === 'title' || field === 'meta_description') {
      cleaned[field] = pySplit(pyStr(value)).join(' ');
    } else {
      cleaned[field] = value;
    }
  }
  if ('title' in cleaned && !cleaned.title) throw fail('title', 'A page needs a title.');
  return cleaned as Partial<PageFields>;
}

/** `audit.snapshot(page, PAGE_FIELDS)`. */
function pageValues(page: PageFields): PageFields {
  return {
    title: page.title,
    meta_description: page.meta_description,
    body: page.body,
    is_published: page.is_published,
  };
}

@Injectable()
export class PagesAdminService {
  constructor(
    private readonly db: Database,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `SitePageSerializer(page).data`. */
  private async serialize(page: PageRow, q: Queryable = this.db) {
    const user = page.updated_by_id
      ? await q.one<{ first_name: string; last_name: string; email: string }>(
          `SELECT first_name, last_name, email FROM accounts_user WHERE id = $1::uuid`,
          [page.updated_by_id],
        )
      : null;
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      meta_description: page.meta_description,
      body: page.body,
      is_published: page.is_published,
      is_system: page.is_system,
      path: pagePath(page.slug),
      created_at: localIso(page.created_at, this.env.DJANGO_TIME_ZONE),
      updated_at: localIso(page.updated_at, this.env.DJANGO_TIME_ZONE),
      updated_by_name: fullName(user),
    };
  }

  private order(query: QueryDict): string[] {
    return orderingFrom(query, PAGE_ORDERING) ?? DEFAULT_ORDER;
  }

  async list(query: QueryDict) {
    const pages = await this.db.query<PageRow>(
      `${PAGE_WITH_EDITOR} ORDER BY ${this.order(query).join(', ')}`,
    );
    const out = [];
    for (const page of pages) out.push(await this.serialize(page));
    return out;
  }

  /** `get_object()`: by slug, through the view's filters. */
  private async find(slug: string, query: QueryDict): Promise<PageRow> {
    const page = await this.db.one<PageRow>(
      `${PAGE_WITH_EDITOR}
        WHERE "content_sitepage"."slug" = $1 ORDER BY ${this.order(query).join(', ')} LIMIT 21`,
      [slug],
    );
    if (!page) throw new NotFound();
    return page;
  }

  async retrieve(slug: string, query: QueryDict) {
    return this.serialize(await this.find(slug, query));
  }

  /** `SitePageCreateSerializer`, then `create_page`. */
  async create(data: unknown, actor: AuditActor, context: AuditContext) {
    const validated = await runSerializer<{
      title: string;
      slug?: string;
      meta_description?: string;
      body?: string;
      is_published?: boolean;
    }>(CREATE_FIELDS, data);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const values = validated.values;

    const slug = pySlice(slugify(values.slug || values.title), 64);
    if (!slug) throw fail('slug', 'Give the page an address, for example size-guide.');
    if (SYSTEM_PAGE_SLUGS.has(slug))
      throw fail('slug', `“${slug}” is already one of the shop's standard pages.`);
    const fields = cleanPageFields({
      title: values.title,
      meta_description: values.meta_description ?? '',
      body: values.body ?? '',
      is_published: values.is_published ?? true,
    }) as PageFields;

    let page: PageRow;
    try {
      page = await this.db.transaction(async (tx) => {
        const row = await tx.one<PageRow>(
          `INSERT INTO "content_sitepage" ("id", "created_at", "updated_at", "slug", "title",
                  "meta_description", "body", "is_published", "is_system", "updated_by_id")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6, false, $7::uuid)
           RETURNING ${PAGE_COLUMNS}`,
          [
            randomUUID(),
            slug,
            fields.title,
            fields.meta_description,
            fields.body,
            fields.is_published,
            actor.id,
          ],
        );
        return row as PageRow;
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new Conflict(`A page at /pages/${slug} already exists.`, {
          details: { slug: ['Already in use.'] },
        });
      }
      throw error;
    }
    // `post_save` asks for the storefront's caches once the insert has committed.
    await this.revalidation.request('site', 'pages', `page:${slug}`);
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      entity: { type: 'SitePage', id: page.id, label: page.title },
      actor,
      newValues: { slug, ...pageValues(page) },
      reason: 'Site page created.',
    });
    return this.serialize(page);
  }

  /** `SitePageWriteSerializer(partial=True)`, `get_object()`, then `update_page`. */
  async update(
    slug: string,
    query: QueryDict,
    data: unknown,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const validated = await runSerializer<Partial<PageFields>>(WRITE_FIELDS, data, {
      partial: true,
    });
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const target = await this.find(slug, query);
    const cleaned = cleanPageFields(validated.values);

    let saved = false;
    const page = await this.db.transaction(async (tx) => {
      const row = await tx.one<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM "content_sitepage" WHERE "content_sitepage"."slug" = $1
          ORDER BY "content_sitepage"."is_system" DESC, "content_sitepage"."title" ASC
          LIMIT 1 FOR UPDATE`,
        [target.slug],
      );
      if (!row) throw new NotFound();
      const before = pageValues(row);
      const next: PageRow = { ...row, ...cleaned };
      const after = pageValues(next);
      const old: Record<string, unknown> = {};
      const changed: Record<string, unknown> = {};
      for (const key of Object.keys(after) as (keyof PageFields)[]) {
        if (before[key] !== after[key]) {
          old[key] = before[key];
          changed[key] = after[key];
        }
      }
      if (!Object.keys(changed).length) return row;
      // `page.save()`: every column written back.
      const updated = (await tx.one<PageRow>(
        `UPDATE "content_sitepage" SET "created_at" = $2, "updated_at" = clock_timestamp(),
                "slug" = $3, "title" = $4, "meta_description" = $5, "body" = $6,
                "is_published" = $7, "is_system" = $8, "updated_by_id" = $9::uuid
          WHERE "content_sitepage"."id" = $1::uuid
          RETURNING ${PAGE_COLUMNS}`,
        [
          row.id,
          row.created_at,
          next.slug,
          next.title,
          next.meta_description,
          next.body,
          next.is_published,
          next.is_system,
          actor.id,
        ],
      )) as PageRow;
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'SitePage', id: row.id, label: next.title },
        actor,
        oldValues: old,
        newValues: changed,
      });
      saved = true;
      return updated;
    });
    if (saved) await this.revalidation.request('site', 'pages', `page:${page.slug}`);
    return this.serialize(page);
  }

  /** `get_object()`, then `delete_page`: the shop's standard pages stay. */
  async destroy(slug: string, query: QueryDict, actor: AuditActor, context: AuditContext) {
    const target = await this.find(slug, query);
    let deleted: PageRow | null = null;
    let navigationItems = 0;
    await this.db.transaction(async (tx) => {
      const page = await tx.one<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM "content_sitepage" WHERE "content_sitepage"."slug" = $1
          ORDER BY "content_sitepage"."is_system" DESC, "content_sitepage"."title" ASC
          LIMIT 1 FOR UPDATE`,
        [target.slug],
      );
      if (!page) throw new NotFound();
      if (page.is_system)
        throw new ValidationError(
          "The shop's standard pages cannot be deleted. Unpublish it instead.",
        );
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'SitePage', id: page.id, label: page.title },
        actor,
        oldValues: { slug: page.slug, ...pageValues(page) },
        reason: 'Site page deleted.',
      });
      navigationItems = await deletePageCascade(tx, page.id);
      deleted = page;
    });
    // Each navigation item the page took with it sent `post_delete` as it
    // went, inside the transaction; the page's own signal waits for the commit.
    for (let i = 0; i < navigationItems; i++) await this.revalidation.request(...NAVIGATION_TAGS);
    if (deleted)
      await this.revalidation.request('site', 'pages', `page:${(deleted as PageRow).slug}`);
  }
}

/**
 * `page.delete()`: Django's collector takes the navigation items that link
 * to the page (`on_delete=CASCADE`) and, with them, the items nested under
 * those; it deletes the page, then the items. Answers how many items went.
 */
async function deletePageCascade(tx: Queryable, pageId: string): Promise<number> {
  const linked = await tx.query<{ id: string }>(
    `SELECT "id" FROM "content_navigationitem" WHERE "page_id" IN ($1::uuid)`,
    [pageId],
  );
  let ids = linked.map((row) => row.id);
  const all: string[] = [...ids];
  while (ids.length) {
    const children = await tx.query<{ id: string }>(
      `SELECT "id" FROM "content_navigationitem" WHERE "parent_id" = ANY($1::uuid[])`,
      [ids],
    );
    ids = children.map((row) => row.id).filter((id) => !all.includes(id));
    all.push(...ids);
  }
  // The page goes first: its foreign keys are checked at the commit.
  await tx.query(`DELETE FROM "content_sitepage" WHERE "id" IN ($1::uuid)`, [pageId]);
  if (all.length)
    await tx.query(`DELETE FROM "content_navigationitem" WHERE "id" = ANY($1::uuid[])`, [all]);
  return all.length;
}
