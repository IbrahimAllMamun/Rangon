import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition, RolePermissions } from '../auth/permissions';
import { NoticesService } from '../checkout/notices.service';
import { money, quantize, ZERO } from '../checkout/pricing';
import type { AuditActor, AuditContext } from '../common/audit';
import { recordAudit } from '../common/audit';
import { localIso } from '../common/datetime';
import { Dec } from '../common/decimal';
import {
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  integerField,
  Invalid,
  nestedListField,
  pkRelatedField,
  runSerializer,
  uuidField,
  withDefault,
} from '../common/drf';
import { Conflict, NotFound, PermissionDenied, ValidationError } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingPlan,
  type OrderingTerm,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { compareCodePoints, pyStr } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { Params as SqlParams } from '../database/sql';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { dataGet, pyTruthy } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { OrderPayments } from './order-payments.service';
import { OrderWritesService } from './order-writes.service';

/**
 * `ReturnRequestViewSet`, `PosReturnView` and `orders.services.returns`:
 *
 *     REQUESTED -> APPROVED -> RECEIVED -> COMPLETED
 *               -> REJECTED
 *
 * The order and its payments are never edited: a return is its own record.
 * Goods come back at RECEIVED, money goes back at COMPLETED, and each step
 * holds the return's row for as long as it runs.
 */

const R = '"orders_returnrequest"';
const SELECT = `${R}."id", ${R}."created_at", ${R}."number", ${R}."order_id", ${R}."status",
  ${R}."reason", ${R}."customer_comment", ${R}."staff_comment", ${R}."refund_amount",
  ${R}."refund_shipping", ${R}."approved_at", ${R}."received_at", ${R}."completed_at",
  "orders_order"."number" AS "order_number", "customers_customer"."name" AS "customer_name"`;
const ORDER_JOIN = `INNER JOIN "orders_order" ON (${R}."order_id" = "orders_order"."id")`;
const FROM = `FROM ${R} ${ORDER_JOIN}
  INNER JOIN "accounts_branch" ON ("orders_order"."branch_id" = "accounts_branch"."id")
  INNER JOIN "customers_customer" ON ("orders_order"."customer_id" = "customers_customer"."id")`;

const RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'COMPLETED'] as const;
const RETURN_REASONS = [
  'WRONG_SIZE',
  'DEFECTIVE',
  'WRONG_PRODUCT',
  'CUSTOMER_CHANGED_MIND',
  'DAMAGED',
  'OTHER',
] as const;
const RESTOCK_DECISIONS = ['RESTOCK', 'DAMAGED', 'QUARANTINE'] as const;
const PAYMENT_METHODS = [
  'CASH',
  'CARD',
  'MOBILE_MFS',
  'BANK',
  'ONLINE_GATEWAY',
  'COD',
  'STORE_CREDIT',
  'OTHER',
] as const;

/** Reasons where the shop, not the customer, is at fault: shipping is refunded. */
const SHOP_FAULT_REASONS = new Set(['DEFECTIVE', 'WRONG_PRODUCT', 'DAMAGED']);

const FILTERS: readonly FilterField[] = [
  choiceFilter('status', `${R}."status"`, RETURN_STATUSES),
  choiceFilter('reason', `${R}."reason"`, RETURN_REASONS),
  modelFilter('order', `${R}."order_id"`, 'orders_order'),
];

/**
 * `OrderingFilter`'s default: every field `ReturnRequestSerializer` reads, by
 * its source. The nested `items` is one of them, and ordering by it joins the
 * lines in -- a return then appears once per line (D159, copied).
 */
const ORDERING: Record<string, OrderingTerm> = {
  id: `${R}."id"`,
  number: `${R}."number"`,
  // A foreign key orders by the related model's own `Meta.ordering`.
  order: '"orders_order"."placed_at" DESC',
  order__number: '"orders_order"."number"',
  order__customer__name: '"customers_customer"."name"',
  status: `${R}."status"`,
  reason: `${R}."reason"`,
  customer_comment: `${R}."customer_comment"`,
  staff_comment: `${R}."staff_comment"`,
  refund_amount: `${R}."refund_amount"`,
  refund_shipping: `${R}."refund_shipping"`,
  items: {
    columns: ['"orders_returnitem"."id"'],
    join: `LEFT OUTER JOIN "orders_returnitem"
      ON (${R}."id" = "orders_returnitem"."return_request_id")`,
  },
  created_at: `${R}."created_at"`,
  approved_at: `${R}."approved_at"`,
  received_at: `${R}."received_at"`,
  completed_at: `${R}."completed_at"`,
};

