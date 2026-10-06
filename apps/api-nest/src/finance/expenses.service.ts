import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition, canCrossBranch, RolePermissions } from '../auth/permissions';
import { likeContains } from '../catalog/discovery.service';
import { money, quantize, ZERO } from '../checkout/pricing';
import { type AuditContext, recordAudit } from '../common/audit';
import { parseWindow } from '../common/dates';
import { localIso, pyIsoformat } from '../common/datetime';
import { type AwareMoment, dateTimeField } from '../common/datetime-field';
import { Dec } from '../common/decimal';
import {
  booleanField,
  charField,
  decimalField,
  errorMessages,
  fileField,
  type Fields,
  Invalid,
  pathSuffix,
  pkRelatedField,
  runSerializer,
  withDefault,
} from '../common/drf';
import { NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  booleanFilter,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
  searchTerms,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pySlice, pySplit, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { nextNumber } from '../common/sequence';
import { MediaStorage } from '../common/storage';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import type { UploadedFile } from '../http/multipart';
import { CashBookService } from './cash-book.service';

/**
 * `ExpenseCategoryViewSet` and `ExpenseViewSet`: money that left the
 * business for something other than stock or a refund. An expense is a
 * document and a movement written together -- the document first, so a retry
 * claims its key before any money leaves -- and it is never edited or
 * deleted: `void` puts the money back with a compensating movement.
 */

const C = '"finance_expensecategory"';
const CATEGORY_SELECT = `${C}."id", ${C}."created_at", ${C}."updated_at", ${C}."name", ${C}."code",
  ${C}."description", ${C}."is_active"`;
const COUNT = `(SELECT COUNT(*) FROM "finance_expense" e
  WHERE e."category_id" = ${C}."id" AND e."status" = 'RECORDED')`;
const CATEGORY_FILTERS: readonly FilterField[] = [booleanFilter('is_active', `${C}."is_active"`)];
const CATEGORY_ORDERING = { name: `${C}."name"`, created_at: `${C}."created_at"` };

const E = '"finance_expense"';
const EXPENSE_SELECT = `${E}."id", ${E}."created_at", ${E}."number", ${E}."branch_id",
  ${E}."category_id", ${E}."account_id", ${E}."amount", ${E}."spent_at", ${E}."note",
  ${E}."attachment", ${E}."status", ${E}."transaction_id", ${E}."reversal_id", ${E}."voided_at",
  ${E}."void_reason", "accounts_branch"."code" AS "branch_code",
  ${C}."name" AS "category_name", ${C}."code" AS "category_code",
  "finance_account"."name" AS "account_name", creator."email" AS "created_by_email",
  voider."email" AS "voided_by_email"`;
const EXPENSE_FROM = `FROM ${E}
  INNER JOIN "accounts_branch" ON (${E}."branch_id" = "accounts_branch"."id")
  INNER JOIN ${C} ON (${E}."category_id" = ${C}."id")
  INNER JOIN "finance_account" ON (${E}."account_id" = "finance_account"."id")
  LEFT OUTER JOIN "accounts_user" creator ON (${E}."created_by_id" = creator."id")
  LEFT OUTER JOIN "accounts_user" voider ON (${E}."voided_by_id" = voider."id")`;
const EXPENSE_FILTERS: readonly FilterField[] = [
  modelFilter('branch', `${E}."branch_id"`, 'accounts_branch'),
  modelFilter('category', `${E}."category_id"`, 'finance_expensecategory'),
  modelFilter('account', `${E}."account_id"`, 'finance_account'),
  choiceFilter('status', `${E}."status"`, ['RECORDED', 'VOID']),
];
const EXPENSE_ORDERING = {
  spent_at: `${E}."spent_at"`,
  amount: `${E}."amount"`,
  created_at: `${E}."created_at"`,
};
const STATUS_LABELS: Record<string, string> = { RECORDED: 'Recorded', VOID: 'Voided' };

/** A receipt is a photo or a scanned bill: `ALLOWED_ATTACHMENT_TYPES` and `_EXTENSIONS`. */
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf'];
const RECEIPT_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.pdf'];
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
/** `mimetypes.guess_type` for the extensions a receipt may have. */
const RECEIPT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

interface CategoryRow {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  code: string;
  description: string;
  is_active: boolean;
  expense_count?: string;
}

interface ExpenseRow {
  id: string;
  created_at: string;
  number: string;
  branch_id: string;
  category_id: string;
  account_id: string;
  amount: string;
  spent_at: string;
  note: string;
  attachment: string;
  status: string;
  transaction_id: string | null;
  reversal_id: string | null;
  voided_at: string | null;
  void_reason: string;
  branch_code: string;
  category_name: string;
  category_code: string;
  account_name: string;
  created_by_email: string | null;
  voided_by_email: string | null;
}

/** `_normalise_code`: a code is cased and spaced one way only. */
export function normaliseCode(code: string): string {
  return pySplit(pyStrip(code).toUpperCase()).join('_');
}

@Injectable()
export class ExpensesService {
  private readonly storage: MediaStorage;

  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly cashBook: CashBookService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.storage = new MediaStorage(env.MEDIA_ROOT, env.DJANGO_TIME_ZONE);
  }

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  // --- Categories ----------------------------------------------------------------------------

  /** `ExpenseCategorySerializer(category).data`; `expense_count` is 0 for one just made. */
  private category(row: CategoryRow) {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      is_active: row.is_active,
      expense_count: Number(row.expense_count ?? 0),
      created_at: this.iso(row.created_at),
      updated_at: this.iso(row.updated_at),
    };
  }

  private async categoryConditions(query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    await applyFilters(this.db, query, CATEGORY_FILTERS, sql, where);
    for (const term of searchTerms(query)) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER(${C}."name"::text) LIKE UPPER(${like}) OR UPPER(${C}."code"::text) LIKE UPPER(${like})
          OR UPPER(${C}."description"::text) LIKE UPPER(${like}))`,
      );
    }
    return where;
  }

  async categories(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.categoryConditions(query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, CATEGORY_ORDERING) ?? [`${C}."name" ASC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${C} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<CategoryRow>(
      `SELECT ${CATEGORY_SELECT}, ${COUNT} AS "expense_count" FROM ${C} ${whereSql}
        ORDER BY ${order.join(', ')} LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.category(row)),
      absoluteUrl,
    );
  }

  async findCategory(pk: string, query: QueryDict): Promise<CategoryRow> {
    const sql = new SqlParams();
    const where = await this.categoryConditions(query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${C}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<CategoryRow>(
      `SELECT ${CATEGORY_SELECT}, ${COUNT} AS "expense_count" FROM ${C}
        WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieveCategory(pk: string, query: QueryDict) {
    return this.category(await this.findCategory(pk, query));
  }

  private unique(column: 'name' | 'code', exclude: string | null) {
    return {
      message: `expense category with this ${column} already exists.`,
      exists: async (value: string) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM ${C} WHERE (${C}."${column}" = $1${
            exclude ? ` AND NOT (${C}."id" = $2)` : ''
          }) LIMIT 1`,
          exclude ? [value, exclude] : [value],
        )) !== null,
    };
  }

  private async validateCategory(data: unknown, instance: CategoryRow | null, partial: boolean) {
    const exclude = instance?.id ?? null;
    const validated = await runSerializer<
      Partial<{ name: string; code: string; description: string; is_active: boolean }>
    >(
      {
        name: charField({ maxLength: 120, unique: this.unique('name', exclude) }),
        code: charField({ maxLength: 32, required: false, unique: this.unique('code', exclude) }),
        description: charField({ maxLength: 255, required: false, allowBlank: true }),
        is_active: booleanField({ required: false }),
      },
      data,
      { partial },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    return validated.values;
  }

  private async nameTaken(name: string, exclude: string | null): Promise<boolean> {
    return (
      (await this.db.one(
        `SELECT 1 AS "a" FROM ${C} WHERE (UPPER(${C}."name"::text) = UPPER($1)${
          exclude ? ` AND NOT (${C}."id" = $2)` : ''
        }) LIMIT 1`,
        exclude ? [name, exclude] : [name],
      )) !== null
    );
  }

  /** `create` and `create_expense_category`: a name, and a code made from it unless one is given. */
  async createCategory(user: RequestUser, data: unknown, context: AuditContext) {
    const values = await this.validateCategory(data, null, false);
    const name = pyStrip(values.name ?? '');
    if (!name) throw new ValidationError('A category needs a name.');
    const code = normaliseCode(values.code ?? '') || pySlice(normaliseCode(name), 32);
    const taken = await this.db.one(`SELECT 1 AS "a" FROM ${C} WHERE ${C}."code" = $1 LIMIT 1`, [
      code,
    ]);
    if (taken) throw new ValidationError(`The category code ${code} is already in use.`);
    if (await this.nameTaken(name, null))
      throw new ValidationError(`A category called ${name} already exists.`);
    const active = values.is_active ?? true;
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ${C} ("id", "created_at", "updated_at", "name", "code", "description",
                           "is_active", "created_by_id")
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, $5, $6::uuid)`,
        [id, name, code, values.description ?? '', active, user.id],
      );
      await recordAudit(tx, context, {
        action: 'CREATE',
        entity: { type: 'ExpenseCategory', id, label: name },
        actor: { id: user.id, email: user.email },
        newValues: { name, code, is_active: active },
      });
    });
    return this.category(
      (await this.db.one<CategoryRow>(`SELECT ${CATEGORY_SELECT} FROM ${C} WHERE "id" = $1`, [
        id,
      ])) as CategoryRow,
    );
  }

  /**
   * `update` and `update_expense_category`: a name, a description, the
   * active switch. The code is the key expenses were filed under and is not
   * edited. A PUT is read as a PATCH is.
   */
  async updateCategory(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const category = await this.findCategory(pk, query);
    const values = await this.validateCategory(data(), category, true);
    const after = {
      name: category.name,
      description: category.description,
      is_active: category.is_active,
    };
    for (const [key, value] of Object.entries(values)) {
      if (key === 'name') {
        const name = pyStrip((value as string | null) ?? '');
        if (!name) throw new ValidationError('A category needs a name.');
        if (await this.nameTaken(name, category.id))
          throw new ValidationError(`A category called ${name} already exists.`);
        after.name = name;
      } else if (key === 'description') after.description = value as string;
      else if (key === 'is_active') after.is_active = value as boolean;
    }
    const before = {
      name: category.name,
      description: category.description,
      is_active: category.is_active,
    };
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE ${C} SET "updated_at" = clock_timestamp(), "name" = $2, "description" = $3,
                "is_active" = $4 WHERE ${C}."id" = $1`,
        [category.id, after.name, after.description, after.is_active],
      );
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await recordAudit(tx, context, {
          action: 'UPDATE',
          entity: { type: 'ExpenseCategory', id: category.id, label: after.name },
          actor: { id: user.id, email: user.email },
          oldValues: before,
          newValues: after,
        });
      }
    });
    return this.category(
      (await this.db.one<CategoryRow>(
        `SELECT ${CATEGORY_SELECT}, ${COUNT} AS "expense_count" FROM ${C} WHERE "id" = $1`,
        [category.id],
      )) as CategoryRow,
    );
  }

  // --- Expenses ------------------------------------------------------------------------------

  /** `ExpenseSerializer(expense).data`: the receipt named by the endpoint that serves it. */
  private expense(row: ExpenseRow) {
    const receipt = row.attachment ? `/api/v1/expenses/${row.id}/attachment/` : '';
    return {
      id: row.id,
      number: row.number,
      branch: row.branch_id,
      branch_code: row.branch_code,
      category: row.category_id,
      category_name: row.category_name,
      category_code: row.category_code,
      account: row.account_id,
      account_name: row.account_name,
      amount: row.amount,
      spent_at: this.iso(row.spent_at),
      note: row.note,
      attachment: receipt || null,
      attachment_url: receipt,
      status: row.status,
      status_display: STATUS_LABELS[row.status] ?? row.status,
      transaction: row.transaction_id,
      reversal: row.reversal_id,
      voided_at: this.iso(row.voided_at),
      voided_by_email: row.voided_by_email ?? '',
      void_reason: row.void_reason,
      created_by_email: row.created_by_email ?? '',
      created_at: this.iso(row.created_at),
    };
  }

  /**
   * `get_queryset` and the filter backends: the date window (a value that is
   * not a date is a 400 on every route), voided rows unless `include_void`
   * is `false`, the user's branch, the filters and the search.
   */
  private async expenseConditions(
    user: RequestUser,
    query: QueryDict,
    sql: SqlParams,
  ): Promise<string[]> {
    const [from, to] = parseWindow(query, this.env.DJANGO_TIME_ZONE);
    const where: string[] = [];
    if ((query.get('include_void') ?? 'true').toLowerCase() === 'false')
      where.push(`${E}."status" = 'RECORDED'`);
    if (from) where.push(`${E}."spent_at" >= ${sql.add(from, 'timestamptz')}`);
    if (to) where.push(`${E}."spent_at" <= ${sql.add(to, 'timestamptz')}`);
    const scope = branchCondition(user, [`${E}."branch_id"`], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    await applyFilters(this.db, query, EXPENSE_FILTERS, sql, where);
    for (const term of searchTerms(query)) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER(${E}."number"::text) LIKE UPPER(${like}) OR UPPER(${E}."note"::text) LIKE UPPER(${like})
          OR UPPER(${C}."name"::text) LIKE UPPER(${like}))`,
      );
    }
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.expenseConditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, EXPENSE_ORDERING) ?? [
      `${E}."spent_at" DESC`,
      `${E}."created_at" DESC`,
    ];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${EXPENSE_FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<ExpenseRow>(
      `SELECT ${EXPENSE_SELECT} ${EXPENSE_FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.expense(row)),
      absoluteUrl,
    );
  }

  async find(user: RequestUser, pk: string, query: QueryDict): Promise<ExpenseRow> {
    const sql = new SqlParams();
    const where = await this.expenseConditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${E}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<ExpenseRow>(
      `SELECT ${EXPENSE_SELECT} ${EXPENSE_FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    return this.expense(await this.find(user, pk, query));
  }

  private async byId(id: string, q: Queryable = this.db) {
    return this.expense(
      (await q.one<ExpenseRow>(
        `SELECT ${EXPENSE_SELECT} ${EXPENSE_FROM} WHERE ${E}."id" = $1 LIMIT 21`,
        [id],
      )) as ExpenseRow,
    );
  }

  private exists(table: string) {
    return async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 1`, [id])) !== null;
  }

  private async expenseByKey(q: Queryable, key: string): Promise<string | null> {
    const row = await q.one<{ id: string }>(
      `SELECT "id" FROM ${E} WHERE ${E}."idempotency_key" = $1
        ORDER BY ${E}."spent_at" DESC, ${E}."created_at" DESC LIMIT 1`,
      [key],
    );
    return row?.id ?? null;
  }

  /**
   * `create` and `record_expense`: the document and the movement in one
   * transaction. The body may be JSON or a form with the receipt attached;
   * the receipt is stored under a random name before the row is written.
   */
  async create(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const tz = this.env.DJANGO_TIME_ZONE;
    const validated = await runSerializer<{
      branch?: string | null;
      category: string;
      account: string;
      amount: string;
      spent_at?: AwareMoment | null;
      note: string;
      attachment?: UploadedFile | null;
    }>(
      {
        branch: pkRelatedField(this.exists('accounts_branch'), {
          required: false,
          allowNull: true,
        }),
        category: pkRelatedField(this.exists('finance_expensecategory')),
        account: pkRelatedField(this.exists('finance_account')),
        amount: decimalField(14, 2),
        spent_at: dateTimeField(tz, { required: false, allowNull: true }),
        note: withDefault(charField({ allowBlank: true, required: false }), () => ''),
        attachment: fileField({ required: false, allowNull: true }),
      } as Fields,
      data,
      {
        hooks: {
          amount: (value: string) => {
            if (new Dec(value).lte(0)) throw Invalid.of('An expense must be greater than zero.');
            return value;
          },
          spent_at: (value: AwareMoment | null) => {
            // A future-dated expense is money that has not left yet.
            if (value && value.micros > BigInt(Date.now()) * 1000n)
              throw Invalid.of('An expense cannot be dated in the future.');
            return value;
          },
          attachment: (file: UploadedFile | null) => {
            if (!file) return file;
            if (file.size > MAX_RECEIPT_BYTES) {
              throw Invalid.of(
                `The receipt must be smaller than ${MAX_RECEIPT_BYTES / (1024 * 1024)} MB.`,
              );
            }
            const type = (file.contentType || '').toLowerCase();
            const named = file.name.toLowerCase();
            if (
              (type && !RECEIPT_TYPES.includes(type)) ||
              !RECEIPT_EXTENSIONS.some((extension) => named.endsWith(extension))
            )
              throw Invalid.of('Attach an image or a PDF of the receipt.');
            return file;
          },
        },
      },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    const branch = await this.permissions.resolveBranch(user, asked.branch ? asked.branch : null);
    const actor = { id: user.id, email: user.email };
    const key = idempotencyKey || null;

    const id = await this.db.transaction(async (tx) => {
      if (key) {
        const existing = await this.expenseByKey(tx, key);
        if (existing) return existing;
      }
      const amount = quantize(asked.amount);
      if (amount.lte(ZERO)) throw new ValidationError('An expense must be greater than zero.');
      const category = (await tx.one<{ name: string; is_active: boolean }>(
        `SELECT "name", "is_active" FROM ${C} WHERE "id" = $1`,
        [asked.category],
      )) as { name: string; is_active: boolean };
      if (!category.is_active) {
        throw new ValidationError(`${category.name} is retired; pick a category still in use.`);
      }
      const account = (await tx.one<{ name: string; branch_id: string }>(
        `SELECT "name", "branch_id" FROM "finance_account" WHERE "id" = $1`,
        [asked.account],
      )) as { name: string; branch_id: string };
      // An expense at one branch cannot be paid out of another branch's drawer.
      if (account.branch_id !== branch.id) {
        throw new ValidationError(
          `${account.name} belongs to another branch. ` +
            'Pay this from an account held by the branch spending the money.',
        );
      }

      const expenseId = randomUUID();
      const now = (
        (await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as {
          now: string;
        }
      ).now;
      const spentAt = asked.spent_at?.pg ?? now;
      let number: string;
      await tx.query('SAVEPOINT record_expense');
      try {
        number = await nextNumber(tx, 'expense', 'EXP');
        // The receipt keeps its extension and nothing else of its name (D91).
        const stored = asked.attachment
          ? await this.storage.save(
              `expenses/${now.slice(0, 4)}/${now.slice(5, 7)}/`,
              `${randomUUID().replaceAll('-', '')}${pathSuffix(asked.attachment.name).toLowerCase()}`,
              asked.attachment.bytes,
            )
          : '';
        await tx.query(
          `INSERT INTO ${E}
             ("id", "created_at", "updated_at", "number", "branch_id", "category_id", "account_id",
              "amount", "spent_at", "note", "attachment", "status", "idempotency_key",
              "transaction_id", "reversal_id", "voided_at", "voided_by_id", "void_reason",
              "created_by_id")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, $4::uuid, $5::uuid,
                   $6, $7::timestamptz, $8, $9, 'RECORDED', $10, NULL, NULL, NULL, NULL, '',
                   $11::uuid)`,
          [
            expenseId,
            number,
            branch.id,
            asked.category,
            asked.account,
            money(amount),
            spentAt,
            asked.note,
            stored,
            key,
            actor.id,
          ],
        );
        await tx.query('RELEASE SAVEPOINT record_expense');
      } catch (error) {
        if (!String((error as { code?: string }).code).startsWith('23')) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT record_expense');
        const winner = key === null ? null : await this.expenseByKey(tx, key);
        if (winner) return winner;
        throw error;
      }

      // Refused if the account cannot cover it, taking the document with it.
      const entry = await this.cashBook.move(tx, {
        accountId: asked.account,
        type: 'EXPENSE',
        amount,
        actor,
        referenceType: 'expense',
        referenceId: expenseId,
        notes: asked.note,
        occurredAt: spentAt,
      });
      await tx.query(
        `UPDATE ${E} SET "updated_at" = clock_timestamp(), "transaction_id" = $2
          WHERE ${E}."id" = $1`,
        [expenseId, entry],
      );
      const balance = (await tx.one<{ balance_after: string }>(
        `SELECT "balance_after" FROM "finance_accounttransaction" WHERE "id" = $1`,
        [entry],
      )) as { balance_after: string };
      await recordAudit(tx, context, {
        action: 'EXPENSE_RECORDED',
        entity: { type: 'Expense', id: expenseId, label: `${number} ${category.name}` },
        actor,
        newValues: {
          category: category.name,
          account: account.name,
          amount: money(amount),
          // `isoformat()`: a stated moment keeps the shop's offset; "now" is UTC.
          spent_at: asked.spent_at ? asked.spent_at.iso : pyIsoformat(now),
          balance_after: balance.balance_after,
        },
        reason: asked.note,
        branchId: branch.id,
      });
      return expenseId;
    });
    return this.byId(id);
  }

  /**
   * `void`: the expense and its movement both stay; a compensating
   * ADJUSTMENT puts the money back, under the expense's row lock, so two
   * voids of one expense put it back once.
   */
  async void(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{ reason: string }>({ reason: charField() }, data, {
      hooks: {
        reason: (value: string) => {
          if (!pyStrip(value)) throw Invalid.of('Say why this expense is being voided.');
          return value;
        },
      },
    });
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const found = await this.find(user, pk, query);
    const reason = pyStrip(validated.values.reason);
    if (!reason) throw new ValidationError('Say why this expense is being voided.');
    const actor = { id: user.id, email: user.email };
    await this.db.transaction(async (tx) => {
      const locked = (await tx.one<{
        number: string;
        status: string;
        amount: string;
        account_id: string;
        branch_id: string;
        category_id: string;
      }>(
        `SELECT "number", "status", "amount", "account_id", "branch_id", "category_id" FROM ${E}
          WHERE ${E}."id" = $1 LIMIT 21 FOR UPDATE`,
        [found.id],
      )) as {
        number: string;
        status: string;
        amount: string;
        account_id: string;
        branch_id: string;
        category_id: string;
      };
      if (locked.status === 'VOID')
        throw new ValidationError(`${locked.number} has already been voided.`);
      const reversal = await this.cashBook.move(tx, {
        accountId: locked.account_id,
        type: 'ADJUSTMENT',
        amount: locked.amount,
        actor,
        referenceType: 'expense',
        referenceId: found.id,
        reason: `Void of ${locked.number}: ${reason}`,
      });
      const now = (
        (await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as {
          now: string;
        }
      ).now;
      await tx.query(
        `UPDATE ${E} SET "updated_at" = clock_timestamp(), "status" = 'VOID', "reversal_id" = $2,
                "voided_at" = $3::timestamptz, "voided_by_id" = $4::uuid, "void_reason" = $5
          WHERE ${E}."id" = $1`,
        [found.id, reversal, now, actor.id, reason],
      );
      const balance = (await tx.one<{ balance_after: string }>(
        `SELECT "balance_after" FROM "finance_accounttransaction" WHERE "id" = $1`,
        [reversal],
      )) as { balance_after: string };
      const category = (await tx.one<{ name: string }>(`SELECT "name" FROM ${C} WHERE "id" = $1`, [
        locked.category_id,
      ])) as { name: string };
      await recordAudit(tx, context, {
        action: 'EXPENSE_VOIDED',
        entity: { type: 'Expense', id: found.id, label: `${locked.number} ${category.name}` },
        actor,
        oldValues: { status: 'RECORDED', amount: locked.amount },
        newValues: { status: 'VOID', balance_after: balance.balance_after },
        reason,
        branchId: locked.branch_id,
      });
    });
    return this.byId(found.id);
  }

  /** `attachment`: the receipt, to someone allowed to read the expense it belongs to. */
  async attachment(user: RequestUser, pk: string, query: QueryDict) {
    const expense = await this.find(user, pk, query);
    if (!expense.attachment) throw new NotFound('This expense has no receipt.');
    const bytes = await this.storage.read(expense.attachment);
    if (!bytes) throw new NotFound('The receipt file is missing.');
    const extension = pathSuffix(expense.attachment).toLowerCase();
    return {
      bytes,
      contentType: RECEIPT_MIME[extension] ?? 'application/octet-stream',
      fileName: `${expense.number}${extension}`,
    };
  }

  /** `summary`: what was spent in a window, voided expenses left out, split by category. */
  async summary(user: RequestUser, query: QueryDict) {
    let branchId: string | null = null;
    const asked = query.get('branch');
    if (asked) branchId = (await this.permissions.resolveBranch(user, asked)).id;
    else if (!canCrossBranch(user) && user.branchId) branchId = user.branchId;
    const [from, to] = parseWindow(query, this.env.DJANGO_TIME_ZONE);

    const sql = new SqlParams();
    const where = [`${E}."status" = 'RECORDED'`];
    if (branchId) where.push(`${E}."branch_id" = ${sql.add(branchId, 'uuid')}`);
    if (from) where.push(`${E}."spent_at" >= ${sql.add(from, 'timestamptz')}`);
    if (to) where.push(`${E}."spent_at" <= ${sql.add(to, 'timestamptz')}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const totals = (await this.db.one<{ total: string | null; count: string }>(
      `SELECT SUM(${E}."amount") AS "total", COUNT(*) AS "count" FROM ${E} ${whereSql}`,
      sql.values,
    )) as { total: string | null; count: string };
    const rows = await this.db.query<{
      category_id: string;
      name: string;
      code: string;
      total: string | null;
      count: string;
    }>(
      `SELECT ${E}."category_id", ${C}."name", ${C}."code", SUM(${E}."amount") AS "total",
              COUNT(${E}."id") AS "count"
         FROM ${E} INNER JOIN ${C} ON (${E}."category_id" = ${C}."id") ${whereSql}
        GROUP BY ${E}."category_id", ${C}."name", ${C}."code" ORDER BY 4 DESC`,
      sql.values,
    );
    const total = quantize(totals.total ?? ZERO);
    return {
      total: money(total),
      count: Number(totals.count),
      by_category: rows.map((row) => ({
        category_id: row.category_id,
        category: row.name,
        code: row.code,
        total: money(quantize(row.total ?? ZERO)),
        count: Number(row.count),
        share: money(
          total.gt(ZERO) ? quantize(new Dec(row.total ?? ZERO).div(total).times(100)) : ZERO,
        ),
      })),
    };
  }
}
