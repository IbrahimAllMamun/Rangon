import { Inject, Injectable } from '@nestjs/common';

import { primaryImageUrl } from '../catalog/primary-image';
import { localIso, parsePgTimestamptz } from '../common/datetime';
import { pyFormatNamed, pyStr } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';

/** `orders_order`'s columns in model order: Django's own SELECT, so the plan -- and a tie's order -- is the same. */
const ORDER_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'number',
  'channel',
  'status',
  'payment_status',
  'branch_id',
  'customer_id',
  'created_by_id',
  'register',
  'subtotal',
  'coupon_discount',
  'manual_discount',
  'discount_total',
  'tax_total',
  'tax_rate',
  'tax_mode',
  'shipping_total',
  'grand_total',
  'paid_total',
  'refunded_total',
  'currency',
  'coupon_id',
  'shipping_method_id',
  'shipping_address',
  'billing_address',
  'customer_note',
  'internal_note',
  'idempotency_key',
  'guest_token',
  'placed_at',
  'confirmed_at',
  'packed_at',
  'shipped_at',
  'delivered_at',
  'cancelled_at',
  'cancel_reason',
  'stock_committed',
] as const;
const ITEM_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'order_id',
  'variant_id',
  'sku',
  'product_name',
  'variant_label',
  'quantity',
  'unit_price',
  'unit_cost',
  'line_discount',
  'tax_amount',
  'line_total',
  'fulfilled_quantity',
  'returned_quantity',
] as const;
const PAYMENT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'order_id',
  'method',
  'status',
  'amount',
  'tendered_amount',
  'change_amount',
  'currency',
  'provider',
  'provider_reference',
  'reference',
  'payload',
  'authorized_at',
  'captured_at',
  'failed_at',
  'refunded_total',
  'account_id',
  'created_by_id',
] as const;
const EVENT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'order_id',
  'event_type',
  'message',
  'data',
  'is_customer_visible',
  'actor_id',
] as const;
const SHIPMENT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'order_id',
  'courier_id',
  'shipping_method_id',
  'tracking_number',
  'status',
  'cost',
  'dispatched_at',
  'delivered_at',
  'notes',
  'created_by_id',
] as const;
const COURIER_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'code',
  'phone',
  'tracking_url_template',
  'integration',
  'is_active',
] as const;
const SHIPMENT_EVENT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'shipment_id',
  'status',
  'message',
  'location',
  'occurred_at',
  'raw',
  'created_by_id',
] as const;

function select(table: string, columns: readonly string[]): string {
  return columns.map((column) => `"${table}"."${column}"`).join(', ');
}

/** Every `orders_order` column, qualified, as the ORM selects them. */
export const ORDER_SELECT = select('orders_order', ORDER_COLUMNS);

export interface OrderRow {
  id: string;
  number: string;
  channel: string;
  status: string;
  payment_status: string;
  customer_id: string;
  shipping_method_id: string | null;
  subtotal: string;
  discount_total: string;
  coupon_discount: string;
  tax_total: string;
  shipping_total: string;
  grand_total: string;
  paid_total: string;
  refunded_total: string;
  currency: string;
  shipping_address: unknown;
  customer_note: string;
  guest_token: string;
  placed_at: string;
  delivered_at: string | null;
  cancel_reason: string;
}

interface ItemRow {
  id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variant_label: string;
  quantity: number;
  unit_price: string;
  line_discount: string;
  tax_amount: string;
  line_total: string;
  fulfilled_quantity: number;
  returned_quantity: number;
}

interface EventRow {
  id: string;
  created_at: string;
  event_type: string;
  message: string;
  data: unknown;
  is_customer_visible: boolean;
}

/** What a customer reads for each status an order moves to (`CUSTOMER_STATUS_TEXT`). */
const CUSTOMER_STATUS_TEXT: Record<string, string> = {
  CONFIRMED: 'Order confirmed',
  PROCESSING: 'Being prepared',
  PACKED: 'Packed',
  SHIPPED: 'On its way',
  DELIVERED: 'Delivered',
  CANCELLED: 'Order cancelled',
  RETURN_REQUESTED: 'Return requested',
  RETURNED: 'Returned',
  REFUNDED: 'Refunded',
};
const RETURN_STEPS = ['approved', 'rejected', 'received'];