interface ReturnRow {
  id: string;
  created_at: string;
  number: string;
  order_id: string;
  status: string;
  reason: string;
  customer_comment: string;
  staff_comment: string;
  refund_amount: string;
  refund_shipping: boolean;
  approved_at: string | null;
  received_at: string | null;
  completed_at: string | null;
  order_number: string;
  customer_name: string;
}

interface ReturnItemRow {
  id: string;
  return_request_id: string;
  order_item_id: string;
  quantity: number;
  restock_decision: string;
  condition_note: string;
  refund_amount: string;
}

interface LockedReturn {
  id: string;
  number: string;
  order_id: string;
  status: string;
  reason: string;
  refund_amount: string;
}

interface CreateData {
  order: string;
  reason: string;
  lines: { order_item: string; quantity: number | bigint; restock_decision: string }[];
  customer_comment?: string;
  [key: string]: unknown;
}

interface ReceiveData {
  items?: { id: string; restock_decision?: string; condition_note: string }[];
  [key: string]: unknown;
}

interface CompleteData {
  refund_amount?: string | null;
  refund_method?: string;
  account?: string | null;
  [key: string]: unknown;
}

/** What a request for a return asks for, once validated. */
interface ReturnAsk {
  orderId: string;
  lines: { orderItem: string; quantity: number | bigint; restockDecision: string }[];
  reason: string;
  customerComment: string;
}

/** `CreateReturnSerializer`. */
const CREATE_FIELDS: Fields = {
  order: uuidField(),
  reason: choiceField(RETURN_REASONS),
  lines: nestedListField({
    order_item: uuidField(),
    quantity: integerField({ minValue: 1 }),
    restock_decision: withDefault(
      choiceField(RESTOCK_DECISIONS, { required: false }),
      () => 'RESTOCK',
    ),
  }),
  customer_comment: charField({ required: false, allowBlank: true }),
};

/** `ReceiveReturnSerializer`: one decision per line, made with the goods in hand. */
const RECEIVE_FIELDS: Fields = {
  items: nestedListField(
    {
      id: uuidField(),
      restock_decision: choiceField(RESTOCK_DECISIONS, { required: false }),
      condition_note: withDefault(
        charField({ maxLength: 255, required: false, allowBlank: true }),
        () => '',
      ),
    },
    { required: false },
  ),
};
const RECEIVE_RULES = {
  hooks: {
    items: (value: { id: string }[]) => {
      const seen = new Set<string>();
      for (const line of value) {
        if (seen.has(line.id))
          throw Invalid.of(`${line.id} appears twice; send one decision per line.`);
        seen.add(line.id);
      }
      return value;
    },
  },
};

/**
 * What a TextField makes of a value on its way to the database: a str as it
 * is, None as NULL (which the column refuses), anything else `str()` of it.
 * Text PostgreSQL cannot hold -- a lone surrogate -- fails as it does for
 * psycopg, rather than being stored as U+FFFD.
 */
export function textValue(value: unknown): string | null {
  if (value === null) return null;
  const text = pyStr(value);
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error("UnicodeEncodeError: 'utf-8' codec can't encode a surrogate");
  }
  return text;
}

/**
 * What the customer handed over for the units coming back (`_line_paid`, and
 * the rounding in `request_return`). A line's total carries its own discount
 * and nothing else: a coupon or a whole-sale discount is on the order, so each
 * line bears it in proportion to its share of the subtotal. VAT that sat on
 * top of the line (EXCLUSIVE) is added; VAT inside the price already is.
 * Rounded once for the request, not line by line -- 20.00 off three equal
 * lines is 6.67 each, and three rounded shares would give back a paisa too
 * little -- and the last line carries the difference.
 */
