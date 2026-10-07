import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { localIso } from '../common/datetime';
import { invalidUuid, NotFound } from '../common/errors';
import { orderingFrom } from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyStr } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid, uuidFromValue } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';
import { dataGet, isDict, parsePythonJson, pythonTypeName, pyTruthy } from '../http/request-body';

/**
 * `notifications.api.views.NotificationViewSet` and
 * `notifications.services.mark_read`: the notices addressed to whoever is
 * signed in -- staff and customers alike -- and marking them read. The rows
 * are written by `notify_staff` and `notify_customer`
 * (checkout/notices.service.ts).
 */

const N = '"notifications_notification"';
/** The model's columns, in its fields' order: the statement is Django's. */
const COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'user_id',
  'permission_code',
  'branch_id',
  'notification_type',
  'level',
  'title',
  'body',
  'link',
  'data',
  'read_at',
  'emailed_at',
] as const;
const SELECT = columns(N, COLUMNS);

/**
 * The view names no `ordering_fields`, so `OrderingFilter` takes the
 * serializer's fields that are columns: `is_read` is a property of the
 * model, and asking for it is ignored.
 */
const ORDERING = Object.fromEntries(
  [
    'id',
    'notification_type',
    'level',
    'title',
    'body',
    'link',
    'data',
    'read_at',
    'created_at',
  ].map((name) => [name, `${N}."${name}"`]),
);

type NoticeRow = Record<(typeof COLUMNS)[number], string | null>;

function noticeRow(values: unknown[]): NoticeRow {
  return Object.fromEntries(COLUMNS.map((name, index) => [name, values[index]])) as NoticeRow;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `NotificationSerializer(notice).data`. */
  private notice(row: NoticeRow) {
    return {
      id: row.id,
      notification_type: row.notification_type,
      level: row.level,
      title: row.title,
      body: row.body,
      link: row.link,
      // As jsonb prints it, read as Python's `json.loads` reads it.
      data: parsePythonJson(row.data as string),
      is_read: row.read_at !== null,
      read_at: localIso(row.read_at, this.env.DJANGO_TIME_ZONE),
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
    };
  }

  /** `get_queryset`: the reader's own notices, and only the unread for `unread=true`. */
  private conditions(user: RequestUser, query: QueryDict, sql: SqlParams): string[] {
    const where = [`${N}."user_id" = ${sql.add(user.id, 'uuid')}`];
    if (query.get('unread') === 'true') where.push(`${N}."read_at" IS NULL`);
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = this.conditions(user, query, sql).join(' AND ');
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${N} WHERE ${where}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const order = orderingFrom(query, ORDERING) ?? [`${N}."created_at" DESC`];
    const rows = await this.db.arrays(
      `SELECT ${SELECT} FROM ${N} WHERE ${where} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
      { jsonAsText: true },
    );
    return paginated(
      page,
      rows.map((row) => this.notice(noticeRow(row))),
      absoluteUrl,
    );
  }

  /** `get_object()`: the same queryset, then the key. */
  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    const sql = new SqlParams();
    const where = this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${N}."id" = ${sql.add(id, 'uuid')}`);
    const [row] = await this.db.arrays(
      `SELECT ${SELECT} FROM ${N} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
      { jsonAsText: true },
    );
    if (!row) throw new NotFound();
    return this.notice(noticeRow(row));
  }

  /** `count`: how many of the reader's notices are unread. */
  async unread(user: RequestUser) {
    const row = await this.db.one<{ count: string }>(
      `SELECT COUNT(*) AS "count" FROM ${N}
        WHERE (${N}."read_at" IS NULL AND ${N}."user_id" = $1::uuid)`,
      [user.id],
    );
    return { unread: Number(row?.count ?? 0) };
  }

  /**
   * `mark_read(user=..., notification_ids=request.data.get("ids"))`: every
   * unread notice of the reader's, or those of them the body names, in one
   * `UPDATE` -- so two requests for the same notices never both count one.
   *
   * `ids` is whatever the body holds, handed to `pk__in` as it is: anything
   * falsy means all; a list is read item by item as a key (a null among them
   * names nothing); a string is its characters and an object its keys; and a
   * number cannot be iterated, which is Django's `TypeError` and a 500.
   */
  async markRead(user: RequestUser, data: unknown) {
    const given = dataGet(data, 'ids');
    const sql = new SqlParams();
    const where = [`${N}."read_at" IS NULL`, `${N}."user_id" = ${sql.add(user.id, 'uuid')}`];
    if (pyTruthy(given)) {
      const ids = keysIn(given);
      // Nothing left to look for: Django's `EmptyResultSet`, and no statement.
      if (!ids.length) return { updated: 0 };
      where.push(`${N}."id" IN ${sql.list(ids, 'uuid')}`);
    }
    // One moment for every row, as `timezone.now()` is taken once.
    const rows = await this.db.query(
      `UPDATE ${N} SET "read_at" = statement_timestamp() WHERE (${where.join(' AND ')})
        RETURNING 1 AS "a"`,
      sql.values,
    );
    return { updated: rows.length };
  }
}

/** The values `pk__in=given` looks for: each read as `UUIDField.get_prep_value` reads it. */
function keysIn(given: unknown): string[] {
  let items: unknown[];
  if (typeof given === 'string') items = Array.from(given);
  else if (Array.isArray(given)) items = given;
  else if (isDict(given)) items = Object.keys(given);
  else throw new TypeError(`'${pythonTypeName(given)}' object is not iterable`);
  const ids: string[] = [];
  for (const item of items) {
    const lookup = uuidFromValue(item);
    if ('invalid' in lookup) throw invalidUuid(pyStr(item));
    if (lookup.id !== null && !ids.includes(lookup.id)) ids.push(lookup.id);
  }
  return ids;
}
