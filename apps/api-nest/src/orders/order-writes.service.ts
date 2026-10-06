import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { quantize, money, ZERO } from '../checkout/pricing';
import { type AuditActor, AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import { InvalidStatusTransition, ValidationError } from '../common/errors';
import { pySlice } from '../common/python';
import { nextNumber } from '../common/sequence';
import { Queryable } from '../database/database.service';

/** What the order-side writes need to know about an order. */
export interface OrderRef {
  id: string;
  number: string;
  branchId: string;
  currency: string;
  grandTotal: string;
}

const CAPTURED_STATES = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

/** `orders.services.lifecycle.ALLOWED_TRANSITIONS`. */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'DELIVERED'],
  SHIPPED: ['DELIVERED', 'RETURN_REQUESTED'],
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUNDED'],
  REFUNDED: [],
  CANCELLED: [],
};
const TIMESTAMP_FIELDS: Record<string, string> = {
  CONFIRMED: 'confirmed_at',
  PACKED: 'packed_at',
  SHIPPED: 'shipped_at',
  DELIVERED: 'delivered_at',
  CANCELLED: 'cancelled_at',
};

/**
 * The order-side writes of `core.services`, `orders.services.lifecycle` and
 * `orders.services.payments` that checkout makes -- each on the caller's
 * transaction, with its row lock where Django takes one.
 */
@Injectable()
export class OrderWritesService {
  /**
   * `core.services.next_number`: row-locked, so two sales never share a
   * number. A rolled-back sale gives its number back with the transaction.
   */
  async nextNumber(tx: Queryable, key: string, prefix: string, padding = 6): Promise<string> {
    return nextNumber(tx, key, prefix, padding);
  }

  /** `lifecycle.log_event`: one timeline entry, append-only. */
  async logEvent(
    tx: Queryable,
    orderId: string,
    eventType: string,
    message: string,
    options: {
      data?: Record<string, unknown>;
      customerVisible?: boolean;
      actorId?: string | null;
    } = {},
  ): Promise<void> {
    await tx.query(
      `INSERT INTO orders_orderevent
         (id, created_at, updated_at, order_id, event_type, message, data, is_customer_visible, actor_id)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4, $5::jsonb, $6,
               $7::uuid)`,
      [
        randomUUID(),
        orderId,
        eventType,
        pySlice(message, 255),
        JSON.stringify(options.data ?? {}),
        options.customerVisible ?? true,
        options.actorId ?? null,
      ],
    );
  }

  /**
   * `payments.record_payment` for a payment not yet taken (a cash-on-delivery
   * or gateway payment recorded at checkout): the order locked, the row
   * written, the order's payment status derived again. Money moves only on
   * capture, so nothing reaches the cash book here.
   */
  async recordPendingPayment(
    tx: Queryable,
    context: AuditContext,
    order: OrderRef,
    method: string,
    amount: Dec,
    provider: string,
  ): Promise<void> {
    await tx.query(`SELECT id FROM orders_order WHERE id = $1::uuid FOR UPDATE`, [order.id]);
    const value = quantize(amount);
    if (value.lte(ZERO)) throw new ValidationError('Payment amount must be positive.');
    const paymentId = randomUUID();
    await tx.query(
      `INSERT INTO orders_payment
         (id, created_at, updated_at, order_id, method, status, amount, tendered_amount, change_amount,
          currency, provider, provider_reference, reference, payload, authorized_at, captured_at,
          failed_at, refunded_total, account_id, created_by_id)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, 'PENDING', $4, NULL, 0.00,
               $5, $6, '', '', '{}'::jsonb, NULL, NULL, NULL, 0.00, NULL, NULL)`,
      [paymentId, order.id, method, money(value), order.currency, provider],
    );
    await this.refreshPaymentStatus(tx, order);
    await this.logEvent(tx, order.id, 'PAYMENT_RECORDED', `${method} ${money(value)}`, {
      // The status says whether money moved: a COD payment is not "received" (D97).
      data: { payment_id: paymentId, method, amount: money(value), status: 'PENDING' },
    });
    await recordAudit(tx, context, {
      action: 'PAYMENT_RECORDED',
      entity: { type: 'Payment', id: paymentId, label: `${method} ${money(value)} (PENDING)` },
      newValues: { order: order.number, method, amount: money(value), status: 'PENDING' },
      branchId: order.branchId,
    });
  }

