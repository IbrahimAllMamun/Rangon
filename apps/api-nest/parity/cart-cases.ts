/**
 * Parity cases for the cart: `shop/cart/`, `shop/cart/coupon/` and
 * `shop/shipping-options/` -- the server re-pricing a basket, with every
 * coupon refusal, both VAT modes, stock short and unavailable lines.
 *
 * Every cart endpoint writes: a read without a token creates a cart, a read
 * can drop a coupon, and the rest edit lines. So each case is a write case
 * (see run.ts) that restores the fixture's carts, and the carts and lines
 * each API leaves are compared.
 */
import pg from 'pg';

import { type Case, token } from './run.ts';

interface Account {
  id: string;
  email: string;
  password: string;
}

// A token the harness did not choose is each API's own: its shape is compared, not its value.
const NEW = `CASE WHEN c.token LIKE 'parity-cart-%' THEN c.token ELSE '<new>' END`;
const CARTS = `SELECT ${NEW} AS token, u.email AS customer, c.is_active, p.code AS coupon,
    c.created_at >= $1 AS created, c.updated_at >= $1 AS touched, c.last_activity_at >= $1 AS active_now,
    length(c.token) AS token_length
  FROM orders_cart c
  LEFT JOIN customers_customer cu ON cu.id = c.customer_id LEFT JOIN accounts_user u ON u.id = cu.user_id
  LEFT JOIN promotions_coupon p ON p.id = c.coupon_id
  WHERE c.token LIKE 'parity-cart-%' OR c.created_at >= $1
  ORDER BY 1, 2`;
const LINES = `SELECT ${NEW} AS cart, v.sku, i.quantity, i.created_at >= $1 AS created, i.updated_at >= $1 AS touched
  FROM orders_cartitem i JOIN orders_cart c ON c.id = i.cart_id
  JOIN catalog_productvariant v ON v.id = i.variant_id
  WHERE c.token LIKE 'parity-cart-%' OR c.created_at >= $1
  ORDER BY 1, 2`;

