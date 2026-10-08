/**
 * Checks of the pg-boss queue (ADR-0016), run by run.ts after the
 * comparison cases when the Nest side queues there (`PARITY_NEST_JOBS=pgboss`).
 * Django has no such queue, so these are the Nest API's alone.
 *
 * What pg-boss was chosen for is that a job is written in the transaction
 * that decides it. Two checks show it, on one request: where the checkout
 * commits, its three jobs carry the order's own transaction id; where it is
 * refused after they were written, none of them exists.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetCheckout } from './checkout-cases.ts';
import { checkout, count, raceCarts, shopper } from './concurrency.ts';
import type { Check } from './races.ts';
import { send } from './run.ts';

const SKU = 'RGN-CLA-L-NAV';

export async function jobsConcurrencyChecks(apis: { NEST: URL }): Promise<Check[]> {
  if (process.env.PARITY_NEST_JOBS !== 'pgboss') return [];
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]
      ?.now as string;
    const queued = () => count(db, `SELECT count(*) AS count FROM pgboss.job`);
    // The shelf two units above its reorder point: three sold leaves it at the
    // point, and a low-stock job is queued the moment the stock is held.
    const arrange = async () => {
      await resetCheckout(db);
      await db.query(`DELETE FROM pgboss.job`);
      await db.query(
        `UPDATE inventory_inventory SET on_hand = 8, reserved = 0, reorder_point = 5
          WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = $1)
            AND branch_id = (SELECT id FROM accounts_branch WHERE is_default LIMIT 1)`,
        [SKU],
      );
    };
    const coupon = (
      await db.query<{ id: string }>(
        `INSERT INTO promotions_coupon (id, created_at, updated_at, code, description, discount_type, value,
           minimum_order_value, maximum_discount, starts_at, ends_at, usage_limit, usage_limit_per_customer,
           used_count, channels, is_active, created_by_id)
         VALUES (gen_random_uuid(), now(), now(), 'PARITY-JOBS', '', 'FIXED', 100, 0, NULL, NULL, NULL, 1, NULL, 0,
                 '[]'::jsonb, true, NULL) RETURNING id`,
      )
    ).rows[0]?.id as string;

    // 1. A checkout that commits: its jobs are rows of the order's own transaction.
    await arrange();
    const [placed] = await raceCarts(db, 'parity-jobs-placed', 1, SKU, 3, coupon);
    const answer = await checkout(apis.NEST, placed as string, 'jobs-placed', shopper(80));
    const number = (JSON.parse(answer.body) as { order?: { number?: string } }).order?.number ?? '';
    const written = (
      await db.query<{ in_transaction: string[] | null }>(
        `SELECT (SELECT array_agg(j.name ORDER BY j.name) FROM pgboss.job j WHERE j.xmin = o.xmin)
                  AS in_transaction
           FROM orders_order o WHERE o.number = $1`,
        [number],
      )
    ).rows[0]?.in_transaction;
    const expected = [
      'inventory.tasks.notify_low_stock',
      'notifications.tasks.send_order_email',
      'notifications.tasks.send_order_sms',
    ];
    checks.push({
      name: "jobs: a checkout that commits -- its low-stock alert, email and SMS are rows of the order's own transaction, and there are no others",
      passed:
        answer.status === 201 &&
        JSON.stringify(written) === JSON.stringify(expected) &&
        (await queued()) === 3,
      detail: `checkout ${answer.status} ${number}, in its transaction: ${(written ?? []).join(', ') || 'none'}; ${await queued()} queued in all`,
    });

    // 2. The same checkout refused after those jobs were written: the coupon's
    //    last use is taken while it waits on the coupon's row.
    await arrange();
    await db.query(`UPDATE promotions_coupon SET used_count = 0 WHERE id = $1`, [coupon]);
    const [refused] = await raceCarts(db, 'parity-jobs-refused', 1, SKU, 3, coupon);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM promotions_coupon WHERE id = $1 FOR UPDATE`, [coupon]);
    const pending = checkout(apis.NEST, refused as string, 'jobs-refused', shopper(81));
    let waiting = 0;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      waiting = await count(
        db,
        `SELECT count(*) AS count FROM pg_stat_activity
          WHERE application_name = 'rangon-api-nest' AND wait_event_type = 'Lock'
            AND query ILIKE '%promotions_coupon%'`,
      );
    }
    await holder.query(`UPDATE promotions_coupon SET used_count = usage_limit WHERE id = $1`, [
      coupon,
    ]);
    await holder.query('COMMIT');
    await holder.end();
    const refusal = await pending;
    const shelf = (
      await db.query<{ reserved: number }>(
        `SELECT reserved FROM inventory_inventory
          WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = $1)
            AND branch_id = (SELECT id FROM accounts_branch WHERE is_default LIMIT 1)`,
        [SKU],
      )
    ).rows[0]?.reserved;
    checks.push({
      name: "jobs: the same checkout refused after its low-stock alert was written (the coupon's last use taken while it waits on the coupon's row) -- nothing is queued, nothing is held",
      passed: waiting > 0 && refusal.status === 422 && (await queued()) === 0 && shelf === 0,
      detail: `checkout ${refusal.status}, ${waiting ? 'waited on the coupon' : 'NEVER reached the coupon'}, ${await queued()} queued, ${shelf} reserved`,
    });

    // 3. A stock movement's alert, through `StockService.run`: a write-off that
    //    takes the shelf to its reorder point.
    await arrange();
    const auth = await staffHeaders(db);
    const variant = (
      await db.query<{ id: string }>(`SELECT id FROM catalog_productvariant WHERE sku = $1`, [SKU])
    ).rows[0]?.id as string;
    const off = await send(apis.NEST, {
      name: 'write-off',
      method: 'POST',
      path: '/api/v1/inventory/write-off/',
      headers: { ...auth('owner'), 'content-type': 'application/json' },
      body: JSON.stringify({
        variant,
        quantity: 3,
        reason: 'Parity: the jobs check',
        transaction_type: 'DAMAGE',
      }),
    });
    // The ledger entry and the shelf are written under a savepoint, which has
    // a transaction id of its own; the audit entry is written beside the job.
    const alert = (
      await db.query<{ in_transaction: string[] | null }>(
        `SELECT (SELECT array_agg(j.name ORDER BY j.name) FROM pgboss.job j WHERE j.xmin = a.xmin)
                  AS in_transaction
           FROM core_auditlog a
          WHERE a.action = 'STOCK_ADJUSTMENT' AND a.created_at >= $1 ORDER BY a.created_at DESC LIMIT 1`,
        [since],
      )
    ).rows[0]?.in_transaction;
    checks.push({
      name: "jobs: a write-off that takes a shelf to its reorder point -- the low-stock alert is a row of the write-off's own transaction",
      passed:
        off.status === 201 &&
        JSON.stringify(alert) === JSON.stringify(['inventory.tasks.notify_low_stock']),
      detail: `write-off ${off.status}, in its transaction: ${(alert ?? []).join(', ') || 'none'}`,
    });

    await resetCheckout(db);
    await db.query(`DELETE FROM pgboss.job`);
    await db.query(`DELETE FROM promotions_coupon WHERE id = $1`, [coupon]);
    await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
  } finally {
    await db.end();
  }
  return checks;
}
