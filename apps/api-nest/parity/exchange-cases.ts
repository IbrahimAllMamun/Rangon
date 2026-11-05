/**
 * Cases for what a customer bringing goods back can lead to, beyond a refund
 * (business rules 2.3, 2.6): an exchange at the counter -- the goods back and
 * new goods out in one transaction, `POST /pos/exchanges/` and its quote --
 * and damaged goods sent back to the supplier, `/damaged-returns/`.
 *
 * Written after Django was gone: every answer here is the NestJS API's own,
 * taken with `PARITY_ACCEPT` and read when it was.
 *
 * The sale and the returns are fixture_returns.py's: `Parity return me` is a
 * counter sale at DHK1 of two navy classics and a white essential (৳890, of
 * which ৳886.93 was paid once the sale's ৳20 discount is shared out), and
 * RET-000004 is an approved return with a damaged white essential on it.
 * PO-000001 brought the essentials into DHK1.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { PURCHASE_EFFECTS, PURCHASE_TABLES } from './purchase-order-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import { RETURN_EFFECTS, RETURN_TABLES } from './returns-cases.ts';
import type { Case } from './run.ts';

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

/** Both sides of a damaged item's journey: the customer's return and the supplier's. */
const TABLES = [...new Set([...RETURN_TABLES, ...PURCHASE_TABLES])];

async function resetBoth(client: pg.Client): Promise<void> {
  await restoreTables(client, TABLES);
  await restoreSequences(client);
}

/** An exchange's two orders, named to each other on their timelines. */
const EXCHANGE_EVENTS = `SELECT o.number, e.event_type, e.message,
        (SELECT r.number FROM orders_returnrequest r WHERE r.id::text = e.data->>'return_id') AS return
   FROM orders_orderevent e JOIN orders_order o ON o.id = e.order_id
  WHERE e.event_type = 'EXCHANGE' AND e.id NOT IN (SELECT id FROM "snap_orders_orderevent")
  ORDER BY o.number`;

/** Which damaged customer-return line each supplier-return line credits. */
const DAMAGED_LINKS = `SELECT p.number, v.sku, x.quantity, x.unit_cost::text, r.number AS customer_return,
        o.number AS customer_order
   FROM purchasing_purchasereturnitem x
   JOIN purchasing_purchasereturn p ON p.id = x.purchase_return_id
   JOIN purchasing_purchaseorderitem i ON i.id = x.purchase_order_item_id
   JOIN catalog_productvariant v ON v.id = i.variant_id
   LEFT JOIN orders_returnitem l ON l.id = x.return_item_id
   LEFT JOIN orders_returnrequest r ON r.id = l.return_request_id
   LEFT JOIN orders_orderitem s ON s.id = l.order_item_id
   LEFT JOIN orders_order o ON o.id = s.order_id
  WHERE x.id NOT IN (SELECT id FROM "snap_purchasing_purchasereturnitem")
  ORDER BY p.number, v.sku`;

