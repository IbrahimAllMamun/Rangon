/**
 * Parity cases for returns and refunds (phase 5 part 5): `/returns/` -- list,
 * read, open, approve, reject, receive, complete -- and the counter's
 * one-step `POST /pos/returns/`. A return is its own record: goods come back
 * at RECEIVED and the money at COMPLETED, so each step is compared by what
 * it wrote to the return, the order, the shelf, the cash book and the audit
 * log.
 *
 * The sales and the returns on them come from fixture_returns.py; the online
 * orders are the demo seed's.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker, SALE_EFFECTS, SALE_TABLES } from './pos-sale-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const RETURN_TABLES = [...SALE_TABLES, 'orders_returnitem', 'orders_returnrequest'];

const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(s) FROM "snap_${table}" s WHERE s.id = ${alias}.id)`;

/**
 * Django reads a return's lines in no stated order (`ReturnItem` has no
 * `Meta.ordering` and nothing asks for one), so which line is restocked
 * first, and which comes first in the answer, is the table's own business and
 * changes from one run to the next (D161). The ledger entries a request made
 * are therefore read by SKU, not by the instant each was written.
 */
const LEDGER = 6;
const BY_TIME = 'ORDER BY t.created_at';
const ledger = SALE_EFFECTS[LEDGER] as string;
if (!ledger.endsWith(BY_TIME)) throw new Error('returns-cases: the ledger query has moved');

export const RETURN_EFFECTS = [
  ...SALE_EFFECTS.slice(0, LEDGER),
  `${ledger.slice(0, -BY_TIME.length)}ORDER BY t.reference_type, b.code, v.sku, t.created_at`,
  ...SALE_EFFECTS.slice(LEDGER + 1),
  // Returns: the ones a request made or moved, and the order of their stamps.
  `SELECT r.number, o.number AS order_number, r.status, r.reason, r.customer_comment,
          r.staff_comment, r.refund_amount::text, r.refund_shipping, q.email AS requested_by,
          a.email AS approved_by, r.approved_at IS NOT NULL AS approved,
          r.received_at IS NOT NULL AS received, r.completed_at IS NOT NULL AS completed,
          GREATEST(r.approved_at, r.received_at, r.completed_at) <= r.updated_at AS stamped_first,
          r.id NOT IN (SELECT id FROM "snap_orders_returnrequest") AS made
     FROM orders_returnrequest r JOIN orders_order o ON o.id = r.order_id
     LEFT JOIN accounts_user q ON q.id = r.requested_by_id
     LEFT JOIN accounts_user a ON a.id = r.approved_by_id
    WHERE ${CHANGED('r', 'orders_returnrequest')}
    ORDER BY r.number`,
  // Their lines: a decision made on receiving leaves the line's `updated_at` alone.
  `SELECT r.number, i.sku, l.quantity, l.restock_decision, l.condition_note,
          l.refund_amount::text,
          l.updated_at > (SELECT s.updated_at FROM "snap_orders_returnitem" s WHERE s.id = l.id)
            AS touched
     FROM orders_returnitem l JOIN orders_returnrequest r ON r.id = l.return_request_id
     JOIN orders_orderitem i ON i.id = l.order_item_id
    WHERE ${CHANGED('l', 'orders_returnitem')}
    ORDER BY r.number, i.created_at, i.id`,
];

