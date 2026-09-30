/**
 * Parity cases for checkout: `shop/checkout/` and `shop/checkout/lead/` --
 * the first stock and money writes the port makes.
 *
 * Each case is a write case (see run.ts). Before each API's request the
 * database is put back as the fixtures left it: orders and everything they
 * wrote removed, stock, coupon counts, the order-number sequence and the
 * call-back list restored, carts restored. So both APIs number the order the
 * same, reserve from the same shelf, and redeem from the same count -- and
 * every row each wrote is compared, down to the ledger and the jobs it queued.
 */
import pg from 'pg';

import { resetCarts } from './cart-cases.ts';
import { type Case, send, type Side, token } from './run.ts';

interface Account {
  id: string;
  email: string;
  password: string;
}

const ORDERS = `SELECT o.number, o.channel, o.status, o.payment_status, o.subtotal, o.coupon_discount,
    o.manual_discount, o.discount_total, o.tax_total, o.tax_rate, o.tax_mode, o.shipping_total,
    o.grand_total, o.paid_total, o.refunded_total, o.currency, o.shipping_address, o.billing_address,
    o.customer_note, o.internal_note, o.register, o.idempotency_key, length(o.guest_token) AS token_length,
    o.confirmed_at IS NOT NULL AS confirmed, o.stock_committed, cp.code AS coupon, sm.code AS method,
    cu.name AS customer, cu.phone AS customer_phone, cu.email AS customer_email, cu.customer_type,
    cu.created_at >= $1 AS new_customer, cu.user_id IS NOT NULL AS registered
  FROM orders_order o JOIN customers_customer cu ON cu.id = o.customer_id
  LEFT JOIN promotions_coupon cp ON cp.id = o.coupon_id
  LEFT JOIN shipping_shippingmethod sm ON sm.id = o.shipping_method_id
  WHERE o.id NOT IN (SELECT id FROM parity_orders) ORDER BY o.number`;
const LINES = `SELECT o.number, i.sku, i.product_name, i.variant_label, i.quantity, i.unit_price, i.unit_cost,
    i.line_discount, i.tax_amount, i.line_total, i.fulfilled_quantity, i.returned_quantity
  FROM orders_orderitem i JOIN orders_order o ON o.id = i.order_id
  WHERE o.id NOT IN (SELECT id FROM parity_orders) ORDER BY o.number, i.sku`;
const LEDGER = `SELECT v.sku, t.transaction_type, t.quantity, t.unit_cost, t.on_hand_after, t.reserved_after,
    t.reference_type, o.number AS reference, t.reason, t.notes, t.created_by_id, t.idempotency_key
  FROM inventory_inventorytransaction t JOIN catalog_productvariant v ON v.id = t.variant_id
  LEFT JOIN orders_order o ON o.id::text = t.reference_id
  WHERE t.id NOT IN (SELECT id FROM parity_ledger) ORDER BY v.sku`;
const STOCK = `SELECT v.sku, i.on_hand, i.reserved, i.average_cost, i.reorder_point, i.created_at >= $1 AS created
  FROM inventory_inventory i JOIN catalog_productvariant v ON v.id = i.variant_id
  WHERE i.updated_at >= $1 ORDER BY v.sku`;
const MONEY = `SELECT o.number, p.method, p.status, p.amount, p.tendered_amount, p.change_amount, p.currency,
    p.provider, p.provider_reference, p.reference, p.payload, p.captured_at IS NOT NULL AS captured,
    p.refunded_total, p.account_id
  FROM orders_payment p JOIN orders_order o ON o.id = p.order_id
  WHERE o.id NOT IN (SELECT id FROM parity_orders) ORDER BY o.number`;
const TIMELINE = `SELECT o.number, e.event_type, e.message, e.data - 'payment_id' AS data, e.is_customer_visible,
    e.data ? 'payment_id' AS names_payment
  FROM orders_orderevent e JOIN orders_order o ON o.id = e.order_id
  WHERE o.id NOT IN (SELECT id FROM parity_orders) ORDER BY e.created_at`;
