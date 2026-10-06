import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { canCrossBranch, RolePermissions } from '../auth/permissions';
import { money, quantize, ZERO } from '../checkout/pricing';
import { localIso } from '../common/datetime';
import { Dec } from '../common/decimal';
import type { QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';

/**
 * `PartyLedgerView` and `finance.selectors.party_ledger`: who owes the
 * business money, and whom it owes. Both sides are derived from orders and
 * purchase orders each time they are asked for; neither a customer nor a
 * supplier carries a balance.
 */

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
    const days = (since: string) =>
      `((clock_timestamp() AT TIME ZONE '${tz}')::date - (${since} AT TIME ZONE '${tz}')::date)`;
    const scope = branchId ? [branchId] : [];

    // `receivables`: real trade with a balance -- not a basket, a cancellation or a refund.
    const orders = await this.db.query<{
      id: string;
      number: string;
      placed_at: string;
      days: number;
      channel: string;
      status: string;
      grand_total: string;
      paid_total: string;
      customer_id: string;
      customer_name: string;
      customer_phone: string | null;
    }>(
      `SELECT o."id", o."number", o."placed_at", ${days('o."placed_at"')} AS "days", o."channel",
              o."status", o."grand_total", o."paid_total", c."id" AS "customer_id",
              c."name" AS "customer_name", c."phone" AS "customer_phone"
         FROM "orders_order" o INNER JOIN "customers_customer" c ON (o."customer_id" = c."id")
        WHERE (o."grand_total" > o."paid_total"
               AND NOT (o."status" IN ('PENDING', 'CANCELLED', 'REFUNDED'))
               ${branchId ? 'AND o."branch_id" = $1' : ''})
        ORDER BY o."placed_at" ASC`,
      scope,
    );
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
    const raised = `COALESCE(p."completed_at", p."ordered_at", p."created_at")`;
    const due = `(${raised} + s."payment_terms_days" * interval '1 day')`;
    const purchases = await this.db.query<{
      id: string;
      number: string;
      raised: string;
      due: string;
      days: number;
      status: string;
      invoice_number: string;
      grand_total: string;
      paid_total: string;
      credited_total: string;
      supplier_id: string;
      supplier_name: string;
      supplier_phone: string;
    }>(
      `SELECT p."id", p."number", ${raised} AS "raised", ${due} AS "due", ${days(due)} AS "days",
              p."status", p."invoice_number", p."grand_total", p."paid_total", p."credited_total",
              s."id" AS "supplier_id", s."name" AS "supplier_name", s."phone" AS "supplier_phone"
         FROM "purchasing_purchaseorder" p
         INNER JOIN "purchasing_supplier" s ON (p."supplier_id" = s."id")
        WHERE (p."grand_total" > (p."paid_total" + p."credited_total")
               AND NOT (p."status" IN ('DRAFT', 'CANCELLED'))
               ${branchId ? 'AND p."branch_id" = $1' : ''})
        ORDER BY p."ordered_at" ASC`,
      scope,
    );
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
