/**
 * Race checks for what staff do to an order (phase 5 part 6), run by run.ts
 * after the comparison cases. Each puts the tables back.
 *
 * A status change takes the order's row, and packing then takes the stock
 * rows; capturing a payment takes the payment's row; a refund takes the
 * order's row and then the account's. As for returns, two requests for one
 * row are run through each API on its own as well as one per API, and the
 * mid-flight checks have the harness hold the row, wait for the request to
 * queue behind it, commit a competing change and see what the request then
 * acts on.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetReturns } from './returns-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export async function staffOrdersConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const order = async (number: string) =>
      (await one<{ id: string }>(`SELECT id FROM orders_order WHERE number = $1`, [number]))?.id;
    const cod = await order('RGN-PARITY-S01');
    const paid = await order('RGN-PARITY-S02');
    const delivered = await order('RGN-PARITY-S08');
    const drawer = await one<{ id: string }>(
      `SELECT id FROM finance_account WHERE name = 'Counter Cash Drawer'`,
    );
    const tee = await one<{ id: string }>(
      `SELECT i.id FROM inventory_inventory i JOIN accounts_branch b ON b.id = i.branch_id
         JOIN catalog_productvariant v ON v.id = i.variant_id
        WHERE b.code = 'DHK1' AND v.sku = 'RGN-ESS-M-OLI'`,
    );
    if (!cod || !paid || !delivered || !drawer || !tee) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetReturns(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const post = (api: URL, id: string, action: string, body: unknown, key?: string) =>
      send(api, {
        name: 'order',
        method: 'POST',
        path: `/api/v1/orders/${id}/${action}/`,
        headers: {
          ...auth('manager'),
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(body),
      });
    const message = (body: string) => {
      try {
        return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        return '';
      }
    };
    const queuedOn = async (pattern: string) =>
      Number(
        (
          await one<{ count: string }>(
            `SELECT count(*) AS count FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND state = 'active'
                AND query ILIKE $1 AND query NOT ILIKE '%pg_stat_activity%'`,
            [pattern],
          )
        )?.count ?? 0,
      );
    /** Hold a row, start the requests, wait until they queue on a lock, change, commit. */
    const behind = async (
      lock: [sql: string, values: unknown[]],
      waitsOn: string,
      requests: (() => Promise<{ status: number; body: string }>)[],
      change: (holder: pg.Client) => Promise<void> = async () => {},
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(lock[0], lock[1]);
      const pending = requests.map((request) => request());
      let queued = 0;
      for (let attempt = 0; attempt < 160 && queued < requests.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        queued = await queuedOn(waitsOn);
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { queued, responses: await Promise.all(pending) };
    };
    const ORDER_ROW = (id: string): [string, unknown[]] => [
      `SELECT id FROM orders_order WHERE id = $1 FOR UPDATE`,
      [id],
    ];
    /** What an order has come to, and what was written for it since the restore. */
    const state = async (id: string) =>
      (await one<Record<string, string>>(
        `SELECT o.status, o.stock_committed::text AS committed, o.payment_status,
                o.paid_total::text AS paid, o.refunded_total::text AS refunded,
                (SELECT count(*) FROM inventory_inventorytransaction t
                  WHERE t.reference_id = o.id::text AND t.transaction_type = 'SALE')::text AS sales,
                (SELECT count(*) FROM inventory_inventorytransaction t
                  WHERE t.reference_id = o.id::text AND t.transaction_type = 'RESERVATION_RELEASE'
                    AND t.id NOT IN (SELECT id FROM "snap_inventory_inventorytransaction"))::text
                  AS releases,
                (SELECT count(*) FROM orders_refund f WHERE f.order_id = o.id
                    AND f.id NOT IN (SELECT id FROM "snap_orders_refund"))::text AS refunds,
                (SELECT count(*) FROM finance_accounttransaction t
                  WHERE t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")
                    AND (t.reference_id IN (SELECT p.id::text FROM orders_payment p WHERE p.order_id = o.id)
                      OR t.reference_id IN (SELECT f.id::text FROM orders_refund f WHERE f.order_id = o.id)))::text
                  AS movements,
                (SELECT string_agg(e.event_type, ',' ORDER BY e.created_at) FROM orders_orderevent e
                  WHERE e.order_id = o.id
                    AND e.id NOT IN (SELECT id FROM "snap_orders_orderevent")) AS events
           FROM orders_order o WHERE o.id = $1`,
        [id],
      )) as Record<string, string>;
    const statuses = (responses: { status: number }[]) =>
      responses.map((response) => response.status).sort((a, b) => a - b);
    const refusals = (responses: { status: number; body: string }[]) =>
      responses
        .filter((response) => response.status >= 400)
        .map((response) => message(response.body));
    const pairs: [string, URL, URL][] = [
      ['one per API', apis.DJANGO, apis.NEST],
      ['both through Django', apis.DJANGO, apis.DJANGO],
      ['both through Nest', apis.NEST, apis.NEST],
    ];
    const sides = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;

    for (const [how, a, b] of pairs) {
      // 1. Two requests to pack one order: it is packed once, its stock leaves once.
      await restore();
      let run = await behind(ORDER_ROW(paid), '%orders_order%', [
        () => post(a, paid, 'status', { to_status: 'PACKED' }),
        () => post(b, paid, 'status', { to_status: 'PACKED' }),
      ]);
      let after = await state(paid);
      checks.push({
        name: `orders: two requests to pack one order, ${how}, queue on its row -- packed once, its stock deducted once`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '200,200' &&
          after.status === 'PACKED' &&
          after.committed === 'true' &&
          after.sales === '1' &&
          after.events === 'STOCK_COMMITTED,STATUS_CHANGED',
        detail: `statuses ${statuses(run.responses).join(',')}, ${run.queued} queued on the order, now ${after.status}, ${after.sales} sale entry, timeline ${after.events}`,
      });

      // 2. Two requests to record one cash-on-delivery payment: captured once.
      await restore();
      const pending = await one<{ id: string }>(
        `SELECT id FROM orders_payment WHERE order_id = $1 AND status = 'PENDING'`,
        [cod],
      );
      run = await behind(
        [`SELECT id FROM orders_payment WHERE id = $1 FOR UPDATE`, [pending?.id]],
        '%orders_payment%',
        [
          () => post(a, cod, 'payments', { method: 'COD', amount: '5790.00' }),
          () => post(b, cod, 'payments', { method: 'COD', amount: '5790.00' }),
        ],
      );
      after = await state(cod);
      checks.push({
        name: `orders: two requests to record one pending payment, ${how}, queue on its row -- captured once, the money entered once`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '201,201' &&
          after.payment_status === 'PAID' &&
          after.paid === '5790.00' &&
          after.movements === '1' &&
          after.events === 'PAYMENT_CAPTURED',
        detail: `statuses ${statuses(run.responses).join(',')}, ${run.queued} queued on the payment, order ${after.payment_status} with ${after.paid} paid, ${after.movements} cash-book entry, timeline ${after.events}`,
      });
    }

    for (const [side, api] of sides) {
      // 3. A cancel that meets its order packed mid-flight is refused: the
      //    stock has left the shelf.
      await restore();
      let held = await behind(
        ORDER_ROW(paid),
        '%orders_order%',
        [() => post(api, paid, 'cancel', { reason: 'Changed their mind' })],
        async (holder) => {
          await holder.query(
            `UPDATE orders_order SET status = 'PACKED', stock_committed = true WHERE id = $1`,
            [paid],
          );
        },
      );
      let after = await state(paid);
      checks.push({
        name: `orders: a cancel (${side}) of an order packed mid-flight is refused, nothing released or refunded -- the order lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          refusals(held.responses).join() === 'An order cannot go from PACKED to CANCELLED.' &&
          after.status === 'PACKED' &&
          after.releases === '0' &&
          after.refunds === '0',
        detail: `${held.responses[0]?.status} ${refusals(held.responses).join().slice(0, 60)}, ${held.queued ? 'waited on the order' : 'never waited'}, order ${after.status}, ${after.releases} releases, ${after.refunds} refunds`,
      });

      // 4. A refund that meets its order refunded in full mid-flight is refused.
      await restore();
      held = await behind(
        ORDER_ROW(delivered),
        '%orders_order%',
        [() => post(api, delivered, 'refunds', { amount: '4230.00' })],
        async (holder) => {
          await holder.query(`UPDATE orders_order SET refunded_total = paid_total WHERE id = $1`, [
            delivered,
          ]);
        },
      );
      after = await state(delivered);
      checks.push({
        name: `orders: a refund (${side}) of an order refunded in full mid-flight is refused -- the order lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 422 &&
          after.refunds === '0' &&
          after.movements === '0',
        detail: `${held.responses[0]?.status} ${refusals(held.responses).join().slice(0, 60)}, ${held.queued ? 'waited on the order' : 'never waited'}, ${after.refunds} refunds, ${after.movements} cash-book entries`,
      });

      // 5. Packing that meets its shelf emptied mid-flight is refused whole.
      await restore();
      held = await behind(
        [`SELECT id FROM inventory_inventory WHERE id = $1 FOR UPDATE`, [tee.id]],
        '%inventory_inventory%',
        [() => post(api, paid, 'status', { to_status: 'PACKED' })],
        async (holder) => {
          await holder.query(
            `UPDATE inventory_inventory SET on_hand = 0, reserved = 0 WHERE id = $1`,
            [tee.id],
          );
        },
      );
      after = await state(paid);
      checks.push({
        name: `orders: packing (${side}) an order whose shelf is emptied mid-flight is refused whole -- the stock lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          after.status === 'PROCESSING' &&
          after.committed === 'false' &&
          after.sales === '0',
        detail: `${held.responses[0]?.status} ${refusals(held.responses).join().slice(0, 60)}, ${held.queued ? 'waited on the shelf' : 'never waited'}, order ${after.status}, ${after.sales} sale entries`,
      });
    }

    // 6. Six refunds of everything paid at once, across both APIs: paid back once.
    await restore();
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(index % 2 ? apis.NEST : apis.DJANGO, delivered, 'refunds', { amount: '4230.00' }),
      ),
    );
    let end = await state(delivered);
    checks.push({
      name: 'orders: 6 refunds of an order’s whole payment at once, across both APIs -- refunded once, never past what was paid',
      passed:
        statuses(burst).join() === '201,422,422,422,422,422' &&
        end.refunded === '4230.00' &&
        end.refunds === '1' &&
        end.movements === '1',
      detail: `statuses ${statuses(burst).join(',')}, refunded ${end.refunded} of ${end.paid} in ${end.refunds} refund, ${end.movements} cash-book entry`,
    });

    // 7. Six clicks of one refund with one Idempotency-Key, across both APIs.
    await restore();
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          index % 2 ? apis.NEST : apis.DJANGO,
          delivered,
          'refunds',
          { amount: '100.00' },
          'parity-refund-clicked',
        ),
      ),
    );
    const ids = new Set(
      clicks.map((response) => (JSON.parse(response.body) as { id?: string }).id),
    );
    end = await state(delivered);
    checks.push({
      name: 'orders: 6 clicks of one refund with one Idempotency-Key, across both APIs -- six 201s, one refund',
      passed:
        statuses(clicks).every((status) => status === 201) &&
        ids.size === 1 &&
        end.refunded === '100.00' &&
        end.refunds === '1' &&
        end.movements === '1',
      detail: `statuses ${statuses(clicks).join(',')}, ${ids.size} refund id, refunded ${end.refunded} in ${end.refunds} refund, ${end.movements} cash-book entry`,
    });

    // 8. A request to pack and a request to cancel one order at once: one wins.
    await restore();
    const both = await Promise.all([
      post(apis.DJANGO, paid, 'status', { to_status: 'PACKED' }),
      post(apis.NEST, paid, 'cancel', { reason: 'Changed their mind' }),
    ]);
    end = await state(paid);
    const packedWon =
      end.status === 'PACKED' && end.sales === '1' && end.refunds === '0' && end.releases === '1';
    const cancelWon =
      end.status === 'CANCELLED' &&
      end.sales === '0' &&
      end.refunds === '1' &&
      end.releases === '1';
    checks.push({
      name: 'orders: an order packed through one API and cancelled through the other at once -- one wins, and its stock and money say the same',
      passed: statuses(both).join() === '200,409' && (packedWon || cancelWon),
      detail: `statuses ${both.map((response) => response.status).join(',')}, order ${end.status}, ${end.sales} sale entries, ${end.releases} releases, ${end.refunds} refunds`,
    });
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
