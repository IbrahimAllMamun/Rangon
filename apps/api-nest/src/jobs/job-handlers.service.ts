import { Inject, Injectable, Logger } from '@nestjs/common';

import { NoticesService } from '../checkout/notices.service';
import type { AuditContext } from '../common/audit';
import { invalidUuid } from '../common/errors';
import { pyStr } from '../common/python';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { columns } from '../database/sql';
import { ORDER_COLUMNS } from '../finance/party-ledger.service';
import { InventoryAdminService } from '../inventory/admin/inventory-admin.service';
import { type AfterCommit, StockService } from '../inventory/stock.service';
import { OrderLifecycle } from '../orders/order-lifecycle.service';
import { pyTruthy } from '../http/request-body';
import { Jobs } from './jobs.service';
import { Mailer } from './mailer.service';
import { smsBodyFor, trackingUrl } from './sms';
import { SmsService } from './sms.service';
import {
  STOCK_ROW_FROM,
  STOCK_ROW_FROM_BY_VARIANT,
  STOCK_ROW_SELECT,
  type StockRow,
  stockRow,
} from './stock-rows';

/**
 * A fault the Celery task hands to `self.retry`: a mail server, an SMS
 * gateway or the storefront not answering. Anything else a job raises is a
 * failure Celery does not retry, and neither does this.
 */
export class RetryJob extends Error {
  constructor(readonly fault: unknown) {
    super(`Retry: ${String(fault)}`);
  }
}

/** `get_audit_context()` outside a request: nobody's address, agent or request id. */
const NO_REQUEST: AuditContext = { ipAddress: null, userAgent: '', requestId: '' };

/** `Order.get_status_display()`. */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return requested',
  RETURNED: 'Returned',
  REFUNDED: 'Refunded',
};

interface OrderForMessage {
  id: string;
  number: string;
  status: string;
  currency: string;
  grand_total: string;
  refunded_total: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
}

/**
 * The ten background jobs (ADR-0016), each named for the Celery task it
 * replaces and answering the word that task returns: `sent`, `skipped`,
 * `released:2`. None owns a stock or money invariant: the one that moves
 * stock, the reservation sweep, goes through the order's status machine and
 * its locks, as a cancellation at the desk does.
 */
@Injectable()
export class JobHandlers {
  private readonly logger = new Logger('rangon.jobs');

