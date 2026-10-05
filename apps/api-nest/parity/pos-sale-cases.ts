/**
 * Parity cases for the counter sale (phase 5 part 3): `POST /pos/sales/`, the
 * sale read back and its receipt. A sale is one transaction over a dozen
 * tables -- the order and its lines, stock and its ledger, the coupon, the
 * payments and the accounts they land in, the customer's totals, a
 * call-back lead, the timeline, the audit log and, where the owner lets the
 * counter into reserved stock, the online orders left short -- and each case
 * compares all of them, with the low-stock jobs queued after the commit.
 *
 * The reserved stock, the lead's customer and four earlier sales come from
 * fixture_pos.py. Every write case puts the tables back first.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { signApproval } from './pos-quote-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import { type Case, token } from './run.ts';

export const SALE_TABLES = [
  'orders_order',
  'orders_orderitem',
  'orders_payment',
  'orders_refund',
  'orders_orderevent',
  'inventory_inventory',
  'inventory_inventorytransaction',
  'promotions_coupon',
  'promotions_couponredemption',
  'finance_account',
  'finance_accounttransaction',
  'customers_customer',
  'orders_abandonedcheckout',
  'notifications_notification',
];

/** A minted id inside a JSON column, read as a placeholder. */
const NO_IDS = (column: string) =>
  `regexp_replace(${column}::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'g')`;