const COUPONS = `SELECT c.code, c.used_count, o.number, r.discount_amount, cu.name AS customer, r.released_at
  FROM promotions_coupon c
  LEFT JOIN promotions_couponredemption r ON r.coupon_id = c.id AND r.created_at >= $1
  LEFT JOIN orders_order o ON o.id = r.order_id LEFT JOIN customers_customer cu ON cu.id = r.customer_id
  WHERE c.updated_at >= $1 OR r.id IS NOT NULL ORDER BY c.code`;
const AUDIT = `SELECT a.action, a.entity_type, a.entity_label, a.actor_id, a.old_values, a.new_values, a.reason,
    a.user_agent, a.request_id, b.code AS branch
  FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
  WHERE a.created_at >= $1 ORDER BY a.created_at`;
const NOTICES = `SELECT n.notification_type, n.level, n.title, n.body,
    regexp_replace(n.link, '[0-9a-f-]{36}', '<order id>') AS link, n.data, n.permission_code,
    b.code AS branch, u.email AS recipient
  FROM notifications_notification n LEFT JOIN accounts_user u ON u.id = n.user_id
  LEFT JOIN accounts_branch b ON b.id = n.branch_id
  WHERE n.created_at >= $1 ORDER BY n.notification_type, u.email`;
const LEADS = `SELECT l.phone, l.name, l.email, l.status, l.cart_total, l.item_count, l.note,
    l.recovered_at IS NOT NULL AS recovered, o.number AS recovered_order,
    CASE WHEN c.token LIKE 'parity-cart-%' THEN c.token ELSE '<new>' END AS cart, cu.name AS customer,
    l.created_at >= $1 AS created
  FROM orders_abandonedcheckout l LEFT JOIN orders_order o ON o.id = l.recovered_order_id
  LEFT JOIN orders_cart c ON c.id = l.cart_id LEFT JOIN customers_customer cu ON cu.id = l.customer_id
  WHERE l.updated_at >= $1 ORDER BY l.phone`;
const CARTS = `SELECT CASE WHEN c.token LIKE 'parity-cart-%' THEN c.token ELSE '<new>' END AS token, c.is_active,
    cp.code AS coupon
  FROM orders_cart c LEFT JOIN promotions_coupon cp ON cp.id = c.coupon_id
  WHERE c.updated_at >= $1 OR c.created_at >= $1 ORDER BY 1`;
const SEQUENCE = `SELECT key, prefix, last_value, padding FROM core_numbersequence WHERE key = 'order:WEB'`;

/**
 * Everything a checkout writes, put back. Copied once, on the harness's
 * connection, at the first checkout case.
 *
 * What a request wrote is told by id, never by time: the demo seed spreads
 * today's sales across shop hours, so a reset before 9 p.m. finds orders,
 * payments and ledger rows stamped later today. The snapshots are also what
 * the effect queries read, so a seeded row is never taken for a new one.
 */
