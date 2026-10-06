import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { type BranchRow, RolePermissions } from '../auth/permissions';
import { CouponsService } from '../checkout/coupons.service';
import { NoticesService } from '../checkout/notices.service';
import { lineTotal, money, quantize, ZERO } from '../checkout/pricing';
import { AuditContext, recordAudit } from '../common/audit';
import {
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  nestedListField,
  pkRelatedField,
  runSerializer,
} from '../common/drf';
import { Conflict, NotFound, PriceChanged, ValidationError } from '../common/errors';
import { Dec } from '../common/decimal';
import { pySlice, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { nextNumber } from '../common/sequence';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { dataGet, pythonTypeName } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { OrderPayments } from '../orders/order-payments.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { type StaffOrderRow, StaffOrders } from '../orders/staff-order.service';
import { BASKET_FIELDS, BASKET_RULES, type BasketData, basketInput } from './pos-counter.service';
import { type CustomerRow, SalePricing } from './sale-pricing.service';

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

interface PaymentData {
  method: string;
  amount: string;
  tendered_amount?: string | null;
  reference?: string;
  account?: string | null;
}

interface SaleData extends BasketData {
  payments: PaymentData[];
  register?: string;
  note?: string;
  expected_total?: string | null;
}

/**
 * `OrderingFilter` over `PosSaleSerializer`'s fields, which is what the
 * viewset offers when it names no `ordering_fields`: some are fields of an
 * order, and the rest are not on the model at all -- `order_by` refuses
 * those (D148).
 */
const ORDERING_NOT_A_FIELD = new Set([
  'lines',
  'manual_discount_percent',
  'coupon_code',
  'approval_token',
  'note',
  'expected_total',
]);
const ORDERING_FIELDS = new Set([
  ...ORDERING_NOT_A_FIELD,
  'customer',
  'manual_discount',
  'branch',
  'payments',
  'register',
]);

/**
 * `PosSaleViewSet` and `orders.services.pos.create_pos_sale`: a completed
 * counter sale -- stock out, money in, receipt ready -- in one transaction.
 */
@Injectable()
export class PosSales {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly pricing: SalePricing,
    private readonly stock: StockService,
    private readonly coupons: CouponsService,
    private readonly payments: OrderPayments,
    private readonly orders: OrderWritesService,
    private readonly notices: NoticesService,
    private readonly staffOrders: StaffOrders,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `PosSaleSerializer`: the basket, and how it was paid for. */
  private fields(): Fields {
    return {
      ...BASKET_FIELDS,
      payments: nestedListField({
        method: choiceField(PAYMENT_METHODS),
        amount: decimalField(14, 2, { minValue: '0' }),
        tendered_amount: decimalField(14, 2, { required: false, allowNull: true }),
        reference: charField({ required: false, allowBlank: true, maxLength: 128 }),
        account: pkRelatedField(
          async (id) =>
            (await this.db.one(
              `SELECT 1 AS "a" FROM "finance_account"
                WHERE ("finance_account"."is_active" AND "finance_account"."id" = $1) LIMIT 1`,
              [id],
            )) !== null,
          { required: false, allowNull: true },
        ),
      }),
      register: charField({ required: false, allowBlank: true, maxLength: 32 }),
      note: charField({ required: false, allowBlank: true }),
      expected_total: decimalField(14, 2, { required: false, allowNull: true }),
    };
  }

  /** The order a retry of this key already made: `Order.objects.filter(idempotency_key=key).first()`. */
  private async byKey(q: Queryable, key: string | null): Promise<string | null> {
    const row = await q.one<{ id: string }>(
      `SELECT "id" FROM "orders_order"
        WHERE "orders_order"."idempotency_key" ${key === null ? 'IS NULL' : '= $1'}
        ORDER BY "orders_order"."placed_at" DESC LIMIT 1`,
      key === null ? [] : [key],
    );
    return row?.id ?? null;
  }

  /**
   * `walk_in_customer`: every order needs a customer, and an anonymous
   * counter sale takes the branch's walk-in record -- made on first use,
   * under its unique index, so two registers at once share one row.
   */
  private async walkInCustomer(tx: Queryable, branch: BranchRow): Promise<string> {
    const name = `Walk-in (${branch.code})`;
    const find = () =>
      tx.one<{ id: string }>(
        `SELECT "id" FROM "customers_customer"
          WHERE ("customers_customer"."is_walk_in" AND "customers_customer"."name" = $1) LIMIT 21`,
        [name],
      );
    const found = await find();
    if (found) return found.id;
    const id = randomUUID();
    await tx.query('SAVEPOINT walk_in_customer');
    try {
      await tx.query(
        `INSERT INTO customers_customer
           (id, created_at, updated_at, name, phone, email, customer_type, is_walk_in, is_active,
            date_of_birth, notes, tags, total_orders, total_spent, loyalty_points, last_order_at,
            created_by_id, user_id)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, NULL, NULL, 'WALK_IN', true, true,
                 NULL, '', '[]'::jsonb, 0, 0, 0, NULL, NULL, NULL)`,
        [id, name],
      );
      await tx.query('RELEASE SAVEPOINT walk_in_customer');
      return id;
    } catch (error) {
      if (!String((error as { code?: string }).code).startsWith('23')) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT walk_in_customer');
      const winner = await find();
      if (!winner) throw error;
      return winner.id;
    }
  }

  /**
   * `shortages.flag_short_orders`: where the owner lets the counter take
   * reserved units, the online orders that lost them -- the newest first --
   * get an entry on their timeline staff see and the customer does not, and
   * a notice to everyone who handles orders at the branch.
   */
  private async flagShortOrders(
    tx: Queryable,
    branch: BranchRow,
    lines: readonly [variantId: string, quantity: number | bigint][],
    sale: { number: string },
    actorId: string,
  ): Promise<void> {
    const sold = new Map<string, bigint>();
    for (const [variantId, quantity] of lines)
      sold.set(variantId, (sold.get(variantId) ?? 0n) + BigInt(quantity));
    const inventories = await tx.query<{
      variant_id: string;
      on_hand: number;
      reserved: number;
      sku: string;
    }>(
      `SELECT "inventory_inventory"."variant_id", "inventory_inventory"."on_hand",
              "inventory_inventory"."reserved", "catalog_productvariant"."sku"
         FROM "inventory_inventory"
        INNER JOIN "catalog_productvariant"
           ON ("inventory_inventory"."variant_id" = "catalog_productvariant"."id")
        WHERE ("inventory_inventory"."branch_id" = $1
               AND "inventory_inventory"."variant_id" = ANY($2::uuid[]))`,
      [branch.id, [...sold.keys()]],
    );
    for (const inventory of inventories) {
      const available = BigInt(inventory.on_hand - inventory.reserved);
      const zero = 0n;
      const shortAfter = -available > zero ? -available : zero;
      const before = -(available + (sold.get(inventory.variant_id) as bigint));
      const shortBefore = before > zero ? before : zero;
      if (shortAfter <= shortBefore) continue;

      // `_held_by_order`: each order's net reservation of the variant, from the ledger.
      const held = new Map(
        (
          await tx.query<{ reference_id: string; held: string }>(
            `SELECT "inventory_inventorytransaction"."reference_id",
                    SUM("inventory_inventorytransaction"."quantity") AS "held"
               FROM "inventory_inventorytransaction"
              WHERE ("inventory_inventorytransaction"."branch_id" = $1
                     AND "inventory_inventorytransaction"."reference_type" = 'order'
                     AND "inventory_inventorytransaction"."transaction_type"
                         IN ('RESERVATION', 'RESERVATION_RELEASE')
                     AND "inventory_inventorytransaction"."variant_id" = $2)
              GROUP BY "inventory_inventorytransaction"."reference_id"
             HAVING SUM("inventory_inventorytransaction"."quantity") > 0`,
            [branch.id, inventory.variant_id],
          )
        ).map((row) => [row.reference_id, BigInt(row.held)]),
      );
      const ids = [...held.keys()].map((id) => parseUuid(id)).filter(Boolean);
      const orders = ids.length
        ? await tx.query<{ id: string; number: string }>(
            `SELECT "id", "number" FROM "orders_order" WHERE "orders_order"."id" = ANY($1::uuid[])
              ORDER BY "orders_order"."placed_at" DESC, "orders_order"."created_at" DESC`,
            [ids],
          )
        : [];
      // Newest first: the first `shortBefore` units were already short.
      let covered = zero;
      for (const order of orders) {
        if (covered >= shortAfter) break;
        const units = held.get(order.id) as bigint;
        const start = covered;
        const end = covered + units;
        covered = end;
        const lost =
          (end < shortAfter ? end : shortAfter) - (start > shortBefore ? start : shortBefore);
        if (lost <= zero) continue;
        const sku = inventory.sku;
        await this.orders.logEvent(
          tx,
          order.id,
          'STOCK_SHORT',
          `${lost} × ${sku} reserved for this order was sold at the counter ` +
            `(${sale.number}). Restock or contact the customer before packing.`,
          {
            data: { sku, short: Number(lost), counter_sale: sale.number },
            customerVisible: false,
            actorId,
          },
        );
        await this.notices.notifyStaff(
          {
            type: 'ORDER_STOCK_SHORT',
            title: `Order ${order.number} is short ${lost} × ${sku}`,
            body:
              `The counter sold units reserved for this order (${sale.number}) at ` +
              `${branch.code}. Restock or contact the customer before packing.`,
            permission: 'orders.view',
            branchId: branch.id,
            link: `/admin/orders/${order.id}`,
            level: 'WARNING',
            data: { order: order.number, sku, short: Number(lost) },
          },
          tx,
        );
      }
    }
  }

  /**
   * `PosSaleViewSet.create`. An `Idempotency-Key` already used answers with
   * the sale it made; so does one that loses a race for it.
   */
  async create(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const validated = await runSerializer<SaleData>(this.fields(), data, BASKET_RULES);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const sale = validated.values;
    const branch = await this.permissions.resolveBranch(user, sale.branch ?? null);
    const actor = { id: user.id, email: user.email };

    const orderId = await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      if (idempotencyKey) {
        const existing = await this.byKey(tx, idempotencyKey);
        if (existing) return existing;
      }

      const quote = await this.pricing.priceSale(branch, user, basketInput(sale));
      const priced = quote.priced;
      const expected = sale.expected_total;
      if (expected !== null && expected !== undefined) {
        if (!quantize(expected).eq(priced.grandTotal)) {
          throw new PriceChanged('The total has changed since the register showed it.', {
            details: { expected: money(quantize(expected)), actual: money(priced.grandTotal) },
          });
        }
      }

      const customer: CustomerRow | null = quote.customer;
      const customerId = customer?.id ?? (await this.walkInCustomer(tx, branch));

      // Under a savepoint: a retry that loses the race for its key answers
      // with the winner's sale instead of failing (D90).
      const id = randomUUID();
      let number: string;
      await tx.query('SAVEPOINT pos_sale');
      try {
        number = await nextNumber(tx, 'order:POS', 'RGN-POS');
        await tx.query(
          `INSERT INTO orders_order
             (id, created_at, updated_at, number, channel, status, payment_status, branch_id,
              customer_id, created_by_id, register, subtotal, coupon_discount, manual_discount,
              discount_total, tax_total, tax_rate, tax_mode, shipping_total, grand_total, paid_total,
              refunded_total, currency, coupon_id, shipping_method_id, shipping_address,
              billing_address, customer_note, internal_note, idempotency_key, guest_token, placed_at,
              confirmed_at, packed_at, shipped_at, delivered_at, cancelled_at, cancel_reason,
              stock_committed)
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, 'POS', 'DELIVERED', 'UNPAID',
                   $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13, 0.00, $14, 0.00,
                   0.00, $15, $16::uuid, NULL, '{}'::jsonb, '{}'::jsonb, $17, '', $18, '',
                   clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), NULL, '', true)`,
          [
            id,
            number,
            branch.id,
            customerId,
            user.id,
            sale.register ?? '',
            money(priced.subtotal),
            money(priced.couponDiscount),
            money(priced.manualDiscount),
            money(priced.discountTotal),
            money(priced.taxTotal),
            quote.taxRateText,
            priced.taxMode,
            money(priced.grandTotal),
            this.env.RANGON_CURRENCY,
            quote.coupon?.id ?? null,
            sale.note ?? '',
            idempotencyKey,
          ],
        );
        await tx.query('RELEASE SAVEPOINT pos_sale');
      } catch (error) {
        if (!String((error as { code?: string }).code).startsWith('23')) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT pos_sale');
        const winner = await this.byKey(tx, idempotencyKey);
        if (winner) return winner;
        throw error;
      }

      for (const line of priced.lines) {
        await tx.query(
          `INSERT INTO orders_orderitem
             (id, created_at, updated_at, order_id, variant_id, sku, product_name, variant_label,
              quantity, unit_price, unit_cost, line_discount, tax_amount, line_total,
              fulfilled_quantity, returned_quantity)
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6, $7,
                   $8, $9, $10, $11, $12, $7, 0)`,
          [
            randomUUID(),
            id,
            line.variant.id,
            line.variant.sku,
            line.variant.productName,
            await line.variant.label(),
            line.quantity.toString(),
            money(line.unitPrice),
            money(line.unitCost),
            money(line.lineDiscount),
            money(line.taxAmount),
            money(lineTotal(line)),
          ],
        );
      }

      // Stock out, under the row lock: this is where an oversell is caught.
      const sold = priced.lines.map(
        (line) => [line.variant.id, line.quantity] as [string, number | bigint],
      );
      await this.stock.sell(tx, after, {
        branch,
        lines: sold,
        actor,
        referenceType: 'order',
        referenceId: id,
      });
      await this.flagShortOrders(tx, branch, sold, { number }, user.id);

      // The coupon's use, counted after the stock: every sale takes the
      // inventory rows first and the coupon row second.
      if (quote.coupon)
        await this.coupons.redeem(
          tx,
          quote.coupon.id,
          id,
          priced.couponDiscount,
          customer?.id ?? null,
        );

      const order = {
        id,
        number,
        branchId: branch.id,
        branchCode: branch.code,
        currency: this.env.RANGON_CURRENCY,
        grandTotal: money(priced.grandTotal),
      };
      let paid = ZERO;
      for (const payment of sale.payments) {
        const amount = quantize(payment.amount);
        if (amount.lte(ZERO)) continue;
        await this.payments.recordCaptured(
          tx,
          context,
          order,
          {
            method: payment.method,
            amount,
            tenderedAmount: payment.tendered_amount ?? null,
            reference: payment.reference ?? '',
            accountId: payment.account ?? null,
          },
          actor,
        );
        paid = paid.plus(amount);
      }
      if (paid.lt(priced.grandTotal)) {
        throw new ValidationError('Payment does not cover the sale total.', {
          details: { total: money(priced.grandTotal), paid: money(quantize(paid)) },
        });
      }

      // `_touch_customer`: from the figures read when the sale was priced.
      const placedAt = (
        (await tx.one<{ placed_at: string }>(
          `SELECT "placed_at" FROM "orders_order" WHERE "id" = $1`,
          [id],
        )) as { placed_at: string }
      ).placed_at;
      if (customer) {
        await tx.query(
          `UPDATE "customers_customer" SET "total_orders" = $2, "total_spent" = $3,
                  "last_order_at" = $4::timestamptz WHERE "customers_customer"."id" = $1`,
          [
            customer.id,
            customer.total_orders + 1,
            money(quantize(priced.grandTotal.plus(customer.total_spent))),
            placedAt,
          ],
        );
      }

      // A lead chased by phone is usually rung up at the counter.
      await this.notices.recoverLead(tx, {
        id,
        customerPhone: customer?.phone ?? null,
        shippingPhone: undefined,
      });

      const couponCode = quote.coupon?.code ?? '';
      await this.orders.logEvent(tx, id, 'CREATED', `POS sale at ${branch.code}`, {
        data: { register: sale.register ?? '', items: priced.lines.length, coupon: couponCode },
        actorId: user.id,
      });
      if (quote.override) {
        await recordAudit(tx, context, {
          action: 'DISCOUNT_OVERRIDE',
          entity: { type: 'Order', id, label: number },
          actor,
          newValues: {
            discount: money(quote.override.discount),
            percent: money(quote.override.percent),
            threshold: quote.override.threshold,
            approved_by: quote.override.approver.email,
          },
          reason: 'Discount above threshold approved',
          // The till's branch: an override is that shop's business (D95).
          branchId: branch.id,
        });
      }
      await recordAudit(tx, context, {
        action: 'SALE_CREATED',
        entity: { type: 'Order', id, label: number },
        actor,
        newValues: {
          number,
          total: money(priced.grandTotal),
          items: priced.lines.length,
          register: sale.register ?? '',
          discount_total: money(priced.discountTotal),
          coupon: couponCode,
        },
        branchId: branch.id,
      });
      return id;
    });
    return this.staffOrders.detail((await this.staffOrders.byId(orderId)) as StaffOrderRow);
  }

  /**
   * `get_object()`: any order by id. The viewset names no `ordering_fields`,
   * so `?ordering=` takes the sale serializer's field names, and one that is
   * not a column of an order fails as Django builds the query (D148,
   * copied). One that is -- `payments` too -- changes nothing: `get()` drops
   * the ordering.
   */
  async find(pk: string, query: QueryDict): Promise<StaffOrderRow> {
    const terms = (query.get('ordering') ?? '')
      .split(',')
      .map((term) => pyStrip(term))
      .map((term) => (term.startsWith('-') ? term.slice(1) : term))
      .filter((term) => ORDERING_FIELDS.has(term));
    if (terms.some((term) => ORDERING_NOT_A_FIELD.has(term)))
      throw new Error(`Cannot resolve keyword '${terms[0]}' into field.`);
    const id = parseUuid(pk);
    const order = id ? await this.staffOrders.byId(id) : null;
    if (!order) throw new NotFound();
    return order;
  }

  /**
   * `void`: `void_sale`. The sale is never deleted: the goods go back on the
   * shelf under a compensating RETURN, whatever was paid and not yet refunded
   * goes back through `refund_order`, the coupon's use is released, and the
   * order is cancelled. A sale already cancelled answers as it is. The checks
   * are made on the order as read, before its row is locked (D154, copied).
   */
  async void(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const found = await this.find(pk, query);
    // `request.data.get("reason", "")`, then `reason.strip()`: anything but a str fails.
    const given = dataGet(data(), 'reason');
    const reason = given === undefined ? '' : given;
    if (found.channel !== 'POS')
      throw new Conflict('Only a POS sale can be voided; use returns for online orders.');
    if (found.status === 'CANCELLED') return this.staffOrders.detail(found);
    if (typeof reason !== 'string')
      throw new TypeError(`'${pythonTypeName(reason)}' object has no attribute 'strip'`);
    if (!pyStrip(reason)) throw new ValidationError('A reason is required to void a sale.');
    const actor = { id: user.id, email: user.email };

    await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      const order = (await tx.one<{
        id: string;
        number: string;
        branch_id: string;
        paid_total: string;
        refunded_total: string;
      }>(
        `SELECT "id", "number", "branch_id", "paid_total", "refunded_total" FROM "orders_order"
          WHERE "orders_order"."id" = $1 LIMIT 21 FOR UPDATE`,
        [found.id],
      )) as {
        id: string;
        number: string;
        branch_id: string;
        paid_total: string;
        refunded_total: string;
      };
      const branch = (await tx.one<{ id: string; code: string }>(
        `SELECT "id", "code" FROM "accounts_branch" WHERE "accounts_branch"."id" = $1 LIMIT 21`,
        [order.branch_id],
      )) as { id: string; code: string };
      const items = await tx.query<{ variant_id: string; quantity: number }>(
        `SELECT "variant_id", "quantity" FROM "orders_orderitem"
          WHERE "orders_orderitem"."order_id" = $1 ORDER BY "orders_orderitem"."created_at" ASC`,
        [order.id],
      );
      await this.stock.restockReturn(tx, after, {
        branch,
        lines: items.map((item) => [item.variant_id, item.quantity] as [string, number]),
        actor,
        referenceType: 'order_void',
        referenceId: order.id,
        reason: `Sale ${order.number} voided: ${reason}`,
      });

      const owed = new Dec(order.paid_total).minus(order.refunded_total);
      if (owed.gt(0)) {
        await this.payments.refundOrder(tx, context, order.id, {
          amount: owed,
          actor,
          reason: `Sale voided: ${reason}`,
        });
      }
      // Goods back, money back -- so the coupon's use comes back too.
      await this.coupons.release(tx, order.id);

      await tx.query(
        `UPDATE "orders_order" SET "updated_at" = clock_timestamp(), "status" = 'CANCELLED',
                "cancelled_at" = clock_timestamp(), "cancel_reason" = $2, "stock_committed" = false
          WHERE "orders_order"."id" = $1`,
        [order.id, pySlice(reason, 255)],
      );
      await this.orders.logEvent(tx, order.id, 'CANCELLED', `Sale voided: ${reason}`, {
        actorId: user.id,
      });
      await recordAudit(tx, context, {
        action: 'ORDER_CANCELLED',
        entity: { type: 'Order', id: order.id, label: order.number },
        actor,
        oldValues: { status: 'DELIVERED' },
        newValues: { status: 'CANCELLED' },
        reason,
        branchId: order.branch_id,
      });
    });
    return this.staffOrders.detail((await this.staffOrders.byId(found.id)) as StaffOrderRow);
  }

  /** `retrieve`. */
  async retrieve(pk: string, query: QueryDict) {
    return this.staffOrders.detail(await this.find(pk, query));
  }

  /** `receipt`: the order, the shop and the till it was rung up at, for the printed slip. */
  async receipt(pk: string, query: QueryDict) {
    const order = await this.find(pk, query);
    const organization = await this.db.one<{
      name: string;
      address: string;
      phone: string;
      email: string;
      vat_registration: string;
      receipt_footer: string;
    }>(
      `SELECT "name", "address", "phone", "email", "vat_registration", "receipt_footer"
         FROM "accounts_organization" WHERE "accounts_organization"."status" = 'ACTIVE'
        ORDER BY "accounts_organization"."created_at" ASC LIMIT 1`,
    );
    const branch = await this.db.one<{
      name: string;
      code: string;
      address: string;
      phone: string;
    }>(`SELECT "name", "code", "address", "phone" FROM "accounts_branch" WHERE "id" = $1`, [
      order.branch_id,
    ]);
    const cashier = order.created_by_id ? await this.pricing.staffName(order.created_by_id) : '';
    return {
      order: await this.staffOrders.detail(order),
      document_type: 'RECEIPT',
      organization: organization
        ? {
            name: organization.name,
            address: organization.address,
            phone: organization.phone,
            email: organization.email,
            vat_registration: organization.vat_registration,
            receipt_footer: organization.receipt_footer,
          }
        : {},
      branch: {
        name: branch?.name,
        code: branch?.code,
        address: branch?.address,
        phone: branch?.phone,
      },
      cashier,
    };
  }
}