  constructor(
    private readonly db: Database,
    private readonly mailer: Mailer,
    private readonly sms: SmsService,
    private readonly notices: NoticesService,
    private readonly jobs: Jobs,
    private readonly stock: StockService,
    private readonly lifecycle: OrderLifecycle,
    private readonly inventory: InventoryAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** One attempt at a job. Throws `RetryJob` for what its task retries. */
  async run(task: string, args: unknown[]): Promise<string> {
    switch (task) {
      case 'content.tasks.revalidate_storefront':
        return this.revalidateStorefront(args[0]);
      case 'notifications.tasks.send_notification_email':
        return this.sendNotificationEmail(args[0]);
      case 'notifications.tasks.send_order_email':
        return this.sendOrderEmail(args[0], args[1]);
      case 'notifications.tasks.send_order_sms':
        return this.sendOrderSms(args[0], args[1]);
      case 'inventory.tasks.notify_low_stock':
        return this.notifyLowStock(args[0]);
      case 'orders.tasks.release_expired_reservations':
        return this.releaseExpiredReservations();
      case 'orders.tasks.expire_abandoned_carts':
        return this.expireAbandonedCarts(args.length ? Number(args[0]) : 30);
      case 'inventory.tasks.verify_inventory_integrity':
        return this.verifyInventoryIntegrity();
      case 'inventory.tasks.send_low_stock_digest':
        return this.sendLowStockDigest();
      case 'catalog.tasks.check_expiring_stock':
        return this.checkExpiringStock(args.length ? Number(args[0]) : 60);
      default:
        throw new Error(`No handler for the job ${task}.`);
    }
  }

  /** A key as the ORM reads one handed to `filter(pk=...)`: Django's `ValidationError` otherwise. */
  private key(value: unknown): string {
    const id = parseUuid(value);
    if (!id) throw invalidUuid(pyStr(value));
    return id;
  }

  // --- Queued ------------------------------------------------------------------------------------

  /** `content.tasks.revalidate_storefront`: ask the web app to drop the pages cached under these tags. */
  private async revalidateStorefront(tags: unknown): Promise<string> {
    const url = this.env.WEB_REVALIDATE_URL;
    if (!url || !pyTruthy(tags)) return 'skipped';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Revalidate-Secret': this.env.WEB_REVALIDATE_SECRET,
        },
        body: JSON.stringify({ tags: Array.from(tags as Iterable<unknown>) }),
        signal: AbortSignal.timeout(5000),
      });
      // `urlopen` raises for anything that is not a success.
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      await response.arrayBuffer();
    } catch (error) {
      this.logger.warn(`Storefront revalidation failed for ${pyStr(tags)}: ${String(error)}`);
      throw new RetryJob(error);
    }
    return 'sent';
  }

  /** `notifications.tasks.send_notification_email`: a staff notice, to the member it is addressed to. */
  private async sendNotificationEmail(notificationId: unknown): Promise<string> {
    const id = this.key(notificationId);
    const notice = await this.db.one<{ title: string; body: string; email: string | null }>(
      `SELECT n.title, n.body, u.email FROM notifications_notification n
         LEFT JOIN accounts_user u ON u.id = n.user_id WHERE n.id = $1::uuid`,
      [id],
    );
    if (!notice || !notice.email) return 'skipped';
    try {
      await this.mailer.send({
        subject: `[Rangon] ${notice.title}`,
        text: notice.body,
        to: [notice.email],
      });
    } catch (error) {
      this.logger.warn(`Notification email failed: ${String(error)}`);
      throw new RetryJob(error);
    }
    await this.db.query(
      `UPDATE notifications_notification SET emailed_at = clock_timestamp() WHERE id = $1::uuid`,
      [id],
    );
    return 'sent';
  }

  private order(orderId: unknown): Promise<OrderForMessage | null> {
    return this.db.one<OrderForMessage>(
      `SELECT o.id, o.number, o.status, o.currency, o.grand_total, o.refunded_total,
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
         FROM orders_order o INNER JOIN customers_customer c ON c.id = o.customer_id
        WHERE o.id = $1::uuid`,
      [this.key(orderId)],
    );
  }

  /** `notifications.tasks.send_order_email`: tell the customer, by email, what became of their order. */
  private async sendOrderEmail(orderId: unknown, notificationType: unknown): Promise<string> {
    const order = await this.order(orderId);
    if (!order) return 'missing';
    if (!order.customer_email) return 'no-email';
    const subjects: Record<string, string> = {
      ORDER_CONFIRMED: `We have your order ${order.number}`,
      ORDER_SHIPPED: `Order ${order.number} is on its way`,
      ORDER_DELIVERED: `Order ${order.number} has been delivered`,
      REFUND_COMPLETED: `Refund issued for order ${order.number}`,
    };
    const type = typeof notificationType === 'string' ? notificationType : '';
    const subject = Object.hasOwn(subjects, type)
      ? (subjects[type] as string)
      : `Update on order ${order.number}`;
    const text =
      `Hello ${order.customer_name},\n\n${subject}.\n\n` +
      `Order: ${order.number}\nTotal: ${order.currency} ${order.grand_total}\n` +
      `Status: ${STATUS_LABELS[order.status] ?? order.status}\n\n` +
      `Track it: ${trackingUrl(order, this.env.RANGON_PUBLIC_URL)}\n\n` +
      'Rangon Fashion';
    try {
      await this.mailer.send({
        subject: `[Rangon Fashion] ${subject}`,
        text,
        to: [order.customer_email],
      });
    } catch (error) {
      this.logger.warn(`Order email failed: ${String(error)}`);
      throw new RetryJob(error);
    }
    return 'sent';
  }

  /**
   * `notifications.tasks.send_order_sms`: the same, by text. A message the
   * gateway refused is recorded and not retried -- re-sending it spends the
   * money again; only a fault on the way is.
   */
  private async sendOrderSms(orderId: unknown, notificationType: unknown): Promise<string> {
    const order = await this.order(orderId);
    if (!order) return 'missing';
    if (!order.customer_phone) return 'no-phone';
    const type = typeof notificationType === 'string' ? notificationType : '';
    const body = smsBodyFor(order, type, this.env.RANGON_PUBLIC_URL);
    if (!body) return 'no-template';
    try {
      const status = await this.sms.send({
        to: order.customer_phone,
        body,
        notificationType: type,
        orderNumber: order.number,
      });
      return status.toLowerCase();
    } catch (error) {
      this.logger.warn(`Order SMS failed: ${String(error)}`);
      throw new RetryJob(error);
    }
  }

  /** `ProductVariant.label`: its name, else its attribute values, as the property reads them. */
  private async variantLabel(row: StockRow): Promise<string> {
    if (row.variant_name) return row.variant_name;
    const links = await this.db.query<{ attribute_value_id: string }>(
      `SELECT "catalog_variantattributevalue"."id", "catalog_variantattributevalue"."created_at",
              "catalog_variantattributevalue"."updated_at", "catalog_variantattributevalue"."variant_id",
              "catalog_variantattributevalue"."attribute_id", "catalog_variantattributevalue"."attribute_value_id"
         FROM "catalog_variantattributevalue" WHERE "catalog_variantattributevalue"."variant_id" = $1::uuid`,
      [row.variant_id],
    );
    const values: string[] = [];
    for (const link of links) {
      const value = await this.db.one<{ label: string; value: string }>(
        `SELECT label, value FROM catalog_attributevalue WHERE id = $1::uuid`,
        [link.attribute_value_id],
      );
      values.push(value ? value.label || value.value : '');
    }
    return values.join(' / ');
  }

  /** `inventory.tasks.notify_low_stock`: tell the branch's stock readers a shelf is at or under its reorder point. */
  private async notifyLowStock(inventoryId: unknown): Promise<string> {
    const [values] = await this.db.arrays(
      `SELECT ${STOCK_ROW_SELECT} ${STOCK_ROW_FROM} WHERE "inventory_inventory"."id" = $1::uuid
        ORDER BY "inventory_inventory"."id" ASC LIMIT 1`,
      [this.key(inventoryId)],
    );
    if (!values) return 'skipped';
    const row = stockRow(values);
    if (row.available > row.reorder_point) return 'skipped';
    const out = row.available <= 0;
    await this.notices.notifyStaff({
      type: out ? 'OUT_OF_STOCK' : 'LOW_STOCK',
      title: `${out ? 'Out of stock' : 'Low stock'}: ${row.product_name} ${await this.variantLabel(row)}`,
      body: `${row.sku} at ${row.branch_code}: ${row.available} available (reorder point ${row.reorder_point}).`,
      permission: 'inventory.view',
      branchId: row.branch_id,
      level: out ? 'ERROR' : 'WARNING',
      link: '/admin/inventory?filter=low-stock',
      data: { variant_id: row.variant_id, available: row.available },
    });
    return 'notified';
  }

  // --- Scheduled ---------------------------------------------------------------------------------

  /**
   * `orders.tasks.release_expired_reservations`: cancel the unpaid online
   * orders past the reservation window and give their stock back. Cash on
   * delivery is exempt -- confirmed when placed, it waits for no payment.
   * Each order is its own transaction, under its row lock; one that will not
   * cancel is logged and the sweep goes on.
   */
  private async releaseExpiredReservations(): Promise<string> {
    const O = '"orders_order"';
    const expired = await this.db.arrays(
      `SELECT DISTINCT ${columns(O, ORDER_COLUMNS)} FROM ${O}
        WHERE (${O}."channel" = 'ONLINE'
          AND ${O}."placed_at" < clock_timestamp() - make_interval(mins => $1::int)
          AND ${O}."status" = 'PENDING' AND NOT ${O}."stock_committed"
          AND NOT (EXISTS(SELECT 1 AS "a" FROM "orders_payment" U1
                           WHERE (U1."method" = 'COD' AND U1."order_id" = (${O}."id")) LIMIT 1)))
        ORDER BY ${O}."placed_at" DESC`,
      [this.env.RANGON_RESERVATION_MINUTES],
    );
    let released = 0;
    for (const values of expired) {
      const id = values[ORDER_COLUMNS.indexOf('id')] as string;
      try {
        await this.stock.run((tx, after: AfterCommit) =>
          this.lifecycle.transition(
            tx,
            after,
            NO_REQUEST,
            id,
            'CANCELLED',
            'PAYMENT_TIMEOUT: reservation expired',
            null,
          ),
        );
        released += 1;
      } catch (error) {
        const number = values[ORDER_COLUMNS.indexOf('number')] as string;
        this.logger.error(`Could not release reservation for order ${number}: ${String(error)}`);
      }
    }
    return `released:${released}`;
  }

  /** `orders.tasks.expire_abandoned_carts`: switch off the carts nobody has touched in `days`. */
  private async expireAbandonedCarts(days: number): Promise<string> {
    const rows = await this.db.query(
      `UPDATE "orders_cart" SET "is_active" = false
        WHERE ("orders_cart"."is_active"
          AND "orders_cart"."last_activity_at" < clock_timestamp() - make_interval(days => $1::int))
        RETURNING 1 AS "a"`,
      [days],
    );
    return `expired:${rows.length}`;
  }

  /** `inventory.tasks.verify_inventory_integrity`: the ledger against the cache. Reports; never rewrites. */
  private async verifyInventoryIntegrity(): Promise<string> {
    const { issues } = await this.inventory.verifyIntegrity(null as never, {});
    if (!issues.length) return 'clean';
    this.logger.error(`Inventory integrity drift on ${issues.length} position(s)`);
    await this.notices.notifyStaff({
      type: 'INTEGRITY_ALERT',
      title: `Inventory integrity: ${issues.length} position(s) drifted`,
      body: issues
        .slice(0, 20)
        .map(
          (issue) =>
            `${pyStr(issue.sku)} @ ${pyStr(issue.branch)}: cached ${pyStr(issue.cached_on_hand)} vs ledger ${pyStr(issue.ledger_on_hand)}`,
        )
        .join('\n'),
      permission: 'inventory.adjust',
      branchId: null,
      level: 'ERROR',
      link: '/admin/inventory?filter=integrity',
    });
    return `drift:${issues.length}`;
  }

  /** `inventory.tasks.send_low_stock_digest`: one notice of what needs reordering, and its email. */
  private async sendLowStockDigest(): Promise<string> {
    const low = (
      await this.db.arrays(
        `SELECT ${STOCK_ROW_SELECT} ${STOCK_ROW_FROM}
          WHERE "inventory_inventory"."on_hand" <= ("inventory_inventory"."reorder_point")
          ORDER BY "accounts_branch"."name" ASC, "inventory_inventory"."on_hand" ASC LIMIT 100`,
      )
    ).map(stockRow);
    if (!low.length) return 'none';
    const written = await this.notices.notifyStaff({
      type: 'LOW_STOCK',
      title: `${low.length} product(s) need reordering`,
      body: low
        .slice(0, 30)
        .map((row) => `${row.sku} — ${row.product_name}: ${row.available} left`)
        .join('\n'),
      permission: 'purchases.create',
      branchId: null,
      level: 'WARNING',
      link: '/admin/inventory?filter=low-stock',
    });
    // `email=True`: each notice is also mailed, by a job of its own.
    for (const id of written) {
      await this.jobs.delay('notifications.tasks.send_notification_email', [id]);
    }
    return `digest:${low.length}`;
  }

  /**
   * `catalog.tasks.check_expiring_stock`: warn about stock that expires
   * within `days`. The horizon is counted from `timezone.now().date()`,
   * which is the day in UTC, not the shop's.
   */
  private async checkExpiringStock(days: number): Promise<string> {
    const rows = (
      await this.db.arrays(
        `SELECT ${STOCK_ROW_SELECT} ${STOCK_ROW_FROM_BY_VARIANT}
          WHERE ("inventory_inventory"."on_hand" > ("inventory_inventory"."reserved")
            AND "catalog_productvariant"."expiry_date" IS NOT NULL
            AND "catalog_productvariant"."expiry_date" <= (clock_timestamp() AT TIME ZONE 'UTC')::date + $1::int)
          ORDER BY "catalog_productvariant"."expiry_date" ASC LIMIT 100`,
        [days],
      )
    ).map(stockRow);
    if (!rows.length) return 'none';
    await this.notices.notifyStaff({
      type: 'STOCK_EXPIRING',
      title: `${rows.length} stocked item(s) expire within ${days} days`,
      body: rows
        .slice(0, 30)
        .map(
          (row) =>
            `${row.sku} — ${row.product_name}: ${row.available} units, expires ${row.expiry_date}`,
        )
        .join('\n'),
      permission: 'inventory.view',
      branchId: null,
      level: 'WARNING',
      link: '/admin/inventory?filter=expiring',
    });
    return `expiring:${rows.length}`;
  }
}
