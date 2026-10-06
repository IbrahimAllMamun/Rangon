import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { canCrossBranch } from '../auth/permissions';
import { likeContains } from '../catalog/discovery.service';
import { parseWindow } from '../common/dates';
import { localIso } from '../common/datetime';
import { NotFound } from '../common/errors';
import {
  applyFilters,
  charFilter,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';
import { parsePythonJson } from '../http/request-body';

/**
 * `accounts.api.views.AuditLogViewSet`: who did what, when, to which record.
 * Read-only -- the log is written by `core.audit.record` (common/audit.ts)
 * and never changed.
 *
 * A row that names a branch belongs to that branch's readers and to those
 * who see across branches; a row with none -- the catalogue, settings, staff
 * accounts, sign-ins -- belongs to every reader (D85).
 */

const A = '"core_auditlog"';
const U = '"accounts_user"';
const B = '"accounts_branch"';

/**
 * The statement is Django's, every column of the three tables in its models'
 * order: with `ordering=created_at` two entries of one instant come back as
 * the plan leaves them, and the plan depends on what is selected -- with the
 * accounts' columns it hashes the log against them, without any it drops
 * that join.
 */
const AUDIT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'actor_id',
  'actor_label',
  'action',
  'entity_type',
  'entity_id',
  'entity_label',
  'old_values',
  'new_values',
  'reason',
  'ip_address',
  'user_agent',
  'request_id',
  'branch_id',
] as const;
const USER_COLUMNS = [
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
] as const;
const BRANCH_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'organization_id',
  'name',
  'code',
  'address',
  'phone',
  'email',
  'is_default',
  'fulfils_online_orders',
  'register_count',
  'status',
] as const;
const SELECT = [
  columns(A, AUDIT_COLUMNS),
  columns(U, USER_COLUMNS),
  columns(B, BRANCH_COLUMNS),
].join(', ');
const BRANCH_CODE = AUDIT_COLUMNS.length + USER_COLUMNS.length + BRANCH_COLUMNS.indexOf('code');
const JOIN_ACTOR = `JOIN ${U} ON (${A}."actor_id" = ${U}."id")`;
const JOIN_BRANCH = `LEFT OUTER JOIN ${B} ON (${A}."branch_id" = ${B}."id")`;

/** `AuditAction.choices`. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  CREATE: 'Create',
  UPDATE: 'Update',
  DELETE: 'Delete',
  LOGIN: 'Login',
  LOGIN_FAILED: 'Login failed',
  LOGOUT: 'Logout',
  PERMISSION_ELEVATION: 'Permission elevation',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  STOCK_TRANSFER: 'Stock transfer',
  PURCHASE_RECEIVED: 'Purchase received',
  SALE_CREATED: 'Sale created',
  ORDER_STATUS_CHANGED: 'Order status changed',
  ORDER_CANCELLED: 'Order cancelled',
  PAYMENT_RECORDED: 'Payment recorded',
  EXPENSE_RECORDED: 'Expense recorded',
  EXPENSE_VOIDED: 'Expense voided',
  REFUND_ISSUED: 'Refund issued',
  DISCOUNT_OVERRIDE: 'Discount override',
  PRICE_OVERRIDE: 'Price override',
  SETTINGS_CHANGED: 'Settings changed',
  USER_CHANGED: 'User changed',
  PRODUCT_IMPORT: 'Product import',
};

const FILTERS: readonly FilterField[] = [
  choiceFilter('action', `${A}."action"`, Object.keys(AUDIT_ACTION_LABELS)),
  charFilter('entity_type', `${A}."entity_type"`),
  charFilter('entity_id', `${A}."entity_id"`),
  modelFilter('actor', `${A}."actor_id"`, 'accounts_user'),
  modelFilter('branch', `${A}."branch_id"`, 'accounts_branch'),
];
const ORDERING = { created_at: `${A}."created_at"` };
const ORDER = [`${A}."created_at" DESC`, `${A}."id" DESC`];

type AuditRow = Record<(typeof AUDIT_COLUMNS)[number], string | null> & {
  branch_code: string | null;
};

/** One row of the statement, read by position: three tables share column names. */
function auditRow(values: unknown[]): AuditRow {
  const row = Object.fromEntries(AUDIT_COLUMNS.map((name, index) => [name, values[index]]));
  return { ...row, branch_code: values[BRANCH_CODE] ?? null } as AuditRow;
}

@Injectable()
export class AuditLogService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `AuditLogSerializer(entry).data`. */
  private entry(row: AuditRow) {
    return {
      id: row.id,
      actor: row.actor_id,
      actor_email: row.actor_label,
      action: row.action,
      // `get_action_display()`: an action the choices do not name is shown as it is.
      action_label: AUDIT_ACTION_LABELS[row.action as string] ?? row.action,
      branch: row.branch_id,
      branch_code: row.branch_code,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      entity_label: row.entity_label,
      // As jsonb prints them, read as Python's `json.loads` reads them: a float
      // stays a float and an integer past 2^53 stays exact.
      old_values: parsePythonJson(row.old_values as string),
      new_values: parsePythonJson(row.new_values as string),
      reason: row.reason,
      // As `inet` prints it; a cast to text would add the netmask.
      ip_address: row.ip_address,
      request_id: row.request_id,
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
    };
  }

  /**
   * `get_queryset`, then the filter backend: the reader's branch, the date
   * window (`core.dates`, which refuses what it cannot read on every route),
   * the search over what was touched, why and by whom, and django-filter.
   */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    if (!(user.isSuperuser || canCrossBranch(user)) && user.branchId) {
      where.push(
        `(${A}."branch_id" = ${sql.add(user.branchId, 'uuid')} OR ${A}."branch_id" IS NULL)`,
      );
    }
    const [from, to] = parseWindow(query, this.env.DJANGO_TIME_ZONE);
    if (from) where.push(`${A}."created_at" >= ${sql.add(from, 'timestamptz')}`);
    if (to) where.push(`${A}."created_at" <= ${sql.add(to, 'timestamptz')}`);
    const search = pyStrip(query.get('search') ?? '');
    if (search) {
      const like = sql.add(likeContains(search));
      where.push(
        `(UPPER(${A}."entity_label"::text) LIKE UPPER(${like}) OR UPPER(${A}."reason"::text) LIKE UPPER(${like})
          OR UPPER(${A}."actor_label"::text) LIKE UPPER(${like}))`,
      );
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  /**
   * The joins `select_related("actor", "branch")` sends. A filter on the
   * actor makes its join an inner one, which Django then writes last.
   */
  private from(query: QueryDict): string {
    return query.get('actor')
      ? `FROM ${A} ${JOIN_BRANCH} INNER ${JOIN_ACTOR}`
      : `FROM ${A} LEFT OUTER ${JOIN_ACTOR} ${JOIN_BRANCH}`;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${A} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const order = orderingFrom(query, ORDERING) ?? ORDER;
    const rows = await this.db.arrays(
      `SELECT ${SELECT} ${this.from(query)} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
      { jsonAsText: true },
    );
    return paginated(
      page,
      rows.map((row) => this.entry(auditRow(row))),
      absoluteUrl,
    );
  }

  /** `get_object()`: the filtered queryset, then the key. */
  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${A}."id" = ${sql.add(id, 'uuid')}`);
    const [row] = await this.db.arrays(
      `SELECT ${SELECT} ${this.from(query)} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
      { jsonAsText: true },
    );
    if (!row) throw new NotFound();
    return this.entry(auditRow(row));
  }
}