export async function cartCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const users = await db.query<Account>(
    `SELECT id, email, password FROM accounts_user
      WHERE email IN ('parity.customer@rangon.test', 'parity.many@rangon.test', 'parity.staff@rangon.test')`,
  );
  const items = await db.query<{ id: string; token: string; sku: string; variant_id: string }>(
    `SELECT i.id, c.token, v.sku, v.id AS variant_id FROM orders_cartitem i
       JOIN orders_cart c ON c.id = i.cart_id JOIN catalog_productvariant v ON v.id = i.variant_id
      WHERE c.token LIKE 'parity-cart-%'`,
  );
  const carts = await db.query<{ id: string }>(
    `SELECT id FROM orders_cart WHERE token LIKE 'parity-cart-%'`,
  );
  const variants = await db.query<{ sku: string; id: string }>(
    `SELECT sku, id FROM catalog_productvariant
      WHERE sku IN ('RGN-CLA-L-NAV', 'RGN-CLA-L-WHI', 'PAR-DRAFT', 'PAR-TEE-M-BLK')`,
  );
  await db.end();
  const account = new Map(users.rows.map((row) => [row.email.split('@')[0] as string, row]));
  const customer = account.get('parity.customer');
  const many = account.get('parity.many');
  const staff = account.get('parity.staff');
  const sku = new Map(variants.rows.map((row) => [row.sku, row.id]));
  const line = (cart: string, of: string) =>
    items.rows.find((row) => row.token === `parity-cart-${cart}` && row.sku === of)?.id;
  const navyInMixed = line('mixed', 'RGN-CLA-L-NAV');
  const whiteInCoupon = line('coupon', 'RGN-CLA-L-WHI');
  if (!customer || !many || !staff || !navyInMixed || !whiteInCoupon || !sku.get('RGN-CLA-L-NAV')) {
    console.log('SKIP  cart: fixture_cart.py has not been applied');
    return [];
  }
  const knownItems = new Map(items.rows.map((row) => [row.id, `${row.token}:${row.sku}`]));
  const knownCarts = new Set(carts.rows.map((row) => row.id));

  /**
   * The fixture's carts and lines back as they were, and every cart made
   * since they were copied gone. Copied once, on the harness's connection,
   * at the first cart case -- before any case has touched a cart.
   */
  const reset = async (client: pg.Client) => {
    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS parity_cart_epoch AS SELECT clock_timestamp() AS at`,
    );
    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS parity_carts AS SELECT * FROM orders_cart WHERE token LIKE 'parity-cart-%'`,
    );
    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS parity_cart_items AS SELECT i.* FROM orders_cartitem i
         JOIN orders_cart c ON c.id = i.cart_id WHERE c.token LIKE 'parity-cart-%'`,
    );
    const since = `(SELECT at FROM parity_cart_epoch)`;
    await client.query(
      `DELETE FROM orders_cartitem WHERE cart_id IN (SELECT id FROM parity_carts)
          OR cart_id IN (SELECT id FROM orders_cart WHERE created_at > ${since})`,
    );
    await client.query(
      `DELETE FROM orders_cart WHERE created_at > ${since} AND id NOT IN (SELECT id FROM parity_carts)`,
    );
    await client.query(
      `UPDATE orders_cart c SET customer_id = s.customer_id, token = s.token, branch_id = s.branch_id,
              coupon_id = s.coupon_id, is_active = s.is_active, last_activity_at = s.last_activity_at,
              updated_at = s.updated_at
         FROM parity_carts s WHERE s.id = c.id`,
    );
    await client.query(`INSERT INTO orders_cartitem SELECT * FROM parity_cart_items`);
  };

  /** New carts and lines carry each API's own ids and token: their shape is what is compared. */
  const normalize = (body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    const cart = body as Record<string, unknown>;
    if (typeof cart.id === 'string' && !knownCarts.has(cart.id)) cart.id = '<new cart>';
    // A token the client chose is compared as sent; one an API minted, by its shape.
    if (typeof cart.token === 'string' && !cart.token.startsWith('parity-cart-')) {
      const shape = /^[A-Za-z0-9_-]{32}$/.test(cart.token) ? '<new token>' : cart.token;
      cart.token = shape;
      if (cart['header:x-cart-token'] !== undefined) cart['header:x-cart-token'] = shape;
    }
    if (Array.isArray(cart.items)) {
      for (const item of cart.items as Record<string, unknown>[]) {
        item.id = knownItems.get(item.id as string) ?? '<new line>';
      }
    }
  };

  const cases: Case[] = [];
  let sequence = 0;
  const add = (
    name: string,
    method: string,
    path: string,
    extra: Partial<Case> & { data?: unknown } = {},
  ) => {
    sequence += 1;
    const { data, ...rest } = extra;
    cases.push({
      name,
      method,
      path,
      reset,
      effects: [CARTS, LINES],
      normalize,
      ...(data === undefined
        ? {}
        : { body: typeof data === 'string' ? data : JSON.stringify(data) }),
      ...rest,
      headers: {
        'x-request-id': `parity-cart-${sequence}`,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        ...rest.headers,
      },
    });
  };
  const holding = (cart: string, headers: Record<string, string> = {}) => ({
    'x-cart-token': `parity-cart-${cart}`,
    ...headers,
  });
  const as = (user: Account) => ({ authorization: `Bearer ${token(user)}` });
  const cart = '/api/v1/shop/cart/';

  // --- Reading a cart ------------------------------------------------------------
  add('cart: no token, a new one', 'GET', cart);
  for (const name of ['mixed', 'coupon', 'expired', 'empty']) {
    add(`cart: ${name}`, 'GET', cart, { headers: holding(name) });
  }
  add('cart: a checked-out cart token is not reused', 'GET', cart, { headers: holding('dead') });
  add('cart: a token the client chose', 'GET', cart, {
    headers: { 'x-cart-token': 'parity-cart-chosen' },
  });
  add('cart: token in the query string', 'GET', `${cart}?cart_token=parity-cart-coupon`);
  add('cart: the header wins over the query', 'GET', `${cart}?cart_token=parity-cart-empty`, {
    headers: holding('coupon'),
  });
  add('cart: a signed-in customer, no token', 'GET', cart, { headers: as(customer) });
  add('cart: signing in merges the guest cart', 'GET', cart, {
    headers: { ...as(customer), ...holding('guest') },
  });
  add('cart: a customer with no cart takes the guest one over', 'GET', cart, {
    headers: { ...as(many), ...holding('attach') },
  });
  add('cart: a customer with no cart and no token', 'GET', cart, { headers: as(many) });
  add('cart: staff, no customer record', 'GET', cart, {
    headers: { ...as(staff), ...holding('mixed') },
  });
  add('cart: a token longer than the column', 'GET', cart, {
    headers: { 'x-cart-token': 'x'.repeat(65) },
  });
  add('cart: VAT from a category override', 'GET', cart, {
    headers: holding('coupon'),
    setup: [`UPDATE catalog_category SET tax_rate = 0.0750 WHERE name = 'Shirts'`],
    teardown: [`UPDATE catalog_category SET tax_rate = NULL WHERE name = 'Shirts'`],
  });
  const vat = (mode: string, rate: string) => ({
    setup: [`UPDATE accounts_organization SET tax_mode = '${mode}', default_tax_rate = ${rate}`],
    teardown: [
      `UPDATE accounts_organization SET tax_mode = 'EXCLUSIVE', default_tax_rate = 0.0000`,
    ],
  });
  add('cart: exclusive VAT spread over lines, with a coupon', 'GET', cart, {
    headers: holding('coupon'),
    ...vat('EXCLUSIVE', '0.1500'),
  });
  add('cart: inclusive VAT, with a coupon', 'GET', cart, {
    headers: holding('coupon'),
    ...vat('INCLUSIVE', '0.1500'),
  });
  add('cart: inclusive VAT, an awkward rate', 'GET', cart, {
    headers: holding('mixed'),
    ...vat('INCLUSIVE', '0.0733'),
  });
  add('cart: no branch sells', 'GET', cart, {
    headers: holding('mixed'),
    setup: [
      `CREATE TEMP TABLE IF NOT EXISTS parity_branches AS SELECT id FROM accounts_branch WHERE status = 'ACTIVE'`,
      `UPDATE accounts_branch SET status = 'INACTIVE' WHERE id IN (SELECT id FROM parity_branches)`,
    ],
    teardown: [
      `UPDATE accounts_branch SET status = 'ACTIVE' WHERE id IN (SELECT id FROM parity_branches)`,
    ],
  });
  add('cart: PUT', 'PUT', cart, { headers: holding('mixed') });

  // --- Adding a line ---------------------------------------------------------------
  const navy = sku.get('RGN-CLA-L-NAV') as string;
  const white = sku.get('RGN-CLA-L-WHI') as string;
  const adding = (name: string, data: unknown, into = 'empty', extra: Partial<Case> = {}) =>
    add(`cart add: ${name}`, 'POST', cart, { data, headers: holding(into), ...extra });
  adding('a new line', { variant: navy, quantity: 2 });
  adding('to an existing line', { variant: navy, quantity: 1 }, 'mixed');
  adding('no quantity is one', { variant: white });
  adding('quantity as text', { variant: white, quantity: ' 3 ' });
  adding('quantity a float, truncated', '{"variant": "' + white + '", "quantity": 2.9}');
  adding('quantity true', { variant: white, quantity: true });
  adding('quantity zero', { variant: white, quantity: 0 });
  adding('quantity negative', { variant: white, quantity: -1 });
  adding('quantity "5.0"', { variant: white, quantity: '5.0' });
  adding('quantity null', { variant: white, quantity: null });
  adding('quantity a list', { variant: white, quantity: [1] });
  adding('more than is on hand', { variant: white, quantity: 20 });
  adding(
    'more than a number can hold',
    '{"variant": "' + white + '", "quantity": 1000000000000000000000000000000}',
  );
  adding('a variant nobody knows', { variant: '00000000-0000-4000-8000-000000000000' });
  adding('a variant id that is not a UUID', { variant: 'navy' });
  adding('an integer variant id', { variant: 7 });
  adding('no variant', { quantity: 1 });
  adding("a draft product's variant", { variant: sku.get('PAR-DRAFT') });
  adding('an archived variant', { variant: sku.get('PAR-TEE-M-BLK') });
  adding('into a new cart', { variant: navy }, 'none', { headers: {} });
  adding('a list', [1]);
  adding('malformed JSON', '{"variant": ');

  // --- Changing and removing lines ---------------------------------------------------
  const changing = (name: string, data: unknown, into = 'mixed') =>
    add(`cart change: ${name}`, 'PATCH', cart, { data, headers: holding(into) });
  changing('a quantity', { item: navyInMixed, quantity: 5 });
  changing('to zero removes it', { item: navyInMixed, quantity: 0 });
  changing('no quantity removes it', { item: navyInMixed });
  changing('more than is on hand', { item: whiteInCoupon, quantity: 99 }, 'coupon');
  changing("another cart's line", { item: whiteInCoupon, quantity: 1 });
  changing('a line id that is not a UUID', { item: 'x', quantity: 1 });
  changing('no line', { quantity: 1 });
  changing('quantity text', { item: navyInMixed, quantity: 'two' });
  add('cart remove: by query', 'DELETE', `${cart}?item=${navyInMixed}`, {
    headers: holding('mixed'),
  });
  add('cart remove: by body', 'DELETE', cart, {
    data: { item: navyInMixed },
    headers: holding('mixed'),
  });
  add('cart remove: nothing named empties the cart', 'DELETE', cart, { headers: holding('mixed') });
  add('cart remove: a line id that is not a UUID', 'DELETE', `${cart}?item=x`, {
    headers: holding('mixed'),
  });
  add("cart remove: another cart's line", 'DELETE', `${cart}?item=${whiteInCoupon}`, {
    headers: holding('mixed'),
  });

  // --- Coupons ---------------------------------------------------------------------------
  const coupon = '/api/v1/shop/cart/coupon/';
  const applying = (name: string, code: unknown, into = 'mixed', extra: Partial<Case> = {}) =>
    add(`coupon: ${name}`, 'POST', coupon, {
      data: code === undefined ? {} : { code },
      headers: holding(into),
      ...extra,
    });
  applying('a percentage, capped', 'RANGON10');
  applying('lower case and spaces', ' rangon10 ');
  applying('unknown', 'NOPE');
  applying('none sent', undefined);
  applying('a number', 5);
  applying('for the counter only', 'STORE100');
  applying('expired', 'EXPIRED50');
  applying('not started', 'PARITY-SOON');
  applying('switched off', 'PARITY-OFF');
  applying('used up', 'PARITY-USED');
  applying('already used by this customer', 'PARITY-ONCE', 'customer', {
    headers: { ...holding('customer'), ...as(customer) },
  });
  applying('below its minimum order', 'FREESHIP', 'empty');
  applying('free shipping', 'FREESHIP', 'coupon');
  applying('no line it covers', 'PARITY-PRODUCT');
  applying("a category, and that category's children", 'PARITY-CAT');
  applying('more than the cart is worth', 'PARITY-BIG', 'coupon');
  applying('a percentage with a cap', 'PARITY-CAP', 'coupon');
  applying('replacing the one applied', 'PARITY-CAT', 'coupon');
  add('coupon: removed', 'DELETE', coupon, { headers: holding('coupon') });
  add('coupon: removed when there is none', 'DELETE', coupon, { headers: holding('empty') });

  // --- Shipping options ----------------------------------------------------------------------
  const shipping = '/api/v1/shop/shipping-options/';
  for (const city of ['Dhaka', ' dhaka ', 'Chattogram', 'sylhet', '4000', 'Nowhere', '']) {
    add(
      `shipping: ${JSON.stringify(city)}`,
      'GET',
      `${shipping}?city=${encodeURIComponent(city)}`,
      { headers: holding('mixed') },
    );
  }
  add('shipping: no city at all', 'GET', shipping, { headers: holding('mixed') });
  add('shipping: free above the threshold', 'GET', `${shipping}?city=Chattogram`, {
    headers: holding('coupon'),
  });
  add('shipping: no default zone, no match', 'GET', `${shipping}?city=Nowhere`, {
    headers: holding('mixed'),
    setup: [`UPDATE shipping_shippingzone SET is_active = false WHERE is_default`],
    teardown: [`UPDATE shipping_shippingzone SET is_active = true WHERE is_default`],
  });

  return cases;
}
