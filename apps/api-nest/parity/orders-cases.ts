/**
 * Parity cases for the rest of phase 2: the signed-in customer's orders and
 * addresses, guest order tracking, and review submission.
 *
 * Rows come from fixture_orders.py. Address and review cases write, so they
 * are write cases (see run.ts): both APIs start from the fixture's rows, and
 * the rows each one leaves -- and its audit entries -- are compared.
 */
import pg from 'pg';

import { type Case, token } from './run.ts';

interface Account {
  id: string;
  email: string;
  password: string;
}

const PARITY_CUSTOMERS = `SELECT c.id FROM customers_customer c JOIN accounts_user u ON u.id = c.user_id
  WHERE u.email IN ('parity.customer@rangon.test', 'parity.many@rangon.test', 'customer@rangon.test')`;

// Addresses and their audit entries, with the ids of new rows blanked (each API mints its own).
const ADDRESSES = `SELECT u.email,
    CASE WHEN a.id IN (SELECT id FROM parity_addresses) THEN a.id::text ELSE '<new>' END AS id,
    a.label, a.address_type, a.recipient_name, a.phone, a.line1, a.line2, a.area, a.city,
    a.district, a.postal_code, a.country, a.is_default, a.notes,
    a.created_at >= $1 AS created, a.updated_at >= $1 AS touched
  FROM customers_customeraddress a
  JOIN customers_customer c ON c.id = a.customer_id JOIN accounts_user u ON u.id = c.user_id
  WHERE a.customer_id IN (${PARITY_CUSTOMERS})
  ORDER BY u.email, a.is_default DESC, a.recipient_name, a.line1, a.city`;
const ADDRESS_AUDIT = `SELECT action, entity_type,
    CASE WHEN entity_id IN (SELECT id::text FROM parity_addresses) THEN entity_id ELSE '<new>' END AS entity_id,
    entity_label, actor_id, actor_label, old_values, new_values, reason, user_agent, request_id
  FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action`;
const REVIEWS = `SELECT p.slug, o.number, r.rating, r.title, r.comment, r.status, r.verified_purchase,
    r.moderated_by_id, r.moderated_at, r.moderation_note
  FROM engagement_review r JOIN catalog_product p ON p.id = r.product_id
  LEFT JOIN orders_order o ON o.id = r.order_id
  WHERE r.created_at >= $1 ORDER BY p.slug`;

