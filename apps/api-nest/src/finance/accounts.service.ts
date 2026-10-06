import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition, canCrossBranch, RolePermissions } from '../auth/permissions';
import { likeContains } from '../catalog/discovery.service';
import { money, quantize, ZERO } from '../checkout/pricing';
import { type AuditContext, recordAudit } from '../common/audit';
import { parseWindow } from '../common/dates';
import { localIso } from '../common/datetime';
import { dateTimeField } from '../common/datetime-field';
import { Dec } from '../common/decimal';
import {
  booleanField,
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  InvalidFields,
  pkRelatedField,
  runSerializer,
  withDefault,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  booleanFilter,
  charFilter,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
  searchTerms,
} from '../common/filtering';
import { lookupDateTime } from '../common/model-lookups';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { dataGet, pyTruthy } from '../http/request-body';
import { CashBookService } from './cash-book.service';

/**
 * `finance.api.views`: accounts and the cash book. An account's balance is a
 * cache over its ledger -- it changes only by a movement appended under the
 * account's row lock (`CashBookService`) -- so nothing here writes it, and
 * there is no delete: an account with movements is history, closed with
 * `is_active=false`.
 */

const A = '"finance_account"';
const KINDS = ['CASH', 'BANK', 'MFS', 'OTHER'] as const;
const KIND_LABELS: Record<string, string> = {
  CASH: 'Cash drawer',
  BANK: 'Bank account',
  MFS: 'Mobile financial service',
  OTHER: 'Other',
};
const TYPES = [
  'OPENING',
  'SALE_PAYMENT',
  'REFUND',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'DEPOSIT',
  'WITHDRAWAL',
  'ADJUSTMENT',
] as const;
const TYPE_LABELS: Record<string, string> = {
  OPENING: 'Opening balance',
  SALE_PAYMENT: 'Payment received from a customer',
  REFUND: 'Refund paid to a customer',
  SUPPLIER_PAYMENT: 'Payment made to a supplier',
  EXPENSE: 'Expense paid',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
  DEPOSIT: 'Manual deposit',
  WITHDRAWAL: 'Manual withdrawal',
  ADJUSTMENT: 'Correction',
};

const ACCOUNT_SELECT = `${A}."id", ${A}."created_at", ${A}."updated_at", ${A}."branch_id",
  ${A}."name", ${A}."kind", ${A}."account_number", ${A}."bank_name", ${A}."balance",
  ${A}."is_active", ${A}."is_default", ${A}."allow_overdraft", ${A}."notes",
  "accounts_branch"."code" AS "branch_code", "accounts_branch"."name" AS "branch_name"`;
const ACCOUNT_FROM = `FROM ${A} INNER JOIN "accounts_branch" ON (${A}."branch_id" = "accounts_branch"."id")`;
const ACCOUNT_ORDER = [`"accounts_branch"."name" ASC`, `${A}."kind" ASC`, `${A}."name" ASC`];
const ACCOUNT_FILTERS: readonly FilterField[] = [
  modelFilter('branch', `${A}."branch_id"`, 'accounts_branch'),
  choiceFilter('kind', `${A}."kind"`, KINDS),
  booleanFilter('is_active', `${A}."is_active"`),
];
const ACCOUNT_ORDERING = {
  name: `${A}."name"`,
  balance: `${A}."balance"`,
  created_at: `${A}."created_at"`,
};

const T = '"finance_accounttransaction"';
const ENTRY_SELECT = `${T}."id", ${T}."created_at", ${T}."account_id", ${T}."transaction_type",
  ${T}."amount", ${T}."balance_after", ${T}."reference_type", ${T}."reference_id", ${T}."reason",
  ${T}."notes", ${T}."occurred_at", ${A}."name" AS "account_name", ${A}."kind" AS "account_kind",
  "accounts_branch"."code" AS "branch_code", "accounts_user"."email" AS "created_by_email"`;
const ENTRY_FROM = `FROM ${T}
  INNER JOIN ${A} ON (${T}."account_id" = ${A}."id")
  INNER JOIN "accounts_branch" ON (${A}."branch_id" = "accounts_branch"."id")
  LEFT OUTER JOIN "accounts_user" ON (${T}."created_by_id" = "accounts_user"."id")`;
