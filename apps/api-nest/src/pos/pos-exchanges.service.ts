import { Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
import { money, quantize, ZERO } from '../checkout/pricing';
import type { AuditContext } from '../common/audit';
import { Dec } from '../common/decimal';
import { Conflict, ValidationError } from '../common/errors';
import { Database, type Queryable } from '../database/database.service';
import { dataGet } from '../http/request-body';
import { AfterCommit, StockService } from '../inventory/stock.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { type Opened, ReturnsService } from '../orders/returns.service';
import { type StaffOrderRow, StaffOrders } from '../orders/staff-order.service';
import { PosSales } from './pos-sales.service';

/**
 * One half of the body -- the return or the sale -- or, where the body is not
 * a dict, the body itself, so its serializer refuses it as DRF would.
 */
function part(data: unknown, key: string): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  return dataGet(data, key) ?? {};
}

/** An Idempotency-Key past this cannot be stored with the prefix its refund carries. */
const MAX_KEY = 64;

/**
 * What an exchange settles to, from what the returned goods were worth and
 * what the new sale comes to. The credit pays for the new goods up to their
 * total; the customer pays the rest, or is given back what the credit did
 * not use. Pure, so it is tested on its own.
 */
export function exchangeSettlement(credit: Dec, total: Dec) {
  const applied = credit.lt(total) ? quantize(credit) : quantize(total);
  return {
    credit: quantize(credit),
    applied,
    toPay: quantize(total.minus(applied)),
    toGiveBack: quantize(credit.minus(applied)),
  };
}

/**
 * An exchange at the counter (business rules 2.6): the customer's goods come
 * back as a return and new goods go out as a sale, in one transaction, so
 * neither happens without the other.
 *
 * The money is two ordinary movements through the branch's cash drawer -- the
 * return refunds what the goods were worth, and the sale takes that much as
 * cash before the customer pays the rest -- so the drawer moves by the
 * difference alone, and every report reads a return and a sale as it always
 * has. The sale is rung up before the refund leaves, so a drawer short of the
 * whole refund but not of the difference is not refused.
 *
 * Once per `Idempotency-Key`: the key is the sale's, held under an advisory
 * lock for the transaction, so a double-click or a retry answers with the
 * exchange already made. The stock rows of both the goods coming back and the
 * goods going out are locked first, lowest id first, as every sale locks its
 * own: two movements in one transaction cannot then deadlock with a sale.
 */
@Injectable()
export class PosExchanges {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly stock: StockService,
    private readonly returns: ReturnsService,
    private readonly sales: PosSales,
    private readonly staffOrders: StaffOrders,
    private readonly orders: OrderWritesService,
  ) {}

  async create(
    user: RequestUser,
    data: unknown,
    idempotencyKey: string | null,
    context: AuditContext,
  ) {
    const key = idempotencyKey ?? '';
    if (!key)
      throw new ValidationError('An exchange needs an Idempotency-Key header, so it runs once.');
    if (key.length > MAX_KEY)
      throw new ValidationError(`An Idempotency-Key is at most ${MAX_KEY} characters.`);
    const ask = await this.returns.counterAsk(part(data, 'return'));
    const sale = await this.sales.validated(part(data, 'sale'));
    const branch = await this.permissions.resolveBranch(user, sale.branch ?? null);

    let opened: Opened | null = null;
    const made = await this.stock.run(async (tx: Queryable, after: AfterCommit) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `pos-exchange:${key}`,
      ]);
      const existing = await this.sales.saleByKey(tx, key);
      if (existing) {
        const returnId = await this.returnOf(tx, existing);
        // A key an ordinary sale holds is not this exchange's to answer with.
        if (!returnId)
          throw new Conflict('That Idempotency-Key belongs to another sale; use a new one.');
        return { saleId: existing, returnId };
      }
      await this.sameBranch(tx, ask.orderId, branch.id);

      const back = await tx.query<{ variant_id: string }>(
        `SELECT "variant_id" FROM "orders_orderitem" WHERE "id" = ANY($1::uuid[])`,
        [ask.lines.map((line) => line.orderItem)],
      );
      await this.stock.lock(tx, branch.id, [
        ...back.map((row) => row.variant_id),
        ...sale.lines.map((line) => line.variant),
      ]);

      let saleId = '';
      const request = await this.returns.counterReturn(
        tx,
        after,
        context,
        user,
        ask,
        { method: 'CASH', idempotencyKey: `exchange:${key}` },
        async (returned, worth) => {
          saleId = await this.sales.createIn(tx, after, context, user, branch, sale, key, {
            amount: worth,
            reference: `Exchange ${returned.number}`,
          });
        },
      );
      opened = request;
      const number = (
        (await tx.one<{ number: string }>(`SELECT "number" FROM "orders_order" WHERE "id" = $1`, [
          saleId,
        ])) as { number: string }
      ).number;
      await this.orders.logEvent(
        tx,
        saleId,
        'EXCHANGE',
        `Exchange: ${request.number} for ${request.orderNumber}`,
        {
          data: { return_id: request.id, return: request.number, order: request.orderNumber },
          actorId: user.id,
        },
      );
      await this.orders.logEvent(
        tx,
        ask.orderId,
        'EXCHANGE',
        `Exchanged on ${number} (${request.number})`,
        { data: { return_id: request.id, sale: number }, actorId: user.id },
      );
      return { saleId, returnId: request.id };
    });
    if (opened) await this.returns.notifyOpened(opened);

    const returned = made.returnId ? await this.returns.answerFor(made.returnId) : null;
    const order = await this.staffOrders.detail(
      (await this.staffOrders.byId(made.saleId)) as StaffOrderRow,
    );
    const worth = new Dec(
      String((returned as { refund_amount?: unknown } | null)?.refund_amount ?? ZERO),
    );
    const settled = exchangeSettlement(worth, new Dec(String(order.grand_total)));
    return {
      return_request: returned,
      sale: order,
      settlement: {
        credit: money(settled.credit),
        applied: money(settled.applied),
        to_pay: money(settled.toPay),
        to_give_back: money(settled.toGiveBack),
      },
    };
  }

  /**
   * What the goods coming back are worth, before the customer pays: the
   * register takes it off what is due. Nothing is written.
   */
  async quote(user: RequestUser, data: unknown, context: AuditContext) {
    const ask = await this.returns.counterAsk(part(data, 'return'));
    const branch = await this.permissions.resolveBranch(user, null);
    await this.sameBranch(this.db, ask.orderId, branch.id);
    return { credit: money(await this.returns.worth(user, context, ask)) };
  }

  /**
   * An exchange is at the till that sold the goods: both of its cash
   * movements go through that one drawer.
   */
  private async sameBranch(q: Queryable, orderId: string, branchId: string): Promise<void> {
    const original = await q.one<{ number: string; branch_id: string }>(
      `SELECT "number", "branch_id" FROM "orders_order" WHERE "id" = $1 LIMIT 21`,
      [orderId],
    );
    if (original && original.branch_id !== branchId) {
      throw new Conflict(
        `${original.number} was sold at another branch; exchange it there, or return it.`,
      );
    }
  }

  /** The return an exchange's sale was made for: its `EXCHANGE` event names it. */
  private async returnOf(tx: Queryable, saleId: string): Promise<string | null> {
    const row = await tx.one<{ id: string | null }>(
      `SELECT "data"->>'return_id' AS "id" FROM "orders_orderevent"
        WHERE "order_id" = $1 AND "event_type" = 'EXCHANGE'
        ORDER BY "created_at" ASC LIMIT 1`,
      [saleId],
    );
    return row?.id ?? null;
  }
}
