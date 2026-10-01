import { randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { OrganizationService } from '../accounts/organization.service';
import { AuditContext, recordAudit } from '../common/audit';
import {
  bangladeshiPhoneField,
  charField,
  choiceField,
  decimalField,
  dictField,
  emailField,
  Errors,
  errorMessages,
  Fields,
  InvalidNested,
  runSerializer,
  uuidField,
} from '../common/drf';
import { Dec } from '../common/decimal';
import { Conflict, CouponInvalid, PriceChanged, ValidationError } from '../common/errors';
import { canonicalPhone, INVALID_PHONE_MESSAGE, normalizePhone } from '../common/phone';
import { pyStr, pyStrip } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database, Queryable, Transaction } from '../database/database.service';
import { StockService } from '../inventory/stock.service';
import { CeleryService } from '../jobs/celery.service';
import { OrderRef, OrderWritesService } from '../orders/order-writes.service';
import { CartRow, CartService, ShippingMethodRow } from './cart.service';
import { isExhausted } from './coupons.service';
import { Job, NoticesService } from './notices.service';
import { itemCount, lineTotal, money, quantize } from './pricing';

const PAYMENT_METHODS = [
  'CASH',
  'CARD',
  'MOBILE_MFS',
  'BANK',
  'ONLINE_GATEWAY',
  'COD',
  'STORE_CREDIT',
  'OTHER',
];
const REQUIRED_ADDRESS_FIELDS = ['recipient_name', 'phone', 'line1', 'city'];

/** Python truthiness of a value in a JSON dict: `not value.get(field)`. */
function falsy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** `CheckoutSerializer._with_canonical_phone`: the delivery contact stored canonically. */
function withCanonicalPhone(value: Record<string, unknown>): Record<string, unknown> {
  const raw = value.phone;
  if (falsy(raw)) return value;
  const number = canonicalPhone(pyStr(raw));
  if (number === null)
    throw new InvalidNested({ phone: [{ message: INVALID_PHONE_MESSAGE, code: 'invalid' }] });
  return { ...value, phone: number };
}

/** `CheckoutSerializer`, field for field. */
const CHECKOUT_FIELDS: Fields = {
  shipping_address: dictField(),
  billing_address: dictField({ required: false }),
  shipping_method: uuidField({ required: false, allowNull: true }),
  payment_method: choiceField(PAYMENT_METHODS),
  contact_name: charField({ required: false, allowBlank: true, maxLength: 160 }),
  contact_phone: bangladeshiPhoneField({ required: false, allowBlank: true, maxLength: 32 }),
  contact_email: emailField({ required: false, allowBlank: true }),
  note: charField({ required: false, allowBlank: true }),
  expected_total: decimalField(14, 2, { required: false, allowNull: true }),
};

interface CheckoutData extends Record<string, unknown> {
  shipping_address: Record<string, unknown>;
  billing_address?: Record<string, unknown>;
  shipping_method?: string | null;
  payment_method: string;
  contact_name?: string;
  contact_phone?: string;
  contact_email?: string;
  note?: string;
  expected_total?: string | null;
}

export interface PlacedOrder {
  orderId: string;
  guestToken: string;
}

