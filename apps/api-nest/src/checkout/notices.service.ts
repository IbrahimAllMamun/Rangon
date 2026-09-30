import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { canonicalPhone } from '../common/phone';
import { pySlice, pyStr, pyStrip } from '../common/python';
import { Database, Queryable } from '../database/database.service';

/** A Celery task to queue once the transaction commits (`transaction.on_commit`). */
export interface Job {
  task: string;
  args: string[];
}

/**
 * `notifications.services` and `orders.services.leads`: the in-app
 * notifications an order raises, and the call-back list of abandoned
 * checkouts it closes.
 */
@Injectable()
export class NoticesService {
  private readonly logger = new Logger('rangon.orders');

  constructor(private readonly db: Database) {}

  /**
   * `notify_staff`: one notification per member of staff holding the
   * permission -- at the branch, or an owner or admin anywhere. Django runs
   * this after the order commits, so it is called after commit here too.
   */
  async notifyStaff(entry: {
    type: string;
    title: string;
    body: string;
    permission: string;
    branchId: string;
    link: string;
  }): Promise<void> {
    const users = await this.db.query<{
      id: string;
      role_code: string | null;
      is_superuser: boolean;
      role_id: string | null;
    }>(
      `SELECT DISTINCT u.id, u.email, r.code AS role_code, u.is_superuser, u.role_id
         FROM accounts_user u LEFT JOIN accounts_role r ON r.id = u.role_id
        WHERE u.is_active AND (u.branch_id = $1::uuid OR r.code IN ('OWNER', 'ADMIN'))
        ORDER BY u.email ASC`,
      [entry.branchId],
    );
    for (const user of users) {
      if (user.role_code === 'CUSTOMER') continue;
      if (!(await this.holds(user, entry.permission))) continue;
      await this.db.query(
        `INSERT INTO notifications_notification
           (id, created_at, updated_at, user_id, permission_code, branch_id, notification_type, level,
            title, body, link, data, read_at, emailed_at)
         VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4::uuid, $5, 'INFO', $6,
                 $7, $8, '{}'::jsonb, NULL, NULL)`,
        [
          randomUUID(),
          user.id,
          entry.permission,
          entry.branchId,
          entry.type,
          pySlice(entry.title, 160),
          entry.body,
          entry.link,
        ],
      );
    }
  }

  /** `User.has_perm_code`: an owner or a superuser holds everything. */
  private async holds(
    user: { role_code: string | null; is_superuser: boolean; role_id: string | null },
    code: string,
  ): Promise<boolean> {
    if (user.role_code === 'OWNER' || user.is_superuser) return true;
    if (!user.role_id) return false;
    const row = await this.db.one(
      `SELECT 1 AS found FROM accounts_role_permissions rp JOIN accounts_permission p ON p.id = rp.permission_id
        WHERE rp.role_id = $1::uuid AND p.code = $2 LIMIT 1`,
      [user.role_id, code],
    );
    return row !== null;
  }

  /**
   * `notify_customer`: the in-app row now, on the order's transaction; the
   * email and the SMS as jobs for after it commits. None of it can fail the order.
   */
  async notifyCustomer(
    tx: Queryable,
    order: { id: string; number: string; customerUserId: string | null },
    type: string,
    title: string,
  ): Promise<Job[]> {
    await tx.query(
      `INSERT INTO notifications_notification
         (id, created_at, updated_at, user_id, permission_code, branch_id, notification_type, level, title,
          body, link, data, read_at, emailed_at)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, '', NULL, $3, 'INFO', $4, $5, $6,
               $7::jsonb, NULL, NULL)`,
      [
        randomUUID(),
        order.customerUserId,
        type,
        pySlice(title, 160),
        `Order ${order.number}`,
        `/account/orders/${order.number}`,
        JSON.stringify({ order_number: order.number }),
      ],
    );
    return [
      { task: 'notifications.tasks.send_order_email', args: [order.id, type] },
      { task: 'notifications.tasks.send_order_sms', args: [order.id, type] },
    ];
  }

  /**
   * `leads.recover_for_order`: close the open lead this order answers --
   * matched on the customer's stored number first, then the delivery number.
   */
  async recoverLead(
    tx: Queryable,
    order: { id: string; customerPhone: string | null; shippingPhone: unknown },
  ): Promise<void> {
    for (const candidate of [order.customerPhone, order.shippingPhone]) {
      if (candidate === null || candidate === undefined) continue;
      const digits = canonicalPhone(pyStr(candidate));
      if (!digits) continue;
      const lead = await tx.one<{ id: string }>(
        `SELECT id FROM orders_abandonedcheckout WHERE phone = $1 AND status = 'OPEN'
          ORDER BY last_seen_at DESC LIMIT 1`,
        [digits],
      );
      if (!lead) continue;
      await tx.query(
        `UPDATE orders_abandonedcheckout SET status = 'RECOVERED', recovered_at = clock_timestamp(),
                recovered_order_id = $2::uuid, updated_at = clock_timestamp() WHERE id = $1::uuid`,
        [lead.id, order.id],
      );
      return;
    }
  }

  /**
   * `leads.capture`: record, or refresh, the one open lead for this mobile.
   * A number that is not a mobile is not a lead; and nothing here may fail
   * checkout, so a race is settled by the unique constraint and the winner's row.
   */
  async captureLead(entry: {
    phone: string;
    branchId: string;
    cartId: string;
    customerId: string | null;
    name: string;
    email: string;
    cartTotal: string;
    itemCount: number;
  }): Promise<void> {
    const digits = canonicalPhone(entry.phone);
    if (!digits) return;
    const name = pySlice(pyStrip(entry.name), 120);
    const email = pySlice(pyStrip(entry.email), 254);
    try {
      await this.db.transaction(async (tx) => {
        const lead = await tx.one<{ id: string; name: string; email: string }>(
          `SELECT id, name, email FROM orders_abandonedcheckout WHERE phone = $1 AND status = 'OPEN'
            ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE`,
          [digits],
        );
        if (!lead) {
          await tx.query(
            `INSERT INTO orders_abandonedcheckout
               (id, created_at, updated_at, phone, name, email, status, cart_total, item_count,
                last_seen_at, recovered_at, note, branch_id, cart_id, customer_id, recovered_order_id)
             VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2, $3, $4, 'OPEN', $5, $6,
                     clock_timestamp(), NULL, '', $7::uuid, $8::uuid, $9::uuid, NULL)`,
            [
              randomUUID(),
              digits,
              name,
              email,
              entry.cartTotal,
              entry.itemCount,
              entry.branchId,
              entry.cartId,
              entry.customerId,
            ],
          );
          return;
        }
        // A name and an email, once given, are kept when a later pass clears them.
        await tx.query(
          `UPDATE orders_abandonedcheckout SET branch_id = $2::uuid, cart_id = $3::uuid,
                  customer_id = $4::uuid, name = $5, email = $6, last_seen_at = clock_timestamp(),
                  cart_total = $7, item_count = $8, updated_at = clock_timestamp()
            WHERE id = $1::uuid`,
          [
            lead.id,
            entry.branchId,
            entry.cartId,
            entry.customerId,
            name || lead.name,
            email || lead.email,
            entry.cartTotal,
            entry.itemCount,
          ],
        );
      });
    } catch (error) {
      // Two tabs, one number, one instant: the constraint did its job.
      if ((error as { code?: string }).code !== '23505') throw error;
      this.logger.log(`abandoned-checkout capture raced for ${digits}`);
    }
  }
}
