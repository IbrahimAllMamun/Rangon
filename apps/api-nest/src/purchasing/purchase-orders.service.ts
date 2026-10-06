import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition, type BranchRow, RolePermissions } from '../auth/permissions';
import { money, quantize, ZERO } from '../checkout/pricing';
import { type AuditContext, recordAudit } from '../common/audit';
import { parseWindow } from '../common/dates';
import { Dec } from '../common/decimal';
import {
  charField,
  choiceField,
  dateField,
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
import { Conflict, NotFound, ValidationError } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import type { QueryDict } from '../common/query-dict';
import { nextNumber } from '../common/sequence';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { dataGet } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { textValue } from '../orders/returns.service';
import {
  PO,
  PO_FROM,
  PO_SELECT,
  PurchaseDocuments,
  type PurchaseOrderRow,
  RETURN_REASONS,
} from './purchase-documents';

/**
 * `PurchaseOrderViewSet` and `purchasing.services`: an order is raised as a
 * draft, sent, received in one delivery or several -- each delivery puts the
 * goods on the shelf at what they cost -- and what is faulty goes back for a
 * credit. Nothing is edited: every step is its own record, taken under the
 * order's row lock.
 */

const STATUSES = ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'];
/** `get_status_display().lower()`. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'draft',
  SENT: 'sent to supplier',
  PARTIALLY_RECEIVED: 'partially received',
  RECEIVED: 'received',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
};
const FILTERS: readonly FilterField[] = [
  choiceFilter('status', `${PO}."status"`, STATUSES),
  modelFilter('supplier', `${PO}."supplier_id"`, 'purchasing_supplier'),
  modelFilter('branch', `${PO}."branch_id"`, 'accounts_branch'),
  choiceFilter('payment_status', `${PO}."payment_status"`, ['UNPAID', 'PARTIALLY_PAID', 'PAID']),
];
const ORDERING = { created_at: `${PO}."created_at"`, expected_at: `${PO}."expected_at"` };

const I = '"purchasing_purchaseorderitem"';
const ITEM_COLUMNS = `${I}."id", ${I}."variant_id", ${I}."quantity_ordered",
  ${I}."quantity_received", ${I}."quantity_returned", ${I}."unit_cost", ${I}."discount",
  ${I}."tax_rate"`;

interface LockedOrder {
  id: string;
  number: string;
  supplier_id: string;
  branch_id: string;
  status: string;
  grand_total: string;
  paid_total: string;
  credited_total: string;
}

interface LockedItem {
  id: string;
  variant_id: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_returned: number;
  unit_cost: string;
  discount: string;
  tax_rate: string;
  sku?: string;
}

interface OrderLine {
  variant: string;
  quantity: number | bigint;
  unit_cost: string;
  discount: string;
  tax_rate: string;
}

type Actor = { id: string; email: string };

/** A whole number as Python prints it, whatever its size. */
const whole = (value: number | bigint) => value.toString();

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly documents: PurchaseDocuments,
    private readonly stock: StockService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- Reading ---------------------------------------------------------------------------------

  /**
   * `get_queryset` and the filter backends: the user's branch, the day the
   * order was raised -- a value that is not a date is a 400 on every route --
   * then the declared filters.
   */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams) {
    const where: string[] = [];
    const scope = branchCondition(user, [`${PO}."branch_id"`], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    const [from, to] = parseWindow(query, this.env.DJANGO_TIME_ZONE);
    if (from) where.push(`${PO}."created_at" >= ${sql.add(from, 'timestamptz')}`);
    if (to) where.push(`${PO}."created_at" <= ${sql.add(to, 'timestamptz')}`);
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${PO}."created_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${PO} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<PurchaseOrderRow>(
      `SELECT ${PO_SELECT} ${PO_FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(page, await this.documents.orders(rows), absoluteUrl);
  }

  /** `get_object()`: the scoped, filtered queryset, then the key. */
  async find(user: RequestUser, pk: string, query: QueryDict): Promise<PurchaseOrderRow> {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${PO}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<PurchaseOrderRow>(
      `SELECT ${PO_SELECT} ${PO_FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  /** `retrieve`: the order, and what it brought in that nobody can buy yet. */
  async retrieve(user: RequestUser, pk: string, query: QueryDict) {
    const row = await this.find(user, pk, query);
    const [order] = await this.documents.orders([row]);
    return { ...order, unpublished_products: await this.documents.unpublishedProducts(row.id) };
  }

  /** `receipts`: the order's deliveries, newest first. */
  async receipts(user: RequestUser, pk: string, query: QueryDict) {
    const row = await this.find(user, pk, query);
    return this.documents.receipts(
      this.db,
      await this.documents.receiptRows(
        this.db,
        `"purchasing_purchasereceipt"."purchase_order_id" IN ($1)
          ORDER BY "purchasing_purchasereceipt"."received_at" DESC`,
        [row.id],
      ),
    );
  }

  // --- Raising ---------------------------------------------------------------------------------

  private exists(table: string) {
    return async (id: string) =>
      (await this.db.one(`SELECT 1 AS "a" FROM "${table}" WHERE "id" = $1 LIMIT 21`, [id])) !==
      null;
  }

  /** `_check_lines`: what makes an order's money wrong rather than merely unusual. */
  private checkLines(lines: OrderLine[], shippingTotal: string): void {
    if (!lines.length) throw new ValidationError('A purchase order needs at least one line.');
    const refuse = (field: string, message: string) => {
      throw new ValidationError(message, { details: { [field]: [message] } });
    };
    if (quantize(shippingTotal).lt(0)) refuse('shipping_total', 'Shipping cannot be negative.');
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.quantity <= 0) throw new ValidationError('Ordered quantity must be positive.');
      if (quantize(line.unit_cost).lt(0) || quantize(line.discount).lt(0))
        refuse('lines', 'Costs and discounts cannot be negative.');
      const gross = quantize(new Dec(line.unit_cost).times(whole(line.quantity)));
      if (quantize(line.discount).gt(gross))
        refuse('lines', "A line's discount cannot be more than the line itself.");
      if (seen.has(line.variant)) {
        refuse(
          'lines',
          'The same product appears on two lines; change the quantity on one instead.',
        );
      }
      seen.add(line.variant);
    }
  }

  /** `recalculate_totals`: each line's total, then the order's, from the rows as stored. */
  private async recalculate(tx: Queryable, orderId: string, shippingTotal: string): Promise<void> {
    const items = await tx.query<LockedItem>(
      `SELECT ${ITEM_COLUMNS} FROM ${I} WHERE ${I}."purchase_order_id" = $1`,
      [orderId],
    );
    let subtotal = ZERO;
    let discounts = ZERO;
    let tax = ZERO;
    for (const item of items) {
      const gross = quantize(new Dec(item.unit_cost).times(item.quantity_ordered));
      const net = gross.minus(item.discount);
      await tx.query(
        `UPDATE ${I} SET "line_total" = $2, "updated_at" = clock_timestamp() WHERE ${I}."id" = $1`,
        [item.id, money(quantize(net))],
      );
      subtotal = subtotal.plus(gross);
      discounts = discounts.plus(item.discount);
      tax = tax.plus(quantize(net.times(item.tax_rate)));
    }
    const grand = quantize(subtotal.minus(discounts).plus(tax).plus(shippingTotal));
    await tx.query(
      `UPDATE ${PO} SET "subtotal" = $2, "discount_total" = $3, "tax_total" = $4,
              "grand_total" = $5, "updated_at" = clock_timestamp() WHERE ${PO}."id" = $1`,
      [
        orderId,
        money(quantize(subtotal)),
        money(quantize(discounts)),
        money(quantize(tax)),
        money(grand),
      ],
    );
  }

  /** `create` and `create_purchase_order`: a draft, numbered, with its lines and totals. */
  async create(user: RequestUser, data: unknown) {
    const lineFields: Fields = {
      variant: uuidField(),
      quantity: integerField({ minValue: 1 }),
      unit_cost: decimalField(14, 2, { minValue: '0' }),
      discount: withDefault(decimalField(14, 2, { required: false, minValue: '0' }), () => '0.00'),
      // A fraction, not a percentage: 0.1500 is 15%.
      tax_rate: withDefault(
        decimalField(6, 4, { required: false, minValue: '0', maxValue: '1' }),
        () => '0.0000',
      ),
    };
    const validated = await runSerializer<{
      supplier: string;
      branch?: string;
      lines: OrderLine[];
      expected_at?: string | null;
      invoice_number?: string;
      shipping_total: string;
      notes?: string;
    }>(
      {
        supplier: pkRelatedField(this.exists('purchasing_supplier')),
        branch: uuidField({ required: false }),
        lines: nestedListField(lineFields),
        expected_at: dateField({ required: false, allowNull: true }),
        invoice_number: charField({ required: false, allowBlank: true, maxLength: 64 }),
        shipping_total: withDefault(
          decimalField(14, 2, { required: false, minValue: '0.00' }),
          () => '0.00',
        ),
        notes: charField({ required: false, allowBlank: true }),
      } as Fields,
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    const branch = await this.permissions.resolveBranch(user, asked.branch ?? null);

    const id = await this.db.transaction(async (tx) => {
      this.checkLines(asked.lines, asked.shipping_total);
      const orderId = randomUUID();
      const number = await nextNumber(tx, 'purchase_order', 'PO');
      const shipping = money(quantize(asked.shipping_total));
      await tx.query(
        `INSERT INTO ${PO}
           ("id", "created_at", "updated_at", "number", "supplier_id", "branch_id", "status",
            "payment_status", "invoice_number", "ordered_at", "expected_at", "completed_at",
            "subtotal", "discount_total", "tax_total", "shipping_total", "grand_total",
            "paid_total", "credited_total", "currency", "notes", "created_by_id")
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, $4::uuid, 'DRAFT',
                 'UNPAID', $5, NULL, $6::date, NULL, 0.00, 0.00, 0.00, $7, 0.00, 0.00, 0.00, 'BDT',
                 $8, $9::uuid)`,
        [
          orderId,
          number,
          asked.supplier,
          branch.id,
          asked.invoice_number ?? '',
          asked.expected_at ?? null,
          shipping,
          asked.notes ?? '',
          user.id,
        ],
      );
      for (const line of asked.lines) {
        await tx.query(
          `INSERT INTO ${I}
             ("id", "created_at", "updated_at", "purchase_order_id", "variant_id",
              "quantity_ordered", "quantity_received", "quantity_returned", "unit_cost", "discount",
              "tax_rate", "line_total")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, 0, 0, $5,
                   $6, $7, 0.00)`,
          [
            randomUUID(),
            orderId,
            line.variant,
            whole(line.quantity),
            money(quantize(line.unit_cost)),
            money(quantize(line.discount)),
            line.tax_rate,
          ],
        );
      }
      await this.recalculate(tx, orderId, shipping);
      return orderId;
    });
    return this.documents.order(id);
  }

  // --- Sending and cancelling ------------------------------------------------------------------

  /** `PurchaseOrder.objects.select_for_update().get(pk=...)`. */
  private async lockOrder(tx: Queryable, id: string): Promise<LockedOrder> {
    return (await tx.one<LockedOrder>(
      `SELECT ${PO}."id", ${PO}."number", ${PO}."supplier_id", ${PO}."branch_id", ${PO}."status",
              ${PO}."grand_total", ${PO}."paid_total", ${PO}."credited_total"
         FROM ${PO} WHERE ${PO}."id" = $1 LIMIT 21 FOR UPDATE`,
      [id],
    )) as LockedOrder;
  }

  /** `str(purchase_order)`: its number and who it is from. */
  private async label(tx: Queryable, order: LockedOrder): Promise<string> {
    const supplier = await tx.one<{ name: string }>(
      `SELECT "name" FROM "purchasing_supplier" WHERE "id" = $1 LIMIT 21`,
      [order.supplier_id],
    );
    return `${order.number} — ${supplier?.name ?? ''}`;
  }

  private now(tx: Queryable): Promise<string> {
    return tx
      .one<{ now: string }>(`SELECT clock_timestamp() AS now`)
      .then((row) => (row as { now: string }).now);
  }

  /** `send` and `send_purchase_order`: a draft goes to the supplier, decided under its row lock. */
  async send(user: RequestUser, pk: string, query: QueryDict, context: AuditContext) {
    const found = await this.find(user, pk, query);
    await this.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, found.id);
      if (order.status !== 'DRAFT') throw new Conflict('Only a draft purchase order can be sent.');
      const now = await this.now(tx);
      await tx.query(
        `UPDATE ${PO} SET "status" = 'SENT', "ordered_at" = $2::timestamptz,
                "updated_at" = clock_timestamp() WHERE ${PO}."id" = $1`,
        [order.id, now],
      );
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: { type: 'PurchaseOrder', id: order.id, label: await this.label(tx, order) },
        actor: { id: user.id, email: user.email },
        newValues: { status: 'SENT' },
        reason: 'Purchase order sent to supplier',
        branchId: order.branch_id,
      });
    });
    return this.documents.order(found.id);
  }

  /**
   * `cancel` and `cancel_purchase_order`: an order nothing has happened to
   * yet. The reason is `request.data.get("reason", "")` as sent, and goes
   * into the audit entry as a TextField takes it.
   */
  async cancel(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const found = await this.find(user, pk, query);
    const given = dataGet(data(), 'reason');
    const reason = given === undefined ? '' : given;
    await this.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, found.id);
      if (order.status === 'CANCELLED') throw new Conflict(`${order.number} is already cancelled.`);
      if (order.status !== 'DRAFT' && order.status !== 'SENT') {
        throw new Conflict(
          `A ${STATUS_WORDS[order.status] ?? order.status.toLowerCase()} purchase order cannot be cancelled.`,
          { details: { status: order.status } },
        );
      }
      const received = await tx.one(
        `SELECT 1 AS "a" FROM "purchasing_purchasereceipt"
          WHERE "purchasing_purchasereceipt"."purchase_order_id" = $1 LIMIT 1`,
        [order.id],
      );
      if (received) {
        throw new Conflict(
          'Stock has already been received against this order; close it instead of cancelling.',
        );
      }
      if (new Dec(order.paid_total).gt(0)) {
        throw new Conflict(
          `${order.paid_total} has already been paid against ${order.number}. Cancelling would ` +
            'leave that money with the supplier and on no list anywhere; receive the goods ' +
            'against this order instead.',
          { details: { paid_total: order.paid_total } },
        );
      }
      await tx.query(
        `UPDATE ${PO} SET "status" = 'CANCELLED', "updated_at" = clock_timestamp()
          WHERE ${PO}."id" = $1`,
        [order.id],
      );
      await recordAudit(tx, context, {
        action: 'UPDATE',
        entity: { type: 'PurchaseOrder', id: order.id, label: await this.label(tx, order) },
        actor: { id: user.id, email: user.email },
        newValues: { status: 'CANCELLED' },
        // `None` reaches the column, which refuses it: the whole cancel is a 409.
        reason: textValue(reason),
        branchId: order.branch_id,
      });
    });
    return this.documents.order(found.id);
  }

  // --- Receiving -------------------------------------------------------------------------------

  private async branchOf(tx: Queryable, id: string): Promise<BranchRow> {
    return (await tx.one<BranchRow>(
      `SELECT "id", "code", "name", "status", "is_default", "fulfils_online_orders"
         FROM "accounts_branch" WHERE "id" = $1 LIMIT 21`,
      [id],
    )) as BranchRow;
  }

  private async skuOf(tx: Queryable, variantId: string): Promise<string> {
    const row = await tx.one<{ sku: string }>(
      `SELECT "sku" FROM "catalog_productvariant" WHERE "id" = $1 LIMIT 21`,
      [variantId],
    );
    return row?.sku ?? '';
  }

  /**
   * `record_supplier_product`: every delivery remembers who supplied the SKU
   * and at what. The first supplier a SKU is received from becomes its
   * preferred one; after that a delivery never moves the preference.
   */
  private async recordSupplierProduct(
    tx: Queryable,
    offer: { supplierId: string; variantId: string; unitCost: string; at: string; actor: Actor },
  ): Promise<void> {
    const O = '"purchasing_supplierproduct"';
    const read = () =>
      tx.one<{ id: string; is_active: boolean }>(
        `SELECT ${O}."id", ${O}."is_active" FROM ${O}
          WHERE (${O}."supplier_id" = $1 AND ${O}."variant_id" = $2) LIMIT 21`,
        [offer.supplierId, offer.variantId],
      );
    let existing = await read();
    if (!existing) {
      const id = randomUUID();
      await tx.query('SAVEPOINT supplier_product');
      try {
        await tx.query(
          `INSERT INTO ${O} ("id", "created_at", "updated_at", "supplier_id", "variant_id",
             "supplier_sku", "last_cost", "lead_time_days", "minimum_order_quantity",
             "is_preferred", "is_active", "last_purchased_at", "notes", "created_by_id")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, '', $4,
                   NULL, 1, false, true, $5::timestamptz, '', $6::uuid)`,
          [id, offer.supplierId, offer.variantId, offer.unitCost, offer.at, offer.actor.id],
        );
        await tx.query('RELEASE SAVEPOINT supplier_product');
      } catch (error) {
        if (!String((error as { code?: string }).code).startsWith('23')) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT supplier_product');
        existing = await read();
        if (!existing) throw error;
      }
      if (!existing) {
        const already = await tx.one(
          `SELECT 1 AS "a" FROM ${O}
            WHERE (${O}."is_preferred" AND ${O}."variant_id" = $1 AND NOT (${O}."id" = $2))
            LIMIT 1`,
          [offer.variantId, id],
        );
        if (!already) {
          await tx.query(
            `UPDATE ${O} SET "is_preferred" = true, "updated_at" = clock_timestamp()
              WHERE ${O}."id" = $1`,
            [id],
          );
        }
        return;
      }
    }
    // A delivery from a supplier marked discontinued means they are not.
    await tx.query(
      `UPDATE ${O} SET "last_cost" = $2, "updated_at" = clock_timestamp(),
              "last_purchased_at" = $3::timestamptz${existing.is_active ? '' : ', "is_active" = true'}
        WHERE ${O}."id" = $1`,
      [existing.id, offer.unitCost, offer.at],
    );
  }

  /** `_refresh_receipt_status`: received in full, in part, or not yet -- written every time. */
  private async refreshReceiptStatus(tx: Queryable, order: LockedOrder): Promise<string> {
    const items = await tx.query<LockedItem>(
      `SELECT ${ITEM_COLUMNS} FROM ${I} WHERE ${I}."purchase_order_id" = $1`,
      [order.id],
    );
    let status = order.status;
    let completedAt: string | null = null;
    if (items.every((item) => item.quantity_received >= item.quantity_ordered)) {
      status = 'RECEIVED';
      completedAt = await this.now(tx);
    } else if (items.some((item) => item.quantity_received > 0)) {
      status = 'PARTIALLY_RECEIVED';
    }
    await tx.query(
      `UPDATE ${PO} SET "status" = $2, "completed_at" = COALESCE($3::timestamptz, "completed_at"),
              "updated_at" = clock_timestamp() WHERE ${PO}."id" = $1`,
      [order.id, status, completedAt],
    );
    return status;
  }

  /**
   * `receive` and `receive_purchase`: one delivery. The body is validated
   * before the order is looked for. Under the order's lock and its lines':
   * a receipt, numbered; each line checked against what is still to come,
   * then put on the shelf at the cost on the delivery note (else the
   * order's), which moves the branch's average; the line's received count;
   * the supplier's price list. Then the order's status, and the audit entry.
   */
  async receive(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      lines: { item: string; quantity: number | bigint; unit_cost?: string | null }[];
      notes?: string;
    }>(
      {
        lines: nestedListField({
          item: uuidField(),
          quantity: integerField({ minValue: 1 }),
          unit_cost: decimalField(14, 2, { required: false, allowNull: true }),
        }),
        notes: charField({ required: false, allowBlank: true }),
      } as Fields,
      data,
      {
        hooks: {
          // A line named twice used to keep only its last quantity (D83).
          lines: (lines: { item: string }[]) => {
            if (new Set(lines.map((line) => line.item)).size !== lines.length) {
              throw Invalid.of(
                'The same order line appears twice in this delivery; enter its total once.',
              );
            }
            return lines;
          },
        },
      },
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const { lines } = validated.values;
    const notes = validated.values.notes ?? '';
    const found = await this.find(user, pk, query);
    const actor = { id: user.id, email: user.email };

    const receiptId = await this.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, found.id);
      if (order.status === 'CANCELLED' || order.status === 'CLOSED')
        throw new Conflict(`A ${order.status} purchase order cannot receive stock.`);
      if (!lines.length) throw new ValidationError('Nothing to receive.');

      const id = randomUUID();
      const number = await nextNumber(tx, 'purchase_receipt', 'GRN');
      const receivedAt = await this.now(tx);
      await tx.query(
        `INSERT INTO "purchasing_purchasereceipt"
           ("id", "created_at", "updated_at", "number", "purchase_order_id", "received_at",
            "received_by_id", "notes", "is_posted")
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, $4::timestamptz,
                 $5::uuid, $6, false)`,
        [id, number, order.id, receivedAt, actor.id, notes],
      );
      const items = new Map(
        (
          await tx.query<LockedItem>(
            `SELECT ${ITEM_COLUMNS} FROM ${I} WHERE ${I}."purchase_order_id" = $1 FOR UPDATE`,
            [order.id],
          )
        ).map((item) => [item.id, item]),
      );
      const branch = await this.branchOf(tx, order.branch_id);

      for (const line of lines) {
        const item = items.get(line.item);
        if (!item)
          throw new ValidationError(`Line ${line.item} does not belong to ${order.number}.`);
        const outstanding = item.quantity_ordered - item.quantity_received;
        if (line.quantity > outstanding) {
          throw new ValidationError(
            `Cannot receive ${whole(line.quantity)} of ${await this.skuOf(tx, item.variant_id)}: ` +
              `only ${outstanding} outstanding.`,
            { details: { item_id: item.id, requested: line.quantity, outstanding } },
          );
        }
        const quantity = Number(line.quantity);
        const unitCost = money(quantize(line.unit_cost ?? item.unit_cost));
        await tx.query(
          `INSERT INTO "purchasing_purchasereceiptitem"
             ("id", "created_at", "updated_at", "receipt_id", "purchase_order_item_id", "quantity",
              "unit_cost")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5)`,
          [randomUUID(), id, item.id, quantity, unitCost],
        );
        await this.stock.receiveStock(tx, {
          branch,
          variantId: item.variant_id,
          quantity,
          unitCost,
          actor,
          referenceType: 'purchase_receipt',
          referenceId: id,
          notes: `${order.number} / ${number}`,
        });
        item.quantity_received += quantity;
        await tx.query(
          `UPDATE ${I} SET "quantity_received" = $2, "updated_at" = clock_timestamp()
            WHERE ${I}."id" = $1`,
          [item.id, item.quantity_received],
        );
        await this.recordSupplierProduct(tx, {
          supplierId: order.supplier_id,
          variantId: item.variant_id,
          unitCost,
          at: receivedAt,
          actor,
        });
      }

      await tx.query(
        `UPDATE "purchasing_purchasereceipt" SET "is_posted" = true, "updated_at" = clock_timestamp()
          WHERE "id" = $1`,
        [id],
      );
      const status = await this.refreshReceiptStatus(tx, order);
      await recordAudit(tx, context, {
        action: 'PURCHASE_RECEIVED',
        entity: { type: 'PurchaseOrder', id: order.id, label: await this.label(tx, order) },
        actor,
        newValues: { receipt: number, lines: lines.length, status },
        reason: notes || 'Stock received',
        branchId: order.branch_id,
      });
      return id;
    });

    const [receipt] = await this.documents.receipts(
      this.db,
      await this.documents.receiptRows(this.db, `"purchasing_purchasereceipt"."id" = $1`, [
        receiptId,
      ]),
    );
    return { receipt, purchase_order: await this.documents.order(found.id) };
  }

  // --- Sending goods back ----------------------------------------------------------------------

  private async returnByKey(tx: Queryable, key: string): Promise<string | null> {
    const row = await tx.one<{ id: string }>(
      `SELECT "id" FROM "purchasing_purchasereturn"
        WHERE "purchasing_purchasereturn"."idempotency_key" = $1
        ORDER BY "purchasing_purchasereturn"."returned_at" DESC LIMIT 1`,
      [key],
    );
    return row?.id ?? null;
  }

  /** `_refresh_payment_status`: cash paid sets the badge; credit counts only towards settling in full. */
  async refreshPaymentStatus(
    tx: Queryable,
    order: { id: string; grand_total: string; paid_total: string; credited_total: string },
  ): Promise<void> {
    const paid = new Dec(order.paid_total);
    const status = paid.plus(order.credited_total).gte(order.grand_total)
      ? 'PAID'
      : paid.gt(0)
        ? 'PARTIALLY_PAID'
        : 'UNPAID';
    await tx.query(
      `UPDATE ${PO} SET "payment_status" = $2, "updated_at" = clock_timestamp()
        WHERE ${PO}."id" = $1`,
      [order.id, status],
    );
  }

  /**
   * `purchase_return` and `create_purchase_return`: received goods sent back.
   * Once per `Idempotency-Key`, looked for under the order's lock and claimed
   * by the return's own row in a savepoint. Each line leaves the shelf
   * through the ledger at the cost on the order, the line remembers what went
   * back, and the order is credited with the sum.
   */
  async purchaseReturn(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      lines: { item: string; quantity: number | bigint }[];
      reason: string;
      notes?: string;
    }>(
      {
        lines: nestedListField({ item: uuidField(), quantity: integerField({ minValue: 1 }) }),
        reason: choiceField(Object.keys(RETURN_REASONS)),
        notes: charField({ required: false, allowBlank: true }),
      } as Fields,
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const { lines, reason } = validated.values;
    const notes = validated.values.notes ?? '';
    const found = await this.find(user, pk, query);
    const actor = { id: user.id, email: user.email };
    const key = idempotencyKey || null;

    const returnId = await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      const order = await this.lockOrder(tx, found.id);
      if (key) {
        const existing = await this.returnByKey(tx, key);
        if (existing) return existing;
      }
      if (order.status === 'DRAFT' || order.status === 'CANCELLED') {
        throw new Conflict(
          `A ${order.status} purchase order has received nothing, so nothing can be sent back.`,
        );
      }
      if (!lines.length) throw new ValidationError('Nothing to return.');

      // `select_for_update().select_related("variant")`: the lines and their variants both.
      const items = new Map(
        (
          await tx.query<LockedItem>(
            `SELECT ${ITEM_COLUMNS}, "catalog_productvariant"."sku" FROM ${I}
              INNER JOIN "catalog_productvariant"
                ON (${I}."variant_id" = "catalog_productvariant"."id")
              WHERE ${I}."purchase_order_id" = $1 FOR UPDATE`,
            [order.id],
          )
        ).map((item) => [item.id, item]),
      );

      const id = randomUUID();
      let number: string;
      await tx.query('SAVEPOINT purchase_return');
      try {
        number = await nextNumber(tx, 'purchase_return', 'PRN');
        const returnedAt = await this.now(tx);
        await tx.query(
          `INSERT INTO "purchasing_purchasereturn"
             ("id", "created_at", "updated_at", "number", "purchase_order_id", "reason", "notes",
              "returned_at", "returned_by_id", "credit_total", "idempotency_key")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3::uuid, $4, $5,
                   $6::timestamptz, $7::uuid, 0.00, $8)`,
          [id, number, order.id, reason, notes, returnedAt, actor.id, key],
        );
        await tx.query('RELEASE SAVEPOINT purchase_return');
      } catch (error) {
        if (!String((error as { code?: string }).code).startsWith('23')) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT purchase_return');
        const winner = key === null ? null : await this.returnByKey(tx, key);
        if (winner) return winner;
        throw error;
      }
      const branch = await this.branchOf(tx, order.branch_id);

      let credit = ZERO;
      for (const line of lines) {
        const item = items.get(line.item);
        if (!item)
          throw new ValidationError(`Line ${line.item} does not belong to ${order.number}.`);
        const returnable = item.quantity_received - item.quantity_returned;
        if (line.quantity > returnable) {
          throw new ValidationError(
            `Cannot return ${whole(line.quantity)} of ${item.sku}: only ${returnable} received ` +
              'and not already sent back.',
            { details: { item_id: item.id, requested: line.quantity, returnable } },
          );
        }
        const quantity = Number(line.quantity);
        const unitCost = quantize(item.unit_cost);
        await tx.query(
          `INSERT INTO "purchasing_purchasereturnitem"
             ("id", "created_at", "updated_at", "purchase_return_id", "purchase_order_item_id",
              "quantity", "unit_cost")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5)`,
          [randomUUID(), id, item.id, quantity, money(unitCost)],
        );
        await this.stock.returnToSupplier(tx, after, context, {
          branch,
          variantId: item.variant_id,
          quantity,
          unitCost: money(unitCost),
          actor,
          referenceType: 'purchase_return',
          referenceId: id,
          notes: `${order.number} / ${number}`,
        });
        item.quantity_returned += quantity;
        await tx.query(
          `UPDATE ${I} SET "quantity_returned" = $2, "updated_at" = clock_timestamp()
            WHERE ${I}."id" = $1`,
          [item.id, item.quantity_returned],
        );
        credit = credit.plus(quantize(unitCost.times(quantity)));
      }

      const creditTotal = quantize(credit);
      await tx.query(
        `UPDATE "purchasing_purchasereturn" SET "credit_total" = $2, "updated_at" = clock_timestamp()
          WHERE "id" = $1`,
        [id, money(creditTotal)],
      );
      const credited = quantize(new Dec(order.credited_total).plus(credit));
      await tx.query(
        `UPDATE ${PO} SET "credited_total" = $2, "updated_at" = clock_timestamp()
          WHERE ${PO}."id" = $1`,
        [order.id, money(credited)],
      );
      await this.refreshPaymentStatus(tx, { ...order, credited_total: money(credited) });
      await recordAudit(tx, context, {
        action: 'PURCHASE_RECEIVED',
        entity: { type: 'PurchaseOrder', id: order.id, label: await this.label(tx, order) },
        actor,
        oldValues: { credited_total: money(credited.minus(credit)) },
        newValues: {
          return: number,
          credit: money(creditTotal),
          credited_total: money(credited),
        },
        reason: notes || `Returned to supplier: ${reason}`,
        branchId: order.branch_id,
      });
      return id;
    });

    const rows = await this.documents.returnRows(this.db, `"purchasing_purchasereturn"."id" = $1`, [
      returnId,
    ]);
    const [purchaseReturn] = await this.documents.returns(this.db, rows);
    return {
      purchase_return: purchaseReturn,
      purchase_order: await this.documents.order(rows[0]?.purchase_order_id as string),
    };
  }
}