export function returnShares(
  order: { subtotal: string; discount_total: string; tax_mode: string },
  lines: readonly { line_total: string; tax_amount: string; quantity: number; returning: number }[],
): { total: Dec; shares: Dec[] } {
  const paid = lines.map((line) => {
    let amount = new Dec(line.line_total);
    if (new Dec(order.subtotal).gt(ZERO)) {
      amount = amount.minus(
        new Dec(line.line_total).times(order.discount_total).div(order.subtotal),
      );
    }
    if (order.tax_mode === 'EXCLUSIVE') amount = amount.plus(line.tax_amount);
    return amount.times(line.returning).div(line.quantity);
  });
  const total = quantize(paid.reduce((sum, amount) => sum.plus(amount), ZERO));
  const shares = paid.map((amount) => quantize(amount));
  const last = shares.length - 1;
  if (last >= 0) {
    shares[last] = (shares[last] as Dec).plus(
      total.minus(shares.reduce((sum, share) => sum.plus(share), ZERO)),
    );
  }
  return { total, shares };
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly stock: StockService,
    private readonly payments: OrderPayments,
    private readonly orders: OrderWritesService,
    private readonly notices: NoticesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  /**
   * `ReturnRequestSerializer(...).data`. The lines are read as Django's
   * prefetch reads them, in no stated order: the table's own.
   */
  async serialise(rows: ReturnRow[], q: Queryable = this.db) {
    if (!rows.length) return [];
    const marks = rows.map((_, index) => `$${index + 1}`).join(', ');
    const items = await q.query<ReturnItemRow>(
      `SELECT "orders_returnitem"."id", "orders_returnitem"."return_request_id",
              "orders_returnitem"."order_item_id", "orders_returnitem"."quantity",
              "orders_returnitem"."restock_decision", "orders_returnitem"."condition_note",
              "orders_returnitem"."refund_amount"
         FROM "orders_returnitem" WHERE "orders_returnitem"."return_request_id" IN (${marks})`,
      rows.map((row) => row.id),
    );
    const lines = new Map(
      (
        await q.query<{ id: string; sku: string; product_name: string }>(
          `SELECT "id", "sku", "product_name" FROM "orders_orderitem" WHERE "id" = ANY($1::uuid[])`,
          [[...new Set(items.map((item) => item.order_item_id))]],
        )
      ).map((line) => [line.id, line]),
    );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      order: row.order_id,
      order_number: row.order_number,
      customer_name: row.customer_name,
      status: row.status,
      reason: row.reason,
      customer_comment: row.customer_comment,
      staff_comment: row.staff_comment,
      refund_amount: row.refund_amount,
      refund_shipping: row.refund_shipping,
      items: items
        .filter((item) => item.return_request_id === row.id)
        .map((item) => ({
          id: item.id,
          order_item: item.order_item_id,
          sku: lines.get(item.order_item_id)?.sku,
          product_name: lines.get(item.order_item_id)?.product_name,
          quantity: item.quantity,
          restock_decision: item.restock_decision,
          condition_note: item.condition_note,
          refund_amount: item.refund_amount,
        })),
      created_at: this.iso(row.created_at),
      approved_at: this.iso(row.approved_at),
      received_at: this.iso(row.received_at),
      completed_at: this.iso(row.completed_at),
    }));
  }

  /** One return as the serializer writes it, read again by id. */
  private async answer(id: string) {
    const row = (await this.db.one<ReturnRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${R}."id" = $1 LIMIT 21`,
      [id],
    )) as ReturnRow;
    return (await this.serialise([row]))[0];
  }

  /** `get_queryset` then `filter_queryset`'s filters: the user's branch, and what was asked for. */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    const scope = branchCondition(user, ['"orders_order"."branch_id"'], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  /** `list`: paginated, the newest first. */
  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const plan = orderingPlan(query, ORDERING);
    const order = plan?.order ?? [`${R}."created_at" DESC`];
    // The count is of returns; the page is cut from the rows as ordered, lines
    // joined in or not.
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${R} ${ORDER_JOIN} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<ReturnRow>(
      `SELECT ${SELECT} ${FROM} ${(plan?.joins ?? []).join(' ')} ${whereSql}
        ORDER BY ${order.join(', ')} LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    // A return listed twice is serialised twice, each time with all its lines.
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
    const payloads = new Map(
      (await this.serialise(unique)).map((payload) => [payload.id, payload]),
    );
    return paginated(
      page,
      rows.map((row) => payloads.get(row.id)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the filtered queryset, then the primary key -- a 404 either way. */
  async find(user: RequestUser, pk: string, query: QueryDict): Promise<ReturnRow> {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${R}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<ReturnRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    return (await this.serialise([await this.find(user, pk, query)]))[0];
  }

  /** `CreateReturnSerializer(data=request.data).is_valid(raise_exception=True)`. */
  private async asked(data: unknown): Promise<ReturnAsk> {
    const validated = await runSerializer<CreateData>(CREATE_FIELDS, data);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const values = validated.values;
    // `Order.objects.get(pk=...)`: any order, whichever branch it is at (D156, copied).
    const order = await this.db.one(
      `SELECT 1 AS "a" FROM "orders_order" WHERE "orders_order"."id" = $1 LIMIT 21`,
      [values.order],
    );
    if (!order) throw new NotFound();
    return {
      orderId: values.order,
      lines: values.lines.map((line) => ({
        orderItem: line.order_item,
        quantity: line.quantity,
        restockDecision: line.restock_decision,
      })),
      reason: values.reason,
      customerComment: values.customer_comment ?? '',
    };
  }

  /** `timezone.now()`, read before the row it stamps is saved. */
  private async now(tx: Queryable): Promise<string> {
    return ((await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as { now: string })
      .now;
  }

  private async lockReturn(tx: Queryable, id: string): Promise<LockedReturn> {
    return (await tx.one<LockedReturn>(
      `SELECT "id", "number", "order_id", "status", "reason", "refund_amount"
         FROM ${R} WHERE ${R}."id" = $1 LIMIT 21 FOR UPDATE`,
      [id],
    )) as LockedReturn;
  }

  /** The staff who refund at the order's branch hear of a new return, once it is committed. */
  private async notify(opened: Opened): Promise<void> {
    await this.notices.notifyStaff({
      type: 'RETURN_REQUESTED',
      title: `Return requested for ${opened.orderNumber}`,
      body: `${opened.number}: ${opened.reason}`,
      permission: 'sales.refund',
      branchId: opened.branchId,
      link: `/admin/returns/${opened.id}`,
    });
  }

  /**
   * `request_return`: open a return for some of an order's lines. The order
   * is locked, then its lines. What comes back is what the customer paid for
   * those units -- the line's share of any whole-order discount taken off,
   * its VAT added where VAT sat on top -- rounded once for the request, the
   * last line carrying the odd paisa, and never more than is left to refund.
   *
   * A line's returnable count moves only when goods are received, so two
   * returns may be opened for the same unit; the second cannot be received
   * (D157, copied).
   */
  private async requestReturn(
    tx: Queryable,
    context: AuditContext,
    user: RequestUser,
    ask: ReturnAsk,
  ): Promise<Opened> {
    const actor = { id: user.id, email: user.email };
    const order = (await tx.one<OrderForReturn>(
      `SELECT "id", "number", "status", "channel", "stock_committed", "delivered_at", "placed_at",
              "subtotal", "discount_total", "tax_mode", "shipping_total", "paid_total",
              "refunded_total", "branch_id", "currency", "grand_total"
         FROM "orders_order" WHERE "orders_order"."id" = $1 LIMIT 21 FOR UPDATE`,
      [ask.orderId],
    )) as OrderForReturn;

    if (order.status === 'CANCELLED' || order.status === 'REFUNDED')
      throw new Conflict(`An order in status ${order.status} cannot be returned.`);
    if (!order.stock_committed && order.channel !== 'POS')
      throw new Conflict('The goods have not been dispatched yet — cancel the order instead.');
    if (!ask.lines.length) throw new ValidationError('Select at least one item to return.');

    const days = this.env.RANGON_RETURN_WINDOW_DAYS;
    const window = (await tx.one<{ open: boolean }>(
      `SELECT clock_timestamp() <= $1::timestamptz + $2 * interval '86400 seconds' AS "open"`,
      [order.delivered_at ?? order.placed_at, days],
    )) as { open: boolean };
    if (!window.open && !(await this.permissions.has(user, 'sales.refund_override'))) {
      throw new PermissionDenied(
        `The ${days}-day return window has passed. A manager can override this.`,
      );
    }

    const items = new Map(
      (
        await tx.query<OrderLine>(
          `SELECT "id", "variant_id", "sku", "product_name", "quantity", "returned_quantity",
                  "line_total", "tax_amount"
             FROM "orders_orderitem" WHERE "orders_orderitem"."order_id" = $1
            ORDER BY "orders_orderitem"."created_at" ASC FOR UPDATE`,
          [order.id],
        )
      ).map((item) => [item.id, item]),
    );

    const id = randomUUID();
    const number = await this.orders.nextNumber(tx, 'return', 'RET');
    const refundShipping = SHOP_FAULT_REASONS.has(ask.reason);
    await tx.query(
      `INSERT INTO ${R}
         (id, created_at, updated_at, number, order_id, status, reason, customer_comment,
          staff_comment, refund_amount, refund_shipping, requested_by_id, approved_by_id,
          approved_at, received_at, completed_at)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, 'REQUESTED', $4, $5,
               '', 0.00, $6, $7::uuid, NULL, NULL, NULL, NULL)`,
      [id, number, order.id, ask.reason, ask.customerComment, refundShipping, actor.id],
    );

    const returned: { item: OrderLine; quantity: number; decision: string }[] = [];
    for (const line of ask.lines) {
      const item = items.get(line.orderItem);
      if (!item)
        throw new ValidationError(`Line ${line.orderItem} does not belong to ${order.number}.`);
      const returnable = item.quantity - item.returned_quantity;
      if (BigInt(line.quantity) > BigInt(returnable)) {
        throw new ValidationError(`Only ${returnable} of ${item.sku} can still be returned.`, {
          details: { order_item_id: item.id, requested: line.quantity, returnable },
        });
      }
      const product = await tx.one<{ is_final_sale: boolean }>(
        `SELECT "catalog_product"."is_final_sale" FROM "catalog_productvariant"
          INNER JOIN "catalog_product"
            ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
          WHERE "catalog_productvariant"."id" = $1 LIMIT 21`,
        [item.variant_id],
      );
      if (product?.is_final_sale) {
        throw new ValidationError(
          `${item.product_name} is a final-sale item and cannot be returned.`,
        );
      }
      const quantity = Number(line.quantity);
      returned.push({ item, quantity, decision: line.restockDecision });
    }
    // The decision is kept per order line: the last one given for a line stands.
    const decisions = new Map(ask.lines.map((line) => [line.orderItem, line.restockDecision]));

    const split = returnShares(
      order,
      returned.map((line) => ({ ...line.item, returning: line.quantity })),
    );
    let refundTotal = split.total;
    const shares = split.shares;
    for (const [index, line] of returned.entries()) {
      await tx.query(
        `INSERT INTO "orders_returnitem"
           (id, created_at, updated_at, return_request_id, order_item_id, quantity,
            restock_decision, condition_note, refund_amount)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, '', $6)`,
        [
          randomUUID(),
          id,
          line.item.id,
          line.quantity,
          decisions.get(line.item.id) ?? 'RESTOCK',
          money(shares[index] as Dec),
        ],
      );
    }

    if (refundShipping) refundTotal = refundTotal.plus(order.shipping_total);
    const refundable = new Dec(order.paid_total).minus(order.refunded_total);
    const amount = quantize(refundTotal.lt(refundable) ? refundTotal : refundable);
    await tx.query(
      `UPDATE ${R} SET "updated_at" = clock_timestamp(), "refund_amount" = $2
        WHERE ${R}."id" = $1`,
      [id, money(amount)],
    );

    await this.orders.logEvent(
      tx,
      order.id,
      'RETURN_REQUESTED',
      `Return ${number} requested (${ask.reason})`,
      { data: { return_id: id, amount: money(amount) }, actorId: actor.id },
    );
    if (order.status === 'DELIVERED' || order.status === 'SHIPPED') {
      await this.orders.transition(
        tx,
        context,
        this.ref(order),
        'RETURN_REQUESTED',
        `Return ${number}`,
        actor,
      );
    }
    return {
      id,
      number,
      orderNumber: order.number,
      branchId: order.branch_id,
      reason: ask.reason,
    };
  }

  private ref(order: {
    id: string;
    number: string;
    branch_id: string;
    currency: string;
    grand_total: string;
  }) {
    return {
      id: order.id,
      number: order.number,
      branchId: order.branch_id,
      currency: order.currency,
      grandTotal: order.grand_total,
    };
  }

  /** `approve`: REQUESTED to APPROVED, under the return's lock. */
  private async approveLocked(tx: Queryable, id: string, actor: AuditActor, comment: unknown) {
    const locked = await this.lockReturn(tx, id);
    if (locked.status !== 'REQUESTED')
      throw new Conflict(`A ${locked.status} return cannot be approved.`);
    const now = await this.now(tx);
    await tx.query(
      `UPDATE ${R} SET "updated_at" = clock_timestamp(), "status" = 'APPROVED',
              "staff_comment" = $2, "approved_by_id" = $3::uuid, "approved_at" = $4::timestamptz
        WHERE ${R}."id" = $1`,
      [id, textValue(comment), actor.id, now],
    );
    await this.orders.logEvent(
      tx,
      locked.order_id,
      'RETURN_UPDATED',
      `Return ${locked.number} approved`,
      { actorId: actor.id },
    );
  }

  /**
   * `receive`: the goods are back. Decisions made on inspection are written
   * first; RESTOCK lines go back on the shelf under a RETURN, every line's
   * returned count moves, and the return becomes RECEIVED.
   */
  private async receiveLocked(
    tx: Queryable,
    after: AfterCommit,
    id: string,
    actor: AuditActor,
    decisions: Map<string, { restock_decision?: string; condition_note?: string }> | null,
  ) {
    const locked = await this.lockReturn(tx, id);
    if (locked.status !== 'APPROVED')
      throw new Conflict('Only an approved return can be received.');

    const lines = () =>
      tx.query<ReturnItemRow & { variant_id: string; sku: string }>(
        `SELECT "orders_returnitem"."id", "orders_returnitem"."return_request_id",
                "orders_returnitem"."order_item_id", "orders_returnitem"."quantity",
                "orders_returnitem"."restock_decision", "orders_returnitem"."condition_note",
                "orders_returnitem"."refund_amount", "orders_orderitem"."variant_id",
                "orders_orderitem"."sku"
           FROM "orders_returnitem" INNER JOIN "orders_orderitem"
             ON ("orders_returnitem"."order_item_id" = "orders_orderitem"."id")
          WHERE "orders_returnitem"."return_request_id" = $1`,
        [id],
      );

    if (decisions?.size) {
      const known = new Map((await lines()).map((item) => [item.id, item]));
      const unknown = [...decisions.keys()]
        .filter((key) => !known.has(key))
        .sort(compareCodePoints);
      if (unknown.length)
        throw new ValidationError('Some lines are not on this return.', { details: { unknown } });
      // `bulk_update`: one statement, and `updated_at` written back as it was read.
      const sql = new SqlParams();
      const ids: string[] = [];
      const decided: string[] = [];
      const notes: string[] = [];
      for (const [itemId, decision] of decisions) {
        const item = known.get(itemId) as ReturnItemRow;
        const mark = sql.add(itemId, 'uuid');
        ids.push(mark);
        decided.push(
          `WHEN ("orders_returnitem"."id" = ${mark}) THEN ${sql.add(decision.restock_decision ?? item.restock_decision)}`,
        );
        notes.push(
          `WHEN ("orders_returnitem"."id" = ${mark}) THEN ${sql.add(
            'condition_note' in decision ? decision.condition_note || '' : item.condition_note,
          )}`,
        );
      }
      await tx.query(
        `UPDATE "orders_returnitem"
            SET "restock_decision" = (CASE ${decided.join(' ')} ELSE NULL END)::varchar(16),
                "condition_note" = (CASE ${notes.join(' ')} ELSE NULL END)::varchar(255)
          WHERE "orders_returnitem"."id" IN (${ids.join(', ')})`,
        sql.values,
      );
    }

    const order = (await tx.one<{ id: string; branch_id: string }>(
      `SELECT "id", "branch_id" FROM "orders_order" WHERE "orders_order"."id" = $1 LIMIT 21`,
      [locked.order_id],
    )) as { id: string; branch_id: string };
    const received = await lines();
    const restock = received.filter((item) => item.restock_decision === 'RESTOCK');
    if (restock.length) {
      const branch = (await tx.one<{ id: string; code: string }>(
        `SELECT "id", "code" FROM "accounts_branch" WHERE "accounts_branch"."id" = $1 LIMIT 21`,
        [order.branch_id],
      )) as { id: string; code: string };
      await this.stock.restockReturn(tx, after, {
        branch,
        lines: restock.map((item) => [item.variant_id, item.quantity] as [string, number]),
        actor,
        referenceType: 'return',
        referenceId: id,
        reason: `Return ${locked.number} restocked`,
      });
    }

    for (const item of received) {
      const line = (await tx.one<{ returned_quantity: number }>(
        `SELECT "returned_quantity" FROM "orders_orderitem"
          WHERE "orders_orderitem"."id" = $1 LIMIT 21 FOR UPDATE`,
        [item.order_item_id],
      )) as { returned_quantity: number };
      await tx.query(
        `UPDATE "orders_orderitem" SET "updated_at" = clock_timestamp(), "returned_quantity" = $2
          WHERE "orders_orderitem"."id" = $1`,
        [item.order_item_id, line.returned_quantity + item.quantity],
      );
    }

    const now = await this.now(tx);
    await tx.query(
      `UPDATE ${R} SET "updated_at" = clock_timestamp(), "status" = 'RECEIVED',
              "received_at" = $2::timestamptz WHERE ${R}."id" = $1`,
      [id, now],
    );
    // A dict keyed by SKU: one entry for a SKU the order carries on two lines.
    const bySku: Record<string, string> = {};
    for (const item of received) bySku[item.sku] = item.restock_decision;
    await this.orders.logEvent(tx, order.id, 'RETURN_UPDATED', `Return ${locked.number} received`, {
      data: { restocked_lines: restock.length, decisions: bySku },
      actorId: actor.id,
    });
  }

  /**
   * `complete`: pay the refund and close the return. A return already
   * completed answers as it is. The refund is keyed -- by the caller's
   * `Idempotency-Key`, else by the return itself -- so a retry pays once; a
   * key some other refund already holds answers with that refund and pays
   * nothing here (D160, copied). An order whose every line is back goes
   * RETURNED then REFUNDED, whatever amount was refunded.
   */
  private async completeLocked(
    tx: Queryable,
    context: AuditContext,
    id: string,
    actor: AuditActor,
    refund: {
      amount?: string | null;
      method?: string | null;
      auditMethod?: unknown;
      accountId?: string | null;
      idempotencyKey?: string | null;
    },
  ) {
    const locked = await this.lockReturn(tx, id);
    if (locked.status === 'COMPLETED') return;
    if (locked.status !== 'RECEIVED')
      throw new Conflict('The goods must be received before a refund is issued.');

    const order = (await tx.one<OrderForReturn>(
      `SELECT "id", "number", "status", "branch_id", "currency", "grand_total"
         FROM "orders_order" WHERE "orders_order"."id" = $1 LIMIT 21 FOR UPDATE`,
      [locked.order_id],
    )) as OrderForReturn;
    const amount = quantize(
      refund.amount !== null && refund.amount !== undefined ? refund.amount : locked.refund_amount,
    );

    if (amount.gt(ZERO)) {
      await this.payments.refundOrder(tx, context, order.id, {
        amount,
        actor,
        reason: `Return ${locked.number}`,
        method: refund.method ?? null,
        auditMethod: refund.auditMethod,
        returnRequestId: id,
        idempotencyKey: refund.idempotencyKey || `return:${id}`,
        accountId: refund.accountId ?? null,
      });
    }

    const now = await this.now(tx);
    await tx.query(
      `UPDATE ${R} SET "updated_at" = clock_timestamp(), "status" = 'COMPLETED',
              "refund_amount" = $2, "completed_at" = $3::timestamptz WHERE ${R}."id" = $1`,
      [id, money(amount), now],
    );

    const lines = await tx.query<{ quantity: number; returned_quantity: number }>(
      `SELECT "quantity", "returned_quantity" FROM "orders_orderitem"
        WHERE "orders_orderitem"."order_id" = $1 ORDER BY "orders_orderitem"."created_at" ASC`,
      [order.id],
    );
    const fullyReturned = lines.every((line) => line.returned_quantity >= line.quantity);
    if (order.status === 'RETURN_REQUESTED' && fullyReturned) {
      const reason = `Return ${locked.number}`;
      await this.orders.transition(tx, context, this.ref(order), 'RETURNED', reason, actor);
      await this.orders.transition(tx, context, this.ref(order), 'REFUNDED', reason, actor);
    }

    await recordAudit(tx, context, {
      action: 'REFUND_ISSUED',
      entity: { type: 'ReturnRequest', id, label: locked.number },
      actor,
      newValues: { order: order.number, amount: money(amount), return: locked.number },
      reason: locked.reason,
      branchId: order.branch_id,
    });
  }

  /** `create`: open a return. */
  async create(user: RequestUser, data: unknown, context: AuditContext) {
    const ask = await this.asked(data);
    const opened = await this.stock.run((tx: Queryable) =>
      this.requestReturn(tx, context, user, ask),
    );
    await this.notify(opened);
    return this.answer(opened.id);
  }

  /** `approve`. The comment is whatever the body's `comment` holds, unvalidated. */
  async approve(user: RequestUser, pk: string, query: QueryDict, data: () => unknown) {
    const found = await this.find(user, pk, query);
    const given = dataGet(data(), 'comment');
    const comment = given === undefined ? '' : given;
    await this.stock.run((tx: Queryable) =>
      this.approveLocked(tx, found.id, { id: user.id, email: user.email }, comment),
    );
    return this.answer(found.id);
  }

  /**
   * `reject`: a return not yet received is turned down, and an order waiting
   * on it goes back to DELIVERED.
   */
  async reject(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const found = await this.find(user, pk, query);
    const given = dataGet(data(), 'comment');
    const comment = given === undefined ? '' : given;
    const actor = { id: user.id, email: user.email };
    await this.stock.run(async (tx: Queryable) => {
      const locked = await this.lockReturn(tx, found.id);
      if (locked.status !== 'REQUESTED' && locked.status !== 'APPROVED')
        throw new Conflict(`A ${locked.status} return cannot be rejected.`);
      await tx.query(
        `UPDATE ${R} SET "updated_at" = clock_timestamp(), "status" = 'REJECTED',
                "staff_comment" = $2 WHERE ${R}."id" = $1`,
        [found.id, textValue(comment)],
      );
      const order = (await tx.one<OrderForReturn>(
        `SELECT "id", "number", "status", "branch_id", "currency", "grand_total"
           FROM "orders_order" WHERE "orders_order"."id" = $1 LIMIT 21`,
        [locked.order_id],
      )) as OrderForReturn;
      if (order.status === 'RETURN_REQUESTED') {
        await this.orders.transition(
          tx,
          context,
          this.ref(order),
          'DELIVERED',
          `Return ${locked.number} rejected`,
          actor,
        );
      }
      await this.orders.logEvent(
        tx,
        order.id,
        'RETURN_UPDATED',
        `Return ${locked.number} rejected: ${pyStr(comment)}`,
        { actorId: actor.id },
      );
    });
    return this.answer(found.id);
  }

  /** `receive`: the body is validated before the return is looked for. */
  async receive(user: RequestUser, pk: string, query: QueryDict, data: unknown) {
    const validated = await runSerializer<ReceiveData>(RECEIVE_FIELDS, data, RECEIVE_RULES);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const decisions = new Map(
      (validated.values.items ?? []).map((line) => {
        const { id, ...decision } = line;
        return [id, decision];
      }),
    );
    const found = await this.find(user, pk, query);
    await this.stock.run((tx: Queryable, after: AfterCommit) =>
      this.receiveLocked(tx, after, found.id, { id: user.id, email: user.email }, decisions),
    );
    return this.answer(found.id);
  }

  /** `CompleteReturnSerializer`: an amount, a method the ledger knows, an account. */
  private completeFields(): Fields {
    return {
      refund_amount: decimalField(14, 2, { required: false, allowNull: true, minValue: '0.01' }),
      refund_method: choiceField(PAYMENT_METHODS, { required: false, allowBlank: true }),
      account: pkRelatedField(
        async (id) =>
          (await this.db.one(
            `SELECT 1 AS "a" FROM "finance_account" WHERE "finance_account"."id" = $1 LIMIT 1`,
            [id],
          )) !== null,
        { required: false, allowNull: true },
      ),
    };
  }

  /** `complete`: the body is validated before the return is looked for. */
  async complete(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const validated = await runSerializer<CompleteData>(this.completeFields(), data);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const values = validated.values;
    const found = await this.find(user, pk, query);
    await this.stock.run((tx: Queryable) =>
      this.completeLocked(
        tx,
        context,
        found.id,
        { id: user.id, email: user.email },
        {
          amount: values.refund_amount,
          method: values.refund_method || null,
          accountId: values.account,
          idempotencyKey,
        },
      ),
    );
    return this.answer(found.id);
  }

  /**
   * `PosReturnView` and `pos_return`: a return at the counter -- requested,
   * approved, received and refunded in one transaction. The refund's method
   * is whatever the body's `refund_method` holds, unvalidated: one the
   * ledger does not know moves no account at all (D158, copied).
   */
  async posReturn(user: RequestUser, data: unknown, context: AuditContext) {
    // `pos_return` takes no comment: one sent is validated and dropped.
    const ask = { ...(await this.asked(data)), customerComment: '' };
    const given = dataGet(data, 'refund_method');
    const method = given === undefined ? 'CASH' : given;
    const actor = { id: user.id, email: user.email };
    const opened = await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      const request = await this.requestReturn(tx, context, user, ask);
      await this.approveLocked(tx, request.id, actor, '');
      await this.receiveLocked(tx, after, request.id, actor, null);
      await this.completeLocked(tx, context, request.id, actor, {
        method: pyTruthy(method) ? textValue(method) : null,
        auditMethod: method,
      });
      return request;
    });
    await this.notify(opened);
    return this.answer(opened.id);
  }
}

interface Opened {
  id: string;
  number: string;
  orderNumber: string;
  branchId: string;
  reason: string;
}

interface OrderForReturn {
  id: string;
  number: string;
  status: string;
  channel: string;
  stock_committed: boolean;
  delivered_at: string | null;
  placed_at: string;
  subtotal: string;
  discount_total: string;
  tax_mode: string;
  shipping_total: string;
  paid_total: string;
  refunded_total: string;
  branch_id: string;
  currency: string;
  grand_total: string;
}

interface OrderLine {
  id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  quantity: number;
  returned_quantity: number;
  line_total: string;
  tax_amount: string;
}
