import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { canCrossBranch, RolePermissions } from '../auth/permissions';
import { money, quantize, ZERO } from '../checkout/pricing';
import { localIso, parsePgTimestamptz, zoneOffsetSeconds } from '../common/datetime';
import { Dec } from '../common/decimal';
import type { QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns, Params as SqlParams } from '../database/sql';

/**
 * `PartyLedgerView` and `finance.selectors.party_ledger`: who owes the
 * business money, and whom it owes. Both sides are derived from orders and
 * purchase orders each time they are asked for; neither a customer nor a
 * supplier carries a balance.
 */

const O = '"orders_order"';
const B = '"accounts_branch"';
const C = '"customers_customer"';
const P = '"purchasing_purchaseorder"';
const S = '"purchasing_supplier"';

/** Each model's columns, in its fields' order: what `select_related` selects. */
export const ORDER_COLUMNS = [
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
const CUSTOMER_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'user_id',
  'name',
  'phone',
  'email',
  'customer_type',
  'is_walk_in',
  'is_active',
  'date_of_birth',
  'notes',
  'tags',
  'total_orders',
  'total_spent',
  'loyalty_points',
  'last_order_at',
  'created_by_id',
] as const;
const PURCHASE_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'number',
  'supplier_id',
  'branch_id',
  'status',
  'payment_status',
  'invoice_number',
  'ordered_at',
  'expected_at',
  'completed_at',
  'subtotal',
  'discount_total',
  'tax_total',
  'shipping_total',
  'grand_total',
  'paid_total',
  'credited_total',
  'currency',
  'notes',
  'created_by_id',
] as const;
const SUPPLIER_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'code',
  'contact_person',
  'phone',
  'email',
  'address',
  'tax_id',
  'payment_terms_days',
  'lead_time_days',
  'status',
  'notes',
] as const;

/** One table's columns out of a row read by position. */
function named<T extends readonly string[]>(
  names: T,
  row: unknown[],
  offset: number,
): Record<T[number], unknown> {
  return Object.fromEntries(names.map((name, index) => [name, row[offset + index]])) as Record<
    T[number],
    unknown
  >;
}