const ENTRY_ORDER = [`${T}."occurred_at" DESC`, `${T}."created_at" DESC`];
const ENTRY_FILTERS: readonly FilterField[] = [
  modelFilter('account', `${T}."account_id"`, 'finance_account'),
  choiceFilter('transaction_type', `${T}."transaction_type"`, TYPES),
  charFilter('reference_type', `${T}."reference_type"`),
];
const ENTRY_ORDERING = { occurred_at: `${T}."occurred_at"`, amount: `${T}."amount"` };

const X = '"finance_accounttransfer"';
const TRANSFER_SELECT = `${X}."id", ${X}."created_at", ${X}."number", ${X}."source_account_id",
  ${X}."target_account_id", ${X}."amount", ${X}."occurred_at", ${X}."notes",
  source."name" AS "source_account_name", target."name" AS "target_account_name",
  "accounts_user"."email" AS "created_by_email"`;
const TRANSFER_FROM = `FROM ${X}
  INNER JOIN ${A} source ON (${X}."source_account_id" = source."id")
  INNER JOIN ${A} target ON (${X}."target_account_id" = target."id")
  LEFT OUTER JOIN "accounts_user" ON (${X}."created_by_id" = "accounts_user"."id")`;
const TRANSFER_ORDERING = { occurred_at: `${X}."occurred_at"`, amount: `${X}."amount"` };

export interface AccountRow {
  id: string;
  created_at: string;
  updated_at: string;
  branch_id: string;
  name: string;
  kind: string;
  account_number: string;
  bank_name: string;
  balance: string;
  is_active: boolean;
  is_default: boolean;
  allow_overdraft: boolean;
  notes: string;
  branch_code: string;
  branch_name: string;
}

interface EntryRow {
  id: string;
  created_at: string;
  account_id: string;
  transaction_type: string;
  amount: string;
  balance_after: string;
  reference_type: string;
  reference_id: string;
  reason: string;
  notes: string;
  occurred_at: string;
  account_name: string;
  account_kind: string;
  branch_code: string;
  created_by_email: string | null;
}

interface TransferRow {
  id: string;
  created_at: string;
  number: string;
  source_account_id: string;
  target_account_id: string;
  amount: string;
  occurred_at: string;
  notes: string;
  source_account_name: string;
  target_account_name: string;
  created_by_email: string | null;
}

type AccountData = Partial<{
  branch: string;
  name: string;
  kind: string;
  account_number: string;
  bank_name: string;
  is_active: boolean;
  is_default: boolean;
  allow_overdraft: boolean;
  notes: string;
  opening_balance: string;
}>;