export async function exchangeCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const one = async <T extends pg.QueryResultRow>(sql: string) =>
    (await db.query<T>(sql)).rows[0] as T | undefined;

  const me = await one<{ id: string; items: string[] }>(
    `SELECT o.id, ARRAY(SELECT i.id::text FROM orders_orderitem i WHERE i.order_id = o.id
                         ORDER BY i.created_at) AS items
       FROM orders_order o WHERE o.customer_note = 'Parity return me'`,
  );
  const mirpur = await one<{ id: string; items: string[] }>(
    `SELECT o.id, ARRAY(SELECT i.id::text FROM orders_orderitem i WHERE i.order_id = o.id) AS items
       FROM orders_order o WHERE o.customer_note = 'Parity return mirpur'`,
  );
  const variant = new Map(
    (
      await db.query<{ sku: string; id: string }>(
        `SELECT sku, id FROM catalog_productvariant
          WHERE sku IN ('RGN-SLI-L-NAV', 'PAR-BUY-C', 'RGN-ESS-XL-WHI', 'RGN-ESS-L-WHI')`,
      )
    ).rows.map((row) => [row.sku, row.id]),
  );
  const approved = await one<{ id: string; damaged: string; restocked: string }>(
    `SELECT r.id,
            (SELECT l.id::text FROM orders_returnitem l WHERE l.return_request_id = r.id
              AND l.restock_decision = 'DAMAGED') AS damaged,
            (SELECT l.id::text FROM orders_returnitem l WHERE l.return_request_id = r.id
              AND l.restock_decision = 'RESTOCK') AS restocked
       FROM orders_returnrequest r WHERE r.number = 'RET-000004'`,
  );
  const po = await one<{ id: string; essentials: string; classics: string }>(
    `SELECT o.id,
            (SELECT i.id::text FROM purchasing_purchaseorderitem i
               JOIN catalog_productvariant v ON v.id = i.variant_id
              WHERE i.purchase_order_id = o.id AND v.sku = 'RGN-ESS-L-WHI') AS essentials,
            (SELECT i.id::text FROM purchasing_purchaseorderitem i
               JOIN catalog_productvariant v ON v.id = i.variant_id
              WHERE i.purchase_order_id = o.id AND v.sku = 'RGN-CLA-M-NAV') AS classics
       FROM purchasing_purchaseorder o WHERE o.number = 'PO-000001'`,
  );
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM orders_orderitem
       UNION ALL SELECT id::text FROM orders_returnrequest UNION ALL SELECT id::text FROM orders_returnitem
       UNION ALL SELECT id::text FROM purchasing_purchaseorder
       UNION ALL SELECT id::text FROM purchasing_purchaseorderitem
       UNION ALL SELECT id::text FROM catalog_productvariant`,
    )
  ).rows.map((row) => row.id);
  if (!me || !mirpur || variant.size < 4 || !approved?.damaged || !po?.essentials) {
    await db.end();
    console.log('SKIP  exchanges: fixture_returns.py has not been applied');
    return [];
  }

  // Kept open: a case's `prepare` changes rows after the reset, before its request.
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const blank = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const everyone = Object.keys(STAFF) as Who[];
  const cases: Case[] = [];

  // === An exchange at the counter ===============================================================
  const EXCHANGE = '/api/v1/pos/exchanges/';
  const essential = me.items[1] as string;
  const back = (lines: unknown = [{ order_item: essential, quantity: 1 }], extra = {}) => ({
    order: me.id,
    reason: 'WRONG_SIZE',
    lines,
    ...extra,
  });
  const out = (sku: string, payments: unknown[] = [], extra = {}) => ({
    lines: [{ variant: variant.get(sku), quantity: 1 }],
    payments,
    ...extra,
  });
  const cash = (amount: string, tendered?: string) => ({
    method: 'CASH',
    amount,
    ...(tendered ? { tendered_amount: tendered } : {}),
  });
  /** A dearer navy slim (৳2,790) for the white essential (৳886.93): ৳1,903.07 to pay. */
  const dearer = { return: back(), sale: out('RGN-SLI-L-NAV', [cash('1903.07', '2000.00')]) };
  const exchange = (
    name: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
    key: string | null = `parity-exchange-${cases.length}`,
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `exchanges: ${name}`,
      method: 'POST',
      path: EXCHANGE,
      headers: {
        ...auth(who),
        ...JSON_TYPE,
        ...(key === null ? {} : { 'idempotency-key': key }),
        ...(headers ?? {}),
      },
      body: text(body),
      reset: resetBoth,
      effects: [...RETURN_EFFECTS, EXCHANGE_EVENTS],
      jobs: true,
      normalize: blank,
      ...rest,
    });
  };
  for (const who of everyone) exchange(`[${who}] a dearer item`, dearer, who);
  exchange('a dearer item, paid by bKash', {
    return: back(),
    sale: out('RGN-SLI-L-NAV', [{ method: 'MOBILE_MFS', amount: '1903.07', reference: 'TX1' }]),
  });
  exchange('a dearer item, a paisa short', {
    return: back(),
    sale: out('RGN-SLI-L-NAV', [cash('1903.06')]),
  });
  // ৳886.93 back for ৳890.00 out: the sale's discount stays with the sale, so ৳3.07 to pay.
  exchange('the same price, another size', {
    return: back(),
    sale: out('RGN-ESS-XL-WHI', [cash('3.07')]),
  });
  exchange('a cheaper item: the rest is given back', {
    return: back(),
    sale: out('PAR-BUY-C'),
  });
  exchange('a cheaper item, paid for again: refused', {
    return: back(),
    sale: out('PAR-BUY-C', [cash('450.00')]),
  });
  exchange('the goods back damaged', {
    return: back([{ order_item: essential, quantity: 1, restock_decision: 'DAMAGED' }]),
    sale: out('RGN-ESS-XL-WHI', [cash('3.07')]),
  });
  exchange('the same item back and out again', {
    return: back(),
    sale: out('RGN-ESS-L-WHI', [cash('3.07')]),
  });
  exchange('the new item out of stock: nothing comes back either', dearer, 'manager', {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = 0
        WHERE variant_id = '${variant.get('RGN-SLI-L-NAV')}'
          AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`,
    ),
  });
  exchange('the drawer short of the refund, not of the difference', dearer, 'manager', {
    prepare: after(
      `UPDATE finance_account SET balance = 100.00 WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  exchange('more than can come back', {
    return: back([{ order_item: essential, quantity: 2 }]),
    sale: out('RGN-ESS-XL-WHI'),
  });
  exchange('nothing coming back', { return: back([]), sale: out('RGN-ESS-XL-WHI') });
  exchange('nothing going out', { return: back(), sale: { lines: [], payments: [] } });
  exchange('an order sold at another branch', {
    return: {
      order: mirpur.id,
      reason: 'WRONG_SIZE',
      lines: [{ order_item: mirpur.items[0], quantity: 1 }],
    },
    sale: out('RGN-ESS-XL-WHI'),
  });
  exchange('an order that is not there', {
    return: back(undefined, { order: MISSING }),
    sale: out('RGN-ESS-XL-WHI'),
  });
  exchange('past the return window', dearer, 'manager', {
    prepare: after(
      `UPDATE orders_order SET delivered_at = now() - interval '15 days' WHERE customer_note = 'Parity return me'`,
    ),
  });
  exchange('past the return window, by the owner', dearer, 'owner', {
    prepare: after(
      `UPDATE orders_order SET delivered_at = now() - interval '15 days' WHERE customer_note = 'Parity return me'`,
    ),
  });
  exchange('no Idempotency-Key', dearer, 'manager', {}, null);
  exchange('an empty Idempotency-Key', dearer, 'manager', {}, '');
  exchange('an Idempotency-Key of 64 characters', dearer, 'manager', {}, 'k'.repeat(64));
  exchange('an Idempotency-Key of 65 characters', dearer, 'manager', {}, 'k'.repeat(65));
  // A key an ordinary sale already holds: not this exchange's to answer with.
  exchange(
    'the key of an earlier sale',
    dearer,
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET idempotency_key = 'parity-exchange-earlier'
          WHERE customer_note = 'Parity return card'`,
      ),
    },
    'parity-exchange-earlier',
  );
  exchange('no return in the body', { sale: out('RGN-ESS-XL-WHI') });
  exchange('no sale in the body', { return: back() });
  exchange('a body that is a list', []);
  exchange('broken JSON', '{"return":');
  cases.push({
    name: 'exchanges: GET',
    path: EXCHANGE,
    headers: auth('manager'),
  });

  // The quote: what the goods are worth, and nothing written.
  const QUOTE = '/api/v1/pos/exchanges/quote/';
  const quote = (name: string, body: unknown, who: Who = 'manager', extra: Partial<Case> = {}) =>
    cases.push({
      name: `exchanges: quote, ${name}`,
      method: 'POST',
      path: QUOTE,
      headers: { ...auth(who), ...JSON_TYPE },
      body: text(body),
      reset: resetBoth,
      effects: [...RETURN_EFFECTS, EXCHANGE_EVENTS],
      jobs: true,
      normalize: blank,
      ...extra,
    });
  for (const who of everyone) quote(`[${who}] the white essential`, { return: back() }, who);
  quote('both lines', {
    return: back([
      { order_item: me.items[0], quantity: 2 },
      { order_item: essential, quantity: 1 },
    ]),
  });
  quote('more than can come back', { return: back([{ order_item: essential, quantity: 2 }]) });
  quote('a shop-fault reason', { return: back(undefined, { reason: 'DEFECTIVE' }) });
  quote('nothing left to refund', { return: back() }, 'manager', {
    prepare: after(
      `UPDATE orders_order SET refunded_total = paid_total WHERE customer_note = 'Parity return me'`,
    ),
  });
  quote('no return in the body', {});

  // === Damaged goods back to the supplier =======================================================
  const DAMAGED = '/api/v1/damaged-returns/';
  // RET-000004's goods arrive: its damaged essential waits for the supplier.
  const arrived = `UPDATE orders_returnrequest SET status = 'RECEIVED', received_at = now()
                    WHERE number = 'RET-000004'`;
  const listing = (name: string, query = '', who: Who = 'owner', prepare = [arrived]) =>
    cases.push({
      name: `damaged returns: ${name}`,
      path: `${DAMAGED}${query ? `?${query}` : ''}`,
      headers: auth(who),
      reset: resetBoth,
      prepare: after(...prepare),
      normalize: blank,
    });
  for (const who of everyone) listing(`[${who}] list`, '', who);
  listing('list, nothing received yet', '', 'owner', []);
  listing('list, a manager at another branch', '', 'mirpur');
  listing('list, every unit of PO-000001 already sent back', '', 'owner', [
    arrived,
    `UPDATE purchasing_purchaseorderitem SET quantity_returned = quantity_received
      WHERE id = '${po.essentials}'`,
  ]);
  listing('list, page_size=1', 'page_size=1');

  const send = (name: string, body: unknown, who: Who = 'manager', extra: Partial<Case> = {}) => {
    const { headers, prepare, ...rest } = extra;
    cases.push({
      name: `damaged returns: send, ${name}`,
      method: 'POST',
      path: `${DAMAGED}send/`,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetBoth,
      prepare: prepare ?? after(arrived),
      effects: [...PURCHASE_EFFECTS, DAMAGED_LINKS],
      jobs: true,
      normalize: blank,
      ...rest,
    });
  };
  const damaged = (extra = {}) => ({
    purchase_order: po.id,
    lines: [{ return_item: approved.damaged, purchase_order_item: po.essentials }],
    ...extra,
  });
  for (const who of everyone) send(`[${who}] the damaged essential`, damaged(), who);
  send('with a reason and a note', damaged({ reason: 'DEFECTIVE', notes: 'Seam split' }));
  send('with a reason it does not know', damaged({ reason: 'NOPE' }));
  send('with an Idempotency-Key', damaged(), 'manager', {
    headers: { 'idempotency-key': 'parity-damaged-1' },
  });
  send('not received yet', damaged(), 'manager', { prepare: after() });
  send('a line that went back on the shelf', {
    purchase_order: po.id,
    lines: [{ return_item: approved.restocked, purchase_order_item: po.classics }],
  });
  send('on a purchase line for another item', {
    purchase_order: po.id,
    lines: [{ return_item: approved.damaged, purchase_order_item: po.classics }],
  });
  send('the same item twice', {
    purchase_order: po.id,
    lines: [
      { return_item: approved.damaged, purchase_order_item: po.essentials },
      { return_item: approved.damaged, purchase_order_item: po.essentials },
    ],
  });
  send('more than the purchase line has left', damaged(), 'manager', {
    prepare: after(
      arrived,
      `UPDATE purchasing_purchaseorderitem SET quantity_returned = quantity_received - 1
        WHERE id = '${po.essentials}'`,
    ),
  });
  send('already sent back', damaged(), 'manager', {
    prepare: after(
      arrived,
      `INSERT INTO purchasing_purchasereturn
         (id, created_at, updated_at, number, purchase_order_id, reason, notes, returned_at,
          returned_by_id, credit_total, idempotency_key)
       VALUES ('11111111-1111-4111-8111-111111111111', now(), now(), 'PRN-PARITY', '${po.id}',
               'DAMAGED', '', now(), NULL, 760.00, NULL)`,
      `INSERT INTO purchasing_purchasereturnitem
         (id, created_at, updated_at, purchase_return_id, purchase_order_item_id, quantity,
          unit_cost, return_item_id)
       VALUES ('22222222-2222-4222-8222-222222222222', now(), now(),
               '11111111-1111-4111-8111-111111111111', '${po.essentials}', 2, 380.00,
               '${approved.damaged}')`,
    ),
  });
  send('a purchase order cancelled', damaged(), 'manager', {
    prepare: after(
      arrived,
      `UPDATE purchasing_purchaseorder SET status = 'CANCELLED' WHERE id = '${po.id}'`,
    ),
  });
  send('a purchase order that is not there', damaged({ purchase_order: MISSING }));
  send('a return line that is not there', {
    purchase_order: po.id,
    lines: [{ return_item: MISSING, purchase_order_item: po.essentials }],
  });
  send('no lines', damaged({ lines: [] }));
  send('a body that is a list', []);
  send('broken JSON', '{"purchase_order":');
  cases.push({
    name: 'damaged returns: GET send',
    path: `${DAMAGED}send/`,
    headers: auth('manager'),
  });

  return cases;
}
