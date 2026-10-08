/**
 * Race checks for the reservation sweep (phase 7 part 4b), run by run.ts
 * after the comparison cases. Each puts the orders and the shelves back.
 *
 * `release_expired_reservations` is the one background job that moves stock.
 * It owns no invariant: each order goes through the status machine, under
 * the order's row lock and then the stock rows', as a cancellation at the
 * desk does. These checks run the Django task and the Nest handler against
 * each other, and against an order that changes while a sweep waits for it.
 */
import pg from 'pg';

import { resetJobs } from './jobs-cases.ts';
import { behind, type Check } from './races.ts';
import { send } from './run.ts';

const SWEEP = 'orders.tasks.release_expired_reservations';

export async function sweepConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]
      ?.now as string;
    const sweep = (api: URL) =>
      send(api, {
        name: 'sweep',
        method: 'POST',
        path: '/parity/jobs/run/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: SWEEP, args: [] }),
      });
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0] as T;
    const restore = async () => {
      await resetJobs(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    /** What a sweep left, counted against the snapshot the restore keeps. */
    const tally = () =>
      one<{
        cancelled: string;
        cancelled_twice: string;
        released_twice: string;
        ledger_rows: string;
        shelves_off: string;
      }>(
        `WITH swept AS (
           SELECT o.id FROM orders_order o JOIN "snap_orders_order" s ON s.id = o.id
            WHERE o.status = 'CANCELLED' AND s.status = 'PENDING'),
         fresh AS (
           SELECT * FROM orders_orderevent e WHERE e.id NOT IN (SELECT id FROM "snap_orders_orderevent")),
         ledger AS (
           SELECT * FROM inventory_inventorytransaction t
            WHERE t.id NOT IN (SELECT id FROM "snap_inventory_inventorytransaction"))
         SELECT (SELECT count(*) FROM swept) AS cancelled,
                (SELECT count(*) FROM (SELECT order_id FROM fresh WHERE event_type = 'CANCELLED'
                                        GROUP BY order_id HAVING count(*) > 1) twice) AS cancelled_twice,
                (SELECT count(*) FROM (SELECT order_id FROM fresh WHERE event_type = 'STOCK_RELEASED'
                                        GROUP BY order_id HAVING count(*) > 1) twice) AS released_twice,
                (SELECT count(*) FROM ledger) AS ledger_rows,
                -- A shelf whose reserved count is not what it was less what the ledger says came off.
                (SELECT count(*) FROM inventory_inventory i JOIN "snap_inventory_inventory" s ON s.id = i.id
                  WHERE i.reserved <> s.reserved + COALESCE((SELECT sum(l.quantity) FROM ledger l
                         WHERE l.branch_id = i.branch_id AND l.variant_id = i.variant_id), 0)) AS shelves_off`,
      );

    // 1. Both sweeps at once, over every order past the window.
    await restore();
    const EXPIRED = `o.channel = 'ONLINE' AND o.status = 'PENDING' AND NOT o.stock_committed
              AND o.placed_at < now() - interval '60 minutes'
              AND NOT EXISTS (SELECT 1 FROM orders_payment p WHERE p.order_id = o.id AND p.method = 'COD')`;
    const expired = Number(
      (
        await one<{ count: string }>(
          `SELECT count(*) AS count FROM orders_order o WHERE ${EXPIRED}`,
        )
      ).count,
    );
    // A release takes what the line asks for or what the shelf holds, whichever
    // is less, and the seed's unpaid orders hold next to nothing. So every shelf
    // one of them names is given what its lines ask for, and five over: a line
    // released twice then shows, as a shelf short of the five.
    await db.query(`DROP TABLE IF EXISTS race_shelves`);
    await db.query(
      `CREATE TEMP TABLE race_shelves AS
         SELECT inv.id, inv.reserved + n.need + 5 AS reserved, inv.on_hand + n.need + 5 AS on_hand,
                n.need, n.lines
           FROM inventory_inventory inv
           JOIN (SELECT o.branch_id, i.variant_id, sum(i.quantity) AS need, count(*) AS lines
                   FROM orders_orderitem i JOIN orders_order o ON o.id = i.order_id
                  WHERE ${EXPIRED} AND i.quantity > 0 GROUP BY 1, 2) n
             ON n.branch_id = inv.branch_id AND n.variant_id = inv.variant_id`,
    );
    await db.query(
      `UPDATE inventory_inventory inv SET reserved = r.reserved, on_hand = r.on_hand
         FROM race_shelves r WHERE r.id = inv.id`,
    );
    const both = await Promise.all([sweep(apis.DJANGO), sweep(apis.NEST)]);
    let t = await tally();
    const shelves = await one<{ shelves: string; lines: string; off: string }>(
      `SELECT count(*) AS shelves, COALESCE(sum(r.lines), 0) AS lines,
              count(*) FILTER (WHERE inv.reserved <> r.reserved - r.need OR inv.on_hand <> r.on_hand) AS off
         FROM race_shelves r JOIN inventory_inventory inv ON inv.id = r.id`,
    );
    const counted = both.map((answer) => Number(/released:(\d+)/.exec(answer.body)?.[1] ?? -1));
    checks.push({
      name: "sweep: Django's task and the Nest handler at once, over every order past the window -- each order is cancelled once and each line's stock given back once, though both sweeps count an order the other got to first (D234, copied)",
      passed:
        expired > 0 &&
        Number(shelves.shelves) > 0 &&
        both.every((answer) => answer.status === 200 && answer.body.includes('SUCCESS')) &&
        counted.every((count) => count >= 0 && count <= expired) &&
        counted.reduce((sum, count) => sum + count, 0) >= expired &&
        Number(t.cancelled) === expired &&
        t.cancelled_twice === '0' &&
        t.released_twice === '0' &&
        t.ledger_rows === shelves.lines &&
        shelves.off === '0',
      detail: `${expired} past the window; ${both.map((answer) => answer.body).join(' ')}; ${t.cancelled} cancelled, ${t.cancelled_twice} twice, ${t.released_twice} released twice, ${t.ledger_rows} ledger rows for ${shelves.lines} lines on ${shelves.shelves} shelves, ${shelves.off} shelves off`,
    });

    // 2. An order confirmed while a sweep waits on its row.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await restore();
      // One order past the window, and only one: the sweep goes straight to it.
      const target = (
        await one<{ id: string }>(
          `SELECT o.id FROM orders_order o
            WHERE o.channel = 'ONLINE' AND o.status = 'PENDING' AND NOT o.stock_committed
              AND o.placed_at < now() - interval '60 minutes'
              AND NOT EXISTS (SELECT 1 FROM orders_payment p WHERE p.order_id = o.id AND p.method = 'COD')
              AND EXISTS (SELECT 1 FROM inventory_inventorytransaction t
                           WHERE t.reference_id = o.id::text AND t.transaction_type = 'RESERVATION')
            ORDER BY o.number LIMIT 1`,
        )
      ).id;
      await db.query(
        `UPDATE orders_order SET placed_at = now() WHERE status = 'PENDING' AND id <> $1`,
        [target],
      );
      const held = await behind(
        db,
        [`SELECT id FROM orders_order WHERE id = $1 FOR UPDATE`, [target]],
        '%orders_order%',
        [() => sweep(api)],
        async (holder) => {
          await holder.query(
            `UPDATE orders_order SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`,
            [target],
          );
        },
      );
      const after = await one<{ status: string; reason: string; released: string }>(
        `SELECT o.status, o.cancel_reason AS reason,
                (SELECT count(*) FROM inventory_inventorytransaction t
                  WHERE t.reference_id = o.id::text AND t.transaction_type = 'RESERVATION_RELEASE'
                    AND t.id NOT IN (SELECT id FROM "snap_inventory_inventorytransaction")) AS released
           FROM orders_order o WHERE o.id = $1`,
        [target],
      );
      t = await tally();
      const answer = held.responses[0];
      checks.push({
        name: `sweep: an order confirmed while the sweep (${side}) waits on its row -- it is cancelled all the same, as paid for too late: the sweep chose it before the lock and the status machine lets a confirmed order be cancelled (D233, copied)`,
        passed:
          held.queued === 1 &&
          answer?.status === 200 &&
          after.status === 'CANCELLED' &&
          after.reason === 'PAYMENT_TIMEOUT: reservation expired' &&
          Number(after.released) > 0 &&
          t.shelves_off === '0',
        detail: `${answer?.body}, ${held.queued ? 'waited on the order' : 'never waited'}, left ${after.status} "${after.reason}", ${after.released} line(s) released, ${t.shelves_off} shelves off`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