@Injectable()
export class AccountsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly cashBook: CashBookService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  // --- Accounts ------------------------------------------------------------------------------

  /** `AccountSerializer(account).data`. */
  serialise(row: AccountRow) {
    return {
      id: row.id,
      branch: row.branch_id,
      branch_code: row.branch_code,
      branch_name: row.branch_name,
      name: row.name,
      kind: row.kind,
      kind_display: KIND_LABELS[row.kind] ?? row.kind,
      account_number: row.account_number,
      bank_name: row.bank_name,
      balance: row.balance,
      is_active: row.is_active,
      is_default: row.is_default,
      allow_overdraft: row.allow_overdraft,
      notes: row.notes,
      created_at: this.iso(row.created_at),
      updated_at: this.iso(row.updated_at),
    };
  }

  /** `filter_queryset(get_queryset())`: the user's branch, the filters, the search. */
  private async accountConditions(
    user: RequestUser,
    query: QueryDict,
    sql: SqlParams,
  ): Promise<string[]> {
    const where: string[] = [];
    const scope = branchCondition(user, [`${A}."branch_id"`], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    await applyFilters(this.db, query, ACCOUNT_FILTERS, sql, where);
    for (const term of searchTerms(query)) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER(${A}."name"::text) LIKE UPPER(${like})
          OR UPPER(${A}."account_number"::text) LIKE UPPER(${like})
          OR UPPER(${A}."bank_name"::text) LIKE UPPER(${like}))`,
      );
    }
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.accountConditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ACCOUNT_ORDERING) ?? ACCOUNT_ORDER;
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${ACCOUNT_FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_SELECT} ${ACCOUNT_FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.serialise(row)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the filtered queryset, then the primary key. */
  async find(user: RequestUser, pk: string, query: QueryDict): Promise<AccountRow> {
    const sql = new SqlParams();
    const where = await this.accountConditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${A}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<AccountRow>(
      `SELECT ${ACCOUNT_SELECT} ${ACCOUNT_FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  private async byId(id: string, q: Queryable = this.db): Promise<AccountRow> {
    return (await q.one<AccountRow>(
      `SELECT ${ACCOUNT_SELECT} ${ACCOUNT_FROM} WHERE ${A}."id" = $1 LIMIT 21`,
      [id],
    )) as AccountRow;
  }

  /**
   * `AccountSerializer(instance, data, partial)`: the model's fields, then the
   * one stated validator -- a branch has one account of a name.
   */
  private async validate(
    data: unknown,
    instance: AccountRow | null,
    partial: boolean,
  ): Promise<AccountData> {
    const fields: Fields = {
      branch: pkRelatedField(
        async (id) =>
          (await this.db.one(`SELECT 1 AS "a" FROM "accounts_branch" WHERE "id" = $1 LIMIT 1`, [
            id,
          ])) !== null,
      ),
      name: charField({ maxLength: 120 }),
      kind: choiceField(KINDS, { required: false }),
      account_number: charField({ maxLength: 64, required: false, allowBlank: true }),
      bank_name: charField({ maxLength: 120, required: false, allowBlank: true }),
      is_active: booleanField({ required: false }),
      is_default: booleanField({ required: false }),
      allow_overdraft: booleanField({ required: false }),
      notes: charField({ required: false, allowBlank: true }),
      opening_balance: decimalField(14, 2, { required: false }),
    };
    const validated = await runSerializer<AccountData>(fields, data, {
      partial,
      validate: async (attrs) => {
        // `UniqueTogetherValidator(fields=["branch", "name"])`: what is not
        // sent is read from the row being edited.
        const branch = attrs.branch ?? instance?.branch_id;
        const name = attrs.name ?? instance?.name;
        if (instance && attrs.branch === undefined && attrs.name === undefined) return attrs;
        if (branch === undefined || name === undefined) return attrs;
        const taken = await this.db.one(
          `SELECT 1 AS "a" FROM ${A}
            WHERE (${A}."branch_id" = $1 AND ${A}."name" = $2${instance ? ` AND NOT (${A}."id" = $3)` : ''})
            LIMIT 1`,
          instance ? [branch, name, instance.id] : [branch, name],
        );
        if (taken) {
          throw new InvalidFields({
            non_field_errors: [
              { message: 'This branch already has an account with that name.', code: 'unique' },
            ],
          });
        }
        return attrs;
      },
    });
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    return validated.values;
  }

  /**
   * `create` and `create_account`: the account opened with a balance of
   * nothing, and its opening balance posted as an OPENING movement, so the
   * balance is the sum of the ledger from the first row. A new default takes
   * the place of the branch's old one for the kind, in the same transaction.
   */
  async create(user: RequestUser, data: unknown, context: AuditContext) {
    const values = await this.validate(data, null, false);
    const branch = await this.permissions.resolveBranch(user, values.branch);
    const actor = { id: user.id, email: user.email };
    const name = pyStrip(values.name ?? '');
    if (!name) throw new ValidationError('An account needs a name.');
    const kind = values.kind ?? 'CASH';
    const opening = quantize(values.opening_balance ?? ZERO);
    if (opening.lt(ZERO) && !values.allow_overdraft) {
      throw new ValidationError(
        'An opening balance cannot be negative unless overdraft is allowed.',
      );
    }
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      if (values.is_default) {
        await tx.query(
          `UPDATE ${A} SET "is_default" = false
            WHERE (${A}."branch_id" = $1 AND ${A}."is_default" AND ${A}."kind" = $2)`,
          [branch.id, kind],
        );
      }
      await tx.query(
        `INSERT INTO ${A}
           ("id", "created_at", "updated_at", "branch_id", "name", "kind", "account_number",
            "bank_name", "balance", "is_active", "is_default", "allow_overdraft", "notes",
            "created_by_id")
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4, $5, $6, 0.00,
                 true, $7, $8, $9, $10::uuid)`,
        [
          id,
          branch.id,
          name,
          kind,
          values.account_number ?? '',
          values.bank_name ?? '',
          values.is_default ?? false,
          values.allow_overdraft ?? false,
          values.notes ?? '',
          actor.id,
        ],
      );
      if (!opening.isZero()) {
        await this.cashBook.move(
          tx,
          {
            accountId: id,
            type: 'OPENING',
            amount: opening,
            actor,
            referenceType: 'account',
            referenceId: id,
            reason: 'Opening balance',
          },
          context,
        );
      }
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'Account', id, label: `${name} (${KIND_LABELS[kind] ?? kind})` },
        actor,
        newValues: { name, kind, opening_balance: money(opening) },
        reason: 'Account opened',
        branchId: branch.id,
      });
    });
    return this.serialise(await this.byId(id));
  }

  /**
   * `update` and `update_account`: an account's descriptive fields, never
   * its balance, branch or opening balance. A PUT is read as a PATCH is.
   */
  async update(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const account = await this.find(user, pk, query);
    const values = await this.validate(data(), account, true);
    const fields = Object.entries(values).filter(
      ([key]) => key !== 'branch' && key !== 'opening_balance',
    ) as [keyof AccountRow, string | boolean][];
    const actor = { id: user.id, email: user.email };
    await this.db.transaction(async (tx) => {
      const changes = new Map(fields);
      if (changes.get('is_default')) {
        await tx.query(
          `UPDATE ${A} SET "is_default" = false
            WHERE (${A}."branch_id" = $1 AND ${A}."is_default" AND ${A}."kind" = $2
                   AND NOT (${A}."id" = $3))`,
          [account.branch_id, changes.get('kind') ?? account.kind, account.id],
        );
      }
      const sql = new SqlParams();
      const id = sql.add(account.id, 'uuid');
      const sets = fields.map(([key, value]) => `"${key}" = ${sql.add(value)}`);
      await tx.query(
        `UPDATE ${A} SET ${[...sets, '"updated_at" = clock_timestamp()'].join(', ')}
          WHERE ${A}."id" = ${id}`,
        sql.values,
      );
      // `audit.diff`: only what changed.
      const changed = fields.filter(([key, value]) => account[key] !== value);
      if (changed.length) {
        await recordAudit(tx, context, {
          action: 'SETTINGS_CHANGED',
          entity: {
            type: 'Account',
            id: account.id,
            label: `${changes.get('name') ?? account.name} (${
              KIND_LABELS[(changes.get('kind') as string | undefined) ?? account.kind]
            })`,
          },
          actor,
          oldValues: Object.fromEntries(changed.map(([key]) => [key, account[key]])),
          newValues: Object.fromEntries(changed),
          branchId: account.branch_id,
        });
      }
    });
    return this.serialise(await this.byId(account.id));
  }

  // --- The cash book -------------------------------------------------------------------------

  /** `AccountTransactionSerializer(entry).data`. */
  private entry(row: EntryRow) {
    return {
      id: row.id,
      account: row.account_id,
      account_name: row.account_name,
      account_kind: row.account_kind,
      branch_code: row.branch_code,
      transaction_type: row.transaction_type,
      type_display: TYPE_LABELS[row.transaction_type] ?? row.transaction_type,
      amount: row.amount,
      balance_after: row.balance_after,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
      reason: row.reason,
      notes: row.notes,
      occurred_at: this.iso(row.occurred_at),
      created_by_email: row.created_by_email ?? '',
      created_at: this.iso(row.created_at),
    };
  }

  private async entryPage(
    where: string[],
    sql: SqlParams,
    order: string[],
    query: QueryDict,
    absoluteUrl: string,
  ) {
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${ENTRY_FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<EntryRow>(
      `SELECT ${ENTRY_SELECT} ${ENTRY_FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.entry(row)),
      absoluteUrl,
    );
  }

  /**
   * `transactions`: one account's cash book, newest first. `date_from` and
   * `date_to` go to the lookup as sent, read as a model `DateTimeField`
   * reads them: a bare date is its midnight, at either end.
   */
  async transactions(user: RequestUser, pk: string, query: QueryDict, absoluteUrl: string) {
    const account = await this.find(user, pk, query);
    const sql = new SqlParams();
    const where = [`${T}."account_id" = ${sql.add(account.id, 'uuid')}`];
    const tz = this.env.DJANGO_TIME_ZONE;
    const from = query.get('date_from');
    if (from)
      where.push(`${T}."occurred_at" >= ${sql.add(lookupDateTime(from, tz), 'timestamptz')}`);
    const to = query.get('date_to');
    if (to) where.push(`${T}."occurred_at" <= ${sql.add(lookupDateTime(to, tz), 'timestamptz')}`);
    const type = query.get('transaction_type');
    if (type) where.push(`${T}."transaction_type" = ${sql.add(type)}`);
    return this.entryPage(where, sql, ENTRY_ORDER, query, absoluteUrl);
  }

  /** `AccountTransactionViewSet.get_queryset` and its filters. */
  private async entryConditions(
    user: RequestUser,
    query: QueryDict,
    sql: SqlParams,
  ): Promise<string[]> {
    const where: string[] = [];
    const scope = branchCondition(user, [`${A}."branch_id"`], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    const tz = this.env.DJANGO_TIME_ZONE;
    const from = query.get('date_from');
    if (from)
      where.push(`${T}."occurred_at" >= ${sql.add(lookupDateTime(from, tz), 'timestamptz')}`);
    const to = query.get('date_to');
    if (to) where.push(`${T}."occurred_at" <= ${sql.add(lookupDateTime(to, tz), 'timestamptz')}`);
    await applyFilters(this.db, query, ENTRY_FILTERS, sql, where);
    return where;
  }

  /** `GET /account-transactions/`: the whole cash book the user may see. */
  async ledger(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.entryConditions(user, query, sql);
    return this.entryPage(
      where,
      sql,
      orderingFrom(query, ENTRY_ORDERING) ?? ENTRY_ORDER,
      query,
      absoluteUrl,
    );
  }

  async ledgerEntry(user: RequestUser, pk: string, query: QueryDict) {
    const sql = new SqlParams();
    const where = await this.entryConditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${T}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<EntryRow>(
      `SELECT ${ENTRY_SELECT} ${ENTRY_FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return this.entry(row);
  }

  private async entryById(id: string) {
    return this.entry(
      (await this.db.one<EntryRow>(
        `SELECT ${ENTRY_SELECT} ${ENTRY_FROM} WHERE ${T}."id" = $1 LIMIT 21`,
        [id],
      )) as EntryRow,
    );
  }

  /**
   * `cash_position`: what the business holds now in its open accounts, by
   * kind and by account, and the money in and out over a window -- transfers
   * and opening balances left out of both sides.
   */
  async cashPosition(user: RequestUser, query: QueryDict) {
    let branchId: string | null = null;
    const asked = query.get('branch');
    if (asked) branchId = (await this.permissions.resolveBranch(user, asked)).id;
    else if (!canCrossBranch(user) && user.branchId) branchId = user.branchId;

    const [from, to] = parseWindow(query, this.env.DJANGO_TIME_ZONE);
    const scope = branchId ? `AND ${A}."branch_id" = $1` : '';
    const values = branchId ? [branchId] : [];
    const total = await this.db.one<{ total: string | null }>(
      `SELECT SUM(${A}."balance") AS "total" FROM ${A} WHERE (${A}."is_active" ${scope})`,
      values,
    );
    const byKind = await this.db.query<{ kind: string; total: string | null }>(
      `SELECT ${A}."kind", SUM(${A}."balance") AS "total" FROM ${A}
        WHERE (${A}."is_active" ${scope}) GROUP BY ${A}."kind" ORDER BY ${A}."kind" ASC`,
      values,
    );
    const accounts = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_SELECT} ${ACCOUNT_FROM} WHERE (${A}."is_active" ${scope})
        ORDER BY ${ACCOUNT_ORDER.join(', ')}`,
      values,
    );

    const sql = new SqlParams();
    const where = [`NOT (${T}."transaction_type" IN ('TRANSFER_IN', 'TRANSFER_OUT', 'OPENING'))`];
    if (branchId) where.push(`${A}."branch_id" = ${sql.add(branchId, 'uuid')}`);
    if (from) where.push(`${T}."occurred_at" >= ${sql.add(from, 'timestamptz')}`);
    if (to) where.push(`${T}."occurred_at" <= ${sql.add(to, 'timestamptz')}`);
    const moved = await this.db.one<{ money_in: string | null; money_out: string | null }>(
      `SELECT SUM(${T}."amount") FILTER (WHERE ${T}."amount" > 0) AS "money_in",
              SUM(${T}."amount") FILTER (WHERE ${T}."amount" < 0) AS "money_out"
         FROM ${T} INNER JOIN ${A} ON (${T}."account_id" = ${A}."id")
        WHERE ${where.join(' AND ')}`,
      sql.values,
    );
    const moneyIn = quantize(moved?.money_in ?? ZERO);
    const moneyOut = quantize(new Dec(moved?.money_out ?? ZERO).abs());
    return {
      total: money(quantize(total?.total ?? ZERO)),
      by_kind: byKind.map((row) => ({ kind: row.kind, total: money(quantize(row.total ?? ZERO)) })),
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        kind: account.kind,
        branch: account.branch_code,
        balance: money(quantize(account.balance)),
      })),
      movements: {
        money_in: money(moneyIn),
        money_out: money(moneyOut),
        net: money(quantize(moneyIn.minus(moneyOut))),
      },
    };
  }

  /**
   * `record_movement`: a manual deposit, withdrawal or correction, at a
   * branch the user may act on, once per `Idempotency-Key`.
   */
  async recordMovement(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const tz = this.env.DJANGO_TIME_ZONE;
    const validated = await runSerializer<{
      account: string;
      transaction_type: string;
      amount: string;
      reason: string;
      notes: string;
      occurred_at?: { pg: string } | null;
    }>(
      {
        account: this.anyAccount(),
        transaction_type: choiceField(['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT']),
        amount: decimalField(14, 2),
        reason: withDefault(charField({ allowBlank: true, required: false }), () => ''),
        notes: withDefault(charField({ allowBlank: true, required: false }), () => ''),
        occurred_at: dateTimeField(tz, { required: false, allowNull: true }),
      },
      data,
      {
        validate: (attrs) => {
          const amount = new Dec(attrs.amount);
          if (attrs.transaction_type === 'ADJUSTMENT') {
            if (amount.isZero()) {
              throw new InvalidFields({
                amount: [{ message: 'An adjustment of zero changes nothing.', code: 'invalid' }],
              });
            }
          } else if (amount.lte(0)) {
            throw new InvalidFields({
              amount: [{ message: 'The amount must be positive.', code: 'invalid' }],
            });
          }
          return attrs;
        },
      },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    const account = (await this.db.one<{ branch_id: string }>(
      `SELECT "branch_id" FROM ${A} WHERE "id" = $1`,
      [asked.account],
    )) as { branch_id: string };
    // A cashier at one branch must not move money in another branch's drawer.
    await this.permissions.resolveBranch(user, account.branch_id);
    const id = await this.db.transaction((tx) =>
      this.cashBook.move(
        tx,
        {
          accountId: asked.account,
          type: asked.transaction_type,
          amount: asked.amount,
          actor: { id: user.id, email: user.email },
          reason: asked.reason,
          notes: asked.notes,
          occurredAt: asked.occurred_at?.pg ?? null,
          idempotencyKey,
        },
        context,
      ),
    );
    return this.entryById(id);
  }

  /** `PrimaryKeyRelatedField(queryset=Account.objects.all())`. */
  private anyAccount() {
    return pkRelatedField(
      async (id) =>
        (await this.db.one(`SELECT 1 AS "a" FROM ${A} WHERE "id" = $1 LIMIT 1`, [id])) !== null,
    );
  }

  /**
   * `verify_integrity`: every account's cached balance beside the sum of its
   * ledger, and the ones that differ. The branch is the body's, read with
   * `request.data.get`.
   */
  async verifyIntegrity(user: RequestUser, data: unknown) {
    const asked = dataGet(data, 'branch');
    const branchId = pyTruthy(asked)
      ? (await this.permissions.resolveBranch(user, asked)).id
      : null;
    const rows = await this.db.query<{
      id: string;
      name: string;
      branch_code: string;
      balance: string;
      ledger: string | null;
    }>(
      `SELECT ${A}."id", ${A}."name", "accounts_branch"."code" AS "branch_code", ${A}."balance",
              (SELECT SUM(t."amount") FROM ${T} t WHERE t."account_id" = ${A}."id") AS "ledger"
         ${ACCOUNT_FROM} ${branchId ? `WHERE ${A}."branch_id" = $1` : ''}
        ORDER BY ${ACCOUNT_ORDER.join(', ')}`,
      branchId ? [branchId] : [],
    );
    const issues = rows
      .map((row) => ({
        cached: quantize(row.balance),
        ledger: quantize(row.ledger ?? ZERO),
        row,
      }))
      .filter((issue) => !issue.cached.eq(issue.ledger));
    return {
      clean: issues.length === 0,
      issue_count: issues.length,
      issues: issues.map(({ row, cached, ledger }) => ({
        account_id: row.id,
        account: row.name,
        branch: row.branch_code,
        cached_balance: money(cached),
        ledger_balance: money(ledger),
        drift: money(quantize(cached.minus(ledger))),
      })),
    };
  }

  // --- Transfers -----------------------------------------------------------------------------

  /** `AccountTransferSerializer(record).data`. */
  private transferPayload(row: TransferRow) {
    return {
      id: row.id,
      number: row.number,
      source_account: row.source_account_id,
      source_account_name: row.source_account_name,
      target_account: row.target_account_id,
      target_account_name: row.target_account_name,
      amount: row.amount,
      occurred_at: this.iso(row.occurred_at),
      notes: row.notes,
      created_by_email: row.created_by_email ?? '',
      created_at: this.iso(row.created_at),
    };
  }

  /** `AccountTransferViewSet.get_queryset`: transfers out of the user's branch. */
  private transferScope(user: RequestUser, sql: SqlParams): string[] {
    const scope = branchCondition(user, ['source."branch_id"'], sql.values.length + 1);
    if (!scope) return [];
    for (const value of scope.values) sql.add(value, 'uuid');
    return [scope.sql];
  }

  async transfers(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = this.transferScope(user, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, TRANSFER_ORDERING) ?? [`${X}."occurred_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${TRANSFER_FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<TransferRow>(
      `SELECT ${TRANSFER_SELECT} ${TRANSFER_FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.transferPayload(row)),
      absoluteUrl,
    );
  }

  async transferById(user: RequestUser | null, pk: string) {
    const sql = new SqlParams();
    const where = user ? this.transferScope(user, sql) : [];
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${X}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<TransferRow>(
      `SELECT ${TRANSFER_SELECT} ${TRANSFER_FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return this.transferPayload(row);
  }

  /** `create`: `CreateTransferSerializer`, both ends at branches the user may act on, `transfer`. */
  async createTransfer(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const tz = this.env.DJANGO_TIME_ZONE;
    const validated = await runSerializer<{
      source_account: string;
      target_account: string;
      amount: string;
      notes: string;
      occurred_at?: { pg: string } | null;
    }>(
      {
        source_account: this.anyAccount(),
        target_account: this.anyAccount(),
        amount: decimalField(14, 2),
        notes: withDefault(charField({ allowBlank: true, required: false }), () => ''),
        occurred_at: dateTimeField(tz, { required: false, allowNull: true }),
      },
      data,
      {
        validate: (attrs) => {
          if (attrs.source_account === attrs.target_account) {
            throw new InvalidFields({
              target_account: [
                { message: 'Source and destination accounts must differ.', code: 'invalid' },
              ],
            });
          }
          if (new Dec(attrs.amount).lte(0)) {
            throw new InvalidFields({
              amount: [{ message: 'The amount must be positive.', code: 'invalid' }],
            });
          }
          return attrs;
        },
      },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    for (const accountId of [asked.source_account, asked.target_account]) {
      const account = (await this.db.one<{ branch_id: string }>(
        `SELECT "branch_id" FROM ${A} WHERE "id" = $1`,
        [accountId],
      )) as { branch_id: string };
      await this.permissions.resolveBranch(user, account.branch_id);
    }
    const id = await this.db.transaction((tx) =>
      this.cashBook.transfer(tx, context, {
        sourceId: asked.source_account,
        targetId: asked.target_account,
        amount: asked.amount,
        actor: { id: user.id, email: user.email },
        notes: asked.notes,
        occurredAt: asked.occurred_at?.pg ?? null,
        idempotencyKey,
      }),
    );
    return this.transferById(null, id);
  }
}