export async function orderCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const rows = await db.query<Account>(
    `SELECT id, email, password FROM accounts_user
      WHERE email IN ('parity.customer@rangon.test', 'parity.bare@rangon.test', 'parity.staff@rangon.test',
                      'parity.many@rangon.test', 'customer@rangon.test')`,
  );
  const account = new Map(rows.rows.map((row) => [row.email.split('@')[0] as string, row]));
  const addressRows = await db.query<{ id: string; email: string; is_default: boolean }>(
    `SELECT a.id, u.email, a.is_default FROM customers_customeraddress a
       JOIN customers_customer c ON c.id = a.customer_id JOIN accounts_user u ON u.id = c.user_id
      WHERE u.email IN ('parity.customer@rangon.test', 'parity.many@rangon.test')
      ORDER BY u.email, a.is_default DESC`,
  );
  await db.end();
  const customer = account.get('parity.customer');
  const bare = account.get('parity.bare');
  const staff = account.get('parity.staff');
  const many = account.get('parity.many');
  const demo = account.get('customer');
  const [home, office] = addressRows.rows.filter((row) => row.email.startsWith('parity.customer'));
  const onlyOne = addressRows.rows.find((row) => row.email.startsWith('parity.many'));
  if (!customer || !bare || !staff || !many || !demo || !home || !office || !onlyOne) {
    console.log('SKIP  orders: fixture_orders.py has not been applied');
    return [];
  }

  const as = (user: Account, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token(user)}`,
    ...extra,
  });
  const json = { 'content-type': 'application/json', 'user-agent': 'rangon-parity' };

  /**
   * Addresses and reviews back as the fixture left them. The address rows are
   * copied once, into a temporary table on the harness's connection, the
   * first time a case needs them -- before any case has changed one.
   */
  const reset = async (client: pg.Client) => {
    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS parity_addresses AS
         SELECT * FROM customers_customeraddress WHERE customer_id IN (${PARITY_CUSTOMERS})`,
    );
    await client.query(
      `DELETE FROM customers_customeraddress WHERE customer_id IN (${PARITY_CUSTOMERS})`,
    );
    await client.query(`INSERT INTO customers_customeraddress SELECT * FROM parity_addresses`);
    await client.query(
      `DELETE FROM engagement_review WHERE moderation_note <> 'parity-fixture'
          AND customer_id IN (${PARITY_CUSTOMERS})`,
    );
  };

  const cases: Case[] = [];
  let sequence = 0;
  const add = (name: string, path: string, extra: Partial<Case> = {}) => {
    sequence += 1;
    cases.push({
      name,
      path,
      ...extra,
      headers: { 'x-request-id': `parity-orders-${sequence}`, ...extra.headers },
    });
  };
  // A write: JSON body, reset, and the effects to compare.
  const write = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    extra: Partial<Case> = {},
  ) =>
    add(name, path, {
      method,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset,
      ...extra,
      headers: { ...json, ...extra.headers },
    });

  // --- The signed-in customer's orders ------------------------------------------
  const orders = '/api/v1/shop/account/orders/';
  add('account orders: list', orders, { headers: as(customer) });
  add('account orders: 52 orders, the newest 50, a tie on placed_at', orders, {
    headers: as(many),
  });
  add('account orders: no customer record', orders, { headers: as(bare) });
  add('account orders: staff', orders, { headers: as(staff) });
  add('account orders: anonymous', orders);
  for (const number of [
    'RGN-PARITY-0001',
    'RGN-PARITY-0002',
    'RGN-PARITY-0003',
    'RGN-PARITY-0004',
  ]) {
    add(`account order ${number}`, `${orders}${number}/`, { headers: as(customer) });
  }
  add("account order: another customer's", `${orders}RGN-PARITY-0009/`, { headers: as(customer) });
  add('account order: unknown', `${orders}RGN-NOPE/`, { headers: as(customer) });
  add('account order: no customer record', `${orders}RGN-PARITY-0001/`, { headers: as(bare) });
  add('account order: an encoded space', `${orders}RGN%20PARITY/`, { headers: as(customer) });
  add('account order: an encoded slash', `${orders}RGN%2FPARITY/`, { headers: as(customer) });
  add('account order: POST', `${orders}RGN-PARITY-0001/`, {
    method: 'POST',
    headers: as(customer),
  });

  // --- Guest order tracking -----------------------------------------------------
  const track = '/api/v1/shop/orders/';
  add('tracking: guest with the token', `${track}RGN-PARITY-0009/?token=parity-token-0009`);
  add('tracking: guest, wrong token', `${track}RGN-PARITY-0009/?token=parity-token-0001`);
  add('tracking: guest, no token', `${track}RGN-PARITY-0009/`);
  add(
    'tracking: repeated token, the last wins',
    `${track}RGN-PARITY-0009/?token=nope&token=parity-token-0009`,
  );
  add(
    'tracking: repeated token, the last loses',
    `${track}RGN-PARITY-0009/?token=parity-token-0009&token=nope`,
  );
  add('tracking: counter order, no token (D113)', `${track}RGN-PARITY-0003/`);
  add('tracking: counter order, blank token (D113)', `${track}RGN-PARITY-0003/?token=`);
  add('tracking: a demo counter order (D113)', `${track}RGN-POS-000001/`);
  add('tracking: its customer, signed in, no token', `${track}RGN-PARITY-0003/`, {
    headers: as(customer),
  });
  add('tracking: another customer, signed in', `${track}RGN-PARITY-0001/`, { headers: as(many) });
  add('tracking: staff with the token', `${track}RGN-PARITY-0001/?token=parity-token-0001`, {
    headers: as(staff),
  });
  add('tracking: the full order', `${track}RGN-PARITY-0001/?token=parity-token-0001`);
  add('tracking: unknown', `${track}RGN-NOPE/?token=x`);
  add('tracking: bad bearer token', `${track}RGN-PARITY-0009/?token=parity-token-0009`, {
    headers: { authorization: 'Bearer abc' },
  });

  // --- Addresses -------------------------------------------------------------------
  const addresses = '/api/v1/shop/account/addresses/';
  const changes = { effects: [ADDRESSES, ADDRESS_AUDIT] };
  const created = {
    ...changes,
    normalize: (body: unknown) => {
      if (body && typeof body === 'object' && 'id' in body) (body as { id: unknown }).id = '<new>';
    },
  };
  add('addresses: list', addresses, { headers: as(customer), reset });
  add('addresses: none yet', addresses, { headers: as(demo), reset });
  add('addresses: no customer record', addresses, { headers: as(bare), reset });
  add('addresses: staff', addresses, { headers: as(staff) });
  add('addresses: anonymous', addresses);
  const full = {
    label: 'Parents',
    address_type: 'SHIPPING',
    recipient_name: '  Rashida Begum ',
    phone: '+880 1911-000003',
    line1: 'Village Road',
    line2: 'Near the mosque',
    area: 'Sadar',
    city: 'Cumilla',
    district: 'Cumilla',
    postal_code: '3500',
    country: 'Bangladesh',
    is_default: 'true',
    notes: 'Call first',
  };
  write('address add: every field, made the default', 'POST', addresses, full, {
    ...created,
    headers: as(customer),
  });
  write(
    'address add: the least, not the default',
    'POST',
    addresses,
    { recipient_name: 'Rafi', phone: '01911000004', line1: 'L1', city: 'Rajshahi' },
    { ...created, headers: as(customer) },
  );
  write(
    'address add: the first is the default whatever was asked',
    'POST',
    addresses,
    {
      recipient_name: 'Demo',
      phone: '01911000005',
      line1: 'L1',
      city: 'Khulna',
      is_default: false,
    },
    { ...created, headers: as(demo) },
  );
  write(
    'address add: every field wrong',
    'POST',
    addresses,
    {
      label: 'x'.repeat(41),
      address_type: 'HOME',
      recipient_name: '',
      phone: '12345',
      city: null,
      country: '',
      is_default: 'maybe',
      notes: 5,
    },
    { ...changes, headers: as(customer) },
  );
  write('address add: nothing sent', 'POST', addresses, {}, { ...changes, headers: as(customer) });
  write('address add: a list', 'POST', addresses, [1], { ...changes, headers: as(customer) });
  write('address add: no customer record', 'POST', addresses, full, {
    ...changes,
    headers: as(bare),
  });
  write(
    'address edit: the city',
    'PATCH',
    addresses,
    { id: home.id, city: 'Chattogram' },
    { ...changes, headers: as(customer) },
  );
  write(
    'address edit: nothing changes',
    'PATCH',
    addresses,
    { id: home.id, city: 'Dhaka' },
    { ...changes, headers: as(customer) },
  );
  write(
    'address edit: make the other one the default',
    'PATCH',
    addresses,
    { id: office.id, is_default: true },
    { ...changes, headers: as(customer) },
  );
  write(
    'address edit: un-default, another on file (stays default)',
    'PATCH',
    addresses,
    { id: home.id, is_default: false, notes: 'Gate 2' },
    { ...changes, headers: as(customer) },
  );
  write(
    'address edit: un-default the only one',
    'PATCH',
    addresses,
    { id: onlyOne.id, is_default: false },
    { ...changes, headers: as(many) },
  );
  write(
    'address edit: a bad phone',
    'PATCH',
    addresses,
    { id: home.id, phone: '02-9612345' },
    { ...changes, headers: as(customer) },
  );
  write(
    "address edit: another customer's",
    'PATCH',
    addresses,
    { id: onlyOne.id, city: 'X' },
    { ...changes, headers: as(customer) },
  );
  write(
    'address edit: id not a UUID',
    'PATCH',
    addresses,
    { id: 'home', city: 'X' },
    { ...changes, headers: as(customer) },
  );
  write(
    'address edit: no id',
    'PATCH',
    addresses,
    { city: 'X' },
    { ...changes, headers: as(customer) },
  );
  write('address edit: a list', 'PATCH', addresses, [1], { ...changes, headers: as(customer) });
  add('address delete: the default, the other promoted', `${addresses}?id=${home.id}`, {
    method: 'DELETE',
    reset,
    ...changes,
    headers: as(customer, json),
  });
  add('address delete: not the default', `${addresses}?id=${office.id}`, {
    method: 'DELETE',
    reset,
    ...changes,
    headers: as(customer, json),
  });
  add('address delete: the only one', `${addresses}?id=${onlyOne.id}`, {
    method: 'DELETE',
    reset,
    ...changes,
    headers: as(many, json),
  });
  add("address delete: another customer's", `${addresses}?id=${onlyOne.id}`, {
    method: 'DELETE',
    reset,
    ...changes,
    headers: as(customer, json),
  });
  add('address delete: id not a UUID', `${addresses}?id=nope`, {
    method: 'DELETE',
    reset,
    ...changes,
    headers: as(customer, json),
  });
  add('address delete: no id', addresses, {
    method: 'DELETE',
    reset,
    ...changes,
    headers: as(customer, json),
  });
  add('addresses: PUT', addresses, { method: 'PUT', headers: as(customer) });

  // --- Reviews ---------------------------------------------------------------------
  const review = (slug: string) => `/api/v1/shop/products/${slug}/reviews/`;
  const reviewed = {
    effects: [REVIEWS],
    normalize: (body: unknown) => {
      if (body && typeof body === 'object' && 'id' in body) (body as { id: unknown }).id = '<new>';
    },
  };
  const tee = review('parity-cotton-tee');
  const rated = (name: string, body: unknown, extra: Partial<Case> = {}) =>
    write(`review: ${name}`, 'POST', tee, body, { ...reviewed, headers: as(customer), ...extra });
  rated('the most recent unreviewed purchase', { rating: 5, title: 'Soft', comment: 'Fits well' });
  rated('rating as text, spaced', { rating: ' 3 ' });
  rated('rating in Bengali digits', { rating: '৫' });
  rated('rating with a sign', { rating: '+4' });
  rated('rating a float', '{"rating": 4.0}');
  rated('rating 4.7', { rating: '4.7' });
  rated('rating zero', { rating: 0 });
  rated('rating six', { rating: 6 });
  rated('rating 1_0', { rating: '1_0' });
  rated('rating huge', '{"rating": 100000000000000000000}');
  rated('rating true', { rating: true });
  rated('rating null', { rating: null });
  rated('rating missing', { title: 'x' });
  rated('rating a list', { rating: [5] });
  rated('title null, comment a number', { rating: 5, title: null, comment: 5 });
  rated('title past 140 characters', { rating: 5, title: 'ত'.repeat(150) });
  rated('body a list', [1]);
  rated('malformed JSON', '{"rating": ');
  write(
    'review: already reviewed this purchase',
    'POST',
    review('essential-cotton-t-shirt'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: a review with no order blocks every purchase',
    'POST',
    review('block-print-kurti'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: not received yet',
    'POST',
    review('slim-fit-chinos'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: never bought',
    'POST',
    review('city-handbag'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: unpublished product',
    'POST',
    review('parity-draft'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: unknown product',
    'POST',
    review('no-such-product'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: slug converter refuses',
    'POST',
    review('bad.slug'),
    { rating: 5 },
    { ...reviewed, headers: as(customer) },
  );
  write(
    'review: no customer record',
    'POST',
    tee,
    { rating: 5 },
    { ...reviewed, headers: as(bare) },
  );
  write('review: staff', 'POST', tee, { rating: 5 }, { ...reviewed, headers: as(staff) });
  write('review: anonymous', 'POST', tee, { rating: 5 }, reviewed);
  add('review: GET', tee, { headers: as(customer) });

  return cases;
}
