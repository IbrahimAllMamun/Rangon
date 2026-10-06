import { Injectable } from '@nestjs/common';

import { CouponsService } from '../checkout/coupons.service';
import type { AuditActor, AuditContext } from '../common/audit';
import { Conflict } from '../common/errors';
import { pySlice, pyStr } from '../common/python';
import type { Queryable } from '../database/database.service';
import { pythonTypeName, pyTruthy } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { OrderWritesService } from './order-writes.service';

/**
 * A transition's reason as the caller holds it. The status route validates a
 * string; the cancel route passes on whatever the body's `reason` is.
 */
export type Reason = unknown;

/** `reason or fallback`, as a text column then stores it. */
export const reasonOr = (reason: Reason, fallback: string): string =>
  pyTruthy(reason) ? pyStr(reason) : fallback;

/** What a customer is told when their order moves: `_notify_status`. */
const CUSTOMER_NOTICES: Record<string, [type: string, title: string]> = {
  SHIPPED: ['ORDER_SHIPPED', 'Your order is on the way'],
  DELIVERED: ['ORDER_DELIVERED', 'Your order has been delivered'],
};

export interface Moved {
  id: string;
  number: string;
  customerId: string;
  paymentStatus: string;
  paidTotal: string;
  refundedTotal: string;
  /** The notice the customer is owed once the transaction commits, if any. */
  notice: [type: string, title: string] | null;
}

/**
 * `orders.services.lifecycle.transition` with the stock side of its two
 * edges: PACKED turns the order's reservation into a sale, under the stock
 * rows' locks, and CANCELLED gives the reservation and the coupon's use back
 * -- unless the goods have left the shelf, when a return is the way.
 */
@Injectable()
export class OrderLifecycle {
  constructor(
    private readonly orders: OrderWritesService,
    private readonly stock: StockService,
    private readonly coupons: CouponsService,
  ) {}

  async transition(
    tx: Queryable,
    after: AfterCommit,
    context: AuditContext,
    orderId: string,
    toStatus: string,
    reason: Reason,
    actor: AuditActor | null,
  ): Promise<Moved> {
    const order = (await tx.one<{
      id: string;
      number: string;
      branch_id: string;
      branch_code: string;
      currency: string;
      grand_total: string;
      customer_id: string;
    }>(
      `SELECT o."id", o."number", o."branch_id", b."code" AS "branch_code", o."currency",
              o."grand_total", o."customer_id"
         FROM "orders_order" o JOIN "accounts_branch" b ON b."id" = o."branch_id"
        WHERE o."id" = $1 LIMIT 21`,
      [orderId],
    )) as {
      id: string;
      number: string;
      branch_id: string;
      branch_code: string;
      currency: string;
      grand_total: string;
      customer_id: string;
    };
    const branch = { id: order.branch_id, code: order.branch_code };
    const lines = async () =>
      (
        await tx.query<{ variant_id: string; quantity: number }>(
          `SELECT "variant_id", "quantity" FROM "orders_orderitem"
            WHERE "orders_orderitem"."order_id" = $1 ORDER BY "orders_orderitem"."created_at" ASC`,
          [order.id],
        )
      ).map((item) => [item.variant_id, item.quantity] as [string, number]);

    const moved = await this.orders.transition(
      tx,
      context,
      {
        id: order.id,
        number: order.number,
        branchId: order.branch_id,
        currency: order.currency,
        grandTotal: order.grand_total,
      },
      toStatus,
      '',
      actor,
      async (locked) => {
        if (toStatus === 'PACKED' && !locked.stockCommitted) {
          // The goods leave the shelf now: the reservation becomes a sale.
          await this.stock.consumeReservation(tx, after, {
            branch,
            lines: await lines(),
            actor,
            referenceId: order.id,
          });
          await this.orders.logEvent(
            tx,
            order.id,
            'STOCK_COMMITTED',
            'Stock deducted for dispatch',
            { actorId: actor?.id ?? null, customerVisible: false },
          );
          return { stockCommitted: true };
        }
        if (toStatus === 'CANCELLED') {
          if (locked.stockCommitted) {
            throw new Conflict(
              'Stock has already left the shelf for this order; process a return instead of cancelling.',
            );
          }
          await this.stock.releaseReservation(tx, after, {
            branch,
            lines: await lines(),
            actor,
            referenceId: order.id,
            reason: reasonOr(reason, 'Order cancelled'),
          });
          await this.orders.logEvent(tx, order.id, 'STOCK_RELEASED', 'Reserved stock released', {
            actorId: actor?.id ?? null,
            customerVisible: false,
          });
          await this.coupons.release(tx, order.id);
          // `order.cancel_reason = reason[:255]`: a string's first 255 characters, a
          // list's first 255 items -- and anything else cannot be sliced, which
          // Python finds out only here, after the stock is released.
          if (typeof reason === 'string') return { cancelReason: pySlice(reason, 255) };
          if (Array.isArray(reason)) return { cancelReason: pyStr(reason.slice(0, 255)) };
          throw new TypeError(`'${pythonTypeName(reason)}' object is not subscriptable`);
        }
        return {};
      },
      { reasonText: pyStr(reason), reasonData: reason },
    );

    const now = (await tx.one<{
      payment_status: string;
      paid_total: string;
      refunded_total: string;
    }>(
      `SELECT "payment_status", "paid_total", "refunded_total" FROM "orders_order" WHERE "id" = $1`,
      [order.id],
    )) as { payment_status: string; paid_total: string; refunded_total: string };
    return {
      id: order.id,
      number: order.number,
      customerId: order.customer_id,
      paymentStatus: now.payment_status,
      paidTotal: now.paid_total,
      refundedTotal: now.refunded_total,
      notice: moved ? (CUSTOMER_NOTICES[toStatus] ?? null) : null,
    };
  }
}
