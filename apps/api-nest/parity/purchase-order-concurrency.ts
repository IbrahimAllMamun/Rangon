/**
 * Race checks for purchase orders (phase 6 part 4), run by run.ts after the
 * comparison cases. Each puts the purchasing and stock tables back.
 *
 * Every step of an order -- sending, cancelling, a delivery, a return --
 * takes the order's row first and decides from the row as committed. A
 * delivery and a return then take the order's lines, and the shelf's row
 * through the stock service.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetPurchases } from './purchase-order-cases.ts';
import { behind, type Check, message, statuses } from './races.ts';
import { send } from './run.ts';

export async function purchaseOrderConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const orderId = async (invoice: string) =>
      (
        await one<{ id: string }>(
          `SELECT id FROM purchasing_purchaseorder WHERE invoice_number = $1`,
          [invoice],
        )
      )?.id as string;
    const lineId = async (invoice: string, sku: string) =>
      (
        await one<{ id: string }>(
          `SELECT i.id FROM purchasing_purchaseorderitem i
             JOIN purchasing_purchaseorder o ON o.id = i.purchase_order_id
             JOIN catalog_productvariant v ON v.id = i.variant_id
            WHERE o.invoice_number = $1 AND v.sku = $2`,
          [invoice, sku],
        )
      )?.id as string;
    const draft = await orderId('PAR-PO-DRAFT');
    if (!draft) return [];
    const sent = await orderId('PAR-PO-SENT');
    const done = await orderId('PAR-PO-DONE');
    const away = await orderId('PAR-PO-MIRPUR');
    const sentA = await lineId('PAR-PO-SENT', 'PAR-BUY-A');
    const doneA = await lineId('PAR-PO-DONE', 'PAR-BUY-A');
    const doneC = await lineId('PAR-PO-DONE', 'PAR-BUY-C');
    const awayA = await lineId('PAR-PO-MIRPUR', 'PAR-BUY-A');
    const ids = (await one<{ a: string; c: string; home: string; mirpur: string; idle: string }>(
      `SELECT (SELECT id FROM catalog_productvariant WHERE sku = 'PAR-BUY-A') AS a,
              (SELECT id FROM catalog_productvariant WHERE sku = 'PAR-BUY-C') AS c,
              (SELECT id FROM accounts_branch WHERE code = 'DHK1') AS home,
              (SELECT id FROM accounts_branch WHERE code = 'PAR3') AS mirpur,
              (SELECT id FROM purchasing_supplier WHERE code = 'PARITY-IDLE') AS idle`,
    )) as { a: string; c: string; home: string; mirpur: string; idle: string };
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetPurchases(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const ORDERS = '/api/v1/purchase-orders/';
    const post = (api: URL, path: string, body: unknown = undefined, key?: string) =>
      send(api, {
        name: 'purchase order',
        method: 'POST',
        path: `${ORDERS}${path}`,
        headers: {
          ...auth('owner'),
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    const SIDES = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    const PAIRS = [
      ['one per API', apis.DJANGO, apis.NEST],
      ['both through Django', apis.DJANGO, apis.DJANGO],
      ['both through Nest', apis.NEST, apis.NEST],
    ] as const;
    const lockOrder = (id: string): [string, unknown[]] => [
      `SELECT id FROM purchasing_purchaseorder WHERE id = $1 FOR UPDATE`,
      [id],
    ];
    /** An order's status and credit, a SKU's shelf against its ledger, and what was made since the restore. */
    const state = async (order: string, sku: string, branch = ids.home) =>
      (await one<Record<string, string>>(
        `SELECT o.status, o.payment_status, o.credited_total::text AS credited,
                i.on_hand::text AS on_hand, i.average_cost::text AS average,
                (SELECT COALESCE(SUM(t.quantity), 0)::text FROM inventory_inventorytransaction t
                  WHERE t.branch_id = i.branch_id AND t.variant_id = i.variant_id
                    AND t.transaction_type NOT IN ('RESERVATION', 'RESERVATION_RELEASE')) AS ledger,
                (SELECT count(*)::text FROM purchasing_purchasereceipt r
                  WHERE r.id NOT IN (SELECT id FROM "snap_purchasing_purchasereceipt")) AS receipts,
                (SELECT count(*)::text FROM purchasing_purchasereturn r
                  WHERE r.id NOT IN (SELECT id FROM "snap_purchasing_purchasereturn")) AS returns,
                (SELECT count(*)::text FROM inventory_inventorytransaction t
                  WHERE t.id NOT IN (SELECT id FROM "snap_inventory_inventorytransaction")) AS movements
           FROM purchasing_purchaseorder o
           LEFT JOIN inventory_inventory i ON i.branch_id = $3 AND i.variant_id = $2
          WHERE o.id = $1`,
        [order, sku, branch],
      )) as Record<string, string>;
    const lineOf = async (id: string) =>
      (await one<{ received: number; returned: number }>(
        `SELECT quantity_received AS received, quantity_returned AS returned
           FROM purchasing_purchaseorderitem WHERE id = $1`,
        [id],
      )) as { received: number; returned: number };

    // 1. A cancel committed while a send waits on the order's row.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        lockOrder(draft),
        '%purchasing_purchaseorder%',
        [() => post(api, `${draft}/send/`)],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorder SET status = 'CANCELLED' WHERE id = $1`,
            [draft],
          );
        },
      );
      const end = await state(draft, ids.a);
      const answer = held.responses[0];
      checks.push({
        name: `purchase orders: an order cancelled while a send of it (${side}) waits on its row is not sent -- the order's lock holds`,
        passed: held.queued === 1 && answer?.status === 409 && end.status === 'CANCELLED',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 50)}, ${held.queued ? 'waited on the lock' : 'never waited'}, the order ${end.status}`,
      });
    }

    // 2. A delivery committed while a cancel waits on the order's row.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        lockOrder(sent),
        '%purchasing_purchaseorder%',
        [() => post(api, `${sent}/cancel/`, { reason: 'Changed our mind' })],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorder SET status = 'PARTIALLY_RECEIVED' WHERE id = $1`,
            [sent],
          );
        },
      );
      const end = await state(sent, ids.a);
      const answer = held.responses[0];
      checks.push({
        name: `purchase orders: an order part received while a cancel of it (${side}) waits on its row is not cancelled`,
        passed: held.queued === 1 && answer?.status === 409 && end.status === 'PARTIALLY_RECEIVED',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, the order ${end.status}`,
      });
    }

    // 3. An order cancelled while a delivery waits on its row.
    for (const [side, api] of SIDES) {
      await restore();
      const before = await state(sent, ids.a);
      const held = await behind(
        db,
        lockOrder(sent),
        '%purchasing_purchaseorder%',
        [() => post(api, `${sent}/receive/`, { lines: [{ item: sentA, quantity: 6 }] })],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorder SET status = 'CANCELLED' WHERE id = $1`,
            [sent],
          );
        },
      );
      const end = await state(sent, ids.a);
      const answer = held.responses[0];
      checks.push({
        name: `purchase orders: an order cancelled while a delivery against it (${side}) waits on its row receives nothing`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          end.status === 'CANCELLED' &&
          end.on_hand === before.on_hand &&
          end.receipts === '0' &&
          end.movements === '0',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 55)}, ${held.queued ? 'waited on the lock' : 'never waited'}, the order ${end.status}, shelf ${before.on_hand} -> ${end.on_hand}, ${end.receipts} receipts`,
      });
    }

    // 4. Part of a line received by someone else while a delivery waits on the line's row.
    for (const [side, api] of SIDES) {
      await restore();
      const before = await state(sent, ids.a);
      const held = await behind(
        db,
        [`SELECT id FROM purchasing_purchaseorderitem WHERE id = $1 FOR UPDATE`, [sentA]],
        '%purchasing_purchaseorderitem%',
        [() => post(api, `${sent}/receive/`, { lines: [{ item: sentA, quantity: 6 }] })],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorderitem SET quantity_received = 4 WHERE id = $1`,
            [sentA],
          );
        },
      );
      const end = await state(sent, ids.a);
      const answer = held.responses[0];
      const line = await lineOf(sentA);
      checks.push({
        name: `purchase orders: a line part received while a delivery of all of it (${side}) waits on the line's row is refused -- the lines' lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 400 &&
          message(answer.body).includes('only 2 outstanding') &&
          line.received === 4 &&
          end.on_hand === before.on_hand,
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, the line at ${line.received} received, shelf ${before.on_hand} -> ${end.on_hand}`,
      });
    }

    // 5. Six deliveries of one whole line at once.
    await restore();
    let before = await state(sent, ids.a);
    const deliveries = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), `${sent}/receive/`, { lines: [{ item: sentA, quantity: 6 }] }),
      ),
    );
    let end = await state(sent, ids.a);
    checks.push({
      name: 'purchase orders: 6 deliveries of one whole line at once, across both APIs -- one is received, the shelf up once and equal to its ledger',
      passed:
        statuses(deliveries).join() === '201,400,400,400,400,400' &&
        Number(end.on_hand) === Number(before.on_hand) + 6 &&
        end.on_hand === end.ledger &&
        end.receipts === '1' &&
        end.movements === '1' &&
        (await lineOf(sentA)).received === 6,
      detail: `statuses ${statuses(deliveries).join(',')}, shelf ${before.on_hand} -> ${end.on_hand} (ledger ${end.ledger}), ${end.receipts} receipt, ${end.movements} movement`,
    });

    // 6. Two returns of different lines queued on the order's row: the credit adds up.
    for (const [how, first, second] of PAIRS) {
      await restore();
      before = await state(done, ids.a);
      const run = await behind(db, lockOrder(done), '%purchasing_purchaseorder%', [
        () =>
          post(first, `${done}/return/`, {
            lines: [{ item: doneA, quantity: 1 }],
            reason: 'DAMAGED',
          }),
        () =>
          post(second, `${done}/return/`, {
            lines: [{ item: doneC, quantity: 1 }],
            reason: 'DEFECTIVE',
          }),
      ]);
      end = await state(done, ids.a);
      checks.push({
        name: `purchase orders: two returns of different lines, ${how}, queue on the order's row -- both go back and the credit is the sum of the two`,
        passed:
          run.queued === 2 &&
          statuses(run.responses).join() === '201,201' &&
          Number(end.credited) === Number(before.credited) + 205 + 300 &&
          end.returns === '2' &&
          end.on_hand === end.ledger,
        detail: `statuses ${statuses(run.responses).join(',')}, ${run.queued} queued on the order, credit ${before.credited} -> ${end.credited}, ${end.returns} returns`,
      });
    }

    // 7. Units of a line sent back by someone else while a return waits on the line's row.
    for (const [side, api] of SIDES) {
      await restore();
      before = await state(done, ids.a);
      const held = await behind(
        db,
        [`SELECT id FROM purchasing_purchaseorderitem WHERE id = $1 FOR UPDATE`, [doneA]],
        '%purchasing_purchaseorderitem%',
        [
          () =>
            post(api, `${done}/return/`, {
              lines: [{ item: doneA, quantity: 4 }],
              reason: 'DAMAGED',
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_purchaseorderitem SET quantity_returned = 3 WHERE id = $1`,
            [doneA],
          );
        },
      );
      end = await state(done, ids.a);
      const answer = held.responses[0];
      const line = await lineOf(doneA);
      checks.push({
        name: `purchase orders: a line part returned while a return of all of it (${side}) waits on the line's row is refused -- the lines' lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 400 &&
          message(answer.body).includes('only 1 received') &&
          line.returned === 3 &&
          end.credited === before.credited &&
          end.on_hand === before.on_hand,
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, the line at ${line.returned} returned, credit ${before.credited} -> ${end.credited}`,
      });
    }

    // 8. A shelf emptied while a return waits on its row.
    for (const [side, api] of SIDES) {
      await restore();
      before = await state(done, ids.c);
      const held = await behind(
        db,
        [
          `SELECT id FROM inventory_inventory WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE`,
          [ids.home, ids.c],
        ],
        '%inventory_inventory%',
        [
          () =>
            post(api, `${done}/return/`, {
              lines: [{ item: doneC, quantity: 2 }],
              reason: 'DAMAGED',
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE inventory_inventory SET on_hand = 1 WHERE branch_id = $1 AND variant_id = $2`,
            [ids.home, ids.c],
          );
        },
      );
      end = await state(done, ids.c);
      const answer = held.responses[0];
      checks.push({
        name: `purchase orders: a shelf emptied while a return (${side}) waits on its row -- the return is refused whole, nothing credited`,
        passed:
          held.queued === 1 &&
          answer?.status === 409 &&
          end.on_hand === '1' &&
          end.credited === before.credited &&
          end.returns === '0' &&
          (await lineOf(doneC)).returned === 2,
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, shelf ${end.on_hand}, credit ${before.credited} -> ${end.credited}, ${end.returns} returns`,
      });
    }

    // 9. Six clicks of one return under one key.
    await restore();
    before = await state(done, ids.a);
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          either(index),
          `${done}/return/`,
          { lines: [{ item: doneA, quantity: 1 }], reason: 'DAMAGED' },
          'parity-return-clicked',
        ),
      ),
    );
    end = await state(done, ids.a);
    const returned = new Set(
      clicks.map(
        (response) =>
          (JSON.parse(response.body) as { purchase_return?: { id?: string } }).purchase_return?.id,
      ),
    );
    checks.push({
      name: 'purchase orders: 6 clicks of one return with one Idempotency-Key, across both APIs -- six 201s, one return, one unit off the shelf',
      passed:
        statuses(clicks).every((status) => status === 201) &&
        returned.size === 1 &&
        end.returns === '1' &&
        Number(end.on_hand) === Number(before.on_hand) - 1 &&
        Number(end.credited) === Number(before.credited) + 205,
      detail: `statuses ${statuses(clicks).join(',')}, ${returned.size} return id, ${end.returns} return, shelf ${before.on_hand} -> ${end.on_hand}, credit ${before.credited} -> ${end.credited}`,
    });

    // 10. Six orders raised at once: six numbers.
    await restore();
    const raised = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), '', {
          supplier: ids.idle,
          lines: [{ variant: ids.a, quantity: 1, unit_cost: '1.00' }],
        }),
      ),
    );
    const numbers = new Set(
      raised.map((response) => (JSON.parse(response.body) as { number?: string }).number),
    );
    checks.push({
      name: 'purchase orders: 6 orders raised at once, across both APIs -- six numbers, none shared',
      passed: statuses(raised).every((status) => status === 201) && numbers.size === 6,
      detail: `statuses ${statuses(raised).join(',')}, numbers ${[...numbers].sort().join(' ')}`,
    });

    // 11. Another supplier becomes a SKU's preferred one while a first delivery of it is in flight.
    for (const [side, api] of SIDES) {
      await restore();
      // PAR3 has never held the SKU and SUP-001 has never supplied it; nobody is preferred yet.
      await db.query(
        `DELETE FROM purchasing_supplierproduct WHERE variant_id = $1 AND is_preferred`,
        [ids.a],
      );
      const held = await behind(
        db,
        [
          `INSERT INTO purchasing_supplierproduct
             (id, created_at, updated_at, supplier_id, variant_id, supplier_sku, last_cost,
              minimum_order_quantity, is_preferred, is_active, notes)
           VALUES (gen_random_uuid(), now(), now(), $1, $2, '', 1.00, 1, true, true, 'Held by the harness')`,
          [ids.idle, ids.a],
        ],
        '%purchasing_supplierproduct%',
        [() => post(api, `${away}/receive/`, { lines: [{ item: awayA, quantity: 1 }] })],
      );
      end = await state(away, ids.a, ids.mirpur);
      const answer = held.responses[0];
      checks.push({
        name: `purchase orders: another supplier made a SKU's preferred one while its first delivery from this one (${side}) is in flight -- the delivery is refused with a bare 409 (D187, copied); no lock is involved`,
        passed: held.queued === 1 && answer?.status === 409 && end.receipts === '0',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the index' : 'never waited'}, ${end.receipts} receipts`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
