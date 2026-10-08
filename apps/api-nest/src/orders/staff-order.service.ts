import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { branchCondition } from '../auth/permissions';
import { likeContains } from '../catalog/discovery.service';
import { primaryImageUrl } from '../catalog/primary-image';
import { localIso } from '../common/datetime';
import { NotFound } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  orderingFrom,
} from '../common/filtering';
import { lookupDate } from '../common/model-lookups';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { searchDigits } from '../common/phone';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { parsePythonJson } from '../http/request-body';

/** An order as staff read it: the row with what `OrderListSerializer` looks up beside it. */
export interface StaffOrderRow {
  id: string;
  number: string;
  channel: string;
  status: string;
  payment_status: string;
  branch_id: string;
  customer_id: string;
  created_by_id: string | null;
  register: string;
  subtotal: string;
  coupon_discount: string;
  manual_discount: string;
  discount_total: string;
  tax_total: string;
  tax_rate: string;
  shipping_total: string;
  grand_total: string;
  paid_total: string;
  refunded_total: string;
  currency: string;
  coupon_id: string | null;
  shipping_method_id: string | null;
  shipping_address: string;
  billing_address: string;
  customer_note: string;
  internal_note: string;
  placed_at: string;
  created_at: string;
  confirmed_at: string | null;
  packed_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  stock_committed: boolean;
}

const ORDER_COLUMNS = `o."id", o."number", o."channel", o."status", o."payment_status", o."branch_id",
  o."customer_id", o."created_by_id", o."register", o."subtotal", o."coupon_discount",
  o."manual_discount", o."discount_total", o."tax_total", o."tax_rate", o."shipping_total",
  o."grand_total", o."paid_total", o."refunded_total", o."currency", o."coupon_id",
  o."shipping_method_id", o."shipping_address"::text AS "shipping_address",
  o."billing_address"::text AS "billing_address", o."customer_note", o."internal_note",
  o."placed_at", o."created_at", o."confirmed_at", o."packed_at", o."shipped_at", o."delivered_at",
  o."cancelled_at", o."cancel_reason", o."stock_committed"`;

