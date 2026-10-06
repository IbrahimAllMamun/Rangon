/**
 * Parity cases for the staff order screens (phase 5 part 6): `/orders/` --
 * the list, an order, its timeline, invoice and packing slip -- and what
 * staff do to one: move it along the status machine, cancel it, record a
 * payment, refund it. Each write is compared by the queries a sale and a
 * return are compared by: the order, its lines, payments and refunds, the
 * shelf and its ledger, coupons, the cash book, notices, the audit log.
 *
 * The orders come from fixture_staff_orders.py (S01 to S08), the returns
 * fixture's counter sales and the demo seed.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { resetReturns, RETURN_EFFECTS } from './returns-cases.ts';
import type { Case } from './run.ts';

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function staffOrdersCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const orders = await map(`SELECT number AS key, id FROM orders_order`);
  const notes = await map(
    `SELECT customer_note AS key, id FROM orders_order WHERE customer_note LIKE 'Parity%'`,
  );
  const account = await map(`SELECT name AS key, id FROM finance_account`);
  const branch = await map(`SELECT code AS key, id FROM accounts_branch`);
  const customer = await map(`SELECT email AS key, id FROM customers_customer WHERE email <> ''`);
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM orders_orderitem
       UNION ALL SELECT id::text FROM orders_payment UNION ALL SELECT id::text FROM orders_refund
       UNION ALL SELECT id::text FROM orders_orderevent UNION ALL SELECT id::text FROM accounts_branch
       UNION ALL SELECT id::text FROM customers_customer UNION ALL SELECT id::text FROM catalog_productvariant
       UNION ALL SELECT id::text FROM promotions_coupon UNION ALL SELECT id::text FROM finance_account`,
    )
  ).rows.map((row) => row.id);
  const doneKey = (
    await db.query<{ key: string }>(
      `SELECT f.idempotency_key AS key FROM orders_refund f JOIN orders_order o ON o.id = f.order_id
        WHERE o.customer_note = 'Parity return done'`,
    )
  ).rows[0]?.key;
  const S = (n: number) => orders.get(`RGN-PARITY-S0${n}`) as string;
  if (!S(1) || !S(8) || !notes.has('Parity return me') || !doneKey) {
    await db.end();
    console.log('SKIP  staff orders: fixture_staff_orders.py has not been applied');
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

  const cases: Case[] = [];
  const LIST = '/api/v1/orders/';
  const one = (id: string, action = '') => `${LIST}${id}/${action ? `${action}/` : ''}`;
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `orders: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `orders: ${name}`,
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
  const posSale = notes.get('Parity return me') as string;
  const voided = (
    await db.query<{ id: string }>(
      `SELECT id FROM orders_order WHERE channel = 'POS' AND status = 'CANCELLED' ORDER BY number LIMIT 1`,
    )
  ).rows[0]?.id as string;
  const returned = orders.get('RGN-PARITY-0004') as string;

  // === Reading ===============================================================================
  for (const who of everyone) {
    read(`[${who}] list`, `${LIST}?page_size=5`, who);
    read(`[${who}] read one`, one(S(1)), who);
    read(`[${who}] timeline`, one(S(1), 'timeline'), who);
    read(`[${who}] invoice`, one(S(1), 'invoice'), who);
    read(`[${who}] packing slip`, one(S(1), 'packing-slip'), who);
  }
  for (const query of [
    '',
    'page_size=3&page=2',
    'page=last&page_size=50',
    'page=999',
    'page_size=0',
    ...['POS', 'ONLINE', 'PHONE', 'SOCIAL', 'OTHER', 'pos', 'NOPE', ''].map((v) => `channel=${v}`),
    ...[
      'PENDING',
      'CONFIRMED',
      'PROCESSING',
      'PACKED',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'RETURN_REQUESTED',
      'RETURNED',
      'REFUNDED',
      'NOPE',
    ].map((v) => `status=${v}`),
    ...['UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'NOPE'].map(
      (v) => `payment_status=${v}`,
    ),
    `branch=${branch.get('DHK1')}`,
    `branch=${branch.get('PAR3')}`,
    `branch=${MISSING}`,
    'branch=abc',
    `customer=${customer.get('parity.customer@rangon.test')}`,
    `customer=${MISSING}`,
    'customer=abc',
    `channel=ONLINE&status=PENDING&payment_status=PAID`,
    'channel=NOPE&status=NOPE&payment_status=NOPE&branch=x&customer=y',
    'search=RGN-PARITY-S0',
    'search=rgn-parity-s0',
    'search=PARITY-S01',
    'search=Parvin',
    'search=parvin%20sultana',
    'search=017',
    'search=01711000078',
    'search=%2B8801711000078',
    'search=008801711',
    'search=880',
    'search=0',
    'search=00880',
    'search=1711',
    'search=%25',
    'search=_',
    'search=%5C',
    'search=RGN_',
    'search=%E0%A7%A7%E0%A7%AD',
    'search=nobody-at-all',
    'search=',
    'search=a%00b',
    'date_from=2026-10-01',
    'date_to=2026-09-01',
    'date_from=2026-09-01&date_to=2026-09-30',
    'date_from=2026-9-1',
    'date_from=20260901',
    'date_from=2026-W36-1',
    'date_from=2026-02-30',
    'date_from=2026-13-01',
    'date_from=abc',
    'date_to=abc',
    'date_from=abc&date_to=2026-02-30',
    'date_from=2026-09-01T00:00:00',
    'date_from=01/09/2026',
    'date_from=%E0%A7%A8%E0%A7%A6%E0%A7%A8%E0%A7%AC-09-01',
    'date_from=',
    'date_from=2026-09-01%0A',
    'date_from=abc&status=NOPE',
    'ordering=placed_at',
    'ordering=-placed_at',
    'ordering=grand_total,placed_at',
    'ordering=-grand_total,-placed_at',
    'ordering=number',
    'ordering=status,grand_total,placed_at',
    'ordering=',
    'search=Parity&status=DELIVERED&ordering=-grand_total,placed_at&page_size=4',
  ]) {
    read(`list ?${query}`, `${LIST}?${query}`);
  }
  read('list, a manager sees only their branch', `${LIST}?search=PARITY-S0`, 'manager');
  read('list, the other branch’s manager', `${LIST}?ordering=placed_at`, 'mirpur');
  read('list, an admin sees every branch', `${LIST}?search=PARITY-S0`, 'admin');
  read(
    'list, another branch asked for by a branch manager',
    `${LIST}?branch=${branch.get('PAR3')}`,
    'manager',
  );
  for (const view of ['', 'timeline', 'invoice', 'packing-slip']) {
    const label = view || 'read';
    for (let n = 1; n <= 8; n++) read(`${label} S0${n}`, one(S(n), view));
    read(`${label} a counter sale`, one(posSale, view));
    read(`${label} a voided sale`, one(voided, view));
    read(`${label} another branch’s order, by a branch manager`, one(S(6), view), 'manager');
    read(`${label} an order at their own branch`, one(S(6), view), 'mirpur');
    read(`${label} the home branch’s order, by the other manager`, one(S(1), view), 'mirpur');
    read(`${label} an order that is not there`, one(MISSING, view));
    read(`${label} an order that is not a uuid`, one('abc', view));
    read(`${label}, filtered to its own status`, `${one(S(1), view)}?status=CONFIRMED`);
    read(`${label}, filtered to another status`, `${one(S(1), view)}?status=PENDING`);
    read(`${label}, with a filter that is not a status`, `${one(S(1), view)}?status=NOPE`);
    read(`${label}, searched for by its number`, `${one(S(1), view)}?search=PARITY-S01`);
    read(`${label}, searched for by another`, `${one(S(1), view)}?search=PARITY-S02`);
    read(`${label}, with a date that is not one`, `${one(S(1), view)}?date_from=abc`);
    read(`${label}, placed before the date asked for`, `${one(S(1), view)}?date_from=2099-01-01`);
    read(`${label}, ordered`, `${one(S(1), view)}?ordering=-grand_total`);
  }
  read('read by its number', one('RGN-PARITY-S01'));
  read('read, no trailing slash', `${LIST}${S(1)}`);
  for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
    if (method !== 'POST') read(`${method} an order`, one(S(1)), 'owner', { method });
    read(`${method} the list`, LIST, 'owner', { method });
    read(`${method} a timeline`, one(S(1), 'timeline'), 'owner', { method });
  }
  for (const action of ['status', 'cancel', 'payments', 'refunds']) {
    read(`GET ${action}`, one(S(1), action));
    read(`[cashier] GET ${action}`, one(S(1), action), 'cashier');
    read(`[stock] GET ${action}`, one(S(1), action), 'stock');
  }

  // === Status ================================================================================
  const to = (status: unknown, extra: Record<string, unknown> = {}) => ({
    to_status: status,
    ...extra,
  });
  for (const who of everyone) {
    write(`[${who}] status: on to PROCESSING`, one(S(1), 'status'), to('PROCESSING'), who);
    write(
      `[${who}] status: cancelled by its status`,
      one(S(1), 'status'),
      to('CANCELLED', { reason: 'By status' }),
      who,
    );
  }
  const STATUSES = [
    'PENDING',
    'CONFIRMED',
    'PROCESSING',
    'PACKED',
    'SHIPPED',
    'DELIVERED',
    'CANCELLED',
    'RETURN_REQUESTED',
    'RETURNED',
    'REFUNDED',
  ];
  for (let n = 1; n <= 8; n++)
    for (const status of STATUSES)
      write(`status: S0${n} to ${status}`, one(S(n), 'status'), to(status));
  for (const status of STATUSES) {
    write(`status: a counter sale to ${status}`, one(posSale, 'status'), to(status));
    write(`status: a returned order to ${status}`, one(returned, 'status'), to(status), 'owner');
    write(`status: a voided sale to ${status}`, one(voided, 'status'), to(status));
  }
  for (const [name, body] of [
    ['a status it does not know', to('NOPE')],
    ['a status in lower case', to('processing')],
    ['a padded status', to('  PROCESSING ')],
    ['a blank status', to('')],
    ['a null status', to(null)],
    ['a status that is a number', to(5)],
    ['a status that is a list', to(['PROCESSING'])],
    ['no status', { reason: 'x' }],
    ['a reason', to('PROCESSING', { reason: 'Stock checked' })],
    ['a blank reason', to('PROCESSING', { reason: '' })],
    ['a reason in Bengali', to('PROCESSING', { reason: 'স্টক মিলেছে' })],
    ['a reason of 255 characters', to('PROCESSING', { reason: 'r'.repeat(255) })],
    ['a reason of 256 characters', to('PROCESSING', { reason: 'r'.repeat(256) })],
    ['a null reason', to('PROCESSING', { reason: null })],
    ['a reason that is a number', to('PROCESSING', { reason: 5 })],
    ['a reason that is a list', to('PROCESSING', { reason: ['x'] })],
    ['a cancelling reason of 255 characters', to('CANCELLED', { reason: 'r'.repeat(255) })],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"to_status":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`status: ${name}`, one(S(1), 'status'), body);
  }
  write(
    'status: another branch’s order, by a branch manager',
    one(S(6), 'status'),
    to('PROCESSING'),
  );
  write('status: an order at their own branch', one(S(6), 'status'), to('PROCESSING'), 'mirpur');
  write(
    'status: their own branch’s order cancelled',
    one(S(6), 'status'),
    to('CANCELLED'),
    'mirpur',
  );
  write('status: an order that is not there', one(MISSING, 'status'), to('PROCESSING'));
  write('status: an order that is not there, with a bad body', one(MISSING, 'status'), {});
  write('status: an order that is not a uuid', one('abc', 'status'), to('PROCESSING'));
  write(
    'status: filtered to another status',
    `${one(S(1), 'status')}?status=PENDING`,
    to('PROCESSING'),
  );
  write(
    'status: with a date that is not one',
    `${one(S(1), 'status')}?date_from=abc`,
    to('PROCESSING'),
  );
  const shelf = (sku: string, set: string) =>
    `UPDATE inventory_inventory SET ${set}
      WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = '${sku}')
        AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`;
  write(
    'status: packed, the shelf since counted away',
    one(S(2), 'status'),
    to('PACKED'),
    'manager',
    {
      prepare: after(shelf('RGN-ESS-M-OLI', 'on_hand = 0, reserved = 0')),
    },
  );
  write('status: packed, one short on the shelf', one(S(2), 'status'), to('PACKED'), 'manager', {
    prepare: after(shelf('RGN-ESS-M-OLI', 'on_hand = 1')),
  });
  write(
    'status: packed, the reservation since released',
    one(S(2), 'status'),
    to('PACKED'),
    'manager',
    {
      prepare: after(shelf('RGN-ESS-M-OLI', 'reserved = 0')),
    },
  );
  write(
    'status: packed, the reservation part released',
    one(S(2), 'status'),
    to('PACKED'),
    'manager',
    {
      prepare: after(shelf('RGN-ESS-M-OLI', 'reserved = 1')),
    },
  );
  write('status: packed, the shelf row gone', one(S(2), 'status'), to('PACKED'), 'manager', {
    prepare: after(
      `DELETE FROM inventory_inventory
        WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-ESS-M-OLI')
          AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`,
    ),
  });
  write(
    'status: packed, already marked as having left the shelf',
    one(S(2), 'status'),
    to('PACKED'),
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET stock_committed = true WHERE number = 'RGN-PARITY-S02'`,
      ),
    },
  );
  write(
    'status: cancelled, already marked as having left the shelf',
    one(S(2), 'status'),
    to('CANCELLED'),
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET stock_committed = true WHERE number = 'RGN-PARITY-S02'`,
      ),
    },
  );
  write(
    'status: cancelled, the reservation since released',
    one(S(1), 'status'),
    to('CANCELLED'),
    'manager',
    {
      prepare: after(shelf('RGN-CLA-M-WHI', 'reserved = 0')),
    },
  );
  write(
    'status: shipped, the customer with no account',
    one(S(5), 'status'),
    to('DELIVERED'),
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET customer_id = (SELECT id FROM customers_customer WHERE email = 'parity.guest@rangon.test')
        WHERE number = 'RGN-PARITY-S05'`,
      ),
    },
  );

  // === Cancel ================================================================================
  const why = { reason: 'Customer changed their mind' };
  for (const who of everyone) write(`[${who}] cancel`, one(S(1), 'cancel'), why, who);
  for (let n = 1; n <= 8; n++) write(`cancel S0${n}`, one(S(n), 'cancel'), why, 'owner');
  write('cancel a counter sale', one(posSale, 'cancel'), why);
  write('cancel a voided sale', one(voided, 'cancel'), why);
  for (const n of [1, 2, 3]) {
    for (const [name, body] of [
      ['no reason', {}],
      ['a blank reason', { reason: '' }],
      ['a reason of 300 characters', { reason: 'r'.repeat(300) }],
      ['a reason in Bengali', { reason: 'গ্রাহক মত বদলেছেন' }],
      ['a null reason', { reason: null }],
      ['a reason that is a number', { reason: 5 }],
      ['a reason that is zero', { reason: 0 }],
      ['a reason that is true', { reason: true }],
      ['a reason that is a list', { reason: ['Changed', 'mind'] }],
      ['a reason that is an empty list', { reason: [] }],
      ['a reason that is an object', { reason: { why: 'x' } }],
      ['a reason that is an empty object', { reason: {} }],
      ['a body that is a list', []],
      ['a body that is null', 'null'],
      ['broken JSON', '{"reason":'],
      ['no body', undefined],
    ] as [string, unknown][]) {
      write(`cancel S0${n}: ${name}`, one(S(n), 'cancel'), body);
    }
  }
  write('cancel another branch’s order, by a branch manager', one(S(6), 'cancel'), why);
  write('cancel an order at their own branch', one(S(6), 'cancel'), why, 'mirpur');
  write('cancel an order that is not there', one(MISSING, 'cancel'), why);
  write(
    'cancel an order that is not there, with broken JSON',
    one(MISSING, 'cancel'),
    '{"reason":',
  );
  write('cancel a packed order, with a body that is a list', one(S(4), 'cancel'), []);
  write('cancel, filtered to another status', `${one(S(1), 'cancel')}?status=PENDING`, why);
  const drawerShort = after(
    `UPDATE finance_account SET balance = 100.00 WHERE name = 'Counter Cash Drawer'`,
  );
  write(
    'cancel a part-paid order, the drawer short of the refund',
    one(S(3), 'cancel'),
    why,
    'manager',
    {
      prepare: drawerShort,
    },
  );
  write(
    'cancel a paid order already marked as having left the shelf',
    one(S(2), 'cancel'),
    why,
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET stock_committed = true WHERE number = 'RGN-PARITY-S02'`,
      ),
    },
  );
  write(
    'cancel a paid order already marked so, with a reason that is a number',
    one(S(2), 'cancel'),
    { reason: 5 },
    'manager',
    {
      prepare: after(
        `UPDATE orders_order SET stock_committed = true WHERE number = 'RGN-PARITY-S02'`,
      ),
    },
  );
  write(
    'cancel a paid order, its coupon’s use already given back',
    one(S(2), 'cancel'),
    why,
    'manager',
    {
      prepare: after(
        `UPDATE promotions_couponredemption SET released_at = now()
        WHERE order_id = (SELECT id FROM orders_order WHERE number = 'RGN-PARITY-S02')`,
      ),
    },
  );

  // === Payments ==============================================================================
  const pay = (method: unknown, amount: unknown, extra: Record<string, unknown> = {}) => ({
    method,
    amount,
    ...extra,
  });
  const drawer = account.get('Counter Cash Drawer');
  const bank = account.get('City Bank Current');
  for (const who of everyone)
    write(
      `[${who}] payment: the cash on delivery`,
      one(S(1), 'payments'),
      pay('COD', '5790.00'),
      who,
    );
  for (const [name, body] of [
    ['the cash on delivery, to the paisa', pay('COD', '5790.00')],
    ['the cash on delivery, as a number', pay('COD', 5790)],
    ['the cash on delivery, with one place', pay('COD', '5790.0')],
    ['the cash on delivery, into the drawer', pay('COD', '5790.00', { account: drawer })],
    ['the cash on delivery, into the bank', pay('COD', '5790.00', { account: bank })],
    [
      'the cash on delivery, into another branch’s till',
      pay('COD', '5790.00', { account: account.get('Parity Mirpur Till') }),
    ],
    [
      'the cash on delivery, into a closed account',
      pay('COD', '5790.00', { account: account.get('Parity Closed Bank') }),
    ],
    ['the cash on delivery, into a null account', pay('COD', '5790.00', { account: null })],
    [
      'the cash on delivery, with a reference',
      pay('COD', '5790.00', { reference: 'Courier slip 4411' }),
    ],
    ['less than the cash on delivery', pay('COD', '5000.00')],
    ['more than the cash on delivery', pay('COD', '6000.00')],
    ['cash, part of the total', pay('CASH', '100.00')],
    ['cash, all of the total', pay('CASH', '5790.00')],
    ['cash, more than the total', pay('CASH', '9999.00')],
    ['a card payment for the total', pay('CARD', '5790.00', { reference: 'Slip 12' })],
    ['a card payment into the drawer', pay('CARD', '100.00', { account: drawer })],
    ['bKash', pay('MOBILE_MFS', '100.00')],
    ['a bank transfer', pay('BANK', '100.00')],
    ['through the gateway', pay('ONLINE_GATEWAY', '100.00')],
    ['store credit', pay('STORE_CREDIT', '100.00')],
    ['some other way', pay('OTHER', '100.00')],
    ['an amount of nothing', pay('CASH', '0')],
    ['an amount below nothing', pay('CASH', '-1')],
    ['an amount with three places', pay('CASH', '1.005')],
    ['an amount of fifteen digits', pay('CASH', '1234567890123.45')],
    ['an amount that is not a number', pay('CASH', 'lots')],
    ['a null amount', pay('CASH', null)],
    ['no amount', { method: 'CASH' }],
    ['no method', { amount: '10.00' }],
    ['a method it does not know', pay('BITCOIN', '10.00')],
    ['a method in lower case', pay('cash', '10.00')],
    ['a blank method', pay('', '10.00')],
    ['a null method', pay(null, '10.00')],
    ['a reference of 128 characters', pay('CASH', '10.00', { reference: 'r'.repeat(128) })],
    ['a reference of 129 characters', pay('CASH', '10.00', { reference: 'r'.repeat(129) })],
    ['a blank reference', pay('CASH', '10.00', { reference: '' })],
    ['a null reference', pay('CASH', '10.00', { reference: null })],
    ['an account that is not there', pay('CASH', '10.00', { account: MISSING })],
    ['an account that is not a uuid', pay('CASH', '10.00', { account: 'abc' })],
    ['everything wrong at once', { method: 'X', amount: '-1', reference: null, account: 'x' }],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"method":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`payment: ${name}`, one(S(1), 'payments'), body);
  }
  write('payment: the rest of a part-paid order', one(S(3), 'payments'), pay('COD', '390.00'));
  write(
    'payment: the rest of a part-paid order, in cash',
    one(S(3), 'payments'),
    pay('CASH', '390.00'),
  );
  write('payment: on a paid order', one(S(2), 'payments'), pay('CASH', '50.00'));
  write(
    'payment: the cash on delivery of a packed order',
    one(S(4), 'payments'),
    pay('COD', '2450.00'),
  );
  write(
    'payment: the cash on delivery of a shipped order',
    one(S(5), 'payments'),
    pay('COD', '890.00'),
  );
  write('payment: on an order refunded in full', one(S(7), 'payments'), pay('CASH', '890.00'));
  write('payment: on a delivered, paid order', one(S(8), 'payments'), pay('COD', '4230.00'));
  write('payment: on a counter sale', one(posSale, 'payments'), pay('CASH', '10.00'));
  write('payment: on a voided sale', one(voided, 'payments'), pay('CASH', '10.00'));
  write(
    'payment: on another branch’s order, by a branch manager',
    one(S(6), 'payments'),
    pay('COD', '890.00'),
  );
  write(
    'payment: on an order at their own branch',
    one(S(6), 'payments'),
    pay('COD', '890.00'),
    'mirpur',
  );
  write(
    'payment: on an order at their own branch, into the home drawer',
    one(S(6), 'payments'),
    pay('COD', '890.00', { account: drawer }),
    'mirpur',
  );
  write('payment: on an order that is not there', one(MISSING, 'payments'), pay('CASH', '10.00'));
  write('payment: on an order that is not there, with a bad body', one(MISSING, 'payments'), {});
  write(
    'payment: filtered to another status',
    `${one(S(1), 'payments')}?status=PENDING`,
    pay('COD', '5790.00'),
  );
  write(
    'payment: the cash on delivery, the pending payment since failed',
    one(S(1), 'payments'),
    pay('COD', '5790.00'),
    'manager',
    {
      prepare: after(
        `UPDATE orders_payment SET status = 'FAILED'
        WHERE order_id = (SELECT id FROM orders_order WHERE number = 'RGN-PARITY-S01')`,
      ),
    },
  );
  write(
    'payment: the cash on delivery, the drawer since closed',
    one(S(1), 'payments'),
    pay('COD', '5790.00'),
    'manager',
    {
      prepare: after(
        `UPDATE finance_account SET is_active = false WHERE name = 'Counter Cash Drawer'`,
      ),
    },
  );
  write(
    'payment: with an Idempotency-Key',
    one(S(1), 'payments'),
    pay('CASH', '10.00'),
    'manager',
    {
      headers: { 'idempotency-key': 'parity-payment-key' },
    },
  );

  // === Refunds ===============================================================================
  const back = (amount: unknown, extra: Record<string, unknown> = {}) => ({ amount, ...extra });
  for (const who of everyone) write(`[${who}] refund`, one(S(8), 'refunds'), back('100.00'), who);
  for (const [name, body] of [
    ['part of it', back('100.00', { reason: 'Seam split' })],
    ['all of it', back('4230.00')],
    ['a paisa more than was paid', back('4230.01')],
    ['the smallest amount', back('0.01')],
    ['an amount as a number', back(100)],
    ['an amount of nothing', back('0')],
    ['an amount below nothing', back('-1')],
    ['an amount with three places', back('1.005')],
    ['an amount that is not a number', back('lots')],
    ['a null amount', back(null)],
    ['no amount', { reason: 'x' }],
    ['a blank reason', back('100.00', { reason: '' })],
    ['a reason in Bengali', back('100.00', { reason: 'সেলাই খুলে গেছে' })],
    ['a reason of 255 characters', back('100.00', { reason: 'r'.repeat(255) })],
    ['a reason of 256 characters', back('100.00', { reason: 'r'.repeat(256) })],
    ['a null reason', back('100.00', { reason: null })],
    ['a reason that is a number', back('100.00', { reason: 5 })],
    ...['CASH', 'CARD', 'MOBILE_MFS', 'BANK', 'ONLINE_GATEWAY', 'COD', 'STORE_CREDIT', 'OTHER'].map(
      (method) => [`by ${method}`, back('100.00', { method })] as [string, unknown],
    ),
    ['by a method it does not know', back('100.00', { method: 'BITCOIN' })],
    ['by a blank method', back('100.00', { method: '' })],
    ['by a null method', back('100.00', { method: null })],
    ['out of the drawer', back('100.00', { account: drawer })],
    ['out of the bank, in cash', back('100.00', { account: bank })],
    ['out of the bank, to the card', back('100.00', { account: bank, method: 'CARD' })],
    ['out of a closed account', back('100.00', { account: account.get('Parity Closed Bank') })],
    [
      'out of another branch’s till',
      back('100.00', { account: account.get('Parity Mirpur Till') }),
    ],
    ['out of a null account', back('100.00', { account: null })],
    ['out of an account that is not there', back('100.00', { account: MISSING })],
    ['everything wrong at once', { amount: 'x', reason: null, method: 'X', account: 'x' }],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"amount":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`refund: ${name}`, one(S(8), 'refunds'), body);
  }
  for (const [name, key] of [
    ['a key of its own', 'parity-refund-1'],
    ['an empty key', ''],
    ['the key of another order’s refund', doneKey],
    ['a key of 64 characters', 'k'.repeat(64)],
    ['a key of 65 characters', 'k'.repeat(65)],
  ] as [string, string][]) {
    write(`refund: with ${name}`, one(S(8), 'refunds'), back('100.00'), 'manager', {
      headers: { 'idempotency-key': key },
    });
  }
  write('refund: an order paid by card', one(S(2), 'refunds'), back('602.00'));
  write(
    'refund: an order paid by card, in cash',
    one(S(2), 'refunds'),
    back('602.00', { method: 'CASH' }),
  );
  write('refund: a part-paid order, what was paid', one(S(3), 'refunds'), back('500.00'));
  write('refund: a part-paid order, its whole total', one(S(3), 'refunds'), back('890.00'));
  write('refund: an order nothing was paid on', one(S(1), 'refunds'), back('100.00'));
  write('refund: an order refunded in full', one(S(7), 'refunds'), back('1.00'));
  write(
    'refund: a counter sale paid in cash and by card',
    one(posSale, 'refunds'),
    back('3000.00'),
  );
  write('refund: a voided sale', one(voided, 'refunds'), back('1.00'));
  write('refund: another branch’s order, by a branch manager', one(S(6), 'refunds'), back('1.00'));
  write('refund: an order at their own branch', one(S(6), 'refunds'), back('1.00'), 'mirpur');
  write('refund: an order that is not there', one(MISSING, 'refunds'), back('1.00'));
  write('refund: an order that is not there, with a bad body', one(MISSING, 'refunds'), {});
  write(
    'refund: filtered to another status',
    `${one(S(8), 'refunds')}?status=PENDING`,
    back('1.00'),
  );
  write('refund: the drawer short of it', one(S(8), 'refunds'), back('4230.00'), 'manager', {
    prepare: drawerShort,
  });
  write(
    'refund: the drawer short but allowed to go overdrawn',
    one(S(8), 'refunds'),
    back('4230.00'),
    'manager',
    {
      prepare: after(
        `UPDATE finance_account SET balance = 100.00, allow_overdraft = true WHERE name = 'Counter Cash Drawer'`,
      ),
    },
  );
  return cases;
}