/**
 * `CheckoutView` and `orders.services.checkout.place_order`: a cart becomes an
 * order -- re-priced, re-checked, stock reserved -- in one transaction, with
 * the inventory rows locked, so two shoppers cannot both buy the last unit.
 *
 * The statement order is Django's (captured in the parity stack). What Django
 * leaves to `transaction.on_commit` -- the staff notifications and the Celery
 * jobs -- runs here only after COMMIT, in the order Django registers it.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger('rangon.orders');

  constructor(
    private readonly db: Database,
    private readonly carts: CartService,
    private readonly organization: OrganizationService,
    private readonly ledger: StockService,
    private readonly orders: OrderWritesService,
    private readonly notices: NoticesService,
    private readonly celery: CeleryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `CheckoutSerializer(data=...).is_valid(raise_exception=True)`. */
  async validate(data: unknown): Promise<CheckoutData> {
    const result = await runSerializer<CheckoutData>(CHECKOUT_FIELDS, data, {
      hooks: {
        shipping_address: (value: Record<string, unknown>) => {
          const missing = REQUIRED_ADDRESS_FIELDS.filter((field) => falsy(value[field]));
          if (missing.length) {
            throw new InvalidNested(
              Object.fromEntries(
                missing.map((field) => [
                  field,
                  [{ message: 'This field is required.', code: 'invalid' }],
                ]),
              ),
            );
          }
          return withCanonicalPhone(value);
        },
        billing_address: (value: Record<string, unknown>) => withCanonicalPhone(value),
      },
    });
    if (!result.ok) throw this.invalid(result.errors);
    return result.values;
  }

  private invalid(errors: Errors): ValidationError {
    return new ValidationError('Invalid input.', { details: errorMessages(errors) });
  }

  /** `place_order`. Answers the order to serialise and the jobs already queued. */
  async placeOrder(
    cart: CartRow,
    data: CheckoutData,
    customerId: string | null,
    idempotencyKey: string,
    context: AuditContext,
  ): Promise<PlacedOrder> {
    const afterCommit: (() => Promise<void>)[] = [];
    const placed = await this.db.transaction(async (tx) => {
      // A double-clicked "Place order": the order the first click made.
      const existing = await this.byKey(tx, idempotencyKey);
      if (existing) return existing;

      const items = await tx.query<{ id: string }>(
        `SELECT id FROM orders_cartitem WHERE cart_id = $1::uuid ORDER BY created_at ASC`,
        [cart.id],
      );
      if (!items.length) throw new ValidationError('Your cart is empty.');

      const methodId = data.shipping_method ?? null;
      const method = methodId
        ? await tx.one<ShippingMethodRow>(
            `SELECT id, code, name, description, price, free_over, min_days, max_days, is_pickup, supports_cod
               FROM shipping_shippingmethod WHERE id = $1::uuid AND is_active LIMIT 1`,
            [methodId],
          )
        : null;
      if (methodId && !method)
        throw new ValidationError('That delivery option is no longer available.');
      if (data.payment_method === 'COD' && method && !method.supports_cod) {
        throw new ValidationError('Cash on delivery is not available for that delivery option.');
      }

      const view = await this.carts.price(cart, method, tx);
      const blocking = view.issues.filter((issue) => issue.code !== 'COUPON_INVALID');
      if (blocking.length) {
        throw new Conflict('Some items in your cart are no longer available.', {
          details: { issues: blocking },
          code: 'INSUFFICIENT_STOCK',
        });
      }
      const priced = view.priced;
      if (data.expected_total !== undefined && data.expected_total !== null) {
        if (!quantize(data.expected_total).eq(priced.grandTotal)) {
          throw new PriceChanged('The total has changed since you reviewed your order.', {
            details: { expected: data.expected_total, actual: money(priced.grandTotal) },
          });
        }
      }

      const buyer =
        customerId ??
        (await this.guestCustomer(
          tx,
          data.contact_name ?? '',
          data.contact_phone ?? '',
          data.contact_email ?? '',
        ));

      const branch = (await tx.one<{ id: string; code: string }>(
        `SELECT id, code FROM accounts_branch WHERE id = $1::uuid`,
        [cart.branch_id],
      )) as { id: string; code: string };

      // The order, under a savepoint: a concurrent click that wins the
      // idempotency key makes this one answer with that click's order.
      const orderId = randomUUID();
      const guestToken = randomBytes(24).toString('base64url');
      await tx.query('SAVEPOINT place_order');
      let number: string;
      try {
        number = await this.orders.nextNumber(tx, 'order:WEB', 'RGN-WEB');
        await tx.query(
          `INSERT INTO orders_order
             (id, created_at, updated_at, number, channel, status, payment_status, register, subtotal,
              coupon_discount, manual_discount, discount_total, tax_total, tax_rate, shipping_total,
              grand_total, paid_total, refunded_total, currency, shipping_address, billing_address,
              customer_note, internal_note, idempotency_key, guest_token, placed_at, confirmed_at,
              packed_at, shipped_at, delivered_at, cancelled_at, cancel_reason, stock_committed,
              branch_id, coupon_id, created_by_id, customer_id, shipping_method_id, tax_mode)
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, 'ONLINE', 'PENDING', 'UNPAID', '',
                   $3, $4, $5, $6, $7, $8, $9, $10, 0.00, 0.00, $11, $12::jsonb, $13::jsonb, $14, '', $15,
                   $16, clock_timestamp(), NULL, NULL, NULL, NULL, NULL, '', false, $17::uuid, $18::uuid,
                   NULL, $19::uuid, $20::uuid, $21)`,
          [
            orderId,
            number,
            money(priced.subtotal),
            money(priced.couponDiscount),
            money(priced.manualDiscount),
            money(priced.discountTotal),
            money(priced.taxTotal),
            priced.taxRate.toString(),
            money(priced.shippingTotal),
            money(priced.grandTotal),
            this.env.RANGON_CURRENCY,
            JSON.stringify(data.shipping_address),
            // `billing_address or shipping_address`: an empty dict counts as none.
            JSON.stringify(
              falsy(data.billing_address) ? data.shipping_address : data.billing_address,
            ),
            data.note ?? '',
            idempotencyKey,
            guestToken,
            cart.branch_id,
            cart.coupon_id,
            buyer,
            method?.id ?? null,
            priced.taxMode,
          ],
        );
        await tx.query('RELEASE SAVEPOINT place_order');
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await tx.query('ROLLBACK TO SAVEPOINT place_order');
        const winner = await this.byKey(tx, idempotencyKey);
        if (winner) return winner;
        throw error;
      }

      for (const line of priced.lines) {
        await tx.query(
          `INSERT INTO orders_orderitem
             (id, created_at, updated_at, order_id, variant_id, sku, product_name, variant_label, quantity,
              unit_price, unit_cost, line_discount, tax_amount, line_total, fulfilled_quantity,
              returned_quantity)
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
                   $9, $10, $11, $12, 0, 0)`,
          [
            randomUUID(),
            orderId,
            line.variant.id,
            line.variant.sku,
            line.variant.productName,
            await line.variant.label(),
            line.quantity,
            money(line.unitPrice),
            money(line.unitCost),
            money(line.lineDiscount),
            money(line.taxAmount),
            money(lineTotal(line)),
          ],
        );
      }

      // Hold the stock, under the row lock; INSUFFICIENT_STOCK if another
      // sale got there first.
      const lowStock = await this.ledger.reserve(
        tx,
        branch,
        priced.lines.map((line) => [line.variant.id, line.quantity]),
        orderId,
      );
      for (const inventoryId of lowStock) {
        afterCommit.push(() =>
          this.celery.delay('inventory.tasks.notify_low_stock', [inventoryId]),
        );
      }
      await this.orders.logEvent(tx, orderId, 'STOCK_RESERVED', 'Stock reserved', {
        customerVisible: false,
      });

      if (cart.coupon_id) {
        await this.redeem(tx, cart.coupon_id, orderId, priced.couponDiscount, buyer);
      }

      const order: OrderRef = {
        id: orderId,
        number,
        branchId: cart.branch_id,
        currency: this.env.RANGON_CURRENCY,
        grandTotal: money(priced.grandTotal),
      };
      if (data.payment_method === 'COD') {
        await this.orders.recordPendingPayment(
          tx,
          context,
          order,
          'COD',
          priced.grandTotal,
          'manual',
        );
        // COD is confirmed straight away: there is nothing to wait for.
        await this.orders.transition(
          tx,
          context,
          order,
          'CONFIRMED',
          'Cash on delivery order placed',
        );
      } else {
        await this.orders.recordPendingPayment(
          tx,
          context,
          order,
          data.payment_method,
          priced.grandTotal,
          this.env.PAYMENT_DEFAULT_PROVIDER,
        );
      }

      await tx.query(
        `UPDATE orders_cart SET updated_at = clock_timestamp(), is_active = false WHERE id = $1::uuid`,
        [cart.id],
      );

      // This order may be the phone call someone was about to make.
      const customer = await tx.one<{ phone: string | null; user_id: string | null }>(
        `SELECT phone, user_id FROM customers_customer WHERE id = $1::uuid`,
        [buyer],
      );
      await this.notices.recoverLead(tx, {
        id: orderId,
        customerPhone: customer?.phone ?? null,
        shippingPhone: data.shipping_address.phone,
      });

      await this.orders.logEvent(tx, orderId, 'CREATED', 'Order placed online', {
        data: { items: priced.lines.length, payment_method: data.payment_method },
      });
      await recordAudit(tx, context, {
        action: 'SALE_CREATED',
        entity: { type: 'Order', id: orderId, label: number },
        newValues: {
          number,
          total: money(priced.grandTotal),
          channel: 'ONLINE',
          payment_method: data.payment_method,
        },
        branchId: cart.branch_id,
      });

      const count = itemCount(priced);
      afterCommit.push(() =>
        this.notices.notifyStaff({
          type: 'NEW_ONLINE_ORDER',
          title: `New online order ${number}`,
          body: `${count} item(s), ${money(priced.grandTotal)} ${this.env.RANGON_CURRENCY}`,
          permission: 'orders.view',
          branchId: cart.branch_id,
          link: `/admin/orders/${orderId}`,
        }),
      );
      const jobs: Job[] = await this.notices.notifyCustomer(
        tx,
        { id: orderId, number, customerUserId: customer?.user_id ?? null },
        'ORDER_CONFIRMED',
        `We have your order ${number}`,
      );
      for (const job of jobs) afterCommit.push(() => this.celery.delay(job.task, job.args));
      return { orderId, guestToken };
    });

    // `transaction.on_commit`: best effort, never failing the order.
    for (const callback of afterCommit) {
      try {
        await callback();
      } catch (error) {
        this.logger.error(`After-commit work for an order failed: ${String(error)}`);
      }
    }
    return placed;
  }

  private async byKey(tx: Transaction, key: string): Promise<PlacedOrder | null> {
    const row = await tx.one<{ id: string; guest_token: string }>(
      `SELECT id, guest_token FROM orders_order WHERE idempotency_key = $1 ORDER BY placed_at DESC LIMIT 1`,
      [key],
    );
    return row ? { orderId: row.id, guestToken: row.guest_token } : null;
  }

  /**
   * `_resolve_guest_customer`: identity is phone-first, the number canonical
   * before the match -- else by email -- else a new guest record.
   */
  private async guestCustomer(
    tx: Queryable,
    name: string,
    phone: string,
    email: string,
  ): Promise<string> {
    const number = normalizePhone(phone, 'contact_phone') ?? '';
    const address = pyStrip(email || '').toLowerCase();
    if (number) {
      const byPhone = await tx.one<{ id: string }>(
        `SELECT id FROM customers_customer WHERE phone = $1 ORDER BY name ASC LIMIT 1`,
        [number],
      );
      if (byPhone) return byPhone.id;
    }
    if (address) {
      const byEmail = await tx.one<{ id: string }>(
        `SELECT id FROM customers_customer WHERE email = $1 ORDER BY name ASC LIMIT 1`,
        [address],
      );
      if (byEmail) return byEmail.id;
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO customers_customer
         (id, created_at, updated_at, name, phone, email, customer_type, is_walk_in, is_active,
          date_of_birth, notes, tags, total_orders, total_spent, loyalty_points, last_order_at,
          created_by_id, user_id)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, 'GUEST', false, true, NULL, '',
               '[]'::jsonb, 0, 0, 0, NULL, NULL, NULL)`,
      [id, name || 'Guest customer', number || null, address || null],
    );
    return id;
  }

  /**
   * `promotions.services.redeem`: count the use under the coupon's row lock,
   * re-checking both limits -- validation ran before this lock existed, so
   * two checkouts can both have passed it (business-rules section 3.3).
   */
  private async redeem(
    tx: Queryable,
    couponId: string,
    orderId: string,
    discount: Dec,
    customerId: string,
  ): Promise<void> {
    const coupon = await tx.one<{
      id: string;
      usage_limit: number | null;
      used_count: number;
      usage_limit_per_customer: number | null;
    }>(
      `SELECT id, usage_limit, used_count, usage_limit_per_customer FROM promotions_coupon WHERE id = $1::uuid FOR UPDATE`,
      [couponId],
    );
    if (!coupon) return;
    if (isExhausted(coupon as never))
      throw new CouponInvalid('This coupon has reached its usage limit.');
    if (coupon.usage_limit_per_customer && customerId) {
      const used = await tx.one<{ count: string }>(
        `SELECT count(*) AS count FROM promotions_couponredemption
          WHERE coupon_id = $1::uuid AND customer_id = $2::uuid AND released_at IS NULL AND NOT (order_id = $3::uuid)`,
        [couponId, customerId, orderId],
      );
      if (Number(used?.count ?? 0) >= coupon.usage_limit_per_customer) {
        throw new CouponInvalid('You have already used this coupon.');
      }
    }
    const created = await tx.query(
      `INSERT INTO promotions_couponredemption
         (id, created_at, updated_at, coupon_id, order_id, customer_id, discount_amount, released_at)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4::uuid, $5, NULL)
       ON CONFLICT (coupon_id, order_id) DO NOTHING RETURNING id`,
      [randomUUID(), couponId, orderId, customerId, money(quantize(discount))],
    );
    if (created.length) {
      await tx.query(
        `UPDATE promotions_coupon SET updated_at = clock_timestamp(), used_count = $2 WHERE id = $1::uuid`,
        [couponId, coupon.used_count + 1],
      );
    }
  }
}