/**
 * A row a request made or changed: told by its snapshot, never by time -- the
 * demo seed dates some of today's rows later today.
 */
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(s) FROM "snap_${table}" s WHERE s.id = ${alias}.id)`;
/** An order, old or new, by its number. */
const ORDER_NUMBER = (column: string) =>
  `COALESCE((SELECT x.number FROM orders_order x WHERE x.id::text = ${column}), ${column})`;

export const SALE_EFFECTS = [
  // 0. Orders: the ones a request made in full, and the totals of every other.
  `SELECT o.number, o.channel, o.status, o.payment_status, b.code AS branch, c.name AS customer,
          u.email AS created_by, o.register, o.subtotal::text, o.coupon_discount::text,
          o.manual_discount::text, o.discount_total::text, o.tax_total::text, o.tax_rate::text,
          o.tax_mode, o.shipping_total::text, o.grand_total::text, o.paid_total::text,
          o.refunded_total::text, o.currency, cp.code AS coupon, o.customer_note, o.internal_note,
          o.idempotency_key, o.guest_token, o.shipping_address::text AS shipping_address,
          o.stock_committed, o.cancel_reason, o.placed_at IS NOT NULL AS placed,
          o.delivered_at >= o.placed_at AS delivered, o.cancelled_at IS NOT NULL AS cancelled,
          o.id NOT IN (SELECT id FROM "snap_orders_order") AS made
     FROM orders_order o JOIN accounts_branch b ON b.id = o.branch_id
     JOIN customers_customer c ON c.id = o.customer_id
     LEFT JOIN accounts_user u ON u.id = o.created_by_id
     LEFT JOIN promotions_coupon cp ON cp.id = o.coupon_id
    WHERE ${CHANGED('o', 'orders_order')}
    ORDER BY o.number`,
  // 1. Lines.
  `SELECT o.number, i.sku, i.product_name, i.variant_label, i.quantity, i.unit_price::text,
          i.unit_cost::text, i.line_discount::text, i.tax_amount::text, i.line_total::text,
          i.fulfilled_quantity, i.returned_quantity
     FROM orders_orderitem i JOIN orders_order o ON o.id = i.order_id
    WHERE ${CHANGED('i', 'orders_orderitem')}
    ORDER BY o.number, i.created_at`,
  // 2. Payments and refunds.
  `SELECT o.number, p.method, p.status, p.amount::text, p.tendered_amount::text,
          p.change_amount::text, p.currency, p.provider, p.provider_reference, p.reference,
          p.payload::text AS payload, p.captured_at IS NOT NULL AS captured,
          p.refunded_total::text, a.name AS account, u.email AS created_by
     FROM orders_payment p JOIN orders_order o ON o.id = p.order_id
     LEFT JOIN finance_account a ON a.id = p.account_id
     LEFT JOIN accounts_user u ON u.id = p.created_by_id
    WHERE ${CHANGED('p', 'orders_payment')}
    ORDER BY o.number, p.created_at`,
  `SELECT o.number, r.amount::text, r.method, r.status, r.reason, r.provider_reference,
          r.idempotency_key, a.name AS account, u.email AS created_by,
          (SELECT p.method FROM orders_payment p WHERE p.id = r.payment_id) AS payment
     FROM orders_refund r JOIN orders_order o ON o.id = r.order_id
     LEFT JOIN finance_account a ON a.id = r.account_id
     LEFT JOIN accounts_user u ON u.id = r.created_by_id
    WHERE ${CHANGED('r', 'orders_refund')}
    ORDER BY o.number, r.created_at`,
  // 4. The timeline.
  `SELECT o.number, e.event_type, e.message, ${NO_IDS('e.data')} AS data, u.email AS actor,
          e.is_customer_visible
     FROM orders_orderevent e JOIN orders_order o ON o.id = e.order_id
     LEFT JOIN accounts_user u ON u.id = e.actor_id
    WHERE e.id NOT IN (SELECT id FROM "snap_orders_orderevent")
    ORDER BY e.created_at, o.number`,
  // 5. Stock, and its ledger.
  `SELECT b.code, v.sku, i.on_hand, i.reserved, i.average_cost::text AS average_cost,
          i.reorder_point, i.id NOT IN (SELECT id FROM "snap_inventory_inventory") AS made
     FROM inventory_inventory i JOIN accounts_branch b ON b.id = i.branch_id
     LEFT JOIN catalog_productvariant v ON v.id = i.variant_id
    WHERE ${CHANGED('i', 'inventory_inventory')}
    ORDER BY b.code, v.sku`,
  `SELECT b.code, v.sku, t.transaction_type, t.quantity, t.unit_cost::text AS unit_cost,
          t.on_hand_after, t.reserved_after, t.reference_type,
          ${ORDER_NUMBER('t.reference_id')} AS reference, t.reason, t.notes, u.email AS created_by,
          t.idempotency_key
     FROM inventory_inventorytransaction t JOIN accounts_branch b ON b.id = t.branch_id
     LEFT JOIN catalog_productvariant v ON v.id = t.variant_id
     LEFT JOIN accounts_user u ON u.id = t.created_by_id
    WHERE t.id NOT IN (SELECT id FROM "snap_inventory_inventorytransaction")
    ORDER BY t.created_at`,
  // 7. Coupons.
  `SELECT code, used_count FROM promotions_coupon ORDER BY code`,
  `SELECT cp.code, o.number, c.name AS customer, r.discount_amount::text,
          r.released_at IS NOT NULL AS released
     FROM promotions_couponredemption r JOIN promotions_coupon cp ON cp.id = r.coupon_id
     JOIN orders_order o ON o.id = r.order_id LEFT JOIN customers_customer c ON c.id = r.customer_id
    WHERE ${CHANGED('r', 'promotions_couponredemption')}
    ORDER BY cp.code, o.number`,
  // 9. Money: every account's balance, and the movements made.
  `SELECT b.code, a.name, a.balance::text FROM finance_account a
     JOIN accounts_branch b ON b.id = a.branch_id ORDER BY b.code, a.name`,
  `SELECT a.name, t.transaction_type, t.amount::text, t.balance_after::text, t.reference_type,
          COALESCE((SELECT o.number || ' ' || p.method FROM orders_payment p
                      JOIN orders_order o ON o.id = p.order_id WHERE p.id::text = t.reference_id),
                   (SELECT o.number || ' refund' FROM orders_refund r
                      JOIN orders_order o ON o.id = r.order_id WHERE r.id::text = t.reference_id),
                   t.reference_id) AS reference,
          t.reason, t.notes, u.email AS created_by, t.idempotency_key,
          t.occurred_at IS NOT NULL AS occurred
     FROM finance_accounttransaction t JOIN finance_account a ON a.id = t.account_id
     LEFT JOIN accounts_user u ON u.id = t.created_by_id
    WHERE t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")
    ORDER BY t.created_at`,
  // 11. Customers, leads, notices.
  `SELECT c.name, c.customer_type, c.is_walk_in, c.phone, c.email, c.total_orders,
          c.total_spent::text, c.last_order_at IS NOT NULL AS ordered,
          c.id NOT IN (SELECT id FROM "snap_customers_customer") AS made
     FROM customers_customer c
    WHERE c.id NOT IN (SELECT id FROM "snap_customers_customer")
       OR ROW(c.total_orders, c.total_spent, c.last_order_at) IS DISTINCT FROM
          (SELECT ROW(s.total_orders, s.total_spent, s.last_order_at)
             FROM "snap_customers_customer" s WHERE s.id = c.id)
    ORDER BY c.name`,
  `SELECT l.phone, l.status, l.recovered_at IS NOT NULL AS recovered, o.number
     FROM orders_abandonedcheckout l LEFT JOIN orders_order o ON o.id = l.recovered_order_id
    ORDER BY l.phone`,
  `SELECT u.email, n.notification_type, n.level, n.title, n.body, n.permission_code,
          b.code AS branch, ${ORDER_NUMBER("substring(n.link from '[0-9a-f-]{36}$')")} AS link,
          n.data::text AS data
     FROM notifications_notification n LEFT JOIN accounts_user u ON u.id = n.user_id
     LEFT JOIN accounts_branch b ON b.id = n.branch_id
    WHERE n.id NOT IN (SELECT id FROM "snap_notifications_notification")
    ORDER BY n.title, u.email`,
  // 14. The audit log, and the number sequences.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
  `SELECT key, last_value FROM core_numbersequence ORDER BY key`,
];

export async function resetSales(client: pg.Client): Promise<void> {
  await restoreTables(client, SALE_TABLES);
  await restoreSequences(client);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;

/**
 * Blank what each API mints in an order it has just made: ids nothing had
 * before the run, and times since it began. What a replayed key hands back
 * is an old order, whose ids and times are compared as they are.
 */
export function mintedBlanker(known: ReadonlySet<string>, since: number) {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (UUID.test(value) && !known.has(value)) return '<minted>';
      if (STAMP.test(value) && Date.parse(value) >= since) return '<now>';
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      for (const key of Object.keys(row)) row[key] = walk(row[key]);
    }
    return value;
  };
  return (body: unknown) => {
    walk(body);
  };
}

export async function posSaleCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const ids = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const user = await ids(`SELECT email AS key, id FROM accounts_user`);
  const branch = await ids(`SELECT code AS key, id FROM accounts_branch`);
  const variant = await ids(`SELECT sku AS key, id FROM catalog_productvariant`);
  const account = await ids(`SELECT name AS key, id FROM finance_account`);
  const customer = await ids(`SELECT name AS key, id FROM customers_customer`);
  const order = await ids(`SELECT COALESCE(idempotency_key, number) AS key, id FROM orders_order`);
  const split = (
    await db.query<{ id: string }>(
      `SELECT id FROM orders_order WHERE customer_note = 'Parity split payment'`,
    )
  ).rows[0]?.id;
  const mirpurSale = (
    await db.query<{ id: string }>(
      `SELECT o.id FROM orders_order o JOIN accounts_branch b ON b.id = o.branch_id
        WHERE o.channel = 'POS' AND b.code = 'PAR3' LIMIT 1`,
    )
  ).rows[0]?.id;
  const online = (
    await db.query<{ id: string }>(
      `SELECT id FROM orders_order WHERE channel = 'ONLINE' ORDER BY number LIMIT 1`,
    )
  ).rows[0]?.id;
  const voided = (
    await db.query<{ id: string }>(
      `SELECT id FROM orders_order WHERE channel = 'POS' AND status = 'CANCELLED' LIMIT 1`,
    )
  ).rows[0]?.id;
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM orders_orderitem
       UNION ALL SELECT id::text FROM orders_payment UNION ALL SELECT id::text FROM orders_refund
       UNION ALL SELECT id::text FROM orders_orderevent UNION ALL SELECT id::text FROM accounts_branch
       UNION ALL SELECT id::text FROM customers_customer UNION ALL SELECT id::text FROM catalog_productvariant
       UNION ALL SELECT id::text FROM promotions_coupon UNION ALL SELECT id::text FROM finance_account`,
    )
  ).rows.map((row) => row.id);
  const till = await db.query<{ id: string; email: string; password: string }>(
    `SELECT id, email, password FROM accounts_user WHERE email = 'parity.till@rangon.test'`,
  );
  await db.end();
  if (!order.has('parity-pos-replayed') || !split || !mirpurSale || !till.rows[0]) {
    console.log('SKIP  pos sale: fixture_pos.py has not been applied');
    return [];
  }
  const blank = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const tillHeader = `Bearer ${token(till.rows[0], { exp: Math.floor(Date.now() / 1000) + 6 * 3600 })}`;
  const headers = (who: Who | 'till') =>
    who === 'till' ? { authorization: tillHeader } : auth(who);

  const V = (sku: string) => variant.get(sku) as string;
  const A = (name: string) => account.get(name) as string;
  const C = (name: string) => customer.get(name) as string;
  const mirpur = branch.get('PAR3') as string;
  const missing = '00000000-0000-4000-8000-000000000000';
  const ESS = V('RGN-ESS-XL-WHI'); // 890.00, sixteen or so on the shelf
  const SHIRT = V('RGN-CLA-L-WHI'); // 2450.00, eight
  const LINEN = V('RGN-LIN-M-WHI'); // five, at its reorder point
  const HELD = V('RGN-EMB-XL-MAR'); // nine, one of them reserved
  const TWA = V('PAR-TWA'); // 990.00; five, four of them reserved by three orders
  const one = [{ variant: ESS, quantity: 1 }];
  const cash = (amount: string | number, extra: Record<string, unknown> = {}) => ({
    method: 'CASH',
    amount,
    ...extra,
  });
  const paid = { lines: one, payments: [cash('890.00')] };

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who | 'till' = 'cashier', method = 'GET') =>
    cases.push({ name: `pos sale: ${name}`, method, path, headers: headers(who) });
  type Body = unknown | (() => unknown);
  const sale = (
    name: string,
    body: Body,
    who: Who | 'till' = 'cashier',
    extra: Partial<Case> & { key?: string | null } = {},
  ) => {
    const { key, ...rest } = extra;
    const fixed = typeof body !== 'function';
    cases.push({
      name: `pos sale: ${name}`,
      method: 'POST',
      path: '/api/v1/pos/sales/',
      headers: {
        ...headers(who),
        'content-type': 'application/json',
        ...(key === undefined || key === null ? {} : { 'idempotency-key': key }),
      },
      body: fixed ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      prepare: fixed
        ? undefined
        : () => Promise.resolve({ body: JSON.stringify((body as () => unknown)()) }),
      reset: resetSales,
      effects: SALE_EFFECTS,
      jobs: true,
      normalize: blank,
      ...rest,
    });
  };

  // --- Who may sell, and who may read a sale --------------------------------------------
  const S = (id: string) => `/api/v1/pos/sales/${id}/`;
  const replayed = order.get('parity-pos-replayed') as string;
  for (const who of [...(Object.keys(STAFF) as Who[]), 'till' as const]) {
    sale(`[${who}] a sale`, paid, who);
    read(`[${who}] read a sale`, S(replayed), who);
    read(`[${who}] a receipt`, `${S(replayed)}receipt/`, who);
    read(`[${who}] the list route`, '/api/v1/pos/sales/', who);
    read(`[${who}] PUT a sale`, S(replayed), who, 'PUT');
    read(`[${who}] DELETE a sale`, S(replayed), who, 'DELETE');
    read(`[${who}] POST a receipt`, `${S(replayed)}receipt/`, who, 'POST');
  }

  // --- A sale read back --------------------------------------------------------------------
  for (const [name, id] of [
    ['one whose key is the empty string', order.get('') as string],
    ['one at another branch', mirpurSale],
    ['one with a coupon, an override and two payments', split],
    ['an online order', online as string],
    ['a voided sale', voided as string],
  ] as [string, string][]) {
    read(`read ${name}`, S(id));
    read(`receipt of ${name}`, `${S(id)}receipt/`);
  }
  read('read a sale at the home branch, as the other branch’s manager', S(replayed), 'mirpur');
  read('read one that is not there', S(missing));
  read('read one that is not a uuid', '/api/v1/pos/sales/abc/');
  read('receipt of one that is not there', `${S(missing)}receipt/`);
  read('read one in capitals', S(replayed.toUpperCase()));
  for (const ordering of [
    'customer',
    '-branch',
    'register',
    'manual_discount',
    'payments',
    'lines',
    'note',
    '-expected_total',
    'coupon_code',
    'approval_token',
    'manual_discount_percent',
    'bogus',
    'bogus,register',
    'register,lines',
    'number',
  ]) {
    read(`read, ordering=${ordering}, one payment`, `${S(replayed)}?ordering=${ordering}`);
    read(`read, ordering=${ordering}, two payments`, `${S(split)}?ordering=${ordering}`);
  }
  read('receipt, ordering=payments, two payments', `${S(split)}receipt/?ordering=payments`);
  read('read one that is not there, ordering=lines', `${S(missing)}?ordering=lines`);

  // --- The sale's shape ----------------------------------------------------------------------
  for (const [name, body] of [
    ['nothing', {}],
    ['no payments', { lines: one }],
    ['payments that are not a list', { lines: one, payments: cash('890.00') }],
    ['null payments', { lines: one, payments: null }],
    ['an empty list of payments', { lines: one, payments: [] }],
    ['a payment with nothing in it', { lines: one, payments: [{}] }],
    ['a method nobody takes', { lines: one, payments: [{ method: 'BARTER', amount: '890.00' }] }],
    ['a method in lower case', { lines: one, payments: [{ method: 'cash', amount: '890.00' }] }],
    ['a negative amount', { lines: one, payments: [cash('-1.00')] }],
    ['an amount with three places', { lines: one, payments: [cash('890.001')] }],
    ['a null amount', { lines: one, payments: [cash(null as never)] }],
    ['an amount that is not a number', { lines: one, payments: [cash('lots')] }],
    [
      'a reference past 128 characters',
      { lines: one, payments: [cash('890.00', { reference: 'r'.repeat(129) })] },
    ],
    ['a null reference', { lines: one, payments: [cash('890.00', { reference: null })] }],
    [
      'an account that is not a uuid',
      { lines: one, payments: [cash('890.00', { account: 'abc' })] },
    ],
    [
      'an account that is not there',
      { lines: one, payments: [cash('890.00', { account: missing })] },
    ],
    [
      'an account that is closed',
      {
        lines: one,
        payments: [{ method: 'BANK', amount: '890.00', account: A('Parity Closed Bank') }],
      },
    ],
    ['a register past 32 characters', { ...paid, register: 'r'.repeat(33) }],
    ['a null register', { ...paid, register: null }],
    ['a null note', { ...paid, note: null }],
    ['an expected total that is not a number', { ...paid, expected_total: 'x' }],
    [
      'a tendered amount that is not a number',
      { lines: one, payments: [cash('890.00', { tendered_amount: 'x' })] },
    ],
    ['no lines', { lines: [], payments: [cash('890.00')] }],
    ['an amount and a percentage', { ...paid, manual_discount: 5, manual_discount_percent: 5 }],
    ['a list', []],
    ['broken JSON', '{"lines":'],
  ] as [string, unknown][]) {
    sale(name, body);
  }

  // --- Paying -------------------------------------------------------------------------------
  for (const [name, body, who] of [
    ['cash, exactly', paid, 'cashier'],
    [
      'cash, with change',
      { lines: one, payments: [cash('890.00', { tendered_amount: '1000.00' })] },
      'cashier',
    ],
    [
      'cash tendered short',
      { lines: one, payments: [cash('890.00', { tendered_amount: '889.99' })] },
      'cashier',
    ],
    [
      'cash tendered, null',
      { lines: one, payments: [cash('890.00', { tendered_amount: null })] },
      'cashier',
    ],
    [
      'a card, with a tendered amount nobody checks',
      {
        lines: one,
        payments: [
          { method: 'CARD', amount: '890.00', tendered_amount: '5', reference: ' slip 12 ' },
        ],
      },
      'cashier',
    ],
    ['too little', { lines: one, payments: [cash('889.99')] }, 'cashier'],
    [
      'too much, by card',
      { lines: one, payments: [{ method: 'CARD', amount: '1000.00' }] },
      'cashier',
    ],
    [
      'too much, in cash, with no tendered amount',
      { lines: one, payments: [cash('1000.00')] },
      'cashier',
    ],
    [
      'cash, a card and a wallet',
      {
        lines: [{ variant: SHIRT, quantity: 1 }],
        payments: [
          cash('1000.00', { tendered_amount: '1000' }),
          { method: 'CARD', amount: '1000.00', reference: 'slip 7' },
          { method: 'MOBILE_MFS', amount: '450.00', reference: 'TXN9' },
        ],
      },
      'cashier',
    ],
    [
      'a payment of nothing among others',
      {
        lines: one,
        payments: [
          cash(0),
          { method: 'CARD', amount: '890.00' },
          cash('0.00', { tendered_amount: '5' }),
        ],
      },
      'cashier',
    ],
    [
      'every method',
      {
        lines: [{ variant: SHIRT, quantity: 1 }],
        payments: [
          'CASH',
          'CARD',
          'MOBILE_MFS',
          'BANK',
          'ONLINE_GATEWAY',
          'COD',
          'STORE_CREDIT',
        ].map((method) => ({ method, amount: '350.00' })),
      },
      'cashier',
    ],
    [
      'a method the branch has no account for',
      { lines: one, payments: [{ method: 'OTHER', amount: '890.00' }] },
      'cashier',
    ],
    [
      'a named account of the right kind',
      {
        lines: one,
        payments: [{ method: 'CARD', amount: '890.00', account: A('Agrani Parity Savings') }],
      },
      'cashier',
    ],
    [
      'a named account of the wrong kind',
      { lines: one, payments: [cash('890.00', { account: A('City Bank Current') })] },
      'cashier',
    ],
    [
      'a named account at another branch',
      { lines: one, payments: [cash('890.00', { account: A('Parity Mirpur Till') })] },
      'cashier',
    ],
    [
      'a named account at an inactive branch',
      {
        lines: one,
        payments: [{ method: 'BANK', amount: '890.00', account: A('Parity Uttara Bank') }],
      },
      'cashier',
    ],
    [
      'a second payment that fails after the first was taken',
      {
        lines: one,
        payments: [cash('400.00'), cash('490.00', { account: A('City Bank Current') })],
      },
      'cashier',
    ],
    [
      'a free item, with no payment',
      { lines: [{ variant: V('PAR-FREE'), quantity: 1 }], payments: [], branch: mirpur },
      'owner',
    ],
    [
      'everything off, with no payment',
      { lines: one, payments: [], manual_discount_percent: 100 },
      'manager',
    ],
    [
      'everything off, and paid anyway',
      { lines: one, payments: [cash('10.00')], manual_discount_percent: 100 },
      'manager',
    ],
    ['the total expected', { ...paid, expected_total: '890.00' }, 'cashier'],
    ['the total expected, as a number', { ...paid, expected_total: 890 }, 'cashier'],
    ['another total expected', { ...paid, expected_total: '889.99' }, 'cashier'],
    ['a null total expected', { ...paid, expected_total: null }, 'cashier'],
    [
      'a register and a note',
      { ...paid, register: ' R7 ', note: '  gift receipt, please \n' },
      'cashier',
    ],
  ] as [string, unknown, Who][]) {
    sale(`paying: ${name}`, body, who);
  }

  // --- Stock ---------------------------------------------------------------------------------
  for (const [name, body, who] of [
    [
      'down to the reorder point',
      { lines: [{ variant: SHIRT, quantity: 3 }], payments: [cash('7350.00')] },
      'cashier',
    ],
    [
      'the last of a SKU',
      {
        lines: [{ variant: LINEN, quantity: 5 }],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'one more than the shelf holds',
      {
        lines: [{ variant: LINEN, quantity: 6 }],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'one SKU on two lines, more than the shelf together',
      {
        lines: [
          { variant: LINEN, quantity: 3 },
          { variant: LINEN, quantity: 3 },
        ],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'one SKU on two lines, within the shelf',
      {
        lines: [
          { variant: LINEN, quantity: 2 },
          { variant: LINEN, quantity: 2, line_discount: 10 },
        ],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'two SKUs, the second short',
      {
        lines: [
          { variant: ESS, quantity: 1 },
          { variant: LINEN, quantity: 9 },
        ],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'a SKU the branch never held',
      { lines: [{ variant: V('PAR-DRAFT'), quantity: 1 }], payments: [cash('500.00')] },
      'cashier',
    ],
    [
      'a variant that is not there',
      { lines: [{ variant: missing, quantity: 1 }], payments: [cash('1.00')] },
      'cashier',
    ],
    [
      'every unit not reserved',
      {
        lines: [{ variant: HELD, quantity: 8 }],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'a unit reserved for an online order',
      {
        lines: [{ variant: HELD, quantity: 9 }],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'more than the shelf, of a SKU with a reservation',
      {
        lines: [{ variant: HELD, quantity: 10 }],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'a quantity past a 32-bit integer, of a free item',
      { lines: [{ variant: V('PAR-FREE'), quantity: 3000000000 }], payments: [], branch: mirpur },
      'owner',
    ],
    [
      'a total past the column',
      {
        lines: [{ variant: ESS, quantity: 2000000000 }],
        payments: [{ method: 'CARD', amount: '99999.00' }],
      },
      'cashier',
    ],
    [
      'at another branch, as an owner',
      {
        lines: [{ variant: V('PAR-TEE-S-WHT'), quantity: 2 }],
        payments: [cash('2200.00')],
        branch: mirpur,
      },
      'owner',
    ],
    [
      'at another branch, paid by card, which has no account there',
      {
        lines: [{ variant: V('PAR-TEE-S-WHT'), quantity: 1 }],
        payments: [{ method: 'CARD', amount: '1100.00' }],
        branch: mirpur,
      },
      'owner',
    ],
    [
      'at another branch, as a cashier',
      { lines: one, payments: [cash('890.00')], branch: mirpur },
      'cashier',
    ],
    [
      'at its own branch, as the other branch’s manager',
      {
        lines: [{ variant: V('RGN-LIN-M-WHI'), quantity: 1 }],
        payments: [cash('9999.00', { tendered_amount: '9999' })],
      },
      'mirpur',
    ],
    [
      'the last unit at another branch, twice over',
      { lines: [{ variant: V('RGN-LIN-M-WHI'), quantity: 2 }], payments: [cash('9999.00')] },
      'mirpur',
    ],
  ] as [string, unknown, Who][]) {
    sale(`stock: ${name}`, body, who);
  }
  // Where the owner lets the counter take reserved units (business rule 1.4, D115).
  const reservedForSale: Partial<Case> = {
    setup: [`UPDATE accounts_organization SET counter_sells_reserved = true`],
    teardown: [`UPDATE accounts_organization SET counter_sells_reserved = false`],
  };
  const card = [{ method: 'CARD', amount: '99999.00' }];
  for (const [name, lines] of [
    ['one unit, which nobody holds', [{ variant: TWA, quantity: 1 }]],
    ['two units, one of them the newest order’s', [{ variant: TWA, quantity: 2 }]],
    ['three units: the newest order and half the next', [{ variant: TWA, quantity: 3 }]],
    ['all five: every order short', [{ variant: TWA, quantity: 5 }]],
    ['six: more than the shelf', [{ variant: TWA, quantity: 6 }]],
    // Each line is within what nobody holds; together they are not (D145).
    [
      'two lines of one unit each',
      [
        { variant: TWA, quantity: 1 },
        { variant: TWA, quantity: 1 },
      ],
    ],
    [
      'two lines that take three between them',
      [
        { variant: TWA, quantity: 1 },
        { variant: TWA, quantity: 2 },
      ],
    ],
    [
      'a reserved unit of another SKU, and one nobody holds',
      [
        { variant: HELD, quantity: 9 },
        { variant: ESS, quantity: 1 },
      ],
    ],
  ] as [string, unknown][]) {
    sale(`reserved stock, allowed: ${name}`, { lines, payments: card }, 'cashier', reservedForSale);
    sale(`reserved stock, not allowed: ${name}`, { lines, payments: card });
  }
  // What is not for sale (D142).
  sale('stock: an archived SKU with units on the shelf', paid, 'cashier', {
    setup: [`UPDATE catalog_productvariant SET status = 'ARCHIVED' WHERE sku = 'RGN-ESS-XL-WHI'`],
    teardown: [`UPDATE catalog_productvariant SET status = 'ACTIVE' WHERE sku = 'RGN-ESS-XL-WHI'`],
  });
  sale('stock: a SKU of a draft product, unpublished', paid, 'cashier', {
    setup: [
      `UPDATE catalog_product SET status = 'DRAFT', published = false
        WHERE id = (SELECT product_id FROM catalog_productvariant WHERE sku = 'RGN-ESS-XL-WHI')`,
    ],
    teardown: [
      `UPDATE catalog_product SET status = 'ACTIVE', published = true
        WHERE id = (SELECT product_id FROM catalog_productvariant WHERE sku = 'RGN-ESS-XL-WHI')`,
    ],
  });

  // --- The customer -----------------------------------------------------------------------------
  for (const [name, body, who] of [
    ['a named customer', { ...paid, customer: C('Ayesha Rahman') }, 'cashier'],
    ['the walk-in record, named', { ...paid, customer: C('Walk-in (DHK1)') }, 'cashier'],
    ['a customer that is not there', { ...paid, customer: missing }, 'cashier'],
    [
      'a customer with an open call-back lead',
      { ...paid, customer: C('Parity Caller') },
      'cashier',
    ],
    [
      'nobody, at a branch with no walk-in record yet',
      {
        lines: [{ variant: V('RGN-CLA-L-WHI'), quantity: 1 }],
        payments: [cash('2450.00')],
        branch: mirpur,
      },
      'owner',
    ],
  ] as [string, unknown, Who][]) {
    sale(`customer: ${name}`, body, who);
  }

  // --- Coupons and discounts ----------------------------------------------------------------------
  const shirt = [{ variant: SHIRT, quantity: 1 }];
  for (const [name, body, who] of [
    [
      'a store coupon',
      { lines: shirt, coupon_code: 'store100', payments: [cash('2350.00')] },
      'cashier',
    ],
    [
      'a once-each coupon, first use',
      {
        lines: shirt,
        coupon_code: 'PARITY-ONCE',
        customer: C('Ayesha Rahman'),
        payments: [cash('2425.00')],
      },
      'cashier',
    ],
    [
      'a once-each coupon, already used',
      {
        lines: shirt,
        coupon_code: 'PARITY-ONCE',
        customer: C('Parvin Sultana'),
        payments: [cash('2425.00')],
      },
      'cashier',
    ],
    [
      'a once-each coupon with no customer',
      { lines: shirt, coupon_code: 'PARITY-ONCE', payments: [cash('2450.00')] },
      'cashier',
    ],
    [
      'a coupon used up',
      { lines: shirt, coupon_code: 'PARITY-USED', payments: [cash('2450.00')] },
      'cashier',
    ],
    [
      'an online-only coupon',
      { lines: shirt, coupon_code: 'RANGON10', payments: [cash('2450.00')] },
      'cashier',
    ],
    [
      'a coupon nobody made',
      { lines: shirt, coupon_code: 'NOPE', payments: [cash('2450.00')] },
      'cashier',
    ],
    [
      'a coupon as large as the sale',
      { lines: shirt, coupon_code: 'PARITY-BIG', payments: [] },
      'cashier',
    ],
    [
      'a coupon and a tenth off',
      {
        lines: shirt,
        coupon_code: 'STORE100',
        manual_discount_percent: 10,
        payments: [cash('2115.00')],
        expected_total: '2115.00',
      },
      'cashier',
    ],
    [
      'a line discount and a sale discount',
      {
        lines: [{ variant: SHIRT, quantity: 2, line_discount: '100.00' }],
        manual_discount: '200.00',
        payments: [cash('4600.00')],
      },
      'cashier',
    ],
    [
      'a discount past the threshold',
      { lines: shirt, manual_discount_percent: 25, payments: [cash('1837.50')] },
      'cashier',
    ],
    [
      'a discount past the threshold, as a manager',
      { lines: shirt, manual_discount_percent: 25, payments: [cash('1837.50')] },
      'manager',
    ],
    [
      'a discount past the threshold, as an owner',
      { lines: shirt, manual_discount_percent: 25, payments: [cash('1837.50')] },
      'owner',
    ],
    [
      'any discount, without the right',
      { lines: shirt, manual_discount: '1.00', payments: [cash('2449.00')] },
      'till',
    ],
    ['no discount, without the right', { lines: shirt, payments: [cash('2450.00')] }, 'till'],
    [
      'a discount past the sale',
      { lines: shirt, manual_discount: '2450.01', payments: [] },
      'manager',
    ],
  ] as [string, unknown, Who | 'till'][]) {
    sale(`discount: ${name}`, body, who);
  }
  const cashierId = user.get('cashier@rangon.test') as string;
  const approval = (fields: Record<string, unknown> = {}) =>
    signApproval({
      approver: user.get('parity.approver@rangon.test'),
      cashier: cashierId,
      permission: 'sales.discount_override',
      max_percent: '25.00',
      ...fields,
    });
  const quarterOff = { lines: shirt, manual_discount_percent: 25, payments: [cash('1837.50')] };
  sale('discount: past the threshold, with a manager’s approval', () => ({
    ...quarterOff,
    approval_token: approval(),
  }));
  sale('discount: past the threshold, approved for less', () => ({
    ...quarterOff,
    approval_token: approval({ max_percent: '24.99' }),
  }));
  sale('discount: past the threshold, an approval six minutes old', () => ({
    ...quarterOff,
    approval_token: signApproval(
      {
        approver: user.get('parity.approver@rangon.test'),
        cashier: cashierId,
        permission: 'sales.discount_override',
        max_percent: '25.00',
      },
      { age: 360 },
    ),
  }));
  sale('discount: past the threshold, approved by the other branch’s manager', () => ({
    ...quarterOff,
    approval_token: approval({ approver: user.get('parity.mirpur@rangon.test') }),
  }));
  sale('discount: past the threshold, approved by an owner', () => ({
    ...quarterOff,
    approval_token: approval({ approver: user.get('owner@rangon.test'), max_percent: null }),
  }));
  sale('discount: a bad approval nobody needed', {
    lines: shirt,
    manual_discount_percent: 5,
    approval_token: 'not-a-token',
    payments: [cash('2327.50')],
  });

  // --- VAT --------------------------------------------------------------------------------------
  const tax = (mode: string, rate: string, category: string | null): Partial<Case> => ({
    setup: [
      `UPDATE accounts_organization SET tax_mode = '${mode}', default_tax_rate = ${rate}`,
      `UPDATE catalog_category SET tax_rate = ${category ?? 'NULL'} WHERE slug = 'parity-leaf'`,
    ],
    teardown: [
      `UPDATE accounts_organization SET tax_mode = 'EXCLUSIVE', default_tax_rate = 0.0000`,
      `UPDATE catalog_category SET tax_rate = NULL WHERE slug = 'parity-leaf'`,
    ],
  });
  const mixed = {
    lines: [
      { variant: SHIRT, quantity: 2 },
      { variant: ESS, quantity: 1, line_discount: '90.00' },
      { variant: LINEN, quantity: 1 },
    ],
    manual_discount: '333.33',
    payments: card,
  };
  sale('VAT added, 15%', mixed, 'cashier', tax('EXCLUSIVE', '0.1500', null));
  sale('VAT inside the price, 15%', mixed, 'cashier', tax('INCLUSIVE', '0.1500', null));
  sale(
    'VAT added, 7.5%, the total expected',
    { ...paid, expected_total: '956.75' },
    'cashier',
    tax('EXCLUSIVE', '0.0750', null),
  );
  sale(
    'VAT added, 7.5%, the untaxed total expected',
    { ...paid, expected_total: '890.00' },
    'cashier',
    tax('EXCLUSIVE', '0.0750', null),
  );

  // --- One key, one sale ----------------------------------------------------------------------------
  sale('key: a new one', paid, 'cashier', { key: 'parity-pos-fresh' });
  sale('key: one already used', paid, 'cashier', { key: 'parity-pos-replayed' });
  sale(
    'key: one already used, for another basket by another cashier',
    { lines: shirt, payments: [cash('1.00')] },
    'manager',
    { key: 'parity-pos-replayed' },
  );
  sale('key: one already used, with a body the serializer refuses', { lines: [] }, 'cashier', {
    key: 'parity-pos-replayed',
  });
  sale('key: one already used, at a branch not allowed', { ...paid, branch: mirpur }, 'cashier', {
    key: 'parity-pos-replayed',
  });
  sale('key: the empty string', paid, 'cashier', { key: '' });
  sale('key: eighty characters', paid, 'cashier', { key: 'k'.repeat(80) });
  sale('key: eighty-one characters', paid, 'cashier', { key: 'k'.repeat(81) });
  sale('key: one that a checkout used', paid, 'cashier', { key: 'seed-order-0' });
  return cases;
}