/**
 * `customer_event_text`: what a customer reads for one timeline entry, or null
 * to leave it out. An allow-list by entry type; no text staff typed is repeated.
 */
export function customerEventText(event: EventRow): string | null {
  if (!event.is_customer_visible) return null;
  const raw = event.data;
  // `event.data or {}`, then `.get()`: a truthy non-dict is an AttributeError in Django.
  const falsy =
    raw === null || raw === false || raw === 0 || raw === '' || (Array.isArray(raw) && !raw.length);
  const data = falsy ? {} : raw;
  const get = (key: string): unknown => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new TypeError(`'${typeof data}' object has no attribute 'get'`);
    }
    return (data as Record<string, unknown>)[key];
  };
  switch (event.event_type) {
    case 'CREATED':
      return 'Order placed';
    case 'CANCELLED':
      return CUSTOMER_STATUS_TEXT.CANCELLED as string;
    case 'STATUS_CHANGED': {
      const to = get('to');
      return CUSTOMER_STATUS_TEXT[to === undefined ? '' : pyStr(to)] ?? null;
    }
    case 'PAYMENT_CAPTURED':
      return 'Payment received';
    case 'PAYMENT_RECORDED':
      // Recording a cash-on-delivery payment moves no money; only one
      // recorded as already taken is news to the customer.
      return get('status') === 'CAPTURED' ? 'Payment received' : null;
    case 'PAYMENT_FAILED':
      return 'A payment did not go through';
    case 'REFUND_ISSUED':
      return 'Refund issued';
    case 'SHIPMENT_CREATED':
      return 'Parcel booked with the courier';
    case 'RETURN_REQUESTED':
      return 'Return requested';
    case 'RETURN_UPDATED': {
      // "Return RET-000003 rejected: <what staff wrote>" -- the step, not the comment.
      const step = RETURN_STEPS.find((word) => event.message.includes(` ${word}`));
      return step ? `Return ${step}` : 'Return updated';
    }
    default:
      return null;
  }
}

function instant(text: string): number {
  const { epochSeconds, microseconds } = parsePgTimestamptz(text);
  return epochSeconds * 1e6 + microseconds;
}

/**
 * The storefront's view of an order (`orders/api/shop_views.py`): the signed-in
 * customer's list and detail, and the guest tracking link -- one shape for
 * both, narrower than staff's (D97).
 */