/** `moment + timedelta(days=n)` on a `timestamptz` as PostgreSQL printed it. */
function addDays(moment: string, days: number): string {
  const { epochSeconds, microseconds } = parsePgTimestamptz(moment);
  const shifted = new Date((epochSeconds + days * 86_400) * 1000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)}.${String(microseconds).padStart(6, '0')}+00`;
}

const BUCKETS = ['current', 'd31_60', 'd61_90', 'over_90'] as const;
type Bucket = (typeof BUCKETS)[number];
type Ageing = Record<Bucket, Dec>;

/** `_bucket_for`: 0-30, 31-60, 61-90, and everything older. */
function bucketFor(days: number): Bucket {
  if (days <= 30) return 'current';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'over_90';
}

const emptyAgeing = (): Ageing => ({ current: ZERO, d31_60: ZERO, d61_90: ZERO, over_90: ZERO });
const ageingPayload = (ageing: Ageing) =>
  Object.fromEntries(BUCKETS.map((bucket) => [bucket, money(ageing[bucket])]));

interface Document {
  party_id: string;
  party_name: string;
  party_phone: string;
  days: number;
  outstanding: Dec;
  payload: Record<string, unknown>;
}

@Injectable()
export class PartyLedgerService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** One side of the ledger: documents in the order read, gathered by party, largest debt first. */
  private side(documents: Document[]) {
    const parties = new Map<
      string,
      {
        party_id: string;
        name: string;
        phone: string;
        outstanding: Dec;
        document_count: number;
        oldest_days: number;
        ageing: Ageing;
        documents: Record<string, unknown>[];
      }
    >();
    let total = ZERO;
    const ageing = emptyAgeing();
    for (const document of documents) {
      const bucket = bucketFor(document.days);
      let party = parties.get(document.party_id);
      if (!party) {
        party = {
          party_id: document.party_id,
          name: document.party_name,
          phone: document.party_phone,
          outstanding: ZERO,
          document_count: 0,
          oldest_days: 0,
          ageing: emptyAgeing(),
          documents: [],
        };
        parties.set(document.party_id, party);
      }
      party.outstanding = quantize(party.outstanding.plus(document.outstanding));
      party.document_count += 1;
      party.oldest_days = Math.max(party.oldest_days, document.days);
      party.ageing[bucket] = quantize(party.ageing[bucket].plus(document.outstanding));
      party.documents.push(document.payload);
      total = quantize(total.plus(document.outstanding));
      ageing[bucket] = quantize(ageing[bucket].plus(document.outstanding));
    }
    // `sorted(..., reverse=True)` keeps parties that owe the same in the order they were met.
    const rows = [...parties.values()].sort((a, b) => b.outstanding.comparedTo(a.outstanding));
    return {
      total,
      payload: {
        total: money(total),
        party_count: rows.length,
        document_count: rows.reduce((sum, row) => sum + row.document_count, 0),
        ageing: ageingPayload(ageing),
        parties: rows.map((row) => ({
          party_id: row.party_id,
          name: row.name,
          phone: row.phone,
          outstanding: money(row.outstanding),
          document_count: row.document_count,
          oldest_days: row.oldest_days,
          ageing: ageingPayload(row.ageing),
          documents: row.documents,
        })),
      },
    };
  }

  async ledger(user: RequestUser, query: QueryDict) {
    let branchId: string | null = null;
    const asked = query.get('branch');
    if (asked) branchId = (await this.permissions.resolveBranch(user, asked)).id;
    else if (!canCrossBranch(user) && user.branchId) branchId = user.branchId;
    const tz = this.env.DJANGO_TIME_ZONE;
    const iso = (value: string | null) => localIso(value, tz);
    // Ageing counts calendar days in the shop's own zone, not elapsed time.
    const localDay = (epochSeconds: number) =>
      Math.floor((epochSeconds + zoneOffsetSeconds(epochSeconds, tz)) / 86_400);
    const today = localDay(Math.floor(Date.now() / 1000));
    const days = (since: string) => today - localDay(parsePgTimestamptz(since).epochSeconds);
    const sql = new SqlParams();
    const atBranch = (table: string) =>
      branchId ? ` AND ${table}."branch_id" = ${sql.add(branchId, 'uuid')}` : '';

    // Both statements are Django's, every column of every table `select_related`
    // joins: documents of one date come back as the plan leaves them, and the
    // plan is the statement's.
    // `receivables`: real trade with a balance -- not a basket, a cancellation or a refund.
    const orderRows = await this.db.arrays(
      `SELECT ${columns(O, ORDER_COLUMNS)}, ${columns(B, BRANCH_COLUMNS)}, ${columns(C, CUSTOMER_COLUMNS)}
         FROM ${O} INNER JOIN ${B} ON (${O}."branch_id" = ${B}."id")
         INNER JOIN ${C} ON (${O}."customer_id" = ${C}."id")
        WHERE (${O}."grand_total" > (${O}."paid_total")
               AND NOT (${O}."status" IN ('PENDING', 'CANCELLED', 'REFUNDED'))${atBranch(O)})
        ORDER BY ${O}."placed_at" ASC`,
      sql.values,
    );
    const customerAt = ORDER_COLUMNS.length + BRANCH_COLUMNS.length;
    const orders = orderRows.map((row) => {
      const order = named(ORDER_COLUMNS, row, 0);
      const customer = named(CUSTOMER_COLUMNS, row, customerAt);
      return {
        id: order.id as string,
        number: order.number as string,
        placed_at: order.placed_at as string,
        days: days(order.placed_at as string),
        channel: order.channel as string,
        status: order.status as string,
        grand_total: order.grand_total as string,
        paid_total: order.paid_total as string,
        customer_id: customer.id as string,
        customer_name: customer.name as string,
        customer_phone: customer.phone as string | null,
      };
    });
    const receivable = this.side(
      orders.flatMap((order) => {
        const outstanding = quantize(new Dec(order.grand_total).minus(order.paid_total));
        if (outstanding.lte(ZERO)) return [];
        const age = Math.max(order.days, 0);
        return [
          {
            party_id: order.customer_id,
            party_name: order.customer_name || 'Unnamed customer',
            party_phone: order.customer_phone || '',
            days: age,
            outstanding,
            payload: {
              id: order.id,
              number: order.number,
              dated: iso(order.placed_at),
              days: age,
              status: order.status,
              channel: order.channel,
              total: money(quantize(order.grand_total)),
              paid: money(quantize(order.paid_total)),
              outstanding: money(outstanding),
            },
          },
        ];
      }),
    );

    // `payables`: committed purchases not yet settled by money or by credit, aged from the due date.
    const supplierJoin = `INNER JOIN ${S} ON (${P}."supplier_id" = ${S}."id")`;
    const branchJoin = `INNER JOIN ${B} ON (${P}."branch_id" = ${B}."id")`;
    const purchaseSql = new SqlParams();
    const purchaseRows = await this.db.arrays(
      // A filter on the branch names its join first, as Django's query holds them.
      `SELECT ${columns(P, PURCHASE_COLUMNS)}, ${columns(S, SUPPLIER_COLUMNS)}, ${columns(B, BRANCH_COLUMNS)}
         FROM ${P} ${branchId ? `${branchJoin} ${supplierJoin}` : `${supplierJoin} ${branchJoin}`}
        WHERE (${P}."grand_total" > (${P}."paid_total" + ${P}."credited_total")
               AND NOT (${P}."status" IN ('DRAFT', 'CANCELLED'))` +
        (branchId ? ` AND ${P}."branch_id" = ${purchaseSql.add(branchId, 'uuid')}` : '') +
        `) ORDER BY ${P}."ordered_at" ASC`,
      purchaseSql.values,
    );
    const purchases = purchaseRows.map((row) => {
      const purchase = named(PURCHASE_COLUMNS, row, 0);
      const supplier = named(SUPPLIER_COLUMNS, row, PURCHASE_COLUMNS.length);
      // `completed_at or ordered_at or created_at`, then the supplier's terms.
      const raised = (purchase.completed_at ??
        purchase.ordered_at ??
        purchase.created_at) as string;
      const due = addDays(raised, Number(supplier.payment_terms_days ?? 0));
      return {
        id: purchase.id as string,
        number: purchase.number as string,
        raised,
        due,
        days: days(due),
        status: purchase.status as string,
        invoice_number: purchase.invoice_number as string,
        grand_total: purchase.grand_total as string,
        paid_total: purchase.paid_total as string,
        credited_total: purchase.credited_total as string,
        supplier_id: supplier.id as string,
        supplier_name: supplier.name as string,
        supplier_phone: supplier.phone as string,
      };
    });
    const payable = this.side(
      purchases.flatMap((purchase) => {
        const outstanding = quantize(
          new Dec(purchase.grand_total).minus(purchase.paid_total).minus(purchase.credited_total),
        );
        if (outstanding.lte(ZERO)) return [];
        const overdue = Math.max(purchase.days, 0);
        return [
          {
            party_id: purchase.supplier_id,
            party_name: purchase.supplier_name,
            party_phone: purchase.supplier_phone,
            days: overdue,
            outstanding,
            payload: {
              id: purchase.id,
              number: purchase.number,
              dated: iso(purchase.raised),
              due: iso(purchase.due),
              days: overdue,
              status: purchase.status,
              invoice_number: purchase.invoice_number,
              total: money(quantize(purchase.grand_total)),
              paid: money(quantize(purchase.paid_total)),
              outstanding: money(outstanding),
            },
          },
        ];
      }),
    );

    return {
      receivable: receivable.payload,
      payable: payable.payload,
      // Positive: more is owed to the business than by it.
      net_position: money(quantize(receivable.total.minus(payable.total))),
    };
  }
}
