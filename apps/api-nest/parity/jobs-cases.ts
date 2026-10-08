/**
 * Parity cases for the background jobs (phase 7 part 4b, ADR-0016): each of
 * the ten Celery tasks beside the Nest handler that replaces it.
 *
 * The parity stack has no worker, so a job is run on demand: a stand-in
 * route both APIs carry here and nowhere else (`gateway/parity_gateway/jobs.py`,
 * `serve.ts`) runs one job, every attempt its task allows, and answers the
 * word it returned. Each case compares that word, the rows the job wrote, the
 * jobs it queued in turn, and what it sent to the sink (`sink.ts`): mail as a
 * reader sees it, and storefront revalidations.
 *
 * The customers and orders are fixture_jobs.py's, the notices
 * fixture_notifications.py's; the sweep and the stock jobs read whatever the
 * demo seed left.
 */
import pg from 'pg';

import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const TABLES = [
  'notifications_notification',
  'notifications_smsmessage',
  'orders_order',
  'orders_orderevent',
  'orders_cart',
  'inventory_inventory',
  'inventory_inventorytransaction',
  'promotions_coupon',
  'promotions_couponredemption',
  'catalog_productvariant',
];

const EFFECTS = [
  // 0. Orders a job changed.
  `SELECT o.number, o.status, o.cancel_reason, o.stock_committed,
          o.cancelled_at IS DISTINCT FROM s.cancelled_at AS cancelled_now,
          o.updated_at IS DISTINCT FROM s.updated_at AS touched
     FROM orders_order o JOIN "snap_orders_order" s ON s.id = o.id
    WHERE to_jsonb(o) IS DISTINCT FROM to_jsonb(s) ORDER BY o.number`,
  // 1. What was added to their timelines.
  `SELECT o.number, e.event_type, e.message, e.data::text AS data, e.is_customer_visible,
          e.actor_id IS NULL AS nobody
     FROM orders_orderevent e JOIN orders_order o ON o.id = e.order_id
    WHERE e.id NOT IN (SELECT id FROM "snap_orders_orderevent")
    ORDER BY o.number, e.event_type, e.message`,
  // 2. Shelves that moved.
  `SELECT v.sku, b.code AS branch, i.on_hand, i.reserved
     FROM inventory_inventory i JOIN "snap_inventory_inventory" s ON s.id = i.id
     JOIN catalog_productvariant v ON v.id = i.variant_id JOIN accounts_branch b ON b.id = i.branch_id
    WHERE i.on_hand <> s.on_hand OR i.reserved <> s.reserved ORDER BY v.sku, b.code`,
  // 3. The ledger entries behind them, each named by its order.
  `SELECT v.sku, t.transaction_type, t.quantity, t.reference_type,
          (SELECT o.number FROM orders_order o WHERE o.id::text = t.reference_id) AS reference,
          t.reason, t.created_by_id IS NULL AS nobody
     FROM inventory_inventorytransaction t JOIN catalog_productvariant v ON v.id = t.variant_id
    WHERE t.id NOT IN (SELECT id FROM "snap_inventory_inventorytransaction")
    ORDER BY 5, v.sku, t.quantity`,
  // 4. Notices written.
  `SELECT u.email AS reader, n.permission_code, b.code AS branch, n.notification_type, n.level, n.title,
          n.body, n.link,
          regexp_replace(n.data::text, '[0-9a-f]{8}-[0-9a-f-]{27}', '<id>', 'g') AS data,
          n.read_at IS NULL AS unread, n.emailed_at IS NULL AS unsent
     FROM notifications_notification n LEFT JOIN accounts_user u ON u.id = n.user_id
     LEFT JOIN accounts_branch b ON b.id = n.branch_id
    WHERE n.id NOT IN (SELECT id FROM "snap_notifications_notification")
    ORDER BY u.email, n.title, n.body`,
  // 5. Notices a job stamped as emailed.
  `SELECT n.title, n.emailed_at >= $1 AS emailed_now
     FROM notifications_notification n JOIN "snap_notifications_notification" s ON s.id = n.id
    WHERE n.emailed_at IS DISTINCT FROM s.emailed_at ORDER BY n.title`,
  // 6. Every SMS recorded: sent, refused, or deliberately not sent.
  `SELECT m."to", m.body, m.provider, m.status,
          regexp_replace(m.reference, '^console-[0-9a-f]{12}$', 'console-<ref>') AS reference, m.error,
          m.segments, m.notification_type, m.order_number, m.sent_at IS NOT NULL AS sent
     FROM notifications_smsmessage m
    WHERE m.id NOT IN (SELECT id FROM "snap_notifications_smsmessage") ORDER BY m."to", m.body`,
  // 7. Carts switched off, and nothing else about them.
  `SELECT c.token, c.is_active, c.updated_at = s.updated_at AS stamp_kept
     FROM orders_cart c JOIN "snap_orders_cart" s ON s.id = c.id
    WHERE to_jsonb(c) IS DISTINCT FROM to_jsonb(s) ORDER BY c.token`,
  // 8. A coupon's use given back.
  `SELECT c.code, c.used_count,
          (SELECT count(*) FROM "snap_promotions_couponredemption" r
            WHERE r.coupon_id = c.id AND r.id NOT IN (SELECT id FROM promotions_couponredemption)) AS released
     FROM promotions_coupon c JOIN "snap_promotions_coupon" s ON s.id = c.id
    WHERE c.used_count <> s.used_count ORDER BY c.code`,
  // 9. The audit log: who is nobody, from nowhere.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch, a.ip_address IS NULL AS no_address,
          a.request_id, a.user_agent
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.entity_label, a.action`,
];

/**
 * The same, for a job whose rows tie in the order it lists them (two shelves
 * of one branch with one count; one variant's expiry date at two branches):
 * a notice's lines are compared sorted. The arranging `UPDATE` before each
 * API's request moves the rows, and Django run twice lists them two ways.
 */
const EFFECTS_TIED = EFFECTS.map((query, index) =>
  index === 4
    ? query.replace(
        'n.body, n.link',
        `(SELECT string_agg(line, E'\n' ORDER BY line)
            FROM unnest(string_to_array(n.body, E'\n')) AS line) AS body, n.link`,
      )
    : query,
);

export async function resetJobs(client: pg.Client): Promise<void> {
  await restoreTables(client, TABLES);
}

const MISSING = '00000000-0000-4000-8000-000000000000';

export async function jobsCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const one = async (sql: string, values: unknown[] = []) =>
    (await db.query<{ id: string }>(sql, values)).rows[0]?.id;
  const orders = new Map(
    (
      await db.query<{ number: string; id: string }>(
        `SELECT number, id FROM orders_order WHERE number LIKE 'PAR-JOB-%'`,
      )
    ).rows.map((row) => [row.number, row.id]),
  );
  const notices = new Map(
    (
      await db.query<{ title: string; id: string }>(
        `SELECT title, id FROM notifications_notification WHERE title ILIKE 'Parity notice %'`,
      )
    ).rows.map((row) => [row.title, row.id]),
  );
  if (!orders.has('PAR-JOB-0001') || !notices.has('Parity notice one')) {
    await db.end();
    console.log('SKIP  jobs: fixture_jobs.py or fixture_notifications.py has not been applied');
    return [];
  }
  const stock = `FROM inventory_inventory i JOIN catalog_productvariant v ON v.id = i.variant_id
                 JOIN accounts_branch b ON b.id = i.branch_id`;
  const shelves = {
    low: await one(
      `SELECT i.id ${stock} WHERE b.code = 'DHK1' AND i.on_hand - i.reserved <= i.reorder_point
          AND i.on_hand - i.reserved > 0 ORDER BY v.sku LIMIT 1`,
    ),
    healthy: await one(
      `SELECT i.id ${stock} WHERE b.code = 'DHK1' AND i.on_hand - i.reserved > i.reorder_point + 5
        ORDER BY v.sku LIMIT 1`,
    ),
    named: await one(
      `SELECT i.id ${stock} WHERE b.code = 'DHK1' AND v.name <> '' ORDER BY v.sku LIMIT 1`,
    ),
    unnamed: await one(
      `SELECT i.id ${stock} WHERE b.code = 'DHK1' AND v.name = '' ORDER BY v.sku LIMIT 1`,
    ),
    mirpur: await one(`SELECT i.id ${stock} WHERE b.code = 'PAR3' ORDER BY v.sku LIMIT 1`),
  };
  await db.end();
  for (const [name, id] of Object.entries(shelves)) {
    if (!id) throw new Error(`jobs-cases: no stock row to stand for "${name}"`);
  }
  // A name the fixtures do not hold is a mistake in this file, not a case.
  const order = (number: string) => {
    const id = orders.get(number);
    if (!id) throw new Error(`jobs-cases: no order ${number}`);
    return id;
  };
  const notice = (title: string) => {
    const id = notices.get(title);
    if (!id) throw new Error(`jobs-cases: no notice called ${title}`);
    return id;
  };
  /** Statements run for each API, after the reset and before its request. */
  const after =
    (...statements: string[]) =>
    async () => {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        for (const statement of statements) await client.query(statement);
      } finally {
        await client.end();
      }
      return {};
    };

  const cases: Case[] = [];
  const job = (name: string, task: string, args: unknown[] = [], extra: Partial<Case> = {}) =>
    cases.push({
      name: `jobs: ${name}`,
      method: 'POST',
      path: '/parity/jobs/run/',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, args }),
      reset: resetJobs,
      effects: EFFECTS,
      jobs: true,
      sink: true,
      ...extra,
    });
  const REFUSE_MAIL = { sink: { mail: 'refuse' } as const };

  // === The storefront's revalidation ============================================================
  const REVALIDATE = 'content.tasks.revalidate_storefront';
  job('revalidate two tags', REVALIDATE, [['site', 'home']]);
  job('revalidate one tag', REVALIDATE, [['navigation']]);
  job('revalidate a tag in Bengali, and one with a quote', REVALIDATE, [['পাতা', 'a"b', 'a b']]);
  job('revalidate no tags', REVALIDATE, [[]]);
  job('revalidate, the storefront refusing: every retry, then a failure', REVALIDATE, [['site']], {
    sink: { revalidate: 'refuse' },
  });

  // === A staff notice by email ==================================================================
  const NOTICE_EMAIL = 'notifications.tasks.send_notification_email';
  job('email a notice', NOTICE_EMAIL, [notice('Parity notice one')]);
  job('email a notice with no body', NOTICE_EMAIL, [notice('Parity notice six')]);
  job('email a notice addressed to nobody', NOTICE_EMAIL, [notice('Parity notice for nobody')]);
  job('email a notice that is not there', NOTICE_EMAIL, [MISSING]);
  job('email a notice by a key that is no id', NOTICE_EMAIL, ['abc']);
  job(
    'email a notice, the mail server refusing: every retry, then a failure',
    NOTICE_EMAIL,
    [notice('Parity notice two')],
    REFUSE_MAIL,
  );
  job('email a notice whose title is in Bengali', NOTICE_EMAIL, [notice('Parity notice three')], {
    prepare: after(
      `UPDATE notifications_notification SET title = 'স্টক কম: শার্ট', body = 'আর তিনটি বাকি।
দ্বিতীয় লাইন, with a line that is long enough to be folded by a client that folds its lines at seventy-six characters.'
        WHERE title = 'Parity notice three'`,
    ),
  });
  job('email a notice whose lines begin with dots', NOTICE_EMAIL, [notice('Parity notice four')], {
    prepare: after(
      `UPDATE notifications_notification SET body = E'.one\\n..two\\n.\\nthree' WHERE title = 'Parity notice four'`,
    ),
  });

  // === An order's email and SMS =================================================================
  const ORDER_EMAIL = 'notifications.tasks.send_order_email';
  const ORDER_SMS = 'notifications.tasks.send_order_sms';
  const TYPES = [
    'ORDER_CONFIRMED',
    'ORDER_SHIPPED',
    'ORDER_DELIVERED',
    'REFUND_COMPLETED',
    'NOPE',
    '',
  ];
  for (const type of TYPES) {
    job(`order email ${type || '(no type)'}`, ORDER_EMAIL, [order('PAR-JOB-0001'), type]);
    job(`order SMS ${type || '(no type)'}, a number on the allowlist`, ORDER_SMS, [
      order('PAR-JOB-0001'),
      type,
    ]);
  }
  job('order email to a customer whose name is in Bengali', ORDER_EMAIL, [
    order('PAR-JOB-0002'),
    'ORDER_SHIPPED',
  ]);
  job('order email to a customer with no email', ORDER_EMAIL, [
    order('PAR-JOB-0003'),
    'ORDER_CONFIRMED',
  ]);
  job('order email to a customer with no number', ORDER_EMAIL, [
    order('PAR-JOB-0004'),
    'ORDER_CONFIRMED',
  ]);
  job('order email for an order that is not there', ORDER_EMAIL, [MISSING, 'ORDER_CONFIRMED']);
  job('order email by a key that is no id', ORDER_EMAIL, ['abc', 'ORDER_CONFIRMED']);
  job(
    'order email, the mail server refusing: every retry, then a failure',
    ORDER_EMAIL,
    [order('PAR-JOB-0001'), 'ORDER_CONFIRMED'],
    REFUSE_MAIL,
  );
  job('order SMS to a number off the allowlist', ORDER_SMS, [
    order('PAR-JOB-0002'),
    'ORDER_SHIPPED',
  ]);
  job('order SMS to a number that is no mobile', ORDER_SMS, [
    order('PAR-JOB-0003'),
    'ORDER_CONFIRMED',
  ]);
  job('order SMS to a customer with no number', ORDER_SMS, [
    order('PAR-JOB-0004'),
    'ORDER_CONFIRMED',
  ]);
  job('order SMS for an order that is not there', ORDER_SMS, [MISSING, 'ORDER_CONFIRMED']);
  job('order SMS by a key that is no id', ORDER_SMS, ['abc', 'ORDER_CONFIRMED']);

  // === A shelf at its reorder point =============================================================
  const LOW = 'inventory.tasks.notify_low_stock';
  job('low stock: a shelf at or under its reorder point', LOW, [shelves.low]);
  job('low stock: a shelf with plenty', LOW, [shelves.healthy]);
  job('low stock: a shelf with nothing left', LOW, [shelves.named], {
    prepare: after(
      `UPDATE inventory_inventory SET reserved = on_hand, reorder_point = 5 WHERE id = '${shelves.named}'`,
    ),
  });
  job('low stock: a shelf below nothing', LOW, [shelves.unnamed], {
    prepare: after(
      `UPDATE inventory_inventory SET reserved = on_hand + 2, reorder_point = 5 WHERE id = '${shelves.unnamed}'`,
    ),
  });
  job('low stock: a variant named by its options', LOW, [shelves.unnamed], {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = 3, reserved = 0, reorder_point = 5 WHERE id = '${shelves.unnamed}'`,
    ),
  });
  job('low stock: at the second branch', LOW, [shelves.mirpur], {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = 2, reserved = 0, reorder_point = 5 WHERE id = '${shelves.mirpur}'`,
    ),
  });
  job('low stock: a shelf that is not there', LOW, [MISSING]);
  job('low stock: a key that is no id', LOW, ['abc']);

  // === The reservation sweep ====================================================================
  const SWEEP = 'orders.tasks.release_expired_reservations';
  job('the sweep, as the seed left the unpaid orders', SWEEP);
  job('the sweep with nothing past the window', SWEEP, [], {
    prepare: after(`UPDATE orders_order SET placed_at = now() WHERE status = 'PENDING'`),
  });
  job('the sweep, one order a minute inside the window and one a minute past it', SWEEP, [], {
    prepare: after(
      `UPDATE orders_order SET placed_at = now() WHERE status = 'PENDING'`,
      `UPDATE orders_order SET placed_at = now() - interval '61 minutes'
        WHERE id = (SELECT id FROM orders_order WHERE status = 'PENDING' AND channel = 'ONLINE'
                     ORDER BY number LIMIT 1)`,
      `UPDATE orders_order SET placed_at = now() - interval '59 minutes'
        WHERE id = (SELECT id FROM orders_order WHERE status = 'PENDING' AND channel = 'ONLINE'
                     ORDER BY number LIMIT 1 OFFSET 1)`,
    ),
  });
  job('the sweep, an order whose goods have left the shelf', SWEEP, [], {
    prepare: after(
      `UPDATE orders_order SET placed_at = now() WHERE status = 'PENDING'`,
      `UPDATE orders_order SET placed_at = now() - interval '2 hours'
        WHERE id IN (SELECT id FROM orders_order WHERE status = 'PENDING' AND channel = 'ONLINE'
                      ORDER BY number LIMIT 2)`,
      // Committed after the sweep would have looked: it is filtered out, not refused.
      `UPDATE orders_order SET stock_committed = true
        WHERE id = (SELECT id FROM orders_order WHERE status = 'PENDING' AND channel = 'ONLINE'
                     ORDER BY number LIMIT 1)`,
    ),
  });

  // === Carts nobody has touched =================================================================
  const CARTS = 'orders.tasks.expire_abandoned_carts';
  job('carts, as the fixtures left them', CARTS);
  job('carts, three of them idle for a month and a day', CARTS, [], {
    prepare: after(
      `UPDATE orders_cart SET last_activity_at = now() - interval '31 days'
        WHERE id IN (SELECT id FROM orders_cart WHERE is_active ORDER BY token LIMIT 3)`,
    ),
  });
  job('carts idle for more than a day', CARTS, [1], {
    prepare: after(
      `UPDATE orders_cart SET last_activity_at = now() - interval '25 hours'
        WHERE id IN (SELECT id FROM orders_cart WHERE is_active ORDER BY token LIMIT 2)`,
    ),
  });
  job('carts, one idle for a month that is switched off already', CARTS, [], {
    prepare: after(
      `UPDATE orders_cart SET last_activity_at = now() - interval '40 days', is_active = false
        WHERE id IN (SELECT id FROM orders_cart WHERE is_active ORDER BY token LIMIT 1)`,
    ),
  });

  // === The ledger against the shelves ===========================================================
  const INTEGRITY = 'inventory.tasks.verify_inventory_integrity';
  job('integrity, as the ledger stands', INTEGRITY);
  job('integrity, one shelf a unit off its ledger', INTEGRITY, [], {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = on_hand + 1 WHERE id = '${shelves.healthy}'`,
    ),
  });
  job('integrity, two shelves off', INTEGRITY, [], {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = on_hand + 1 WHERE id = '${shelves.healthy}'`,
      `UPDATE inventory_inventory SET reserved = reserved + 3 WHERE id = '${shelves.mirpur}'`,
    ),
  });

  // === What needs reordering, each morning ======================================================
  const DIGEST = 'inventory.tasks.send_low_stock_digest';
  job('the digest, as the shelves stand', DIGEST, [], { effects: EFFECTS_TIED });
  job('the digest with nothing low', DIGEST, [], {
    prepare: after(`UPDATE inventory_inventory SET reorder_point = -100000`),
  });
  // More than the thirty it lists, and no two alike: every shelf its own
  // count, so the order -- and where the list is cut -- is one.
  job('the digest with everything low', DIGEST, [], {
    prepare: after(
      `UPDATE inventory_inventory i SET on_hand = r.n, reserved = 0, reorder_point = 100000
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM inventory_inventory) r
        WHERE r.id = i.id`,
    ),
  });

  // === Stock near its expiry date ===============================================================
  const EXPIRING = 'catalog.tasks.check_expiring_stock';
  job('expiring, as the catalogue stands', EXPIRING);
  job('expiring, three variants within the horizon and one past it', EXPIRING, [], {
    effects: EFFECTS_TIED,
    prepare: after(
      `UPDATE catalog_productvariant SET expiry_date = (now() AT TIME ZONE 'UTC')::date + 10
        WHERE sku IN ('RGN-CLA-M-WHI', 'RGN-ESS-M-OLI')`,
      `UPDATE catalog_productvariant SET expiry_date = (now() AT TIME ZONE 'UTC')::date + 60
        WHERE sku = 'RGN-CLA-L-NAV'`,
      `UPDATE catalog_productvariant SET expiry_date = (now() AT TIME ZONE 'UTC')::date + 61
        WHERE sku = 'RGN-CLA-L-WHI'`,
    ),
  });
  job('expiring within five days', EXPIRING, [5], {
    effects: EFFECTS_TIED,
    prepare: after(
      `UPDATE catalog_productvariant SET expiry_date = (now() AT TIME ZONE 'UTC')::date + 5
        WHERE sku = 'RGN-CLA-M-WHI'`,
      `UPDATE catalog_productvariant SET expiry_date = (now() AT TIME ZONE 'UTC')::date + 6
        WHERE sku = 'RGN-ESS-M-OLI'`,
    ),
  });
  job('expiring, a variant already past its date', EXPIRING, [], {
    effects: EFFECTS_TIED,
    prepare: after(
      `UPDATE catalog_productvariant SET expiry_date = (now() AT TIME ZONE 'UTC')::date - 3
        WHERE sku = 'RGN-CLA-M-WHI'`,
    ),
  });

  // === What is scheduled, and what can be queued =================================================
  // Beat's five lines and its clock, the ten tasks, and how often and how far
  // apart each is tried again: Celery's own account of itself beside the port's.
  cases.push({
    name: 'jobs: the schedule, the tasks and their retries',
    method: 'GET',
    path: '/parity/jobs/schedule/',
  });

  return cases;
}
