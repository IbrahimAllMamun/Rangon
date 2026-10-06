import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { canCrossBranch, RolePermissions } from '../auth/permissions';
import { money, quantize } from '../checkout/pricing';
import { type AuditContext, recordAudit } from '../common/audit';
import { localIso } from '../common/datetime';
import { type AwareMoment, dateTimeField } from '../common/datetime-field';
import { Dec } from '../common/decimal';
import {
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  pkRelatedField,
  runSerializer,
} from '../common/drf';
import { Conflict, PaymentExceedsOutstanding, ValidationError } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingPlan,
  type OrderingTerm,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import type { QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { CashBookService } from '../finance/cash-book.service';
import { dataGet } from '../http/request-body';
import { PurchaseOrdersService } from './purchase-orders.service';

/**
 * `SupplierPaymentViewSet` and `record_supplier_payment`: money leaving the
 * business for a supplier, out of one of its own accounts. A payment is
 * recorded once and never edited or deleted. Against an order it is decided
 * under the order's row lock -- never more than is outstanding, never an
 * order the supplier was not sent -- and it is idempotent on the caller's key.
 */

const P = '"purchasing_supplierpayment"';
const S = '"purchasing_supplier"';
const O = '"purchasing_purchaseorder"';
const A = '"finance_account"';
const METHODS = ['CASH', 'BANK', 'CHEQUE', 'MOBILE_MFS', 'OTHER'] as const;
const SELECT = `${P}."id", ${P}."created_at", ${P}."supplier_id", ${P}."purchase_order_id",
  ${P}."amount", ${P}."method", ${P}."reference", ${P}."paid_at", ${P}."notes", ${P}."account_id",
  ${S}."name" AS "supplier_name", ${O}."number" AS "purchase_number"`;
const JOIN_SUPPLIER = `INNER JOIN ${S} ON (${P}."supplier_id" = ${S}."id")`;
const JOIN_ORDER = `LEFT OUTER JOIN ${O} ON (${P}."purchase_order_id" = ${O}."id")`;
const JOIN_ACCOUNT = `LEFT OUTER JOIN ${A} ON (${P}."account_id" = ${A}."id")`;
const JOIN_ACCOUNT_BRANCH = `LEFT OUTER JOIN "accounts_branch" ON (${A}."branch_id" = "accounts_branch"."id")`;
const FILTERS: readonly FilterField[] = [
  modelFilter('supplier', `${P}."supplier_id"`, 'purchasing_supplier'),
  modelFilter('purchase_order', `${P}."purchase_order_id"`, 'purchasing_purchaseorder'),
  choiceFilter('method', `${P}."method"`, METHODS),
];
/** `get_status_display().lower()` for the statuses an order cannot be paid in. */
const UNPAYABLE: Readonly<Record<string, string>> = { DRAFT: 'draft', CANCELLED: 'cancelled' };

interface PaymentRow {
  id: string;
  created_at: string;
  supplier_id: string;
  purchase_order_id: string | null;
  amount: string;
  method: string;
  reference: string;
  paid_at: string;
  notes: string;
  account_id: string | null;
  supplier_name: string;
  purchase_number: string | null;
}

interface PaidOrder {
  id: string;
  number: string;
  supplier_id: string;
  branch_id: string;
  status: string;
  grand_total: string;
  paid_total: string;
  credited_total: string;
}

@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly cashBook: CashBookService,
    private readonly orders: PurchaseOrdersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `SupplierPaymentSerializer(payments, many=True).data`. */
  private async serialise(rows: PaymentRow[], q: Queryable = this.db) {
    const accounts = [...new Set(rows.map((row) => row.account_id).filter((id) => id !== null))];
    const names = new Map(
      accounts.length
        ? (
            await q.query<{ id: string; name: string }>(
              `SELECT "id", "name" FROM ${A} WHERE "id" = ANY($1::uuid[])`,
              [accounts],
            )
          ).map((row) => [row.id, row.name])
        : [],
    );
    const tz = this.env.DJANGO_TIME_ZONE;
    return rows.map((row) => ({
      id: row.id,
      supplier: row.supplier_id,
      supplier_name: row.supplier_name,
      purchase_order: row.purchase_order_id,
      purchase_number: row.purchase_number ?? '',
      amount: row.amount,
      method: row.method,
      reference: row.reference,
      paid_at: localIso(row.paid_at, tz),
      notes: row.notes,
      account: row.account_id,
      account_name: row.account_id ? (names.get(row.account_id) ?? '') : '',
      created_at: localIso(row.created_at, tz),
    }));
  }

  /**
   * `list`: a payment belongs to the branch whose order it settles, or --
   * for an advance against no order -- whose account it came out of (D95).
   */
  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where: string[] = [];
    const scoped = !(user.isSuperuser || canCrossBranch(user) || !user.branchId);
    if (scoped) {
      const branch = sql.add(user.branchId, 'uuid');
      where.push(`(${O}."branch_id" = ${branch} OR ${A}."branch_id" = ${branch})`);
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const plan = orderingPlan(query, ORDERING);
    const order = plan?.order ?? [`${P}."paid_at" DESC`];
    // The tables in the order Django's query holds them. The scope's filter
    // names the order and the account first -- and the account's branch,
    // which an ordering by account then uses -- before `select_related`
    // adds the supplier; with no scope the supplier and the order come first.
    const wanted = plan?.joins ?? [];
    const byBranch = wanted.includes(JOIN_ACCOUNT_BRANCH);
    const joins = scoped
      ? [JOIN_ORDER, JOIN_ACCOUNT, ...(byBranch ? [JOIN_ACCOUNT_BRANCH] : []), JOIN_SUPPLIER]
      : [JOIN_SUPPLIER, JOIN_ORDER];
    for (const join of wanted) {
      if (join === JOIN_ACCOUNT_BRANCH && !joins.includes(JOIN_ACCOUNT)) joins.push(JOIN_ACCOUNT);
      if (!joins.includes(join)) joins.push(join);
    }
    const from = `FROM ${P} ${joins.join(' ')}`;
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${P} ${scoped ? `${JOIN_ORDER} ${JOIN_ACCOUNT}` : ''}
            ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<PaymentRow>(
      `SELECT ${SELECT} ${from} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(page, await this.serialise(rows), absoluteUrl);
  }

  private async byId(id: string, q: Queryable = this.db) {
    const row = (await q.one<PaymentRow>(
      `SELECT ${SELECT} FROM ${P} ${JOIN_SUPPLIER} ${JOIN_ORDER} WHERE ${P}."id" = $1 LIMIT 21`,
      [id],
    )) as PaymentRow;
    return (await this.serialise([row], q))[0];
  }

  private exists(table: string) {
    return async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
  }

  private async byKey(q: Queryable, key: string): Promise<string | null> {
    const row = await q.one<{ id: string }>(
      `SELECT ${P}."id" FROM ${P} WHERE ${P}."idempotency_key" = $1
        ORDER BY ${P}."paid_at" DESC LIMIT 1`,
      [key],
    );
    return row?.id ?? null;
  }

  /** `create` and `record_supplier_payment`. */
  async create(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      supplier: string;
      purchase_order?: string | null;
      amount?: string;
      method: string;
      reference?: string;
      paid_at?: AwareMoment | null;
      notes?: string;
      account?: string | null;
    }>(
      {
        supplier: pkRelatedField(this.exists('purchasing_supplier')),
        purchase_order: pkRelatedField(this.exists('purchasing_purchaseorder'), {
          required: false,
          allowNull: true,
        }),
        // The column has a default, so DRF does not require it (D194).
        amount: decimalField(14, 2, { required: false }),
        method: choiceField(METHODS),
        reference: charField({ maxLength: 120, required: false, allowBlank: true }),
        paid_at: dateTimeField(this.env.DJANGO_TIME_ZONE, { required: false, allowNull: true }),
        notes: charField({ required: false, allowBlank: true }),
        account: pkRelatedField(this.exists('finance_account'), {
          required: false,
          allowNull: true,
        }),
      } as Fields,
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    const orderId = asked.purchase_order ?? null;

    // Paying an order is acting on its branch: the same rule as receiving it.
    if (orderId) {
      const branch = await this.db.one<{ branch_id: string }>(
        `SELECT "branch_id" FROM ${O} WHERE "id" = $1 LIMIT 21`,
        [orderId],
      );
      await this.permissions.resolveBranch(user, branch?.branch_id ?? null);
    }
    // `data["amount"]` on a body that left it out: a KeyError in the view.
    if (asked.amount === undefined) throw new TypeError("KeyError: 'amount'");
    const fallback = await this.permissions.resolveBranch(user, dataGet(data, 'branch'));
    const actor = { id: user.id, email: user.email };
    const key = idempotencyKey || null;

    const id = await this.db.transaction(async (tx) => {
      const amount = quantize(asked.amount as string);
      if (amount.lte(0)) throw new ValidationError('Payment amount must be positive.');
      // Before any lock is taken and before any money moves.
      if (key) {
        const existing = await this.byKey(tx, key);
        if (existing) return existing;
      }
      const supplier = (await tx.one<{ name: string }>(
        `SELECT "name" FROM ${S} WHERE "id" = $1 LIMIT 21`,
        [asked.supplier],
      )) as { name: string };

      // The order first, then the account: the outstanding check and the
      // increment are decided under one lock.
      let order: PaidOrder | null = null;
      if (orderId) {
        order = (await tx.one<PaidOrder>(
          `SELECT ${O}."id", ${O}."number", ${O}."supplier_id", ${O}."branch_id", ${O}."status",
                  ${O}."grand_total", ${O}."paid_total", ${O}."credited_total"
             FROM ${O} WHERE ${O}."id" = $1 LIMIT 21 FOR UPDATE`,
          [orderId],
        )) as PaidOrder;
        if (key) {
          const existing = await this.byKey(tx, key);
          if (existing) return existing;
        }
        if (order.supplier_id !== asked.supplier) {
          throw new ValidationError(`${order.number} belongs to a different supplier.`, {
            details: {
              purchase_order_supplier: order.supplier_id,
              payment_supplier: asked.supplier,
            },
          });
        }
        const unpayable = UNPAYABLE[order.status];
        if (unpayable) {
          throw new Conflict(`A ${unpayable} purchase order cannot be paid.`, {
            details: { status: order.status },
          });
        }
        const outstanding = quantize(
          new Dec(order.grand_total).minus(order.paid_total).minus(order.credited_total),
        );
        if (amount.gt(outstanding)) {
          throw new PaymentExceedsOutstanding(
            `Only ${money(outstanding)} is outstanding on ${order.number}.`,
            {
              details: {
                requested: money(amount),
                outstanding: money(outstanding),
                grand_total: order.grand_total,
                paid_total: order.paid_total,
              },
            },
          );
        }
      }

      const now = (
        (await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as { now: string }
      ).now;
      const when = asked.paid_at?.pg ?? now;
      const paymentId = randomUUID();
      await tx.query('SAVEPOINT supplier_payment');
      try {
        await tx.query(
          `INSERT INTO ${P}
             ("id", "created_at", "updated_at", "supplier_id", "purchase_order_id", "amount",
              "method", "reference", "paid_at", "notes", "account_id", "created_by_id",
              "idempotency_key")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6,
                   $7::timestamptz, $8, $9::uuid, $10::uuid, $11)`,
          [
            paymentId,
            asked.supplier,
            orderId,
            money(amount),
            asked.method,
            asked.reference ?? '',
            when,
            asked.notes ?? '',
            asked.account ?? null,
            actor.id,
            key,
          ],
        );
        await tx.query('RELEASE SAVEPOINT supplier_payment');
      } catch (error) {
        if (!String((error as { code?: string }).code).startsWith('23')) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT supplier_payment');
        const winner = key === null ? null : await this.byKey(tx, key);
        if (winner) return winner;
        throw error;
      }

      // The goods' branch pays for them; the stated branch is only for an advance.
      const source = order
        ? ((await tx.one<{ id: string; code: string }>(
            `SELECT "id", "code" FROM "accounts_branch" WHERE "id" = $1 LIMIT 21`,
            [order.branch_id],
          )) as { id: string; code: string })
        : fallback;
      const account = await this.cashBook.recordSupplierPayment(tx, {
        branch: { id: source.id, code: source.code },
        amount,
        accountId: asked.account ?? null,
        method: asked.method,
        referenceType: 'supplier_payment',
        referenceId: paymentId,
        actorId: actor.id,
        notes: `${supplier.name}${order ? ` ${order.number}` : ''}`,
        occurredAt: when,
      });
      if (account !== null && account !== (asked.account ?? null)) {
        await tx.query(
          `UPDATE ${P} SET "account_id" = $2::uuid, "updated_at" = clock_timestamp()
            WHERE ${P}."id" = $1`,
          [paymentId, account],
        );
      }
      if (order) {
        const paid = money(quantize(new Dec(order.paid_total).plus(amount)));
        await tx.query(
          `UPDATE ${O} SET "paid_total" = $2, "updated_at" = clock_timestamp() WHERE ${O}."id" = $1`,
          [order.id, paid],
        );
        await this.orders.refreshPaymentStatus(tx, { ...order, paid_total: paid });
      }
      await recordAudit(tx, context, {
        action: 'PAYMENT_RECORDED',
        entity: {
          type: 'SupplierPayment',
          id: paymentId,
          label: `${supplier.name}: ${money(amount)}`,
        },
        actor,
        newValues: { supplier: supplier.name, amount: money(amount), method: asked.method },
        reason: asked.notes ?? '',
        branchId: source.id,
      });
      return paymentId;
    });
    return this.byId(id);
  }
}

/**
 * What `OrderingFilter` allows when a view names no `ordering_fields`: every
 * field the serializer reads, by its source. A relation orders by the related
 * model's own ordering, through a join.
 */
const ORDERING: Readonly<Record<string, OrderingTerm>> = {
  id: `${P}."id"`,
  supplier: { columns: [`${S}."name"`], join: JOIN_SUPPLIER },
  supplier__name: { columns: [`${S}."name"`], join: JOIN_SUPPLIER },
  purchase_order: { columns: [`${O}."created_at" DESC`], join: JOIN_ORDER },
  purchase_order__number: { columns: [`${O}."number"`], join: JOIN_ORDER },
  amount: `${P}."amount"`,
  method: `${P}."method"`,
  reference: `${P}."reference"`,
  paid_at: `${P}."paid_at"`,
  notes: `${P}."notes"`,
  account: {
    columns: [`"accounts_branch"."name"`, `${A}."kind"`, `${A}."name"`],
    join: JOIN_ACCOUNT_BRANCH,
  },
  account__name: { columns: [`${A}."name"`], join: JOIN_ACCOUNT },
  created_at: `${P}."created_at"`,
};
