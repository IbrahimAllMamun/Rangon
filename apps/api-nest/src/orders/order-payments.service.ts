import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { money, quantize, ZERO } from '../checkout/pricing';
import { AuditActor, AuditContext, recordAudit } from '../common/audit';
import { Dec } from '../common/decimal';
import { ValidationError } from '../common/errors';
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
}
