import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { NoticesService } from '../checkout/notices.service';
import type { AuditContext } from '../common/audit';
import { localIso } from '../common/datetime';
import { Dec } from '../common/decimal';
import {
  charField,
  choiceField,
  decimalField,
  errorMessages,
  type Fields,
  pkRelatedField,
  runSerializer,
} from '../common/drf';
import { Conflict, ValidationError } from '../common/errors';
import type { QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { dataGet, pyTruthy } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { CeleryService } from '../jobs/celery.service';
import { type Moved, OrderLifecycle, reasonOr } from './order-lifecycle.service';
import { OrderPayments } from './order-payments.service';
import { type StaffOrderRow, StaffOrders } from './staff-order.service';

const PAYMENT_METHODS = [
  'CASH',
  'CARD',
  'MOBILE_MFS',
  'BANK',
  'ONLINE_GATEWAY',
  'COD',
  'STORE_CREDIT',
  'OTHER',
] as const;
/** `Order.is_cancellable`. */
const CANCELLABLE = new Set(['PENDING', 'CONFIRMED', 'PROCESSING']);

/** `StatusChangeSerializer`: any status at all; the status machine refuses what it does not know. */
const STATUS_FIELDS: Fields = {
  to_status: charField(),
  reason: charField({ required: false, allowBlank: true, maxLength: 255 }),
};

/**
 * `OrderViewSet`'s writes: an order moved along its status machine,
 * cancelled, paid and refunded by staff. Each is one transaction, begun by
 * the service it ports.
 */
@Injectable()
export class StaffOrderActions {
  constructor(
    private readonly db: Database,
    private readonly staffOrders: StaffOrders,
    private readonly lifecycle: OrderLifecycle,
    private readonly payments: OrderPayments,
    private readonly stock: StockService,
    private readonly notices: NoticesService,
    private readonly celery: CeleryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async answer(id: string) {
    return this.staffOrders.detail((await this.staffOrders.byId(id)) as StaffOrderRow);
  }

  /** An account that is open: `Account.objects.filter(is_active=True)`. */
  private account() {
    return pkRelatedField(
      async (id) =>
        (await this.db.one(
          `SELECT 1 AS "a" FROM "finance_account"
            WHERE ("finance_account"."is_active" AND "finance_account"."id" = $1) LIMIT 1`,
          [id],
        )) !== null,
      { required: false, allowNull: true },
    );
  }

  /** `_notify_status`, once the move has committed: the in-app row, then the email and the SMS. */
  private async notify(moved: Moved): Promise<void> {
    if (!moved.notice) return;
    const customer = await this.db.one<{ user_id: string | null }>(
      `SELECT "user_id" FROM "customers_customer" WHERE "id" = $1`,
      [moved.customerId],
    );
    const jobs = await this.notices.notifyCustomer(
      this.db,
      { id: moved.id, number: moved.number, customerUserId: customer?.user_id ?? null },
      moved.notice[0],
      moved.notice[1],
    );
    for (const job of jobs) await this.celery.delay(job.task, job.args);
  }

  /** `status`: the body is validated before the order is looked for. */
  async status(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{ to_status: string; reason?: string }>(
      STATUS_FIELDS,
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const found = await this.staffOrders.find(user, pk, query);
    const moved = await this.stock.run((tx: Queryable, after: AfterCommit) =>
      this.lifecycle.transition(
        tx,
        after,
        context,
        found.id,
        validated.values.to_status,
        validated.values.reason ?? '',
        { id: user.id, email: user.email },
      ),
    );
    await this.notify(moved);
    return this.answer(found.id);
  }

  /**
   * `cancel`: `cancel_order`. Only an order not yet packed; cancelled through
   * the status machine, which releases its stock and its coupon, and then
   * whatever was paid and not yet refunded goes back. The reason is the
   * body's `reason` as sent: Python slices it, so a string or a list passes
   * and anything else is a 500 (D168, copied).
   */
  async cancel(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    context: AuditContext,
  ) {
    const found = await this.staffOrders.find(user, pk, query);
    const given = dataGet(data(), 'reason');
    const reason = given === undefined ? '' : given;
    if (!CANCELLABLE.has(found.status))
      throw new Conflict(`An order in status ${found.status} cannot be cancelled.`);
    const actor = { id: user.id, email: user.email };
    const cancelled = await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      const moved = await this.lifecycle.transition(
        tx,
        after,
        context,
        found.id,
        'CANCELLED',
        reason,
        actor,
      );
      if (new Dec(moved.paidTotal).gt(0)) {
        await this.payments.refundOrder(tx, context, found.id, {
          amount: new Dec(moved.paidTotal).minus(moved.refundedTotal),
          actor,
          reason: reasonOr(reason, 'Order cancelled'),
          ...(typeof reason === 'string' || !pyTruthy(reason) ? {} : { reasonData: reason }),
        });
      }
      return moved;
    });
    // The answer is the order as the status machine left it: the refund that
    // followed is in its `refunds` and `payments`, and not yet in its own
    // payment status or totals (D170, copied).
    return {
      ...(await this.answer(found.id)),
      payment_status: cancelled.paymentStatus,
      paid_total: cancelled.paidTotal,
      refunded_total: cancelled.refundedTotal,
    };
  }

  /**
   * `payments`: money actually received. A pending payment of the same
   * method and amount is captured -- its account set first, on its own, when
   * the body names one -- and anything else is recorded as a new captured
   * payment. Nothing compares it with what the order still owes.
   */
  async recordPayment(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      method: string;
      amount: string;
      reference?: string;
      account?: string | null;
    }>(
      {
        method: choiceField(PAYMENT_METHODS),
        amount: decimalField(14, 2, { minValue: '0' }),
        reference: charField({ required: false, allowBlank: true, maxLength: 128 }),
        account: this.account(),
      },
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const paid = validated.values;
    const found = await this.staffOrders.find(user, pk, query);
    const actor = { id: user.id, email: user.email };

    const pending = await this.db.one<{ id: string; amount: string }>(
      `SELECT "id", "amount" FROM "orders_payment"
        WHERE ("orders_payment"."method" = $2 AND "orders_payment"."order_id" = $1
               AND "orders_payment"."status" = 'PENDING')
        ORDER BY "orders_payment"."created_at" ASC LIMIT 1`,
      [found.id, paid.method],
    );
    if (pending && new Dec(pending.amount).eq(paid.amount)) {
      // The account is chosen at capture, because that is when the money arrives.
      if (paid.account !== null && paid.account !== undefined) {
        await this.db.query(
          `UPDATE "orders_payment" SET "updated_at" = clock_timestamp(), "account_id" = $2
            WHERE "orders_payment"."id" = $1`,
          [pending.id, paid.account],
        );
      }
      await this.stock.run((tx: Queryable) =>
        this.payments.capture(tx, context, pending.id, { actor }),
      );
    } else {
      const branch = (await this.db.one<{ code: string }>(
        `SELECT "code" FROM "accounts_branch" WHERE "id" = $1`,
        [found.branch_id],
      )) as { code: string };
      await this.stock.run((tx: Queryable) =>
        this.payments.recordCaptured(
          tx,
          context,
          {
            id: found.id,
            number: found.number,
            branchId: found.branch_id,
            currency: found.currency,
            grandTotal: found.grand_total,
            branchCode: branch.code,
          },
          {
            method: paid.method,
            amount: new Dec(paid.amount),
            tenderedAmount: null,
            reference: paid.reference ?? '',
            accountId: paid.account ?? null,
          },
          actor,
        ),
      );
    }
    return this.answer(found.id);
  }

  /**
   * `refunds`: `refund_order` as the back office asks for it -- an amount, a
   * reason, a method the ledger knows, an open account -- keyed by the
   * `Idempotency-Key` header. Answers the refund.
   */
  async refund(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const validated = await runSerializer<{
      amount: string;
      reason?: string;
      method?: string;
      account?: string | null;
    }>(
      {
        amount: decimalField(14, 2, { minValue: '0' }),
        reason: charField({ required: false, allowBlank: true, maxLength: 255 }),
        method: choiceField(PAYMENT_METHODS, { required: false }),
        account: this.account(),
      },
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const asked = validated.values;
    const found = await this.staffOrders.find(user, pk, query);
    const refundId = await this.stock.run((tx: Queryable) =>
      this.payments.refundOrder(tx, context, found.id, {
        amount: new Dec(asked.amount),
        actor: { id: user.id, email: user.email },
        reason: asked.reason ?? '',
        method: asked.method ?? null,
        accountId: asked.account ?? null,
        idempotencyKey,
      }),
    );
    const refund = (await this.db.one<{
      id: string;
      order_id: string;
      payment_id: string | null;
      amount: string;
      method: string;
      status: string;
      reason: string;
      provider_reference: string;
      created_at: string;
    }>(
      `SELECT "id", "order_id", "payment_id", "amount", "method", "status", "reason",
              "provider_reference", "created_at"
         FROM "orders_refund" WHERE "orders_refund"."id" = $1`,
      [refundId],
    )) as {
      id: string;
      order_id: string;
      payment_id: string | null;
      amount: string;
      method: string;
      status: string;
      reason: string;
      provider_reference: string;
      created_at: string;
    };
    return {
      id: refund.id,
      order: refund.order_id,
      payment: refund.payment_id,
      amount: refund.amount,
      method: refund.method,
      status: refund.status,
      reason: refund.reason,
      provider_reference: refund.provider_reference,
      created_at: localIso(refund.created_at, this.env.DJANGO_TIME_ZONE),
    };
  }
}