export async function resetCheckout(client: pg.Client): Promise<void> {
  const snapshot = [
    `CREATE TEMP TABLE IF NOT EXISTS parity_orders AS SELECT id FROM orders_order`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_ledger AS SELECT id FROM inventory_inventorytransaction`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_notices AS SELECT id FROM notifications_notification`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_postings AS SELECT id FROM finance_accounttransaction`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_customers AS SELECT id FROM customers_customer`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_inventory AS SELECT * FROM inventory_inventory`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_coupon_counts AS SELECT id, used_count, updated_at FROM promotions_coupon`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_sequences AS SELECT * FROM core_numbersequence`,
    `CREATE TEMP TABLE IF NOT EXISTS parity_leads AS SELECT * FROM orders_abandonedcheckout`,
    // A counter sale -- a competitor in the races -- posts to the cash book.
    `CREATE TEMP TABLE IF NOT EXISTS parity_accounts AS SELECT id, balance, updated_at FROM finance_account`,
  ];
  for (const statement of snapshot) await client.query(statement);
  const orders = `(SELECT id FROM orders_order WHERE id NOT IN (SELECT id FROM parity_orders))`;
  const statements = [
    // Leads first: they point at orders and carts about to go.
    `DELETE FROM orders_abandonedcheckout WHERE id NOT IN (SELECT id FROM parity_leads)`,
    `UPDATE orders_abandonedcheckout l SET status = s.status, name = s.name, email = s.email,
            cart_total = s.cart_total, item_count = s.item_count, last_seen_at = s.last_seen_at,
            recovered_at = s.recovered_at, recovered_order_id = s.recovered_order_id, cart_id = s.cart_id,
            customer_id = s.customer_id, branch_id = s.branch_id, note = s.note, updated_at = s.updated_at
       FROM parity_leads s WHERE s.id = l.id`,
    `DELETE FROM promotions_couponredemption WHERE order_id IN ${orders}`,
    `DELETE FROM orders_payment WHERE order_id IN ${orders}`,
    `DELETE FROM orders_orderevent WHERE order_id IN ${orders}`,
    `DELETE FROM orders_orderitem WHERE order_id IN ${orders}`,
    `DELETE FROM inventory_inventorytransaction WHERE id NOT IN (SELECT id FROM parity_ledger)`,
    `DELETE FROM notifications_notification WHERE id NOT IN (SELECT id FROM parity_notices)`,
    `DELETE FROM orders_order WHERE id IN ${orders}`,
    `DELETE FROM customers_customer WHERE id NOT IN (SELECT id FROM parity_customers)`,
    `DELETE FROM inventory_inventory WHERE id NOT IN (SELECT id FROM parity_inventory)`,
    `UPDATE inventory_inventory i SET on_hand = s.on_hand, reserved = s.reserved, average_cost = s.average_cost,
            updated_at = s.updated_at FROM parity_inventory s WHERE s.id = i.id`,
    `UPDATE promotions_coupon c SET used_count = s.used_count, updated_at = s.updated_at
       FROM parity_coupon_counts s WHERE s.id = c.id`,
    `DELETE FROM finance_accounttransaction WHERE id NOT IN (SELECT id FROM parity_postings)`,
    `UPDATE finance_account a SET balance = s.balance, updated_at = s.updated_at
       FROM parity_accounts s WHERE s.id = a.id`,
    `DELETE FROM core_numbersequence WHERE key NOT IN (SELECT key FROM parity_sequences)`,
    `UPDATE core_numbersequence n SET last_value = s.last_value, updated_at = s.updated_at
       FROM parity_sequences s WHERE s.key = n.key`,
  ];
  for (const statement of statements) await client.query(statement);
  await resetCarts(client);
}

export async function checkoutCases(apis: { DJANGO: URL; NEST: URL }): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const users = await db.query<Account>(
    `SELECT id, email, password FROM accounts_user WHERE email IN ('parity.customer@rangon.test')`,
  );
  const methods = await db.query<{ code: string; id: string; zone: string }>(
    `SELECT m.code, m.id, z.name AS zone FROM shipping_shippingmethod m JOIN shipping_shippingzone z ON z.id = m.zone_id`,
  );
  const coupons = await db.query<{ code: string; id: string }>(
    `SELECT code, id FROM promotions_coupon`,
  );
  // Kept open: a case's `prepare` adjusts rows after the reset, before its request.
  const after = (statement: string) => async () => {
    await db.query(statement);
    return {};
  };
  const customer = users.rows[0];
  const method = (code: string, zone: string) =>
    methods.rows.find((row) => row.code === code && row.zone === zone)?.id;
  const coupon = new Map(coupons.rows.map((row) => [row.code, row.id]));
  if (!customer || !method('p-nocod', 'Parity Zone')) {
    console.log('SKIP  checkout: fixture_cart.py has not been applied');
    return [];
  }

  const effects = [
    ORDERS,
    LINES,
    LEDGER,
    STOCK,
    MONEY,
    TIMELINE,
    COUPONS,
    AUDIT,
    NOTICES,
    LEADS,
    CARTS,
    SEQUENCE,
  ];
  // The new order's and new lines' ids are each API's own.
  // Each API stamps the moment it wrote: a time is compared by its form, not its value.
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+06:00$/;
  const stamp = (row: Record<string, unknown>, key: string) => {
    if (typeof row[key] === 'string' && ISO.test(row[key] as string)) row[key] = '<local time>';
  };
  const normalize = (body: unknown) => {
    const order = (body as { order?: Record<string, unknown> } | null)?.order;
    if (!order) return;
    stamp(order, 'placed_at');
    for (const row of (order.payments as Record<string, unknown>[] | undefined) ?? []) {
      stamp(row, 'created_at');
      stamp(row, 'captured_at');
    }
    for (const row of (order.events as Record<string, unknown>[] | undefined) ?? [])
      stamp(row, 'created_at');
    for (const list of ['items', 'payments', 'events']) {
      for (const row of (order[list] as Record<string, unknown>[] | undefined) ?? []) {
        row.id = `<${list}>`;
      }
    }
    const tracking = (body as { tracking_token?: unknown }).tracking_token;
    if (typeof tracking === 'string' && /^[A-Za-z0-9_-]{32}$/.test(tracking)) {
      (body as { tracking_token: string }).tracking_token = '<token>';
    }
  };

  const address = {
    recipient_name: 'Parity Buyer',
    phone: '01711000077',
    line1: 'Road 9',
    city: 'Dhaka',
  };
  const cases: Case[] = [];
  let sequence = 0;
  const checkout = (
    name: string,
    body: unknown,
    extra: Partial<Case> & { cart?: string | null; key?: string | null } = {},
  ) => {
    sequence += 1;
    const { cart = 'coupon', key = `parity-checkout-${sequence}`, ...rest } = extra;
    cases.push({
      name: `checkout: ${name}`,
      method: 'POST',
      path: '/api/v1/shop/checkout/',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset: resetCheckout,
      effects,
      jobs: true,
      normalize,
      ...rest,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'rangon-parity',
        'x-request-id': `parity-checkout-${sequence}`,
        ...(cart ? { 'x-cart-token': `parity-cart-${cart}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...rest.headers,
      },
    });
  };
  const cod = {
    shipping_address: address,
    payment_method: 'COD',
    contact_name: 'Parity Buyer',
    contact_phone: '01711000077',
  };

  // --- Orders placed -------------------------------------------------------------------
  checkout('cash on delivery, a coupon, a new guest', cod);
  checkout('paid online, left pending', { ...cod, payment_method: 'MOBILE_MFS' });
  checkout('a guest found by phone', {
    ...cod,
    contact_phone: '+880 1711-000001',
    contact_name: '',
  });
  checkout('a guest found by email', {
    ...cod,
    contact_phone: '',
    contact_email: 'PARITY.GUEST@rangon.test',
  });
  checkout('a guest with no name', { ...cod, contact_name: '', contact_phone: '01911000999' });
  checkout('a signed-in customer', cod, {
    cart: null,
    headers: { authorization: `Bearer ${token(customer)}` },
  });
  checkout('the total the shopper saw', { ...cod, expected_total: '4410.00' });
  checkout('a delivery option, free above its threshold', {
    ...cod,
    shipping_method: method('standard', 'Inside Dhaka'),
  });
  checkout(
    'a delivery option that charges',
    { ...cod, shipping_method: method('p-std', 'Parity Zone') },
    { cart: 'expired' },
  );
  checkout('a billing address of its own', {
    ...cod,
    billing_address: { recipient_name: 'Accounts', phone: '+8801811000002' },
  });
  checkout('an empty billing address is none', { ...cod, billing_address: {} });
  checkout('a note, and the lead it closes', {
    ...cod,
    contact_phone: '01711000078',
    note: 'Ring twice',
  });
  checkout('a coupon that stopped applying is dropped', cod, { cart: 'expired' });
  checkout('VAT, spread over the lines', cod, {
    setup: [`UPDATE accounts_organization SET tax_mode = 'EXCLUSIVE', default_tax_rate = 0.0733`],
    teardown: [
      `UPDATE accounts_organization SET tax_mode = 'EXCLUSIVE', default_tax_rate = 0.0000`,
    ],
  });
  checkout('stock left at the reorder point queues an alert', cod, {
    setup: [
      `UPDATE inventory_inventory SET reorder_point = 60 WHERE variant_id IN
               (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-NAV')`,
    ],
    teardown: [
      `UPDATE inventory_inventory SET reorder_point = 5 WHERE variant_id IN
                  (SELECT id FROM catalog_productvariant WHERE sku = 'RGN-CLA-L-NAV')`,
    ],
  });

  // --- Replays ----------------------------------------------------------------------------
  const firstThen = (side: Side) => async () => {
    await send(side === 'django' ? apis.DJANGO : apis.NEST, {
      name: 'first click',
      method: 'POST',
      path: '/api/v1/shop/checkout/',
      headers: {
        'content-type': 'application/json',
        'x-cart-token': 'parity-cart-coupon',
        'idempotency-key': 'parity-double-click',
      },
      body: JSON.stringify(cod),
    });
    return {};
  };
  checkout('a double click answers with the first order', cod, {
    key: 'parity-double-click',
    prepare: (side) => firstThen(side)(),
  });

  // --- Refused ------------------------------------------------------------------------------
  checkout('no Idempotency-Key', cod, { key: null });
  checkout('an Idempotency-Key longer than the column', cod, { key: 'k'.repeat(81) });
  checkout('the total changed since', { ...cod, expected_total: '4409.99' });
  checkout('a cart with stock problems', cod, { cart: 'mixed' });
  checkout('an empty cart', cod, { cart: 'empty' });
  checkout('no cart at all', cod, { cart: null });
  checkout('a delivery option gone', {
    ...cod,
    shipping_method: '00000000-0000-4000-8000-000000000000',
  });
  checkout('cash on delivery where it is refused', {
    ...cod,
    shipping_method: method('p-nocod', 'Parity Zone'),
  });
  checkout('a free order cannot be paid for', cod, {
    prepare: after(
      `UPDATE orders_cart SET coupon_id = '${coupon.get('PARITY-BIG')}' WHERE token = 'parity-cart-coupon'`,
    ),
  });
  checkout('a coupon used up since it was applied is dropped', cod, {
    prepare: after(`UPDATE promotions_coupon SET usage_limit = 0 WHERE code = 'RANGON10'`),
    teardown: [`UPDATE promotions_coupon SET usage_limit = 500 WHERE code = 'RANGON10'`],
  });
  checkout('the address incomplete, the phone not a mobile', {
    ...cod,
    shipping_address: { recipient_name: 'X', phone: '02-9612345', line1: '', city: null },
  });
  checkout('the address a list', { ...cod, shipping_address: ['x'] });
  checkout('every other field wrong', {
    shipping_address: address,
    billing_address: { phone: '123' },
    shipping_method: 'standard',
    payment_method: 'CHEQUE',
    contact_name: 'x'.repeat(161),
    contact_phone: '999',
    contact_email: 'not-an-email',
    expected_total: '44.105',
  });
  for (const [label, value] of [
    ['a word', 'abc'],
    ['too many digits', '1e20'],
    ['a float', '{"x":1}'],
    ['blank', ''],
  ] as const) {
    checkout(
      `expected total ${label}`,
      label === 'a float'
        ? `{"shipping_address": ${JSON.stringify(address)}, "payment_method": "COD", "expected_total": 4410.0}`
        : { ...cod, expected_total: value },
    );
  }
  checkout('nothing sent', {});
  checkout('a list', [1]);
  checkout('malformed JSON', '{"payment_method": ');

  // --- The call-back list ----------------------------------------------------------------------
  const lead = (name: string, body: unknown, extra: Partial<Case> = {}) => {
    sequence += 1;
    cases.push({
      name: `lead: ${name}`,
      method: 'POST',
      path: '/api/v1/shop/checkout/lead/',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset: resetCheckout,
      effects: [LEADS, CARTS],
      ...extra,
      headers: {
        'content-type': 'application/json',
        'x-request-id': `parity-checkout-${sequence}`,
        'x-cart-token': 'parity-cart-coupon',
        ...extra.headers,
      },
    });
  };
  lead('a new number', { phone: '+880 1811-000123', name: '  Ruma ', email: ' ruma@example.com ' });
  lead('the open lead refreshed, its name kept', { phone: '01711000078', name: '' });
  lead('not a mobile', { phone: '02-9612345' });
  lead('no phone', {});
  lead('a number sent as a number', { phone: 1811000124 });
  lead('a list', [1]);

  return cases;
}
