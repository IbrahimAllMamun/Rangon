import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { money, quantize, ZERO } from '../checkout/pricing';
import { AuditActor, AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import { RefundExceedsCaptured, ValidationError } from '../common/errors';
import { pySlice } from '../common/python';
import { Queryable } from '../database/database.service';
import { CashBookService } from '../finance/cash-book.service';
import { OrderRef, OrderWritesService } from './order-writes.service';

/** A payment taken by a member of staff, as `record_payment` takes it. */
export interface TakenPayment {
  method: string;
  amount: Dec;
  /** As the serializer validated it; quantized only for a cash payment. */
  tenderedAmount: string | null;
  reference: string;
  /** The account the cashier named; else the branch's own for the method. */
  accountId: string | null;
}

/**
 * `orders.services.payments`, where staff take money: a payment recorded as
 * captured the moment it is rung up, posted to the account it landed in.
 */
@Injectable()
export class OrderPayments {
  constructor(
    private readonly orders: OrderWritesService,
    private readonly cashBook: CashBookService,
  ) {}

  /**
   * `record_payment(status=CAPTURED)`: the order locked, the payment written,
   * its money posted to the cash book -- the named account, checked, or the
   * branch's default for the method; none at all leaves the sale standing --
   * then the order's payment status, its timeline and the audit log.
   */
  async recordCaptured(
    tx: Queryable,
    context: AuditContext,
    order: OrderRef & { branchCode: string },
    payment: TakenPayment,
    actor: AuditActor,
  ): Promise<string> {
    await tx.query(`SELECT id FROM orders_order WHERE id = $1::uuid LIMIT 21 FOR UPDATE`, [
      order.id,
    ]);
    const amount = quantize(payment.amount);
    if (amount.lte(ZERO)) throw new ValidationError('Payment amount must be positive.');

    const now = (
      (await tx.one<{ now: string }>(`SELECT clock_timestamp() AS now`)) as { now: string }
    ).now;
    let tendered = payment.tenderedAmount;
    let change = ZERO;
    if (tendered !== null && payment.method === 'CASH') {
      const given = quantize(tendered);
      if (given.lt(amount)) throw new ValidationError('Cash tendered is less than the amount due.');
      tendered = money(given);
      change = quantize(given.minus(amount));
    }

    const paymentId = randomUUID();
    await tx.query(
      `INSERT INTO orders_payment
         (id, created_at, updated_at, order_id, method, status, amount, tendered_amount, change_amount,
          currency, provider, provider_reference, reference, payload, authorized_at, captured_at,
          failed_at, refunded_total, account_id, created_by_id)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, 'CAPTURED', $4, $5, $6, $7,
               'manual', '', $8, '{}'::jsonb, NULL, $9::timestamptz, NULL, 0.00, $10::uuid, $11::uuid)`,
      [
        paymentId,
        order.id,
        payment.method,
        money(amount),
        tendered,
        money(change),
        order.currency,
        payment.reference,
        now,
        payment.accountId,
        actor.id,
      ],
    );

    // Money moves on capture, which for a counter payment is now.
    if (!(await this.cashBook.alreadyPosted(tx, 'payment', paymentId))) {
      const accountId = await this.cashBook.recordSalePayment(tx, {
        branch: { id: order.branchId, code: order.branchCode },
        amount,
        referenceType: 'payment',
        referenceId: paymentId,
        accountId: payment.accountId,
        method: payment.method,
        notes: `${order.number} - ${payment.method}`,
        occurredAt: now,
        actorId: actor.id,
      });
      if (accountId !== null && payment.accountId !== accountId) {
        await tx.query(
          `UPDATE orders_payment SET updated_at = clock_timestamp(), account_id = $2::uuid
            WHERE id = $1::uuid`,
          [paymentId, accountId],
        );
      }
    }

    await this.orders.refreshPaymentStatus(tx, order);
    await this.orders.logEvent(
      tx,
      order.id,
      'PAYMENT_RECORDED',
      `${payment.method} ${money(amount)}`,
      {
        data: {
          payment_id: paymentId,
          method: payment.method,
          amount: money(amount),
          status: 'CAPTURED',
        },
        actorId: actor.id,
      },
    );
    await recordAudit(tx, context, {
      action: 'PAYMENT_RECORDED',
      entity: {
        type: 'Payment',
        id: paymentId,
        label: `${payment.method} ${money(amount)} (CAPTURED)`,
      },
      actor,
      newValues: {
        order: order.number,
        method: payment.method,
        amount: money(amount),
        status: 'CAPTURED',
      },
      branchId: order.branchId,
    });
    return paymentId;
  }

  /**
   * `refund_order`: money back against an order, never more than was
   * captured, once per `idempotencyKey`. It goes back through the largest
   * captured payment: that payment's method unless the caller names one, and
   * its account when the refund goes back the way the money came -- else the
   * branch's own for the method (D95). The whole amount is entered against
   * that one payment, whatever the others took (D149, copied).
   */
  async refundOrder(
    tx: Queryable,
    context: AuditContext,
    orderId: string,
    refund: {
      amount: Dec;
      actor: AuditActor;
      reason: string;
      method?: string | null;
      accountId?: string | null;
      idempotencyKey?: string | null;
      returnRequestId?: string | null;
    },
  ): Promise<string> {
    const order = (await tx.one<{
      id: string;
      number: string;
      branch_id: string;
      currency: string;
      grand_total: string;
      paid_total: string;
      refunded_total: string;
    }>(
      `SELECT "id", "number", "branch_id", "currency", "grand_total", "paid_total", "refunded_total"
         FROM "orders_order" WHERE "orders_order"."id" = $1 LIMIT 21 FOR UPDATE`,
      [orderId],
    )) as {
      id: string;
      number: string;
      branch_id: string;
      currency: string;
      grand_total: string;
      paid_total: string;
      refunded_total: string;
    };
    const amount = quantize(refund.amount);
    if (amount.lte(ZERO)) throw new ValidationError('Refund amount must be positive.');

    const byKey = (key: string) =>
      tx.one<{ id: string }>(
        `SELECT "id" FROM "orders_refund" WHERE "orders_refund"."idempotency_key" = $1
          ORDER BY "orders_refund"."created_at" DESC LIMIT 1`,
        [key],
      );
    const key = refund.idempotencyKey ?? null;
    if (key) {
      const existing = await byKey(key);
      if (existing) return existing.id;
    }

    const refundable = quantize(new Dec(order.paid_total).minus(order.refunded_total));
    if (amount.gt(refundable)) {
      throw new RefundExceedsCaptured(
        `Only ${money(refundable)} can be refunded on ${order.number}.`,
        {
          details: {
            requested: money(amount),
            refundable: money(refundable),
            paid_total: order.paid_total,
            refunded_total: order.refunded_total,
          },
        },
      );
    }

    // The payment that took the most money: Django's statement, so a tie breaks alike.
    const source = await tx.one<{
      id: string;
      method: string;
      amount: string;
      refunded_total: string;
      account_id: string | null;
    }>(
      `SELECT "orders_payment"."id", "orders_payment"."method", "orders_payment"."amount",
              "orders_payment"."refunded_total", "orders_payment"."account_id"
         FROM "orders_payment"
        WHERE ("orders_payment"."order_id" = $1
               AND "orders_payment"."status" IN ('PARTIALLY_REFUNDED', 'CAPTURED', 'REFUNDED'))
        ORDER BY "orders_payment"."amount" DESC LIMIT 1`,
      [order.id],
    );
    const method = refund.method || (source ? source.method : 'CASH');
    let accountId = refund.accountId ?? null;
    if (accountId === null && source?.account_id) {
      const kind = (
        await tx.one<{ kind: string }>(
          `SELECT "kind" FROM "finance_account" WHERE "finance_account"."id" = $1 LIMIT 21`,
          [source.account_id],
        )
      )?.kind;
      if (this.cashBook.kindOf(method) === kind) accountId = source.account_id;
    }

    const reason = pySlice(refund.reason, 255);
    const refundId = randomUUID();
    await tx.query('SAVEPOINT refund_order');
    try {
      await tx.query(
        `INSERT INTO orders_refund
           (id, created_at, updated_at, order_id, payment_id, return_request_id, amount, method,
            status, reason, provider_reference, idempotency_key, account_id, created_by_id)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4::uuid, $5, $6,
                 'COMPLETED', $7, '', $8, $9::uuid, $10::uuid)`,
        [
          refundId,
          order.id,
          source?.id ?? null,
          refund.returnRequestId ?? null,
          money(amount),
          method,
          reason,
          key,
          accountId,
          refund.actor.id,
        ],
      );
      await tx.query('RELEASE SAVEPOINT refund_order');
    } catch (error) {
      if (!String((error as { code?: string }).code).startsWith('23')) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT refund_order');
      const winner = key === null ? null : await byKey(key);
      if (winner) return winner.id;
      throw error;
    }

    // `_post_refund_to_cash_book`.
    if (!(await this.cashBook.alreadyPosted(tx, 'refund', refundId))) {
      const branch = (await tx.one<{ code: string }>(
        `SELECT "code" FROM "accounts_branch" WHERE "accounts_branch"."id" = $1 LIMIT 21`,
        [order.branch_id],
      )) as { code: string };
      const posted = await this.cashBook.recordRefund(tx, {
        branch: { id: order.branch_id, code: branch.code },
        amount,
        referenceType: 'refund',
        referenceId: refundId,
        accountId,
        method,
        notes: `${order.number} refund`,
        reason,
        actorId: refund.actor.id,
      });
      if (posted !== null && accountId !== posted) {
        await tx.query(
          `UPDATE "orders_refund" SET "updated_at" = clock_timestamp(), "account_id" = $2
            WHERE "orders_refund"."id" = $1`,
          [refundId, posted],
        );
      }
    }

    if (source) {
      const refunded = quantize(new Dec(source.refunded_total).plus(amount));
      await tx.query(
        `UPDATE "orders_payment" SET "updated_at" = clock_timestamp(), "status" = $2,
                "refunded_total" = $3 WHERE "orders_payment"."id" = $1`,
        [
          source.id,
          refunded.gte(source.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          money(refunded),
        ],
      );
    }

    await this.orders.refreshPaymentStatus(tx, {
      id: order.id,
      number: order.number,
      branchId: order.branch_id,
      currency: order.currency,
      grandTotal: order.grand_total,
    });
    await this.orders.logEvent(tx, order.id, 'REFUND_ISSUED', `Refund ${money(amount)}`, {
      data: { refund_id: refundId, amount: money(amount), reason: refund.reason },
      actorId: refund.actor.id,
    });
    await recordAudit(tx, context, {
      action: 'REFUND_ISSUED',
      entity: { type: 'Refund', id: refundId, label: `Refund ${money(amount)} on ${order.id}` },
      actor: refund.actor,
      newValues: { order: order.number, amount: money(amount), method },
      reason: refund.reason,
      branchId: order.branch_id,
    });
    return refundId;
  }
}
