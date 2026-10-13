import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
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
import { Conflict, PermissionDenied, ValidationError } from '../common/errors';
import type { QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database, Queryable } from '../database/database.service';
import { dataGet, pyTruthy } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { Jobs } from '../jobs/jobs.service';
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
    private readonly jobs: Jobs,
    private readonly permissions: RolePermissions,
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
    for (const job of jobs) await this.jobs.delay(job.task, job.args);
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
    if (validated.values.to_status === 'CANCELLED') {
      // Cancelling is its own right, and it refunds what was captured
      // (business-rules section 5.2). This route once asked only for
      // `orders.update_status` and moved the status: somebody who may not
      // cancel could, and a paid order was left cancelled, the money kept (D166).
      if (!(await this.permissions.has(user, 'sales.cancel'))) throw new PermissionDenied();
      const order = await this.staffOrders.find(user, pk, query);
      return this.cancelFound(order, validated.values.reason ?? '', user, context);
    }
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
    return this.cancelFound(found, given === undefined ? '' : given, user, context);
  }

  /** `cancel_order`, for the two routes that reach it: `cancel`, and `status` asked for CANCELLED. */
  private async cancelFound(
    found: StaffOrderRow,
    reason: unknown,
    user: RequestUser,
    context: AuditContext,
  ) {
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
   * `payments`: money actually received, keyed by the `Idempotency-Key`
   * header. The whole of it is `receive_payment`, one transaction under the
   * order's lock.
   */
  async recordPayment(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: unknown,
    idempotencyKey: string | null,
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
    await this.stock.run((tx: Queryable) =>
      this.payments.receive(
        tx,
        context,
        found.id,
        {
          method: paid.method,
          amount: new Dec(paid.amount),
          reference: paid.reference ?? '',
          accountId: paid.account ?? null,
          idempotencyKey,
        },
        { id: user.id, email: user.email },
      ),
    );
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