  /** `payments.refresh_payment_status`: the order's payment status from its payment and refund rows. */
  async refreshPaymentStatus(tx: Queryable, order: OrderRef): Promise<void> {
    const payments = await tx.query<{ status: string; amount: string }>(
      `SELECT status, amount FROM orders_payment WHERE order_id = $1::uuid ORDER BY created_at ASC`,
      [order.id],
    );
    const refunds = await tx.query<{ amount: string }>(
      `SELECT amount FROM orders_refund WHERE order_id = $1::uuid AND status = 'COMPLETED' ORDER BY created_at DESC`,
      [order.id],
    );
    let captured = ZERO;
    for (const payment of payments) {
      if (CAPTURED_STATES.has(payment.status)) captured = captured.plus(payment.amount);
    }
    const refunded = quantize(refunds.reduce((sum, refund) => sum.plus(refund.amount), ZERO));
    captured = quantize(captured);
    const net = quantize(captured.minus(refunded));
    const total = new Dec(order.grandTotal);
    let status: string;
    if (refunded.gt(0) && net.lte(0)) status = 'REFUNDED';
    else if (refunded.gt(0)) status = 'PARTIALLY_REFUNDED';
    else if (net.gte(total) && total.gt(0)) status = 'PAID';
    else if (net.gt(0)) status = 'PARTIALLY_PAID';
    else status = 'UNPAID';
    await tx.query(
      `UPDATE orders_order SET updated_at = clock_timestamp(), payment_status = $2, paid_total = $3,
              refunded_total = $4 WHERE id = $1::uuid`,
      [order.id, status, money(captured), money(refunded)],
    );
  }

  /**
   * `lifecycle.transition` for an edge with no stock side effect (PENDING to
   * CONFIRMED is the one checkout takes). The edges that move stock --
   * PACKED, CANCELLED -- are refused here rather than half-ported.
   */
  async transition(
    tx: Queryable,
    context: AuditContext,
    order: OrderRef,
    toStatus: string,
    reason: string,
    actor: AuditActor | null = null,
  ): Promise<void> {
    if (toStatus === 'PACKED' || toStatus === 'CANCELLED') {
      throw new Error(`The ${toStatus} transition moves stock and is not ported yet.`);
    }
    const locked = await tx.one<{ status: string }>(
      `SELECT status FROM orders_order WHERE id = $1::uuid FOR UPDATE`,
      [order.id],
    );
    const from = locked?.status ?? '';
    if (from === toStatus) return;
    if (!(ALLOWED_TRANSITIONS[from] ?? []).includes(toStatus)) {
      throw new InvalidStatusTransition(`An order cannot go from ${from} to ${toStatus}.`, {
        details: { from, to: toStatus },
      });
    }
    const stamp = TIMESTAMP_FIELDS[toStatus];
    await tx.query(
      `UPDATE orders_order SET updated_at = clock_timestamp(), status = $2,
              cancel_reason = cancel_reason, stock_committed = stock_committed
              ${stamp ? `, ${stamp} = clock_timestamp()` : ''}
        WHERE id = $1::uuid`,
      [order.id, toStatus],
    );
    await this.logEvent(tx, order.id, 'STATUS_CHANGED', `${from} → ${toStatus}`, {
      data: { from, to: toStatus, reason },
      actorId: actor?.id ?? null,
    });
    await recordAudit(tx, context, {
      action: 'ORDER_STATUS_CHANGED',
      entity: { type: 'Order', id: order.id, label: order.number },
      actor,
      oldValues: { status: from },
      newValues: { status: toStatus },
      reason,
      branchId: order.branchId,
    });
  }
}
