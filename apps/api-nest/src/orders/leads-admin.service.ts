import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition } from '../auth/permissions';
import { localIso } from '../common/datetime';
import { charField, errorMessages, type Fields, runSerializer } from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyStr, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { dataGet } from '../http/request-body';

/**
 * `AbandonedCheckoutViewSet`: the call-back list -- shoppers who typed a
 * number at checkout and did not finish. Read, annotated and written off;
 * never created here, and never deleted, since the list is judged by how
 * many leads became orders.
 */

const L = '"orders_abandonedcheckout"';
const SELECT = `${L}."id", ${L}."created_at", ${L}."phone", ${L}."name", ${L}."email",
  ${L}."branch_id", ${L}."cart_id", ${L}."customer_id", ${L}."status", ${L}."cart_total",
  ${L}."item_count", ${L}."last_seen_at", ${L}."recovered_at", ${L}."recovered_order_id",
  ${L}."note", "accounts_branch"."code" AS "branch_code",
  "orders_order"."number" AS "recovered_order_number"`;
const FROM = `FROM ${L}
  INNER JOIN "accounts_branch" ON (${L}."branch_id" = "accounts_branch"."id")
  LEFT OUTER JOIN "customers_customer" ON (${L}."customer_id" = "customers_customer"."id")
  LEFT OUTER JOIN "orders_order" ON (${L}."recovered_order_id" = "orders_order"."id")`;
const FILTERS: readonly FilterField[] = [
  choiceFilter('status', `${L}."status"`, ['OPEN', 'RECOVERED', 'LOST']),
  modelFilter('branch', `${L}."branch_id"`, 'accounts_branch'),
];
/** The view names no `ordering_fields`: every serializer field, by its source. */
const ORDERING = {
  id: `${L}."id"`,
  phone: `${L}."phone"`,
  name: `${L}."name"`,
  email: `${L}."email"`,
  status: `${L}."status"`,
  cart_total: `${L}."cart_total"`,
  item_count: `${L}."item_count"`,
  branch__code: `"accounts_branch"."code"`,
  last_seen_at: `${L}."last_seen_at"`,
  recovered_at: `${L}."recovered_at"`,
  recovered_order__number: `"orders_order"."number"`,
  note: `${L}."note"`,
  created_at: `${L}."created_at"`,
};

interface LeadRow {
  id: string;
  created_at: string;
  phone: string;
  name: string;
  email: string;
  branch_id: string;
  cart_id: string | null;
  customer_id: string | null;
  status: string;
  cart_total: string;
  item_count: number;
  last_seen_at: string;
  recovered_at: string | null;
  recovered_order_id: string | null;
  note: string;
  branch_code: string;
  recovered_order_number: string | null;
}

@Injectable()
export class LeadsAdminService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `AbandonedCheckoutSerializer(lead).data`. On a partial update DRF leaves
   * out a read-only field with a default whose source is missing: a lead
   * with no order then answers without `recovered_order_number`.
   */
  private serialise(row: LeadRow, partial = false) {
    const tz = this.env.DJANGO_TIME_ZONE;
    const out: Record<string, unknown> = {
      id: row.id,
      phone: row.phone,
      name: row.name,
      email: row.email,
      status: row.status,
      cart_total: row.cart_total,
      item_count: row.item_count,
      branch_code: row.branch_code,
      last_seen_at: localIso(row.last_seen_at, tz),
      recovered_at: localIso(row.recovered_at, tz),
      recovered_order_number: row.recovered_order_number ?? '',
      note: row.note,
      created_at: localIso(row.created_at, tz),
    };
    if (partial && row.recovered_order_id === null) delete out.recovered_order_number;
    return out;
  }

  /** `branch_queryset`, then the declared filters. */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    const scope = branchCondition(user, [`${L}."branch_id"`], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${L}."last_seen_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${L} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<LeadRow>(
      `SELECT ${SELECT} ${FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.serialise(row)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the scoped, filtered queryset, then the key. */
  private async find(user: RequestUser, pk: string, query: QueryDict): Promise<LeadRow> {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${L}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<LeadRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    return this.serialise(await this.find(user, pk, query));
  }

  /**
   * `update` and `partial_update`: only the note is writable. The save
   * writes every column back from the lead as read.
   */
  async update(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    partial: boolean,
  ) {
    const lead = await this.find(user, pk, query);
    const validated = await runSerializer<{ note?: string }>(
      { note: charField({ required: false, allowBlank: true }) } as Fields,
      data(),
      { partial },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const note = validated.values.note ?? lead.note;
    await this.db.query(
      `UPDATE ${L} SET "updated_at" = clock_timestamp(), "phone" = $2, "name" = $3, "email" = $4,
         "branch_id" = $5, "cart_id" = $6, "customer_id" = $7, "status" = $8, "cart_total" = $9,
         "item_count" = $10, "last_seen_at" = $11::timestamptz, "recovered_at" = $12::timestamptz,
         "recovered_order_id" = $13, "note" = $14
       WHERE ${L}."id" = $1`,
      [
        lead.id,
        lead.phone,
        lead.name,
        lead.email,
        lead.branch_id,
        lead.cart_id,
        lead.customer_id,
        lead.status,
        lead.cart_total,
        lead.item_count,
        lead.last_seen_at,
        lead.recovered_at,
        lead.recovered_order_id,
        note,
      ],
    );
    return this.serialise({ ...lead, note }, partial);
  }

  /**
   * `lost` and `mark_lost`: a lead written off after it was chased, whatever
   * its status. The note is `str(request.data.get("note", "")).strip()`, and
   * replaces the lead's own only when it says something.
   */
  async lost(user: RequestUser, pk: string, query: QueryDict, data: () => unknown) {
    const lead = await this.find(user, pk, query);
    const given = dataGet(data(), 'note');
    const said = pyStrip(pyStr(given === undefined ? '' : given));
    const note = said || lead.note;
    await this.db.query(
      `UPDATE ${L} SET "updated_at" = clock_timestamp(), "status" = 'LOST', "note" = $2
        WHERE ${L}."id" = $1`,
      [lead.id, note],
    );
    return this.serialise({ ...lead, status: 'LOST', note });
  }
}