@Injectable()
export class CustomerOrdersService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private iso(text: string | null): string | null {
    return localIso(text, this.env.DJANGO_TIME_ZONE);
  }

  /** `_customer_for(request)`: the signed-in account's customer record, if it has one. */
  async customerOf(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM customers_customer WHERE user_id = $1::uuid`,
      [userId],
    );
    return row?.id ?? null;
  }

  /** `Order.objects.filter(number=number).first()`. */
  async byNumber(number: string): Promise<OrderRow | null> {
    return this.db.one<OrderRow>(
      `SELECT ${select('orders_order', ORDER_COLUMNS)} FROM "orders_order"
        WHERE "orders_order"."number" = $1 ORDER BY "orders_order"."placed_at" DESC LIMIT 1`,
      [number],
    );
  }

  async byId(id: string): Promise<OrderRow | null> {
    return this.db.one<OrderRow>(
      `SELECT ${select('orders_order', ORDER_COLUMNS)} FROM "orders_order" WHERE "orders_order"."id" = $1::uuid`,
      [id],
    );
  }

  /** `get_object_or_404(Order, number=number, customer=customer)`. */
  async byNumberFor(number: string, customerId: string): Promise<OrderRow | null> {
    return this.db.one<OrderRow>(
      `SELECT ${select('orders_order', ORDER_COLUMNS)} FROM "orders_order"
        WHERE ("orders_order"."customer_id" = $1::uuid AND "orders_order"."number" = $2) LIMIT 21`,
      [customerId, number],
    );
  }

  /** The newest 50, as `CustomerOrderListSerializer`. */
  async list(customerId: string): Promise<Record<string, unknown>[]> {
    const orders = await this.db.query<OrderRow>(
      `SELECT ${select('orders_order', ORDER_COLUMNS)} FROM "orders_order"
        WHERE "orders_order"."customer_id" = $1::uuid
        ORDER BY "orders_order"."placed_at" DESC LIMIT 50`,
      [customerId],
    );
    if (!orders.length) return [];
    const quantities = await this.db.query<{ order_id: string; quantity: number }>(
      `SELECT order_id, quantity FROM orders_orderitem WHERE order_id = ANY($1::uuid[])`,
      [orders.map((order) => order.id)],
    );
    const counts = new Map<string, number>();
    for (const row of quantities)
      counts.set(row.order_id, (counts.get(row.order_id) ?? 0) + row.quantity);
    return orders.map((order) => ({
      number: order.number,
      channel: order.channel,
      status: order.status,
      payment_status: order.payment_status,
      item_count: counts.get(order.id) ?? 0,
      grand_total: order.grand_total,
      currency: order.currency,
      placed_at: this.iso(order.placed_at),
    }));
  }

  /**
   * `_customer_order(order)`: `CustomerOrderSerializer` plus the parcels --
   * or, as checkout answers, the serializer alone.
   */
  async payload(
    order: OrderRow,
    options: { shipments?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const customer = await this.db.one<{ name: string }>(
      `SELECT name FROM customers_customer WHERE id = $1::uuid`,
      [order.customer_id],
    );
    const method = order.shipping_method_id
      ? await this.db.one<{ name: string }>(
          `SELECT name FROM shipping_shippingmethod WHERE id = $1::uuid`,
          [order.shipping_method_id],
        )
      : null;
    return {
      number: order.number,
      channel: order.channel,
      status: order.status,
      payment_status: order.payment_status,
      currency: order.currency,
      placed_at: this.iso(order.placed_at),
      delivered_at: this.iso(order.delivered_at),
      cancel_reason: order.cancel_reason,
      customer_name: customer?.name,
      subtotal: order.subtotal,
      discount_total: order.discount_total,
      coupon_discount: order.coupon_discount,
      tax_total: order.tax_total,
      shipping_total: order.shipping_total,
      grand_total: order.grand_total,
      paid_total: order.paid_total,
      refunded_total: order.refunded_total,
      shipping_method_name: method?.name ?? '',
      shipping_address: order.shipping_address,
      customer_note: order.customer_note,
      items: await this.items(order.id),
      payments: await this.payments(order.id),
      events: await this.events(order.id),
      ...(options.shipments === false ? {} : { shipments: await this.shipments(order.id) }),
    };
  }

  /** `OrderItemSerializer`, each line's image its product's `primary_image`. */
  private async items(orderId: string): Promise<Record<string, unknown>[]> {
    const items = await this.db.query<ItemRow>(
      `SELECT ${select('orders_orderitem', ITEM_COLUMNS)} FROM "orders_orderitem"
        WHERE "orders_orderitem"."order_id" = $1::uuid ORDER BY "orders_orderitem"."created_at" ASC`,
      [orderId],
    );
    const images = new Map<string, string>();
    const out: Record<string, unknown>[] = [];
    for (const item of items) {
      const variant = await this.db.one<{ product_id: string }>(
        `SELECT product_id FROM catalog_productvariant WHERE id = $1::uuid`,
        [item.variant_id],
      );
      const productId = variant?.product_id ?? '';
      if (!images.has(productId))
        images.set(productId, await primaryImageUrl(this.db, productId, this.env.MEDIA_URL));
      out.push({
        id: item.id,
        variant: item.variant_id,
        sku: item.sku,
        product_name: item.product_name,
        variant_label: item.variant_label,
        quantity: item.quantity,
        unit_price: item.unit_price,
        line_discount: item.line_discount,
        tax_amount: item.tax_amount,
        line_total: item.line_total,
        fulfilled_quantity: item.fulfilled_quantity,
        returned_quantity: item.returned_quantity,
        returnable_quantity: item.quantity - item.returned_quantity,
        image: images.get(productId) ?? '',
      });
    }
    return out;
  }

  /** `CustomerPaymentSerializer`. */
  private async payments(orderId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<Record<string, string | null>>(
      `SELECT ${select('orders_payment', PAYMENT_COLUMNS)} FROM "orders_payment"
        WHERE "orders_payment"."order_id" = $1::uuid ORDER BY "orders_payment"."created_at" ASC`,
      [orderId],
    );
    return rows.map((row) => ({
      id: row.id,
      method: row.method,
      status: row.status,
      amount: row.amount,
      captured_at: this.iso(row.captured_at ?? null),
      created_at: this.iso(row.created_at ?? null),
    }));
  }

  /**
   * `CustomerOrderSerializer.get_events`: in time order, only what a customer
   * is told, and the "placed" entry first -- checkout logs the payment before it.
   */
  private async events(orderId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<EventRow>(
      `SELECT ${select('orders_orderevent', EVENT_COLUMNS)} FROM "orders_orderevent"
        WHERE "orders_orderevent"."order_id" = $1::uuid ORDER BY "orders_orderevent"."created_at" ASC`,
      [orderId],
    );
    // `sorted(..., key=created_at)`: stable, so a tie keeps the query's order.
    const ordered = [...rows].sort((a, b) => instant(a.created_at) - instant(b.created_at));
    const shown: Record<string, unknown>[] = [];
    for (const event of ordered) {
      const text = customerEventText(event);
      if (text !== null) {
        shown.push({
          id: event.id,
          event_type: event.event_type,
          message: text,
          created_at: this.iso(event.created_at),
        });
      }
    }
    // `shown.sort(key=lambda row: row["event_type"] != "CREATED")`: stable too.
    return shown.sort(
      (a, b) => Number(a.event_type !== 'CREATED') - Number(b.event_type !== 'CREATED'),
    );
  }

  /** `CustomerShipmentSerializer`: no cost, no packing notes. */
  private async shipments(orderId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.arrays(
      `SELECT ${select('shipping_shipment', SHIPMENT_COLUMNS)}, ${select('shipping_courier', COURIER_COLUMNS)}
         FROM "shipping_shipment"
         LEFT OUTER JOIN "shipping_courier" ON ("shipping_shipment"."courier_id" = "shipping_courier"."id")
        WHERE "shipping_shipment"."order_id" = $1::uuid ORDER BY "shipping_shipment"."created_at" DESC`,
      [orderId],
    );
    if (!rows.length) return [];
    const at = (name: string) =>
      SHIPMENT_COLUMNS.indexOf(name as (typeof SHIPMENT_COLUMNS)[number]);
    const courierAt = (name: string) =>
      SHIPMENT_COLUMNS.length + COURIER_COLUMNS.indexOf(name as (typeof COURIER_COLUMNS)[number]);
    const ids = rows.map((row) => row[at('id')] as string);

    const events = await this.db.query<Record<string, string>>(
      `SELECT ${select('shipping_shipmentevent', SHIPMENT_EVENT_COLUMNS)} FROM "shipping_shipmentevent"
        WHERE "shipping_shipmentevent"."shipment_id" IN (${ids.map((_, index) => `$${index + 1}::uuid`).join(', ')})
        ORDER BY "shipping_shipmentevent"."occurred_at" ASC`,
      ids,
    );
    return rows.map((row) => {
      const courierId = row[courierAt('id')] as string | null;
      const template = (row[courierAt('tracking_url_template')] as string | null) ?? '';
      const trackingNumber = row[at('tracking_number')] as string;
      return {
        id: row[at('id')],
        courier_name: courierId ? row[courierAt('name')] : '',
        tracking_number: trackingNumber,
        // `Courier.tracking_url`: nothing without both a template and a number.
        tracking_url:
          courierId && template && trackingNumber
            ? pyFormatNamed(template, { tracking_number: trackingNumber })
            : '',
        status: row[at('status')],
        dispatched_at: this.iso(row[at('dispatched_at')] as string | null),
        delivered_at: this.iso(row[at('delivered_at')] as string | null),
        events: events
          .filter((event) => event.shipment_id === row[at('id')])
          .map((event) => ({
            status: event.status,
            message: event.message,
            location: event.location,
            occurred_at: this.iso(event.occurred_at ?? null),
          })),
      };
    });
  }
}
