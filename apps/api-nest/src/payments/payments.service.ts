import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { quantize } from '../checkout/pricing';
import { AuditContext, recordAudit } from '../common/audit';
import { Conflict } from '../common/errors';
import { Database, Queryable } from '../database/database.service';
import { CashBookService } from '../finance/cash-book.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { ProviderEvent } from './providers';

const CAPTURED_STATES = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const CAPTURE_EVENTS = new Set(['payment.captured', 'payment.success']);
const FAILURE_EVENTS = new Set(['payment.failed', 'payment.cancelled']);

interface PaymentRow {
  id: string;
  order_id: string;
  method: string;
  status: string;
  amount: string;
  provider: string;
  account_id: string | null;
}

const PAYMENT_COLUMNS = 'id, order_id, method, status, amount, provider, account_id';

/**
 * A provider's webhook, from the parsed event on: `PaymentWebhookView`'s
 * lookups, then `orders.services.payments.handle_provider_event` with the
 * `capture_payment` and `fail_payment` it calls -- in Django's order, with
 * Django's locks, in one transaction.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderWritesService,
    private readonly cashBook: CashBookService,
  ) {}

  /** Store the event exactly once and act on it. Answers the stored result. */
  async handleWebhook(
    provider: string,
    event: ProviderEvent,
    context: AuditContext,
  ): Promise<string> {
    // The view's reads, made before the service's transaction as Django makes
    // them. The payment is the one this provider was asked to take -- never a
    // cash-on-delivery payment a courier still carries (D100).
    const order = await this.db.one<{ id: string }>(
      `SELECT id FROM orders_order WHERE number = $1 ORDER BY placed_at DESC LIMIT 1`,
      [event.orderNumber],
    );
    const payment = order
      ? await this.db.one<PaymentRow>(
          `SELECT ${PAYMENT_COLUMNS} FROM orders_payment
            WHERE (order_id = $1::uuid AND provider = $2 AND status IN ('PENDING', 'AUTHORIZED'))
            ORDER BY created_at ASC LIMIT 1`,
          [order.id, provider],
        )
      : null;

    return this.db.transaction(async (tx) => {
      // The unique constraint on (provider, provider_event_id) is what makes
      // a replay safe under concurrency: a second insert of the same event
      // waits for the first to commit, then fails, and gets the first's result.
      const eventRowId = randomUUID();
      await tx.query('SAVEPOINT payment_event');
      try {
        await tx.query(
          `INSERT INTO orders_paymentevent
             (id, created_at, updated_at, payment_id, order_id, provider, provider_event_id, event_type,
              payload, processed, result)
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb,
                   false, '')`,
          [
            eventRowId,
            payment?.id ?? null,
            order?.id ?? null,
            provider,
            event.eventId,
            event.eventType,
            JSON.stringify(event.raw),
          ],
        );
        await tx.query('RELEASE SAVEPOINT payment_event');
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await tx.query('ROLLBACK TO SAVEPOINT payment_event');
        const duplicate = await tx.one<{ result: string }>(
          `SELECT result FROM orders_paymentevent WHERE (provider = $1 AND provider_event_id = $2) LIMIT 21`,
          [provider, event.eventId],
        );
        return duplicate?.result ?? '';
      }

      let result: string;
      if (payment && payment.provider !== provider) {
        result = 'provider_mismatch';
      } else if (payment && CAPTURE_EVENTS.has(event.eventType)) {
        // A verified event for ৳1 is still not ৳1,000 (D100).
        if (event.amount !== null && !quantize(event.amount).eq(quantize(payment.amount))) {
          result = 'amount_mismatch';
        } else {
          await this.capture(tx, context, payment.id, event.eventId, event.raw);
          result = 'captured';
        }
      } else if (payment && FAILURE_EVENTS.has(event.eventType)) {
        await this.fail(tx, payment.id, event.eventType);
        result = 'failed';
      } else {
        result = 'ignored';
      }

      // Append-only: the outcome is a targeted UPDATE, which leaves `updated_at` alone.
      await tx.query(
        `UPDATE orders_paymentevent SET processed = true, result = $2 WHERE id = $1::uuid`,
        [eventRowId, result],
      );
      return result;
    });
  }

  /**
   * `capture_payment`: the payment locked and captured once, the money posted
   * to the account it landed in, the order's payment status derived again.
   */
  private async capture(
    tx: Queryable,
    context: AuditContext,
    paymentId: string,
    providerReference: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const payment = await tx.one<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM orders_payment WHERE id = $1::uuid LIMIT 21 FOR UPDATE`,
      [paymentId],
    );
    if (!payment) throw new Error('Payment matching query does not exist.');
    // Idempotent: whoever held the lock first captured it.
    if (CAPTURED_STATES.has(payment.status)) return;
    if (payment.status === 'VOIDED' || payment.status === 'FAILED') {
      throw new Conflict(`A ${payment.status} payment cannot be captured.`);
    }
    // Django stamps `captured_at`, then `updated_at` as it saves. One UPDATE
    // cannot keep that order: Postgres fills the columns in table order, and
    // `updated_at` comes first. So the moment is read before the write.
    const capturedAt = await this.now(tx);
    await tx.query(
      `UPDATE orders_payment SET updated_at = clock_timestamp(), status = 'CAPTURED',
              provider_reference = CASE WHEN $2 = '' THEN provider_reference ELSE $2 END,
              payload = CASE WHEN $3 THEN payload || $4::jsonb ELSE payload END,
              captured_at = $5::timestamptz
        WHERE id = $1::uuid`,
      [
        payment.id,
        providerReference,
        Object.keys(payload).length > 0,
        JSON.stringify(payload),
        capturedAt,
      ],
    );

    const order = await tx.one<{
      id: string;
      number: string;
      currency: string;
      grand_total: string;
      branch_id: string;
      branch_code: string;
    }>(
      `SELECT o.id, o.number, o.currency, o.grand_total, o.branch_id, b.code AS branch_code
         FROM orders_order o JOIN accounts_branch b ON b.id = o.branch_id
        WHERE o.id = $1::uuid LIMIT 21 FOR UPDATE OF o`,
      [payment.order_id],
    );
    if (!order) throw new Error('Order matching query does not exist.');

    // Capture is when the money is really the shop's: this is where a gateway's
    // settled payment enters the cash book.
    if (!(await this.cashBook.alreadyPosted(tx, 'payment', payment.id))) {
      const accountId = await this.cashBook.recordSalePayment(tx, {
        branch: { id: order.branch_id, code: order.branch_code },
        amount: payment.amount,
        referenceType: 'payment',
        referenceId: payment.id,
        accountId: payment.account_id,
        method: payment.method,
        notes: `${order.number} - ${payment.method}`,
        occurredAt: capturedAt,
      });
      if (accountId !== null && payment.account_id !== accountId) {
        await tx.query(
          `UPDATE orders_payment SET updated_at = clock_timestamp(), account_id = $2::uuid WHERE id = $1::uuid`,
          [payment.id, accountId],
        );
      }
    }

    const ref = {
      id: order.id,
      number: order.number,
      branchId: order.branch_id,
      currency: order.currency,
      grandTotal: order.grand_total,
    };
    await this.orders.refreshPaymentStatus(tx, ref);
    await this.orders.logEvent(
      tx,
      order.id,
      'PAYMENT_CAPTURED',
      `${payment.method} ${payment.amount} captured`,
      { data: { payment_id: payment.id } },
    );
    await recordAudit(tx, context, {
      action: 'PAYMENT_RECORDED',
      entity: {
        type: 'Payment',
        id: payment.id,
        label: `${payment.method} ${payment.amount} (CAPTURED)`,
      },
      oldValues: { status: 'PENDING' },
      newValues: { status: 'CAPTURED', amount: payment.amount },
      branchId: order.branch_id,
    });
  }

  /** `timezone.now()`, read as the service reads it: before the row it stamps is saved. */
  private async now(tx: Queryable): Promise<string> {
    const row = await tx.one<{ now: string }>('SELECT clock_timestamp() AS now');
    return row?.now ?? '';
  }

  /** `fail_payment`: a payment not yet captured, marked failed. */
  private async fail(tx: Queryable, paymentId: string, reason: string): Promise<void> {
    const payment = await tx.one<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM orders_payment WHERE id = $1::uuid LIMIT 21 FOR UPDATE`,
      [paymentId],
    );
    if (!payment) throw new Error('Payment matching query does not exist.');
    if (CAPTURED_STATES.has(payment.status)) {
      throw new Conflict('A captured payment cannot be marked failed; refund it instead.');
    }
    const failedAt = await this.now(tx);
    await tx.query(
      `UPDATE orders_payment SET updated_at = clock_timestamp(), status = 'FAILED',
              failed_at = $2::timestamptz WHERE id = $1::uuid`,
      [payment.id, failedAt],
    );
    await this.orders.logEvent(tx, payment.order_id, 'PAYMENT_FAILED', reason || 'Payment failed');
  }
}
