/**
 * Race checks for exchanges and damaged returns (business rules 2.3, 2.6),
 * run by run.ts after the cases. Each puts the tables back.
 *
 * An exchange is keyed: the advisory lock on its Idempotency-Key makes a
 * double-click wait for the first press and answer with the exchange it
 * made. Take the lock out and the presses after the first are refused by the
 * order's lock instead -- one exchange still, but five errors at the counter,
 * which is what the first check is there to catch.
 *
 * A damaged item is credited once: its return line is locked while it is
 * sent, so a second send waits and then finds it already gone back.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { PURCHASE_TABLES } from './purchase-order-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import { RETURN_TABLES } from './returns-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export async function exchangeConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const me = await one<{ id: string; essential: string }>(
      `SELECT o.id, (SELECT i.id FROM orders_orderitem i JOIN catalog_productvariant v ON v.id = i.variant_id
                      WHERE i.order_id = o.id AND v.sku = 'RGN-ESS-L-WHI') AS essential
         FROM orders_order o WHERE o.customer_note = 'Parity return me'`,
    );
    const slim = await one<{ id: string }>(
      `SELECT id FROM catalog_productvariant WHERE sku = 'RGN-SLI-L-NAV'`,
    );
    const damaged = await one<{ id: string }>(
      `SELECT l.id FROM orders_returnitem l JOIN orders_returnrequest r ON r.id = l.return_request_id
        WHERE r.number = 'RET-000004' AND l.restock_decision = 'DAMAGED'`,
    );
    const po = await one<{ id: string; line: string }>(
      `SELECT o.id, (SELECT i.id FROM purchasing_purchaseorderitem i JOIN catalog_productvariant v
                       ON v.id = i.variant_id
                      WHERE i.purchase_order_id = o.id AND v.sku = 'RGN-ESS-L-WHI') AS line
         FROM purchasing_purchaseorder o WHERE o.number = 'PO-000001'`,
    );
    if (!me?.essential || !slim || !damaged || !po?.line) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp()::text AS now`))
      ?.now as string;
    const restore = async () => {
      await restoreTables(db, [...new Set([...RETURN_TABLES, ...PURCHASE_TABLES])]);
      await restoreSequences(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const post = (api: URL, path: string, body: unknown, key: string) =>
      send(api, {
        name: 'exchange',
        method: 'POST',
        path,
        headers: {
          ...auth('manager'),
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      });
    const statuses = (responses: { status: number }[]) => responses.map((r) => r.status);
    const shelf = async (sku: string) =>
      Number(
        (
          await one<{ on_hand: number }>(
            `SELECT i.on_hand FROM inventory_inventory i
               JOIN catalog_productvariant v ON v.id = i.variant_id
               JOIN accounts_branch b ON b.id = i.branch_id
              WHERE v.sku = $1 AND b.code = 'DHK1'`,
            [sku],
          )
        )?.on_hand,
      );
    const drawer = async () =>
      (
        await one<{ balance: string }>(
          `SELECT balance::text FROM finance_account WHERE name = 'Counter Cash Drawer'`,
        )
      )?.balance;

    // 1. Six presses of one exchange, split across two Nest processes.
    await restore();
    const before = {
      essential: await shelf('RGN-ESS-L-WHI'),
      slim: await shelf('RGN-SLI-L-NAV'),
      drawer: await drawer(),
    };
    const exchange = {
      return: {
        order: me.id,
        reason: 'WRONG_SIZE',
        lines: [{ order_item: me.essential, quantity: 1 }],
      },
      sale: {
        lines: [{ variant: slim.id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: '1903.07', tendered_amount: '2000.00' }],
      },
    };
    const presses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          index % 2 ? apis.NEST : apis.DJANGO,
          '/api/v1/pos/exchanges/',
          exchange,
          'parity-exchange-race',
        ),
      ),
    );
    const sales = new Set(
      presses.map((response) => {
        try {
          return (JSON.parse(response.body) as { sale?: { number?: string } }).sale?.number ?? '';
        } catch {
          return '';
        }
      }),
    );
    const made = await one<{ returns: string; orders: string; refunds: string }>(
      `SELECT (SELECT count(*) FROM orders_returnrequest WHERE order_id = $1) AS returns,
              (SELECT count(*) FROM orders_order WHERE idempotency_key = 'parity-exchange-race') AS orders,
              (SELECT count(*) FROM orders_refund WHERE idempotency_key = 'exchange:parity-exchange-race') AS refunds`,
      [me.id],
    );
    const afterwards = {
      essential: await shelf('RGN-ESS-L-WHI'),
      slim: await shelf('RGN-SLI-L-NAV'),
      drawer: await drawer(),
    };
    checks.push({
      name: 'exchanges: 6 presses of one exchange at once, across two Nest processes -- six answers naming one sale; the goods, the stock and the drawer move once',
      passed:
        statuses(presses).every((status) => status === 201) &&
        sales.size === 1 &&
        !sales.has('') &&
        made?.returns === '1' &&
        made.orders === '1' &&
        made.refunds === '1' &&
        afterwards.essential === before.essential + 1 &&
        afterwards.slim === before.slim - 1 &&
        Math.round((Number(afterwards.drawer) - Number(before.drawer)) * 100) === 190307,
      detail: `statuses ${statuses(presses).join(',')}, sales ${[...sales].join(' ')}, ${made?.returns} return(s), ${made?.orders} sale(s), ${made?.refunds} refund(s), essentials ${before.essential} -> ${afterwards.essential}, slims ${before.slim} -> ${afterwards.slim}, drawer ${before.drawer} -> ${afterwards.drawer}`,
    });

    // 2. Six sends of one damaged item at once, each with its own key, split
    // between two purchase orders that both brought it in: no order's lock
    // is shared, so only the return line's holds them apart.
    await restore();
    await db.query(
      `UPDATE orders_returnrequest SET status = 'RECEIVED', received_at = now() WHERE number = 'RET-000004'`,
    );
    const twin = {
      id: '33333333-3333-4333-8333-333333333333',
      line: '44444444-4444-4444-8444-444444444444',
    };
    await db.query(
      `INSERT INTO purchasing_purchaseorder
       SELECT (jsonb_populate_record(NULL::purchasing_purchaseorder,
                 to_jsonb(o) || jsonb_build_object('id', $1::text, 'number', 'PO-PARITY-TWIN',
                                                   'credited_total', 0))).*
         FROM purchasing_purchaseorder o WHERE o.id = $2`,
      [twin.id, po.id],
    );
    await db.query(
      `INSERT INTO purchasing_purchaseorderitem
       SELECT (jsonb_populate_record(NULL::purchasing_purchaseorderitem,
                 to_jsonb(i) || jsonb_build_object('id', $2::text, 'purchase_order_id', $1::text,
                                                   'quantity_returned', 0))).*
         FROM purchasing_purchaseorderitem i WHERE i.id = $3`,
      [twin.id, twin.line, po.line],
    );
    const sends = await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const target = index < 3 ? po : twin;
        return post(
          index % 2 ? apis.NEST : apis.DJANGO,
          '/api/v1/damaged-returns/send/',
          {
            purchase_order: target.id,
            lines: [{ return_item: damaged.id, purchase_order_item: target.line }],
          },
          `parity-damaged-race-${index}`,
        );
      }),
    );
    const credited = await one<{ lines: string; credited: string; returned: number }>(
      `SELECT (SELECT count(*) FROM purchasing_purchasereturnitem WHERE return_item_id = $1) AS lines,
              (SELECT sum(credited_total)::text FROM purchasing_purchaseorder WHERE id = ANY($2::uuid[])) AS credited,
              (SELECT sum(quantity_returned) FROM purchasing_purchaseorderitem WHERE id = ANY($3::uuid[]))::int AS returned`,
      [damaged.id, [po.id, twin.id], [po.line, twin.line]],
    );
    checks.push({
      name: 'damaged returns: 6 sends of one damaged item at once, on two purchase orders, across two Nest processes -- one credit; the rest find it gone back: the return line’s lock holds',
      passed:
        statuses(sends).filter((status) => status === 201).length === 1 &&
        statuses(sends).every((status) => status === 201 || status === 409) &&
        // Refused by the return line's lock, which reads what the winner wrote --
        // not by the unique column underneath it, which only says "conflict".
        sends
          .filter((response) => response.status === 409)
          .every((response) => response.body.includes('already gone back to the supplier')) &&
        credited?.lines === '1' &&
        credited.credited === '760.00' &&
        credited.returned === 2,
      detail: `statuses ${statuses(sends).join(',')}, ${credited?.lines} line(s), credited ${credited?.credited} across both orders, ${credited?.returned} back on their lines; refused: ${[
        ...new Set(
          sends
            .filter((response) => response.status !== 201)
            .map((response) => {
              try {
                return (
                  (
                    JSON.parse(response.body) as { error?: { message?: string } }
                  ).error?.message?.slice(0, 50) ?? ''
                );
              } catch {
                return '';
              }
            }),
        ),
      ].join(' | ')}`,
    });
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