const CHANNELS = ['POS', 'ONLINE', 'PHONE', 'SOCIAL', 'OTHER'] as const;
const STATUSES = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURN_REQUESTED',
  'RETURNED',
  'REFUNDED',
] as const;
const PAYMENT_STATUSES = [
  'UNPAID',
  'PARTIALLY_PAID',
  'PAID',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

/** `OrderViewSet.filterset_fields`. */
const FILTERS: readonly FilterField[] = [
  choiceFilter('channel', 'o."channel"', CHANNELS),
  choiceFilter('status', 'o."status"', STATUSES),
  choiceFilter('payment_status', 'o."payment_status"', PAYMENT_STATUSES),
  modelFilter('branch', 'o."branch_id"', 'accounts_branch'),
  modelFilter('customer', 'o."customer_id"', 'customers_customer'),
];
/** `OrderViewSet.ordering_fields`. */
const ORDERING = { placed_at: 'o."placed_at"', grand_total: 'o."grand_total"' };

const FROM = `FROM "orders_order" o
  INNER JOIN "accounts_branch" ON (o."branch_id" = "accounts_branch"."id")
  INNER JOIN "customers_customer" ON (o."customer_id" = "customers_customer"."id")
  LEFT OUTER JOIN "accounts_user" ON (o."created_by_id" = "accounts_user"."id")`;

/**
 * `OrderDetailSerializer`: an order with its lines, payments, refunds and
 * timeline, as the counter's receipt and the back office read it. Everything
 * beside the order row is looked up the way the serializer reaches for it.
 */
@Injectable()
export class StaffOrders {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The order by id, or null. */
  async byId(id: string, q: Queryable = this.db): Promise<StaffOrderRow | null> {
    return q.one<StaffOrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM "orders_order" o WHERE o."id" = $1 LIMIT 21`,
      [id],
    );
  }

  private iso(value: string | null): string | null {
    return localIso(value, this.env.DJANGO_TIME_ZONE);
  }

  /**
   * `OrderViewSet.get_queryset` and its filters: the user's branch, then
   * `search` (the number, the customer's name, the digits of a phone number),
   * `date_from` and `date_to` on the day the order was placed in Dhaka, then
   * the declared filters. Every route of the viewset runs through it, so a
   * read by id that the filters exclude is a 404.
   */
  private async conditions(user: RequestUser, query: QueryDict, sql: SqlParams): Promise<string[]> {
    const where: string[] = [];
    const scope = branchCondition(user, ['o."branch_id"'], sql.values.length + 1);
    if (scope) {
      where.push(scope.sql);
      for (const value of scope.values) sql.add(value, 'uuid');
    }
    const search = query.get('search');
    if (search) {
      const like = sql.add(likeContains(search));
      const matches = [
        `UPPER(o."number"::text) LIKE UPPER(${like})`,
        `UPPER("customers_customer"."name"::text) LIKE UPPER(${like})`,
      ];
      // A query that is only a country code or a trunk `0` identifies nobody.
      const digits = searchDigits(search);
      if (digits)
        matches.push(`"customers_customer"."phone"::text LIKE ${sql.add(likeContains(digits))}`);
      where.push(`(${matches.join(' OR ')})`);
    }
    const day = `(o."placed_at" AT TIME ZONE '${this.env.DJANGO_TIME_ZONE}')::date`;
    const from = query.get('date_from');
    if (from) where.push(`${day} >= ${sql.add(lookupDate(from), 'date')}`);
    const to = query.get('date_to');
    if (to) where.push(`${day} <= ${sql.add(lookupDate(to), 'date')}`);
    await applyFilters(this.db, query, FILTERS, sql, where);
    return where;
  }

  /** `list`: `OrderListSerializer`, paginated, the newest placed first. */
  async list(user: RequestUser, query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? ['o."placed_at" DESC'];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" ${FROM} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<
      StaffOrderRow & {
        branch_code: string;
        customer_name: string;
        customer_phone: string | null;
        created_by_email: string | null;
      }
    >(
      `SELECT ${ORDER_COLUMNS}, "accounts_branch"."code" AS "branch_code",
              "customers_customer"."name" AS "customer_name",
              "customers_customer"."phone" AS "customer_phone",
              "accounts_user"."email" AS "created_by_email"
         ${FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    const counts = new Map(
      (
        await this.db.query<{ order_id: string; units: string }>(
          `SELECT "order_id", SUM("quantity") AS "units" FROM "orders_orderitem"
            WHERE "order_id" = ANY($1::uuid[]) GROUP BY "order_id"`,
          [rows.map((row) => row.id)],
        )
      ).map((row) => [row.order_id, Number(row.units)]),
    );
    return paginated(
      page,
      rows.map((row) => ({
        id: row.id,
        number: row.number,
        channel: row.channel,
        status: row.status,
        payment_status: row.payment_status,
        branch: row.branch_id,
        branch_code: row.branch_code,
        customer: row.customer_id,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        item_count: counts.get(row.id) ?? 0,
        subtotal: row.subtotal,
        discount_total: row.discount_total,
        tax_total: row.tax_total,
        shipping_total: row.shipping_total,
        grand_total: row.grand_total,
        paid_total: row.paid_total,
        refunded_total: row.refunded_total,
        currency: row.currency,
        created_by_email: row.created_by_email ?? '',
        placed_at: this.iso(row.placed_at),
        created_at: this.iso(row.created_at),
      })),
      absoluteUrl,
    );
  }

  /**
   * `OrderListSerializer(customer.orders.select_related("branch")
   * .order_by("-placed_at")[:100], many=True).data`: a customer's last
   * hundred orders, whatever their branch.
   */
  async ofCustomer(customer: { id: string; name: string; phone: string | null }) {
    const rows = await this.db.query<
      StaffOrderRow & { branch_code: string; created_by_email: string | null }
    >(
      `SELECT ${ORDER_COLUMNS}, "accounts_branch"."code" AS "branch_code",
              (SELECT u."email" FROM "accounts_user" u WHERE u."id" = o."created_by_id")
                AS "created_by_email"
         FROM "orders_order" o
         INNER JOIN "accounts_branch" ON (o."branch_id" = "accounts_branch"."id")
        WHERE o."customer_id" = $1 ORDER BY o."placed_at" DESC LIMIT 100`,
      [customer.id],
    );
    const counts = new Map(
      (
        await this.db.query<{ order_id: string; units: string }>(
          `SELECT "order_id", SUM("quantity") AS "units" FROM "orders_orderitem"
            WHERE "order_id" = ANY($1::uuid[]) GROUP BY "order_id"`,
          [rows.map((row) => row.id)],
        )
      ).map((row) => [row.order_id, Number(row.units)]),
    );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      channel: row.channel,
      status: row.status,
      payment_status: row.payment_status,
      branch: row.branch_id,
      branch_code: row.branch_code,
      customer: row.customer_id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      item_count: counts.get(row.id) ?? 0,
      subtotal: row.subtotal,
      discount_total: row.discount_total,
      tax_total: row.tax_total,
      shipping_total: row.shipping_total,
      grand_total: row.grand_total,
      paid_total: row.paid_total,
      refunded_total: row.refunded_total,
      currency: row.currency,
      created_by_email: row.created_by_email ?? '',
      placed_at: this.iso(row.placed_at),
      created_at: this.iso(row.created_at),
    }));
  }

  /** `get_object()`: the filtered queryset, then the primary key -- a 404 either way. */
  async find(user: RequestUser, pk: string, query: QueryDict): Promise<StaffOrderRow> {
    const sql = new SqlParams();
    const where = await this.conditions(user, query, sql);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`o."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<StaffOrderRow>(
      `SELECT ${ORDER_COLUMNS} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  /** `timeline`: `OrderEventSerializer` over the order's events, oldest first. */
  async timeline(order: StaffOrderRow) {
    return (await this.detail(order)).events;
  }

  /** `_organization_payload`: the shop, as a printed document names it. */
  async organization(): Promise<Record<string, string>> {
    const organization = await this.db.one<Record<string, string>>(
      `SELECT "name", "address", "phone", "email", "vat_registration", "receipt_footer"
         FROM "accounts_organization" WHERE "accounts_organization"."status" = 'ACTIVE'
        ORDER BY "accounts_organization"."created_at" ASC LIMIT 1`,
    );
    return organization ?? {};
  }

  /** `invoice`: what the printable A4 invoice is drawn from. */
  async invoice(order: StaffOrderRow) {
    return {
      order: await this.detail(order),
      document_type: 'INVOICE',
      organization: await this.organization(),
    };
  }

  /** `packing_slip`: the same, with no prices on the lines. */
  async packingSlip(order: StaffOrderRow) {
    const detail = await this.detail(order);
    return {
      order: {
        ...detail,
        // A packing slip never shows prices.
        items: detail.items.map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(
              ([key]) => !['unit_price', 'line_discount', 'tax_amount', 'line_total'].includes(key),
            ),
          ),
        ),
      },
      document_type: 'PACKING_SLIP',
      organization: await this.organization(),
    };
  }

  /** `OrderDetailSerializer(order).data`. */
  async detail(order: StaffOrderRow, q: Queryable = this.db) {
    const branch = await q.one<{ code: string }>(
      `SELECT "code" FROM "accounts_branch" WHERE "id" = $1`,
      [order.branch_id],
    );
    const customer = await q.one<{ name: string; phone: string | null }>(
      `SELECT "name", "phone" FROM "customers_customer" WHERE "id" = $1`,
      [order.customer_id],
    );
    const email = async (userId: string | null) =>
      userId
        ? ((
            await q.one<{ email: string }>(`SELECT "email" FROM "accounts_user" WHERE "id" = $1`, [
              userId,
            ])
          )?.email ?? '')
        : '';
    const coupon = order.coupon_id
      ? await q.one<{ code: string }>(`SELECT "code" FROM "promotions_coupon" WHERE "id" = $1`, [
          order.coupon_id,
        ])
      : null;
    const shipping = order.shipping_method_id
      ? await q.one<{ name: string }>(
          `SELECT "name" FROM "shipping_shippingmethod" WHERE "id" = $1`,
          [order.shipping_method_id],
        )
      : null;

    const items = await q.query<{
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
      product_id: string | null;
    }>(
      `SELECT i."id", i."variant_id", i."sku", i."product_name", i."variant_label", i."quantity",
              i."unit_price", i."line_discount", i."tax_amount", i."line_total",
              i."fulfilled_quantity", i."returned_quantity", v."product_id"
         FROM "orders_orderitem" i
         LEFT JOIN "catalog_productvariant" v ON v."id" = i."variant_id"
        WHERE i."order_id" = $1 ORDER BY i."created_at" ASC`,
      [order.id],
    );
    const payments = await q.query<{
      id: string;
      method: string;
      status: string;
      amount: string;
      tendered_amount: string | null;
      change_amount: string;
      currency: string;
      provider: string;
      provider_reference: string;
      reference: string;
      authorized_at: string | null;
      captured_at: string | null;
      failed_at: string | null;
      refunded_total: string;
      account_id: string | null;
      account_name: string | null;
      created_by_id: string | null;
      created_at: string;
    }>(
      `SELECT p."id", p."method", p."status", p."amount", p."tendered_amount", p."change_amount",
              p."currency", p."provider", p."provider_reference", p."reference", p."authorized_at",
              p."captured_at", p."failed_at", p."refunded_total", p."account_id",
              a."name" AS "account_name", p."created_by_id", p."created_at"
         FROM "orders_payment" p LEFT JOIN "finance_account" a ON a."id" = p."account_id"
        WHERE p."order_id" = $1 ORDER BY p."created_at" ASC`,
      [order.id],
    );
    const refunds = await q.query<{
      id: string;
      payment_id: string | null;
      amount: string;
      method: string;
      status: string;
      reason: string;
      provider_reference: string;
      created_at: string;
    }>(
      `SELECT r."id", r."payment_id", r."amount", r."method", r."status", r."reason",
              r."provider_reference", r."created_at"
         FROM "orders_refund" r WHERE r."order_id" = $1 ORDER BY r."created_at" DESC`,
      [order.id],
    );
    const events = await q.query<{
      id: string;
      event_type: string;
      message: string;
      data: string;
      actor_id: string | null;
      is_customer_visible: boolean;
      created_at: string;
    }>(
      `SELECT e."id", e."event_type", e."message", e."data"::text AS "data", e."actor_id",
              e."is_customer_visible", e."created_at"
         FROM "orders_orderevent" e WHERE e."order_id" = $1 ORDER BY e."created_at" ASC`,
      [order.id],
    );

    const images = new Map<string, string>();
    for (const item of items) {
      if (item.product_id && !images.has(item.product_id))
        images.set(item.product_id, await primaryImageUrl(q, item.product_id, this.env.mediaBase));
    }
    const emails = new Map<string, string>();
    const emailOf = async (userId: string | null) => {
      if (!userId) return '';
      if (!emails.has(userId)) emails.set(userId, await email(userId));
      return emails.get(userId) as string;
    };

    return {
      id: order.id,
      number: order.number,
      channel: order.channel,
      status: order.status,
      payment_status: order.payment_status,
      branch: order.branch_id,
      branch_code: branch?.code,
      customer: order.customer_id,
      customer_name: customer?.name,
      customer_phone: customer ? customer.phone : '',
      // `sum(item.quantity for item in self.items.all())`.
      item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal: order.subtotal,
      discount_total: order.discount_total,
      tax_total: order.tax_total,
      shipping_total: order.shipping_total,
      grand_total: order.grand_total,
      paid_total: order.paid_total,
      refunded_total: order.refunded_total,
      currency: order.currency,
      created_by_email: await emailOf(order.created_by_id),
      placed_at: this.iso(order.placed_at),
      created_at: this.iso(order.created_at),
      coupon: order.coupon_id,
      coupon_code: coupon?.code ?? '',
      coupon_discount: order.coupon_discount,
      manual_discount: order.manual_discount,
      tax_rate: order.tax_rate,
      shipping_method: order.shipping_method_id,
      shipping_method_name: shipping?.name ?? '',
      shipping_address: parsePythonJson(order.shipping_address),
      billing_address: parsePythonJson(order.billing_address),
      customer_note: order.customer_note,
      internal_note: order.internal_note,
      register: order.register,
      stock_committed: order.stock_committed,
      confirmed_at: this.iso(order.confirmed_at),
      packed_at: this.iso(order.packed_at),
      shipped_at: this.iso(order.shipped_at),
      delivered_at: this.iso(order.delivered_at),
      cancelled_at: this.iso(order.cancelled_at),
      cancel_reason: order.cancel_reason,
      items: items.map((item) => ({
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
        image: (item.product_id && images.get(item.product_id)) || '',
      })),
      payments: await Promise.all(
        payments.map(async (payment) => ({
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amount: payment.amount,
          tendered_amount: payment.tendered_amount,
          change_amount: payment.change_amount,
          currency: payment.currency,
          provider: payment.provider,
          provider_reference: payment.provider_reference,
          reference: payment.reference,
          authorized_at: this.iso(payment.authorized_at),
          captured_at: this.iso(payment.captured_at),
          failed_at: this.iso(payment.failed_at),
          refunded_total: payment.refunded_total,
          account: payment.account_id,
          account_name: payment.account_name ?? '',
          created_by_email: await emailOf(payment.created_by_id),
          created_at: this.iso(payment.created_at),
        })),
      ),
      refunds: refunds.map((refund) => ({
        id: refund.id,
        order: order.id,
        payment: refund.payment_id,
        amount: refund.amount,
        method: refund.method,
        status: refund.status,
        reason: refund.reason,
        provider_reference: refund.provider_reference,
        created_at: this.iso(refund.created_at),
      })),
      events: await Promise.all(
        events.map(async (event) => ({
          id: event.id,
          event_type: event.event_type,
          message: event.message,
          data: parsePythonJson(event.data),
          actor_email: await emailOf(event.actor_id),
          is_customer_visible: event.is_customer_visible,
          created_at: this.iso(event.created_at),
        })),
      ),
    };
  }
}