export async function resetReturns(client: pg.Client): Promise<void> {
  await restoreTables(client, RETURN_TABLES);
  await restoreSequences(client);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MARKER = 'Parity return me';
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function returnsCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const rows = async <T extends pg.QueryResultRow>(sql: string) => (await db.query<T>(sql)).rows;

  // Sales by their note, each with its lines oldest first.
  const sales = new Map<string, { id: string; items: string[] }>();
  for (const row of await rows<{ note: string; id: string; items: string[] }>(
    `SELECT o.customer_note AS note, o.id,
            ARRAY(SELECT i.id::text FROM orders_orderitem i WHERE i.order_id = o.id
                   ORDER BY i.created_at) AS items
       FROM orders_order o WHERE o.customer_note LIKE 'Parity%'`,
  ))
    sales.set(row.note, { id: row.id, items: row.items });
  // Returns by their order's note; the second return of "twice" by its comment.
  const returns = new Map<string, { id: string; items: string[] }>();
  for (const row of await rows<{ key: string; id: string; items: string[] }>(
    `SELECT CASE WHEN r.customer_comment = 'second' THEN 'second'
                 ELSE replace(o.customer_note, 'Parity return ', '') END AS key, r.id,
            ARRAY(SELECT l.id::text FROM orders_returnitem l
                    JOIN orders_orderitem i ON i.id = l.order_item_id
                   WHERE l.return_request_id = r.id ORDER BY i.created_at) AS items
       FROM orders_returnrequest r JOIN orders_order o ON o.id = r.order_id
      WHERE o.customer_note LIKE 'Parity return %'`,
  ))
    returns.set(row.key, { id: row.id, items: row.items });
  // The demo seed's online orders, by number: dispatched and inside the return
  // window, dispatched long ago, and not dispatched at all.
  const online = new Map<string, { id: string; items: string[]; status: string }>();
  for (const row of await rows<{ number: string; status: string; id: string; items: string[] }>(
    `SELECT o.number, o.status, o.id,
            ARRAY(SELECT i.id::text FROM orders_orderitem i WHERE i.order_id = o.id
                   ORDER BY i.created_at) AS items
       FROM orders_order o
      WHERE o.number IN ('RGN-WEB-000015', 'RGN-WEB-000010', 'RGN-WEB-000013', 'RGN-WEB-000014',
                         'RGN-WEB-000005', 'RGN-WEB-000009', 'RGN-PARITY-0001', 'RGN-PARITY-0004')
         OR o.id IN (SELECT DISTINCT ON (x.status) x.id FROM orders_order x
                      WHERE x.channel = 'ONLINE' AND x.status IN ('PENDING', 'CONFIRMED', 'PROCESSING')
                        AND EXISTS (SELECT 1 FROM orders_orderitem i WHERE i.order_id = x.id)
                      ORDER BY x.status, x.number)
      ORDER BY o.number`,
  ))
    online.set(row.number, { id: row.id, items: row.items, status: row.status });
  const voided = (
    await rows<{ id: string; items: string[] }>(
      `SELECT o.id, ARRAY(SELECT i.id::text FROM orders_orderitem i WHERE i.order_id = o.id) AS items
         FROM orders_order o WHERE o.channel = 'POS' AND o.status = 'CANCELLED' ORDER BY o.number LIMIT 1`,
    )
  )[0];
  const account = new Map(
    (await rows<{ name: string; id: string }>(`SELECT name, id FROM finance_account`)).map(
      (row) => [row.name, row.id],
    ),
  );
  const everyId = (
    await rows<{ id: string }>(
      `SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM orders_orderitem
       UNION ALL SELECT id::text FROM orders_returnrequest UNION ALL SELECT id::text FROM orders_returnitem
       UNION ALL SELECT id::text FROM finance_account`,
    )
  ).map((row) => row.id);

  const me = sales.get('Parity return me');
  const need = ['open', 'approved', 'received', 'done', 'rejected', 'twice', 'second', 'mirpur'];
  if (!me || need.some((key) => !returns.has(key)) || !voided) {
    await db.end();
    console.log('SKIP  returns: fixture_returns.py has not been applied');
    return [];
  }
  const sale = (note: string) => sales.get(note) as { id: string; items: string[] };
  const ret = (key: string) => returns.get(key) as { id: string; items: string[] };
  const thirds = sale('Parity return thirds');
  const carded = sale('Parity return card');
  const doneKey = `return:${ret('done').id}`;

  // Kept open: a case's `prepare` changes rows after the reset, before its request.
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  // A return's lines by the order line each is for: their own order is not stated (D161).
  const blank = (body: unknown) => {
    const payload = body as { items?: { order_item: string }[] } | null;
    if (payload && Array.isArray(payload.items))
      payload.items.sort((a, b) => (a.order_item < b.order_item ? -1 : 1));
    minted(body);
  };
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `returns: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `returns: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetReturns,
      effects: RETURN_EFFECTS,
      jobs: true,
      normalize: blank,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];

  // === Reading ===============================================================================
  const LIST = '/api/v1/returns/';
  for (const who of everyone) {
    read(`[${who}] list`, LIST, who);
    read(`[${who}] read one`, `${LIST}${ret('open').id}/`, who);
  }
  for (const query of [
    'status=REQUESTED',
    'status=APPROVED',
    'status=RECEIVED',
    'status=COMPLETED',
    'status=REJECTED',
    'status=',
    'status=requested',
    'status=NOPE',
    'reason=WRONG_SIZE',
    'reason=DEFECTIVE&status=APPROVED',
    'reason=nope',
    `order=${sale('Parity return twice').id}`,
    `order=${me.id}`,
    `order=${MISSING}`,
    'order=abc',
    'order=',
    'status=NOPE&reason=x&order=y',
    'customer_name=Walk-in',
    'page_size=3',
    'page_size=3&page=2',
    'page_size=3&page=4',
    'page_size=3&page=5',
    'page=last&page_size=4',
    'page=0',
    'page=abc',
    'page_size=0',
    'page_size=1000',
    ...[
      'id',
      'number',
      'order',
      'order__number',
      'order__customer__name',
      'status',
      'reason',
      'customer_comment',
      'staff_comment',
      'refund_amount',
      'refund_shipping',
      'items',
      'created_at',
      'approved_at',
      'received_at',
      'completed_at',
    ].flatMap((term) => [`ordering=${term},number`, `ordering=-${term},-number`]),
    'ordering=items',
    'ordering=-items',
    'ordering=items&page_size=2',
    'ordering=items&page_size=2&page=2',
    'ordering=items&status=APPROVED',
    'ordering=order_number',
    'ordering=customer_name,-number',
    'ordering=nope',
    'ordering=',
    'ordering=status,,-number',
    'ordering=%20number%20',
    'search=RET-000004',
  ]) {
    read(`list ?${query}`, `${LIST}?${query}`);
  }
  read('list, a manager sees only their branch', `${LIST}?ordering=number`, 'manager');
  read('list, the other branch’s manager', `${LIST}?ordering=number`, 'mirpur');
  read('list, an admin sees every branch', `${LIST}?ordering=number`, 'admin');
  read('list, ordered by lines, by a branch manager', `${LIST}?ordering=-items`, 'manager');
  for (const key of need) read(`read the ${key} return`, `${LIST}${ret(key).id}/`);
  read(
    'read another branch’s return, by a branch manager',
    `${LIST}${ret('mirpur').id}/`,
    'manager',
  );
  read('read a return at their own branch', `${LIST}${ret('mirpur').id}/`, 'mirpur');
  read(
    'read the home branch’s return, by the other manager',
    `${LIST}${ret('open').id}/`,
    'mirpur',
  );
  read('read a return that is not there', `${LIST}${MISSING}/`);
  read('read a return that is not a uuid', `${LIST}abc/`);
  read('read a return by its number', `${LIST}RET-000004/`);
  read('read, filtered to its own status', `${LIST}${ret('approved').id}/?status=APPROVED`);
  read('read, filtered to another status', `${LIST}${ret('approved').id}/?status=REQUESTED`);
  read('read, with a filter that is not a status', `${LIST}${ret('approved').id}/?status=NOPE`);
  read('read, ordered by lines', `${LIST}${ret('approved').id}/?ordering=items`);
  read('read, no trailing slash', `${LIST}${ret('approved').id}`);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    read(`${method} a return`, `${LIST}${ret('open').id}/`, 'owner', { method });
    read(`${method} the list`, LIST, 'owner', { method });
  }
  for (const action of ['approve', 'reject', 'receive', 'complete']) {
    read(`GET ${action}`, `${LIST}${ret('open').id}/${action}/`);
    read(`[cashier] GET ${action}`, `${LIST}${ret('open').id}/${action}/`, 'cashier');
  }
  read('GET the counter return', '/api/v1/pos/returns/');

  // === Opening a return ======================================================================
  const line = (item: string, quantity: unknown = 1, extra: Record<string, unknown> = {}) => ({
    order_item: item,
    quantity,
    ...extra,
  });
  const ask = (order: unknown, lines: unknown, extra: Record<string, unknown> = {}) => ({
    order,
    reason: 'WRONG_SIZE',
    lines,
    ...extra,
  });
  const oneShirt = ask(me.id, [line(me.items[0] as string)]);
  const everything = [line(me.items[0] as string, 2), line(me.items[1] as string, 1)];
  const old = (note: string, column = 'delivered_at', age = "interval '15 days'") =>
    after(`UPDATE orders_order SET ${column} = now() - (${age}) WHERE customer_note = '${note}'`);

  for (const [route, path] of [
    ['open', LIST],
    ['counter', '/api/v1/pos/returns/'],
  ] as const) {
    const post = (name: string, body: unknown, who: Who = 'manager', extra: Partial<Case> = {}) =>
      write(`${route}: ${name}`, path, body, who, extra);

    for (const who of everyone) post(`[${who}] one shirt`, oneShirt, who);

    // --- What is returned -------------------------------------------------------------------
    post('both shirts', ask(me.id, [line(me.items[0] as string, 2)]));
    post('the tee', ask(me.id, [line(me.items[1] as string)]));
    post('every line', ask(me.id, everything));
    post('every line, the tee first', ask(me.id, [...everything].reverse()));
    post(
      'every line, one written off and one quarantined',
      ask(me.id, [
        line(me.items[0] as string, 2, { restock_decision: 'DAMAGED' }),
        line(me.items[1] as string, 1, { restock_decision: 'QUARANTINE' }),
      ]),
    );
    post(
      'a line to restock, said so',
      ask(me.id, [line(me.items[0] as string, 1, { restock_decision: 'RESTOCK' })]),
    );
    for (const reason of [
      'DEFECTIVE',
      'WRONG_PRODUCT',
      'CUSTOMER_CHANGED_MIND',
      'DAMAGED',
      'OTHER',
    ])
      post(`reason ${reason}`, ask(me.id, everything, { reason }));
    post(
      'three lines of one SKU, all back',
      ask(
        thirds.id,
        thirds.items.map((item) => line(item)),
      ),
    );
    post(
      'three lines of one SKU, two back',
      ask(
        thirds.id,
        thirds.items.slice(0, 2).map((item) => line(item)),
      ),
    );
    post(
      'three lines of one SKU, the last back',
      ask(thirds.id, [line(thirds.items[2] as string)]),
    );
    post('a sale paid by card', ask(carded.id, [line(carded.items[0] as string)]));
    post(
      'with a comment',
      ask(me.id, everything, { customer_comment: 'Seam split after one wash' }),
    );
    post('with a blank comment', ask(me.id, everything, { customer_comment: '' }));
    post(
      'with a comment in Bengali',
      ask(me.id, everything, { customer_comment: 'সেলাই খুলে গেছে' }),
    );
    post('with a long comment', ask(me.id, everything, { customer_comment: 'c'.repeat(3000) }));
    post('with a comment that is a number', ask(me.id, everything, { customer_comment: 5 }));
    post('with a null comment', ask(me.id, everything, { customer_comment: null }));
    post('with a NUL in the comment', ask(me.id, everything, { customer_comment: 'a\u0000b' }));
    post(
      'with fields it does not know',
      ask(me.id, everything, { status: 'COMPLETED', refund_amount: '1' }),
    );

    // --- The order ---------------------------------------------------------------------------
    post(
      'the second shirt of a sale with a return open',
      ask(sale('Parity return open').id, [line(sale('Parity return open').items[0] as string)]),
    );
    post(
      'both shirts of a sale with one already asked for',
      ask(sale('Parity return open').id, [line(sale('Parity return open').items[0] as string, 2)]),
    );
    post(
      'a unit already back',
      ask(sale('Parity return twice').id, [line(sale('Parity return twice').items[0] as string)]),
    );
    post(
      'a unit of a sale partly back',
      ask(sale('Parity return received').id, [
        line(sale('Parity return received').items[0] as string),
      ]),
    );
    post(
      'a sale whose return was rejected',
      ask(sale('Parity return rejected').id, [
        line(sale('Parity return rejected').items[0] as string),
      ]),
    );
    post(
      'a sale refunded in full',
      ask(sale('Parity return done').id, [line(sale('Parity return done').items[0] as string)]),
    );
    post('a voided sale', ask(voided.id, [line(voided.items[0] as string)]));
    post(
      'a sale that came to nothing',
      ask(sale('Parity void free').id, [line(sale('Parity void free').items[0] as string)]),
    );
    post(
      'a sale at another branch, by a manager bound elsewhere',
      ask(sale('Parity return mirpur').id, [line(sale('Parity return mirpur').items[0] as string)]),
    );
    post('a sale at the home branch, by the other branch’s manager', oneShirt, 'mirpur');
    for (const [number, order] of online) {
      const lines = [line(order.items[0] as string)];
      post(
        `online ${number}, ${order.status}, damaged`,
        ask(order.id, lines, { reason: 'DAMAGED' }),
      );
      post(`online ${number}, ${order.status}, the wrong size`, ask(order.id, lines));
      post(`[admin] online ${number}, ${order.status}`, ask(order.id, lines), 'admin');
    }
    post('an order that is not there', ask(MISSING, [line(me.items[0] as string)]));
    post('an order that is not there, and no lines', ask(MISSING, []));

    // --- The window --------------------------------------------------------------------------
    for (const who of ['manager', 'admin', 'owner', 'super'] as Who[])
      post(`[${who}] delivered fifteen days ago`, oneShirt, who, { prepare: old(MARKER) });
    post('delivered a second inside the window', oneShirt, 'manager', {
      prepare: old(MARKER, 'delivered_at', "interval '14 days' - interval '5 seconds'"),
    });
    post('delivered a second outside the window', oneShirt, 'manager', {
      prepare: old(MARKER, 'delivered_at', "interval '14 days' + interval '5 seconds'"),
    });
    post('never delivered, placed fifteen days ago', oneShirt, 'manager', {
      prepare: after(
        `UPDATE orders_order SET delivered_at = NULL, placed_at = now() - interval '15 days'
          WHERE customer_note = '${MARKER}'`,
      ),
    });
    post('placed long ago, delivered yesterday', oneShirt, 'manager', {
      prepare: after(
        `UPDATE orders_order SET delivered_at = now() - interval '1 day',
                placed_at = now() - interval '60 days' WHERE customer_note = '${MARKER}'`,
      ),
    });

    // --- Final sale --------------------------------------------------------------------------
    const final = {
      setup: [
        `UPDATE catalog_product SET is_final_sale = true
          WHERE id = (SELECT product_id FROM catalog_productvariant WHERE sku = 'RGN-ESS-L-WHI')`,
      ],
      teardown: [
        `UPDATE catalog_product SET is_final_sale = false
          WHERE id = (SELECT product_id FROM catalog_productvariant WHERE sku = 'RGN-ESS-L-WHI')`,
      ],
    };
    post('a final-sale tee', ask(me.id, [line(me.items[1] as string)]), 'manager', final);
    post('a shirt and a final-sale tee', ask(me.id, everything), 'manager', final);
    post('a shirt, the sale’s tee final-sale', oneShirt, 'manager', final);

    // --- What comes back ---------------------------------------------------------------------
    post('every line, the VAT inside the price', ask(me.id, everything), 'manager', {
      prepare: after(
        `UPDATE orders_orderitem SET tax_amount = 150.00 WHERE order_id = '${me.id}'`,
        `UPDATE orders_order SET tax_mode = 'INCLUSIVE' WHERE id = '${me.id}'`,
      ),
    });
    post('every line, the VAT on top', ask(me.id, everything), 'manager', {
      prepare: after(`UPDATE orders_orderitem SET tax_amount = 150.00 WHERE order_id = '${me.id}'`),
    });
    post('every line, most of it refunded already', ask(me.id, everything), 'manager', {
      prepare: after(
        `UPDATE orders_order SET refunded_total = paid_total - 100 WHERE id = '${me.id}'`,
      ),
    });
    post(
      'every line, a shop fault, shipping charged',
      ask(me.id, everything, { reason: 'DEFECTIVE' }),
      'manager',
      {
        prepare: after(
          `UPDATE orders_order SET shipping_total = 70.00, grand_total = grand_total + 70,
                paid_total = paid_total + 70 WHERE id = '${me.id}'`,
        ),
      },
    );
    post('one shirt, the customer’s choice, shipping charged', oneShirt, 'manager', {
      prepare: after(
        `UPDATE orders_order SET shipping_total = 70.00, grand_total = grand_total + 70,
                paid_total = paid_total + 70 WHERE id = '${me.id}'`,
      ),
    });
    post('one shirt, a discount that does not divide', oneShirt, 'manager', {
      prepare: after(`UPDATE orders_order SET discount_total = 33.33 WHERE id = '${me.id}'`),
    });
    post('one shirt, a subtotal of nothing', oneShirt, 'manager', {
      prepare: after(`UPDATE orders_order SET subtotal = 0 WHERE id = '${me.id}'`),
    });

    // --- A body that will not do ---------------------------------------------------------------
    for (const [name, body] of [
      ['no body', undefined],
      ['an empty object', {}],
      ['a list', [oneShirt]],
      ['null', 'null'],
      ['a string', '"x"'],
      ['broken JSON', '{"order":'],
      ['no order', { reason: 'OTHER', lines: [line(me.items[0] as string)] }],
      ['an order that is not a uuid', ask('abc', [line(me.items[0] as string)])],
      ['an order that is a number', ask(5, [line(me.items[0] as string)])],
      ['a null order', ask(null, [line(me.items[0] as string)])],
      ['an order id in capitals', ask(me.id.toUpperCase(), [line(me.items[0] as string)])],
      [
        'an order id without hyphens',
        ask(me.id.replaceAll('-', ''), [line(me.items[0] as string)]),
      ],
      ['no reason', { order: me.id, lines: [line(me.items[0] as string)] }],
      ['a reason it does not know', ask(me.id, everything, { reason: 'CHANGED_MIND' })],
      ['a blank reason', ask(me.id, everything, { reason: '' })],
      ['a null reason', ask(me.id, everything, { reason: null })],
      ['a reason in lower case', ask(me.id, everything, { reason: 'other' })],
      ['no lines', { order: me.id, reason: 'OTHER' }],
      ['lines that are empty', ask(me.id, [])],
      ['lines that are null', ask(me.id, null)],
      ['lines that are an object', ask(me.id, { 0: line(me.items[0] as string) })],
      ['lines that are a string', ask(me.id, 'all')],
      ['a line that is null', ask(me.id, [null])],
      ['a line that is a string', ask(me.id, ['x'])],
      ['a line that is empty', ask(me.id, [{}])],
      ['a line that is not on the order', ask(me.id, [line(thirds.items[0] as string)])],
      ['a line that is not there', ask(me.id, [line(MISSING)])],
      ['a line that is not a uuid', ask(me.id, [line('abc')])],
      ['a line id in capitals', ask(me.id, [line((me.items[0] as string).toUpperCase())])],
      [
        'the same line twice',
        ask(me.id, [line(me.items[0] as string), line(me.items[0] as string)]),
      ],
      [
        'the same line twice, then one not on the order',
        ask(me.id, [line(me.items[0] as string), line(me.items[0] as string), line(MISSING)]),
      ],
      ['more than was bought', ask(me.id, [line(me.items[0] as string, 3)])],
      [
        'more than was bought, on the second line',
        ask(me.id, [line(me.items[0] as string, 2), line(me.items[1] as string, 2)]),
      ],
      ['a quantity of nothing', ask(me.id, [line(me.items[0] as string, 0)])],
      ['a quantity below nothing', ask(me.id, [line(me.items[0] as string, -1)])],
      ['a quantity as text', ask(me.id, [line(me.items[0] as string, '2')])],
      [
        'a quantity of 2.0',
        '{"order":"' +
          me.id +
          '","reason":"OTHER","lines":[{"order_item":"' +
          me.items[0] +
          '","quantity":2.0}]}',
      ],
      ['a quantity of 1.5', ask(me.id, [line(me.items[0] as string, 1.5)])],
      ['a quantity of true', ask(me.id, [line(me.items[0] as string, true)])],
      ['a null quantity', ask(me.id, [line(me.items[0] as string, null)])],
      ['no quantity', ask(me.id, [{ order_item: me.items[0] }])],
      [
        'a quantity past a 64-bit integer',
        '{"order":"' +
          me.id +
          '","reason":"OTHER","lines":[{"order_item":"' +
          me.items[0] +
          '","quantity":1000000000000000000000000000000}]}',
      ],
      [
        'a restock decision it does not know',
        ask(me.id, [line(me.items[0] as string, 1, { restock_decision: 'BIN' })]),
      ],
      [
        'a blank restock decision',
        ask(me.id, [line(me.items[0] as string, 1, { restock_decision: '' })]),
      ],
      [
        'a null restock decision',
        ask(me.id, [line(me.items[0] as string, 1, { restock_decision: null })]),
      ],
      [
        'everything wrong at once',
        {
          order: 'x',
          reason: 'X',
          lines: [{ order_item: 'x', quantity: 0, restock_decision: 'NO' }, null],
          customer_comment: null,
        },
      ],
    ] as [string, unknown][]) {
      post(name, body);
    }
    post('a form body', `order=${me.id}&reason=OTHER`, 'manager', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }
  write('open: a return, with an Idempotency-Key', LIST, oneShirt, 'manager', {
    headers: { 'idempotency-key': 'parity-return-key' },
  });

  // === The counter's refund method ==============================================================
  const COUNTER = '/api/v1/pos/returns/';
  const counter = (name: string, body: unknown, who: Who = 'manager', extra: Partial<Case> = {}) =>
    write(`counter: ${name}`, COUNTER, body, who, extra);
  for (const [name, method] of [
    ['CASH', 'CASH'],
    ['CARD', 'CARD'],
    ['MOBILE_MFS', 'MOBILE_MFS'],
    ['BANK', 'BANK'],
    ['COD', 'COD'],
    ['STORE_CREDIT', 'STORE_CREDIT'],
    ['OTHER', 'OTHER'],
    ['one the ledger does not know', 'BITCOIN'],
    ['in lower case', 'cash'],
    ['blank', ''],
    ['null', null],
    ['zero', 0],
    ['a number', 5],
    ['true', true],
    ['false', false],
    ['a list', ['CASH']],
    ['an empty list', []],
    ['an object', { a: 1 }],
    ['an empty object', {}],
    ['of 20 characters', 'x'.repeat(20)],
    ['of 21 characters', 'x'.repeat(21)],
    ['with a NUL', 'CA\u0000SH'],
  ] as [string, unknown][]) {
    counter(`refunded by ${name}`, ask(me.id, everything, { refund_method: method }));
  }
  counter(
    'refunded by a float',
    '{"order":"' +
      me.id +
      '","reason":"OTHER","lines":[{"order_item":"' +
      me.items[1] +
      '","quantity":1}],"refund_method":1.50}',
  );
  counter(
    'a card sale, refunded in cash by default',
    ask(carded.id, [line(carded.items[0] as string)]),
  );
  counter(
    'a card sale, refunded to the card',
    ask(carded.id, [line(carded.items[0] as string)], { refund_method: 'CARD' }),
  );
  counter(
    'a card sale, refunded by bKash',
    ask(carded.id, [line(carded.items[0] as string)], { refund_method: 'MOBILE_MFS' }),
  );
  const short = after(
    `UPDATE finance_account SET balance = 100.00 WHERE name = 'Counter Cash Drawer'`,
  );
  counter('every line, the drawer short of the refund', ask(me.id, everything), 'manager', {
    prepare: short,
  });
  counter(
    'every line, the drawer short but allowed to go overdrawn',
    ask(me.id, everything),
    'manager',
    {
      prepare: after(
        `UPDATE finance_account SET balance = 100.00, allow_overdraft = true WHERE name = 'Counter Cash Drawer'`,
      ),
    },
  );
  counter('every line, the drawer since closed', ask(me.id, everything), 'manager', {
    prepare: after(
      `UPDATE finance_account SET is_active = false WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  counter('every line, nothing left to refund', ask(me.id, everything), 'manager', {
    prepare: after(`UPDATE orders_order SET refunded_total = paid_total WHERE id = '${me.id}'`),
  });
  counter('every line, the shelf since counted away', ask(me.id, everything), 'manager', {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = 0
        WHERE variant_id IN (SELECT id FROM catalog_productvariant WHERE sku IN ('RGN-ESS-L-WHI', 'RGN-CLA-M-NAV'))
          AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`,
    ),
  });
  counter('a body that is a list, with a refund method', [{ refund_method: 'CASH' }]);

  // === Approve and reject =====================================================================
  const act = (key: string, action: string) => `${LIST}${ret(key).id}/${action}/`;
  const COMMENTS: [string, unknown][] = [
    ['no comment', {}],
    ['a comment', { comment: 'Bring it to the counter' }],
    ['a blank comment', { comment: '' }],
    ['a comment in Bengali', { comment: 'কাউন্টারে নিয়ে আসুন' }],
    ['a comment of 300 characters', { comment: 'c'.repeat(300) }],
    ['a comment of 5000 characters', { comment: 'c'.repeat(5000) }],
    ['a comment that is a number', { comment: 5 }],
    ['a comment that is a float', '{"comment":1.50}'],
    ['a comment that is true', { comment: true }],
    ['a comment that is a list', { comment: ['a', 1, null, true, { k: "it's" }] }],
    ['a comment that is an object', { comment: { a: 1 } }],
    ['a null comment', { comment: null }],
    ['a comment with a NUL', { comment: 'a\u0000b' }],
    ['a comment with half an emoji', '{"comment":"a\\ud83db"}'],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['a body that is a string', '"x"'],
    ['broken JSON', '{"comment":'],
    ['no body', undefined],
  ];
  for (const action of ['approve', 'reject']) {
    for (const who of everyone) write(`[${who}] ${action}`, act('open', action), {}, who);
    for (const key of need)
      write(`${action} the ${key} return`, act(key, action), { comment: 'Seen' }, 'owner');
    for (const [name, body] of COMMENTS) write(`${action}: ${name}`, act('open', action), body);
    write(`${action} another branch’s return, by a branch manager`, act('mirpur', action), {});
    write(`${action} a return at their own branch`, act('mirpur', action), {}, 'mirpur');
    write(`${action} a return that is not there`, `${LIST}${MISSING}/${action}/`, {});
    write(
      `${action} a return that is not there, with broken JSON`,
      `${LIST}${MISSING}/${action}/`,
      '{"comment":',
    );
    write(`${action} a return that is not a uuid`, `${LIST}abc/${action}/`, {});
    write(`${action}, filtered to another status`, `${act('open', action)}?status=APPROVED`, {});
    write(
      `${action}, with a filter that is not a status`,
      `${act('open', action)}?status=NOPE`,
      {},
    );
    write(`${action}: a form body`, act('open', action), 'comment=From+a+form', 'manager', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }
  write(
    'reject the approved return, its order already delivered again',
    act('approved', 'reject'),
    {},
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET status = 'DELIVERED' WHERE customer_note = 'Parity return approved'`,
      ),
    },
  );

  // === Receive ================================================================================
  const approved = ret('approved');
  const [shirtLine, teeLine] = approved.items as [string, string];
  for (const who of everyone) write(`[${who}] receive`, act('approved', 'receive'), {}, who);
  for (const key of need) write(`receive the ${key} return`, act(key, 'receive'), {}, 'owner');
  for (const [name, body] of [
    ['no decisions', {}],
    ['an empty list of decisions', { items: [] }],
    ['the tee restocked after all', { items: [{ id: teeLine, restock_decision: 'RESTOCK' }] }],
    [
      'the shirt quarantined, with a note',
      {
        items: [
          { id: shirtLine, restock_decision: 'QUARANTINE', condition_note: 'Smells of smoke' },
        ],
      },
    ],
    [
      'both written off',
      {
        items: [
          { id: teeLine, restock_decision: 'DAMAGED', condition_note: 'Torn' },
          { id: shirtLine, restock_decision: 'DAMAGED' },
        ],
      },
    ],
    [
      'both restocked, the shirt named first',
      {
        items: [
          { id: shirtLine, restock_decision: 'RESTOCK' },
          { id: teeLine, restock_decision: 'RESTOCK' },
        ],
      },
    ],
    ['a note and no decision', { items: [{ id: teeLine, condition_note: 'Box crushed' }] }],
    ['a line named and nothing said', { items: [{ id: teeLine }] }],
    ['a blank note', { items: [{ id: teeLine, condition_note: '' }] }],
    ['a note of 255 characters', { items: [{ id: teeLine, condition_note: 'n'.repeat(255) }] }],
    ['a note of 256 characters', { items: [{ id: teeLine, condition_note: 'n'.repeat(256) }] }],
    ['a note with spaces around it', { items: [{ id: teeLine, condition_note: '  dented  ' }] }],
    ['a null note', { items: [{ id: teeLine, condition_note: null }] }],
    ['a note that is a number', { items: [{ id: teeLine, condition_note: 7 }] }],
    [
      'a line named twice',
      { items: [{ id: teeLine }, { id: teeLine, restock_decision: 'RESTOCK' }] },
    ],
    [
      'a line named twice, once in capitals',
      { items: [{ id: teeLine }, { id: teeLine.toUpperCase() }] },
    ],
    [
      'a line that is not on this return',
      { items: [{ id: ret('open').items[0], restock_decision: 'DAMAGED' }] },
    ],
    [
      'two lines that are nowhere',
      {
        items: [
          { id: '00000000-0000-4000-8000-000000000002' },
          { id: '00000000-0000-4000-8000-000000000001' },
        ],
      },
    ],
    [
      'a known line and an unknown one',
      { items: [{ id: teeLine, restock_decision: 'RESTOCK' }, { id: MISSING }] },
    ],
    ['a line with no id', { items: [{ restock_decision: 'DAMAGED' }] }],
    ['a line id that is not a uuid', { items: [{ id: 'abc' }] }],
    ['a decision it does not know', { items: [{ id: teeLine, restock_decision: 'BIN' }] }],
    ['a blank decision', { items: [{ id: teeLine, restock_decision: '' }] }],
    ['a null decision', { items: [{ id: teeLine, restock_decision: null }] }],
    ['items that are null', { items: null }],
    ['items that are an object', { items: { id: teeLine } }],
    ['an item that is null', { items: [null] }],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"items":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`receive: ${name}`, act('approved', 'receive'), body);
  }
  write('receive another branch’s return, by a branch manager', act('mirpur', 'receive'), {});
  write('receive a return that is not there', `${LIST}${MISSING}/receive/`, {});
  write('receive a return that is not there, with a bad body', `${LIST}${MISSING}/receive/`, {
    items: [{ id: 'abc' }],
  });
  write(
    'receive a return that is not there, with broken JSON',
    `${LIST}${MISSING}/receive/`,
    '{"items":',
  );
  write(
    'receive, filtered to another status',
    `${act('approved', 'receive')}?status=REQUESTED`,
    {},
  );
  write('receive the open return, with a decision', act('open', 'receive'), {
    items: [{ id: ret('open').items[0], restock_decision: 'DAMAGED' }],
  });
  write('receive, the shelf since counted away', act('approved', 'receive'), {}, 'manager', {
    prepare: after(
      `UPDATE inventory_inventory SET on_hand = 0
        WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-M-NAV')
          AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`,
    ),
  });
  write('receive, the shelf row gone', act('approved', 'receive'), {}, 'manager', {
    prepare: after(
      `DELETE FROM inventory_inventory
        WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-M-NAV')
          AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`,
    ),
  });

  // === Complete ===============================================================================
  const drawer = account.get('Counter Cash Drawer');
  const bank = account.get('City Bank Current');
  for (const who of everyone) write(`[${who}] complete`, act('received', 'complete'), {}, who);
  for (const key of need) write(`complete the ${key} return`, act(key, 'complete'), {}, 'owner');
  for (const [name, body] of [
    ['as asked', {}],
    ['a smaller amount', { refund_amount: '100.00' }],
    ['the smallest amount', { refund_amount: '0.01' }],
    ['an amount as a number', { refund_amount: 100 }],
    ['an amount with one place', { refund_amount: '100.5' }],
    ['an amount with three places', { refund_amount: '100.005' }],
    ['an amount of nothing', { refund_amount: '0' }],
    ['an amount below nothing', { refund_amount: '-5' }],
    ['a null amount', { refund_amount: null }],
    ['a blank amount', { refund_amount: '' }],
    ['an amount that is not a number', { refund_amount: 'lots' }],
    ['all that was paid', { refund_amount: '1780.00' }],
    ['a paisa more than was paid', { refund_amount: '1780.01' }],
    ['an amount of fifteen digits', { refund_amount: '1234567890123.45' }],
    ['by CASH', { refund_method: 'CASH' }],
    ['by CARD', { refund_method: 'CARD' }],
    ['by MOBILE_MFS', { refund_method: 'MOBILE_MFS' }],
    ['by BANK', { refund_method: 'BANK' }],
    ['by ONLINE_GATEWAY', { refund_method: 'ONLINE_GATEWAY' }],
    ['by COD', { refund_method: 'COD' }],
    ['by STORE_CREDIT', { refund_method: 'STORE_CREDIT' }],
    ['by OTHER', { refund_method: 'OTHER' }],
    ['by a blank method', { refund_method: '' }],
    ['by a null method', { refund_method: null }],
    ['by a method it does not know', { refund_method: 'BITCOIN' }],
    ['by a method in lower case', { refund_method: 'cash' }],
    ['out of the drawer', { account: drawer }],
    ['out of the bank, in cash', { account: bank }],
    ['out of the bank, to the card', { account: bank, refund_method: 'CARD' }],
    ['out of the drawer, to the card', { account: drawer, refund_method: 'CARD' }],
    [
      'out of a closed account',
      { account: account.get('Parity Closed Bank'), refund_method: 'BANK' },
    ],
    ['out of another branch’s till', { account: account.get('Parity Mirpur Till') }],
    ['out of a null account', { account: null }],
    ['out of a blank account', { account: '' }],
    ['out of an account that is not there', { account: MISSING }],
    ['out of an account that is not a uuid', { account: 'abc' }],
    ['out of an account that is a number', { account: 5 }],
    ['everything wrong at once', { refund_amount: '0', refund_method: 'BITCOIN', account: 'x' }],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"refund_amount":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`complete: ${name}`, act('received', 'complete'), body);
  }
  for (const [name, key] of [
    ['a key of its own', 'parity-complete-1'],
    ['an empty key', ''],
    ['the key of another return’s refund', doneKey],
    ['a key of 64 characters', 'k'.repeat(64)],
    ['a key of 65 characters', 'k'.repeat(65)],
  ] as [string, string][]) {
    write(`complete: with ${name}`, act('received', 'complete'), {}, 'manager', {
      headers: { 'idempotency-key': key },
    });
  }
  write('complete the completed return, with another amount', act('done', 'complete'), {
    refund_amount: '5.00',
  });
  write('complete the completed return, with a bad body', act('done', 'complete'), {
    refund_amount: '0',
  });
  write('complete another branch’s return, by a branch manager', act('mirpur', 'complete'), {});
  write('complete a return that is not there', `${LIST}${MISSING}/complete/`, {});
  write('complete a return that is not there, with a bad body', `${LIST}${MISSING}/complete/`, {
    refund_amount: '0',
  });
  write(
    'complete, filtered to another status',
    `${act('received', 'complete')}?status=APPROVED`,
    {},
  );
  write('complete, the drawer short of the refund', act('received', 'complete'), {}, 'manager', {
    prepare: short,
  });
  write(
    'complete, the refund already paid by other means',
    act('received', 'complete'),
    {},
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET refunded_total = paid_total WHERE customer_note = 'Parity return received'`,
      ),
    },
  );
  write('complete, the return asking for nothing', act('received', 'complete'), {}, 'manager', {
    prepare: after(
      `UPDATE orders_returnrequest SET refund_amount = 0 WHERE id = '${ret('received').id}'`,
    ),
  });
  write('complete, the order since delivered again', act('received', 'complete'), {}, 'manager', {
    prepare: after(
      `UPDATE orders_order SET status = 'DELIVERED' WHERE customer_note = 'Parity return received'`,
    ),
  });
  write('complete, a line of the order not yet back', act('received', 'complete'), {}, 'manager', {
    prepare: after(
      `UPDATE orders_orderitem SET returned_quantity = 1
        WHERE order_id = (SELECT id FROM orders_order WHERE customer_note = 'Parity return received')`,
    ),
  });
  return cases;
}
