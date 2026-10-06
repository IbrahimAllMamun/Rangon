/**
 * Race checks for returns (phase 5 part 5), run by run.ts after the
 * comparison cases. Each puts the returns' tables back.
 *
 * Every step of a return takes the return's own row first, so two requests
 * for one return queue there; opening a return and paying its refund take the
 * order's row, and receiving takes each order line's. A burst shows the
 * invariant; what proves a lock is the mid-flight check: the harness holds
 * the row, starts the requests, waits until they are queued behind it, makes
 * a competing change and commits. Each request must then act on what was
 * committed.
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

export async function returnsConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const returns = new Map(
      (
        await db.query<{ key: string; id: string; order_id: string }>(
          `SELECT CASE WHEN r.customer_comment = 'second' THEN 'second'
                       ELSE replace(o.customer_note, 'Parity return ', '') END AS key, r.id, r.order_id
             FROM orders_returnrequest r JOIN orders_order o ON o.id = r.order_id
            WHERE o.customer_note LIKE 'Parity return %'`,
        )
      ).rows.map((row) => [row.key, row]),
    );
    const sale = async (note: string) =>
      one<{ id: string; item: string }>(
        `SELECT o.id, (SELECT i.id FROM orders_orderitem i WHERE i.order_id = o.id
                        ORDER BY i.created_at LIMIT 1) AS item
           FROM orders_order o WHERE o.customer_note = $1`,
        [note],
      );
    const me = await sale('Parity return me');
    const carded = await sale('Parity return card');
    const drawer = await one<{ id: string }>(
      `SELECT id FROM finance_account WHERE name = 'Counter Cash Drawer'`,
    );
    const approved = returns.get('approved');
    const received = returns.get('received');
    const opened = returns.get('open');
    const first = returns.get('twice');
    const second = returns.get('second');
    if (!me || !carded || !drawer || !approved || !received || !opened || !first || !second)
      return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetReturns(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const sides = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    const post = (api: URL, path: string, body: unknown = {}) =>
      send(api, {
        name: 'return',
        method: 'POST',
        path,
        headers: { ...auth('manager'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const act = (api: URL, id: string, action: string, body: unknown = {}) =>
      post(api, `/api/v1/returns/${id}/${action}/`, body);
    const message = (body: string) => {
      try {
        return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        return '';
      }
    };
    /** How many statements matching `pattern` are queued on a lock. */
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
    /**
     * Hold a row (`lock`), start the requests, wait until `want` statements
     * matching `waitsOn` are queued on a lock, run `change` in the holder's
     * transaction, and commit.
     */
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
    const RETURN_ROW = (id: string): [string, unknown[]] => [
      `SELECT id FROM orders_returnrequest WHERE id = $1 FOR UPDATE`,
      [id],
    ];
    /** What a return and its order have come to. */
    const state = async (id: string) =>
      (await one<{
        status: string;
        order_status: string;
        restocks: string;
        returned: string;
        refunds: string;
        refunded: string;
        movements: string;
        audits: string;
        updates: string;
      }>(
        `SELECT r.status, o.status AS order_status, o.refunded_total::text AS refunded,
                (SELECT count(*) FROM inventory_inventorytransaction t
                  WHERE t.reference_type = 'return' AND t.reference_id = r.id::text) AS restocks,
                (SELECT string_agg(i.returned_quantity || '/' || i.quantity, ' ' ORDER BY i.created_at)
                   FROM orders_orderitem i WHERE i.order_id = o.id) AS returned,
                (SELECT count(*) FROM orders_refund f WHERE f.order_id = o.id) AS refunds,
                (SELECT count(*) FROM finance_accounttransaction t JOIN orders_refund f
                    ON f.id::text = t.reference_id WHERE f.order_id = o.id) AS movements,
                (SELECT count(*) FROM core_auditlog a
                  WHERE a.entity_type = 'ReturnRequest' AND a.entity_id = r.id::text
                    AND a.created_at >= $2) AS audits,
                (SELECT count(*) FROM orders_orderevent e
                  WHERE e.order_id = o.id AND e.event_type = 'RETURN_UPDATED'
                    AND e.id NOT IN (SELECT id FROM "snap_orders_orderevent")) AS updates
           FROM orders_returnrequest r JOIN orders_order o ON o.id = r.order_id WHERE r.id = $1`,
        [id, since],
      )) as Record<string, string>;
    const statuses = (responses: { status: number }[]) =>
      responses.map((response) => response.status).sort((a, b) => a - b);

    // Two requests for one return queue on its row. One per API shows the two
    // agree; both through one API show that API's own lock, since a request
    // that did not take the row would act on the return as it first read it.
    const pairs: [string, URL, URL][] = [
      ['one per API', apis.DJANGO, apis.NEST],
      ['both through Django', apis.DJANGO, apis.DJANGO],
      ['both through Nest', apis.NEST, apis.NEST],
    ];
    const shelfOf = async (id: string) =>
      (
        await one<{ total: string }>(
          `SELECT COALESCE(SUM(v.on_hand), 0) AS total FROM inventory_inventory v
            WHERE (v.branch_id, v.variant_id) IN
                  (SELECT o.branch_id, i.variant_id FROM orders_returnrequest r
                     JOIN orders_order o ON o.id = r.order_id
                     JOIN orders_orderitem i ON i.order_id = o.id WHERE r.id = $1)`,
          [id],
        )
      )?.total;
    const refusals = (responses: { status: number; body: string }[]) =>
      responses
        .filter((response) => response.status !== 200)
        .map((response) => message(response.body));
    let after: Record<string, string> = {};
    let shelf: string | undefined;
    for (const [how, a, b] of pairs) {
      // 1. Two approvals: one approves, the other finds it approved.
      await restore();
      let run = await behind(RETURN_ROW(opened.id), '%orders_returnrequest%', [
        () => act(a, opened.id, 'approve'),
        () => act(b, opened.id, 'approve'),
      ]);
      after = await state(opened.id);
      checks.push({
        name: `returns: two approvals of one return, ${how}, queue on its row -- one approves, one is refused`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '200,409' &&
          refusals(run.responses).join() === 'A APPROVED return cannot be approved.' &&
          after.status === 'APPROVED' &&
          after.updates === '1',
        detail: `statuses ${statuses(run.responses).join(',')} (${refusals(run.responses).join('; ')}), ${run.queued} queued on the return, now ${after.status}, ${after.updates} timeline entry`,
      });

      // 2. Two receipts: the goods go back once, and the second is told the
      //    return is no longer approved -- not stopped by the line's own count.
      await restore();
      shelf = await shelfOf(approved.id);
      run = await behind(RETURN_ROW(approved.id), '%orders_returnrequest%', [
        () => act(a, approved.id, 'receive'),
        () => act(b, approved.id, 'receive'),
      ]);
      after = await state(approved.id);
      checks.push({
        name: `returns: two receipts of one return, ${how}, queue on its row -- the goods go back once`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '200,409' &&
          refusals(run.responses).join() === 'Only an approved return can be received.' &&
          after.status === 'RECEIVED' &&
          after.restocks === '1' &&
          after.returned === '1/1 2/2' &&
          Number(await shelfOf(approved.id)) === Number(shelf) + 1,
        detail: `statuses ${statuses(run.responses).join(',')} (${refusals(run.responses).join('; ')}), ${run.queued} queued on the return, ${after.restocks} restock entry, lines back ${after.returned}, shelf ${shelf} -> ${await shelfOf(approved.id)}`,
      });

      // 4. Two completions: both answer, one refund.
      await restore();
      run = await behind(RETURN_ROW(received.id), '%orders_returnrequest%', [
        () => act(a, received.id, 'complete'),
        () => act(b, received.id, 'complete'),
      ]);
      after = await state(received.id);
      checks.push({
        name: `returns: two completions of one return, ${how}, queue on its row -- both answer, the refund is paid once`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '200,200' &&
          after.status === 'COMPLETED' &&
          after.refunds === '1' &&
          after.movements === '1' &&
          after.audits === '1' &&
          after.refunded === '1780.00',
        detail: `statuses ${statuses(run.responses).join(',')}, ${run.queued} queued on the return, ${after.refunds} refund, ${after.movements} cash-book entry, ${after.audits} audit entry, refunded ${after.refunded}`,
      });
    }

    // 3. Six receipts at once, across both APIs: still once.
    await restore();
    shelf = await shelfOf(approved.id);
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        act(index % 2 ? apis.NEST : apis.DJANGO, approved.id, 'receive'),
      ),
    );
    after = await state(approved.id);
    checks.push({
      name: 'returns: 6 receipts of one return at once, across both APIs -- one receives, the goods go back once',
      passed:
        statuses(burst).join() === '200,409,409,409,409,409' &&
        after.restocks === '1' &&
        after.returned === '1/1 2/2' &&
        Number(await shelfOf(approved.id)) === Number(shelf) + 1,
      detail: `statuses ${statuses(burst).join(',')}, ${after.restocks} restock entry, lines back ${after.returned}, shelf ${shelf} -> ${await shelfOf(approved.id)}`,
    });

    for (const [side, api] of sides) {
      // 5. A completion that meets its order changed mid-flight acts on the
      //    order as committed: delivered again, so it is not moved to REFUNDED.
      await restore();
      let held = await behind(
        [`SELECT id FROM orders_order WHERE id = $1 FOR UPDATE`, [received.order_id]],
        '%orders_order%',
        [() => act(api, received.id, 'complete')],
        async (holder) => {
          await holder.query(`UPDATE orders_order SET status = 'DELIVERED' WHERE id = $1`, [
            received.order_id,
          ]);
        },
      );
      after = await state(received.id);
      checks.push({
        name: `returns: a completion (${side}) whose order is delivered again mid-flight refunds and leaves the order's status alone -- the order lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 200 &&
          after.status === 'COMPLETED' &&
          after.order_status === 'DELIVERED' &&
          after.refunds === '1',
        detail: `${held.responses[0]?.status} ${message(held.responses[0]?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the order' : 'never waited'}, return ${after.status}, order ${after.order_status}, ${after.refunds} refund`,
      });

      // 6. A return opened on a sale that is voided mid-flight is refused as
      //    one on a cancelled order is.
      await restore();
      const before = Number(
        (await one<{ count: string }>(`SELECT count(*) AS count FROM orders_returnrequest`))?.count,
      );
      held = await behind(
        [`SELECT id FROM orders_order WHERE id = $1 FOR UPDATE`, [me.id]],
        '%orders_order%',
        [
          () =>
            post(api, '/api/v1/returns/', {
              order: me.id,
              reason: 'WRONG_SIZE',
              lines: [{ order_item: me.item, quantity: 1 }],
            }),
        ],
        async (holder) => {
          await holder.query(`UPDATE orders_order SET status = 'CANCELLED' WHERE id = $1`, [me.id]);
        },
      );
      const made =
        Number(
          (await one<{ count: string }>(`SELECT count(*) AS count FROM orders_returnrequest`))
            ?.count,
        ) - before;
      const refusal = message(held.responses[0]?.body ?? '');
      checks.push({
        name: `returns: a return opened (${side}) on a sale cancelled mid-flight is refused -- the order lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          refusal === 'An order in status CANCELLED cannot be returned.' &&
          made === 0,
        detail: `${held.responses[0]?.status} ${refusal.slice(0, 60)}, ${held.queued ? 'waited on the order' : 'never waited'}, ${made} returns made`,
      });

      // 7. Two returns for one unit (D157), neither restocking, received at
      //    once through one API: both queue on the order line, and the second
      //    finds the unit already back.
      await restore();
      await db.query(
        `UPDATE orders_returnrequest SET status = 'APPROVED', received_at = NULL WHERE id = $1`,
        [first.id],
      );
      await db.query(
        `UPDATE orders_returnitem SET restock_decision = 'DAMAGED' WHERE return_request_id IN ($1, $2)`,
        [first.id, second.id],
      );
      const lineId = (
        await one<{ id: string }>(`SELECT id FROM orders_orderitem WHERE order_id = $1`, [
          first.order_id,
        ])
      )?.id;
      await db.query(`UPDATE orders_orderitem SET returned_quantity = 0 WHERE id = $1`, [lineId]);
      held = await behind(
        [`SELECT id FROM orders_orderitem WHERE id = $1 FOR UPDATE`, [lineId]],
        '%orders_orderitem%',
        [() => act(api, first.id, 'receive'), () => act(api, second.id, 'receive')],
      );
      const pair = [await state(first.id), await state(second.id)];
      checks.push({
        name: `returns: two returns for one unit received at once (${side}) queue on the order line -- one is received, the unit comes back once`,
        passed:
          held.queued === 2 &&
          statuses(held.responses).join() === '200,409' &&
          pair[0]?.returned === '1/1' &&
          pair.filter((entry) => entry.status === 'RECEIVED').length === 1,
        detail: `statuses ${statuses(held.responses).join(',')}, ${held.queued} queued on the line, line back ${pair[0]?.returned}, returns ${pair.map((entry) => entry.status).join(' and ')}`,
      });

      // 8. A completion whose drawer is emptied mid-flight is refused whole.
      await restore();
      held = await behind(
        [`SELECT id FROM finance_account WHERE id = $1 FOR UPDATE`, [drawer.id]],
        '%finance_account%',
        [() => act(api, received.id, 'complete')],
        async (holder) => {
          await holder.query(
            `INSERT INTO finance_accounttransaction
               (id, created_at, updated_at, account_id, transaction_type, amount, balance_after,
                reference_type, reference_id, reason, notes, occurred_at)
             SELECT gen_random_uuid(), clock_timestamp(), clock_timestamp(), a.id, 'WITHDRAWAL',
                    100.00 - a.balance, 100.00, 'manual', '', 'Banked by the harness mid-flight', '',
                    clock_timestamp()
               FROM finance_account a WHERE a.id = $1`,
            [drawer.id],
          );
          await holder.query(`UPDATE finance_account SET balance = 100.00 WHERE id = $1`, [
            drawer.id,
          ]);
        },
      );
      after = await state(received.id);
      const balance = (
        await one<{ balance: string }>(`SELECT balance::text FROM finance_account WHERE id = $1`, [
          drawer.id,
        ])
      )?.balance;
      checks.push({
        name: `returns: a completion (${side}) whose drawer is emptied mid-flight is refused whole -- the account lock holds`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 409 &&
          after.status === 'RECEIVED' &&
          after.refunds === '0' &&
          balance === '100.00',
        detail: `${held.responses[0]?.status} ${message(held.responses[0]?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, return ${after.status}, ${after.refunds} refunds, drawer ${balance}`,
      });
    }

    // 9. Six returns opened at once, across both APIs: six numbers, none shared.
    await restore();
    const opens = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(index % 2 ? apis.NEST : apis.DJANGO, '/api/v1/returns/', {
          order: me.id,
          reason: 'OTHER',
          lines: [{ order_item: me.item, quantity: 1 }],
        }),
      ),
    );
    const numbers = opens
      .map((response) => (JSON.parse(response.body) as { number?: string }).number ?? '?')
      .sort();
    checks.push({
      name: 'returns: 6 returns opened at once, across both APIs -- six numbers in a row, none shared',
      passed:
        statuses(opens).every((status) => status === 201) &&
        numbers.join() === 'RET-000011,RET-000012,RET-000013,RET-000014,RET-000015,RET-000016',
      detail: `statuses ${statuses(opens).join(',')}, numbers ${numbers.join(' ')}`,
    });

    // 10. Six counter returns of a sale's one unit at once, across both APIs.
    await restore();
    const shelfOfSale = async () =>
      Number(
        (
          await one<{ on_hand: number }>(
            `SELECT v.on_hand FROM inventory_inventory v JOIN orders_order o ON o.branch_id = v.branch_id
               JOIN orders_orderitem i ON i.order_id = o.id AND i.variant_id = v.variant_id
              WHERE o.id = $1`,
            [carded.id],
          )
        )?.on_hand,
      );
    const teeShelf = await shelfOfSale();
    const counter = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(index % 2 ? apis.NEST : apis.DJANGO, '/api/v1/pos/returns/', {
          order: carded.id,
          reason: 'OTHER',
          lines: [{ order_item: carded.item, quantity: 1 }],
        }),
      ),
    );
    const sold = await one<{ status: string; refunded: string; refunds: string; returned: number }>(
      `SELECT o.status, o.refunded_total::text AS refunded,
              (SELECT count(*) FROM orders_refund f WHERE f.order_id = o.id) AS refunds,
              (SELECT i.returned_quantity FROM orders_orderitem i WHERE i.order_id = o.id) AS returned
         FROM orders_order o WHERE o.id = $1`,
      [carded.id],
    );
    checks.push({
      name: 'returns: 6 counter returns of a sale’s one unit at once, across both APIs -- one goes through, the unit and the money come back once',
      passed:
        statuses(counter).filter((status) => status === 201).length === 1 &&
        statuses(counter).every((status) => status === 201 || status === 400 || status === 409) &&
        sold?.status === 'REFUNDED' &&
        sold.refunded === '890.00' &&
        Number(sold.refunds) === 1 &&
        sold.returned === 1 &&
        (await shelfOfSale()) === teeShelf + 1,
      detail: `statuses ${statuses(counter).join(',')}, sale ${sold?.status}, refunded ${sold?.refunded} in ${sold?.refunds} refund, ${sold?.returned} unit back, shelf ${teeShelf} -> ${await shelfOfSale()}`,
    });
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
