/**
 * Parity cases for the back office's customers and its call-back list
 * (phase 6 part 6): `/customers/` with the counter's lookup, a customer's
 * orders, addresses and notes, and `/abandoned-checkouts/`. Nothing here
 * moves stock or money; each write is compared by the customers, addresses,
 * notes and leads it made, changed or deleted, by how many default addresses
 * each customer is left with, and by the audit log.
 *
 * The customers are the demo seed's, earlier fixtures' and
 * fixture_customers.py's.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const CUSTOMER_TABLES = [
  'customers_customernote',
  'customers_customeraddress',
  'orders_abandonedcheckout',
  'customers_customer',
];
const NEW = (alias: string, table: string) => `${alias}.id NOT IN (SELECT id FROM "snap_${table}")`;
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(snap) FROM "snap_${table}" snap WHERE snap.id = ${alias}.id)`;
const GONE = (table: string, what: string) =>
  `SELECT '${table}' AS kind, ${what} AS what FROM "snap_${table}" x
    WHERE x.id NOT IN (SELECT id FROM "${table}")`;

export const CUSTOMER_EFFECTS = [
  // 0. Customers a request made or changed.
  `SELECT c.name, c.phone, c.email, c.customer_type, c.is_walk_in, c.is_active,
          c.date_of_birth::text AS born, c.notes, c.tags::text AS tags, c.total_orders,
          c.total_spent::text, c.loyalty_points, c.user_id IS NOT NULL AS has_account,
          u.email AS created_by, ${NEW('c', 'customers_customer')} AS made
     FROM customers_customer c LEFT JOIN accounts_user u ON u.id = c.created_by_id
    WHERE ${CHANGED('c', 'customers_customer')} ORDER BY c.name, c.phone, c.email`,
  // 1. Addresses a request made or changed.
  `SELECT c.name AS customer, a.label, a.address_type, a.recipient_name, a.phone, a.line1, a.line2,
          a.area, a.city, a.district, a.postal_code, a.country, a.is_default, a.notes,
          ${NEW('a', 'customers_customeraddress')} AS made,
          a.updated_at > (SELECT x.updated_at FROM "snap_customers_customeraddress" x WHERE x.id = a.id)
            AS touched
     FROM customers_customeraddress a JOIN customers_customer c ON c.id = a.customer_id
    WHERE ${CHANGED('a', 'customers_customeraddress')} ORDER BY c.name, a.line1, a.label`,
  // 2. How many addresses, and how many defaults, each customer is left with.
  `SELECT c.name, count(a.id) AS addresses, count(a.id) FILTER (WHERE a.is_default) AS defaults
     FROM customers_customer c JOIN customers_customeraddress a ON a.customer_id = c.id
    GROUP BY c.id, c.name ORDER BY c.name, c.id`,
  // 3. Notes a request made.
  `SELECT c.name AS customer, n.body, n.is_pinned, u.email AS created_by
     FROM customers_customernote n JOIN customers_customer c ON c.id = n.customer_id
     LEFT JOIN accounts_user u ON u.id = n.created_by_id
    WHERE ${NEW('n', 'customers_customernote')} ORDER BY c.name, n.body`,
  // 4. What a request deleted.
  `${GONE('customers_customer', 'x.name')} UNION ALL
   ${GONE('customers_customeraddress', 'x.line1')} UNION ALL
   ${GONE('customers_customernote', 'x.body')} UNION ALL
   ${GONE('orders_abandonedcheckout', 'x.phone')} ORDER BY 1, 2`,
  // 5. Leads a request made or changed.
  `SELECT l.phone, l.name, l.email, b.code AS branch, l.status, l.cart_total::text, l.item_count,
          l.recovered_at IS NOT NULL AS recovered, o.number AS recovered_order, l.note,
          l.last_seen_at = (SELECT x.last_seen_at FROM "snap_orders_abandonedcheckout" x WHERE x.id = l.id)
            AS seen_kept,
          ${NEW('l', 'orders_abandonedcheckout')} AS made
     FROM orders_abandonedcheckout l JOIN accounts_branch b ON b.id = l.branch_id
     LEFT JOIN orders_order o ON o.id = l.recovered_order_id
    WHERE ${CHANGED('l', 'orders_abandonedcheckout')}
       OR l.updated_at > (SELECT x.updated_at FROM "snap_orders_abandonedcheckout" x WHERE x.id = l.id)
    ORDER BY l.phone, l.status`,
  // 6. The audit log.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values,
          regexp_replace(a.reason, '[0-9a-f]{8}-[0-9a-f-]{27}', '<id>') AS reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

export async function resetCustomers(client: pg.Client): Promise<void> {
  await restoreTables(client, CUSTOMER_TABLES);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function customersCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (what: string, sql: string) => {
    const found = new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
    // A name the fixtures do not hold is a mistake in this file, not a case.
    return (key: string) => {
      const id = found.get(key);
      if (!id) throw new Error(`customers-cases: no ${what} called ${key}`);
      return id;
    };
  };
  const marker = await db.query(
    `SELECT 1 FROM customers_customer WHERE name = 'Parity Ledger Lady'`,
  );
  if (!marker.rows.length) {
    await db.end();
    console.log('SKIP  customers: fixture_customers.py has not been applied');
    return [];
  }
  const customer = await map('customer', `SELECT name AS key, id FROM customers_customer`);
  const address = await map(
    'address',
    `SELECT c.name || ' ' || COALESCE(NULLIF(a.label, ''), a.line1) AS key, a.id
       FROM customers_customeraddress a JOIN customers_customer c ON c.id = a.customer_id`,
  );
  const note = await map(
    'note',
    `SELECT body AS key, id FROM customers_customernote WHERE body LIKE 'Parity:%'`,
  );
  const lead = await map('lead', `SELECT phone AS key, id FROM orders_abandonedcheckout`);
  const branch = await map('branch', `SELECT code AS key, id FROM accounts_branch`);
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM customers_customer UNION ALL SELECT id::text FROM customers_customeraddress
       UNION ALL SELECT id::text FROM customers_customernote UNION ALL SELECT id::text FROM orders_abandonedcheckout
       UNION ALL SELECT id::text FROM orders_order UNION ALL SELECT id::text FROM accounts_branch`,
    )
  ).rows.map((row) => row.id);
  await db.end();
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `customers: ${name}`, path, headers: auth(who), ...extra });
  const write = (name: string, path: string, body: unknown, who: Who = 'owner', method = 'POST') =>
    cases.push({
      name: `customers: ${name}`,
      method,
      path,
      headers: { ...auth(who), ...JSON_TYPE },
      body: text(body),
      reset: resetCustomers,
      effects: CUSTOMER_EFFECTS,
      normalize: minted,
    });
  const everyone = Object.keys(STAFF) as Who[];
  const CUSTOMERS = '/api/v1/customers/';
  const lady = customer('Parity Ledger Lady');
  const single = customer('Parity One Address');
  const emailOnly = customer('Parity Email Only');
  const gone = customer('Parity Gone');
  const LADY = `${CUSTOMERS}${lady}/`;

  // === Reading =================================================================================
  for (const who of everyone) {
    read(`[${who}] the list`, `${CUSTOMERS}?page_size=3`, who);
    read(`[${who}] a customer`, LADY, who);
    read(`[${who}] a lookup`, `${CUSTOMERS}lookup/?phone=01911000301`, who);
    read(`[${who}] a customer's orders`, `${CUSTOMERS}${customer('Imran Chowdhury')}/orders/`, who);
    read(`[${who}] a customer's addresses`, `${LADY}addresses/`, who);
    read(`[${who}] a customer's notes`, `${LADY}notes/`, who);
  }
  for (const query of [
    '',
    'search=ledger',
    'search=LEDGER%20LADY',
    'search=parity.test',
    'search=01911000301',
    'search=%2B8801911000301',
    'search=8801911',
    'search=1911',
    'search=880',
    'search=0',
    'search=%2B880',
    'search=019-1100',
    'search=zzzz',
    'search=100%25',
    'search=parity_',
    'search=',
    'search=a%00b',
    'customer_type=WHOLESALE',
    'customer_type=WALK_IN',
    'customer_type=GUEST&page_size=4',
    'customer_type=REGISTERED&page_size=4',
    'customer_type=wholesale',
    'customer_type=',
    'is_active=false',
    'is_active=true&page_size=4',
    'is_active=maybe&page_size=4',
    'search=parity&is_active=false&customer_type=GUEST',
    'ordering=name&page_size=6',
    'ordering=-name&page_size=6',
    'ordering=created_at&page_size=6',
    'ordering=-created_at&page_size=6',
    'ordering=total_spent,name&page_size=6',
    'ordering=-total_spent,name&page_size=6',
    'ordering=last_order_at,name&page_size=6',
    'ordering=-last_order_at,name&page_size=6',
    'ordering=phone&page_size=6',
    'page_size=5&page=2',
    'page_size=100',
    'page=99',
  ]) {
    read(`the list ?${query}`, `${CUSTOMERS}?${query}`);
  }
  for (const name of [
    'Parity Email Only',
    'Parity Gone',
    'Parity One Address',
    'Parvin Sultana',
    'Imran Chowdhury',
  ]) {
    read(`the customer ${name}`, `${CUSTOMERS}${customer(name)}/`);
    read(`the orders of ${name}`, `${CUSTOMERS}${customer(name)}/orders/`);
    read(`the addresses of ${name}`, `${CUSTOMERS}${customer(name)}/addresses/`);
    read(`the notes of ${name}`, `${CUSTOMERS}${customer(name)}/notes/`);
  }
  read('a customer who is not there', `${CUSTOMERS}${MISSING}/`);
  read('a customer who is not a uuid', `${CUSTOMERS}abc/`);
  read('a customer, searched out', `${LADY}?search=zzzz`);
  read('a customer, searched in', `${LADY}?search=ledger&ordering=-name`);
  read('a customer, filtered out', `${LADY}?is_active=false`);
  read('a customer with a filter that is not a choice', `${LADY}?customer_type=nope`);
  read('the orders of a customer who is not there', `${CUSTOMERS}${MISSING}/orders/`);
  read('the orders of a customer, filtered out', `${LADY}orders/?is_active=false`);
  read('the addresses of a customer who is not there', `${CUSTOMERS}${MISSING}/addresses/`);
  read('the notes of a customer, searched out', `${LADY}notes/?search=zzzz`);
  for (const phone of [
    '01911000301',
    '%2B8801911000301',
    '8801911000301',
    '019110003',
    '0191',
    '191',
    '301',
    '30',
    '3',
    '',
    '880',
    '0',
    '%2B880',
    'abc',
    '019-1100-0301',
    '01911000302',
    '99999999',
    'a%00b',
  ]) {
    read(`a lookup of ${phone || 'nothing'}`, `${CUSTOMERS}lookup/?phone=${phone}`);
  }
  read('a lookup with no phone', `${CUSTOMERS}lookup/`);
  read(
    'a lookup, with the list’s filters',
    `${CUSTOMERS}lookup/?phone=1911&is_active=false&search=zzzz`,
  );
  read('POST the lookup', `${CUSTOMERS}lookup/`, 'owner', { method: 'POST' });
  read('GET an address', `${LADY}addresses/${address('Parity Ledger Lady Shop')}/`);
  read('GET a note', `${LADY}notes/${note('Parity: asked for a catalogue')}/`);
  read('PUT the orders', `${LADY}orders/`, 'owner', { method: 'PUT' });

  // === Customers: writing ======================================================================
  const fresh = { name: 'Parity New Face', phone: '01911000399' };
  for (const who of everyone) write(`[${who}] add a customer`, CUSTOMERS, fresh, who);
  for (const [name, body] of [
    ['a name and a phone', fresh],
    ['a name and an email', { name: 'Parity New Face', email: ' New.Face@Parity.TEST ' }],
    [
      'everything stated',
      {
        name: '  Parity New Face  ',
        phone: '+880 1911-000399',
        email: 'new.face@parity.test',
        customer_type: 'WHOLESALE',
        is_active: false,
        date_of_birth: '1990-02-03',
        notes: 'Met at the fair',
        tags: ['fair', 3.0, { tier: null }],
      },
    ],
    [
      'what it may not state',
      {
        ...fresh,
        is_walk_in: true,
        total_orders: 9,
        total_spent: '9.00',
        loyalty_points: 5,
        id: MISSING,
        has_account: true,
      },
    ],
    ['a name alone', { name: 'Parity New Face' }],
    ['a blank phone and a blank email', { name: 'Parity New Face', phone: '', email: '' }],
    ['a null phone and a null email', { name: 'Parity New Face', phone: null, email: null }],
    [
      'a blank phone and an email',
      { name: 'Parity New Face', phone: '', email: 'new.face@parity.test' },
    ],
    ['a phone another customer has', { name: 'Parity New Face', phone: '01911000301' }],
    [
      'a phone another has, spelled another way',
      { name: 'Parity New Face', phone: '+8801911000301' },
    ],
    ['a phone that is not a mobile', { name: 'Parity New Face', phone: '02-9612345' }],
    ['a phone in Bengali digits', { name: 'Parity New Face', phone: '০১৯১১০০০৩৯৯' }],
    ['a phone that is a number', { name: 'Parity New Face', phone: 1911000399 }],
    ['a phone of 33 characters', { name: 'Parity New Face', phone: '0'.repeat(33) }],
    [
      'an email another customer has',
      { name: 'Parity New Face', email: 'ledger.lady@parity.test' },
    ],
    [
      'an email another has, in another case',
      { name: 'Parity New Face', email: 'Ledger.Lady@Parity.Test' },
    ],
    ['an email that is not one', { name: 'Parity New Face', email: 'not an email' }],
    [
      'an email of 255 characters',
      { name: 'Parity New Face', email: `${'a'.repeat(244)}@parity.test` },
    ],
    [
      'a phone and an email both taken',
      { name: 'Parity New Face', phone: '01911000301', email: 'ledger.lady@parity.test' },
    ],
    ['a blank name', { ...fresh, name: '' }],
    ['a name of 160 characters', { ...fresh, name: 'n'.repeat(160) }],
    ['a name of 161 characters', { ...fresh, name: 'n'.repeat(161) }],
    ['no name', { phone: '01911000399' }],
    ['a null name', { ...fresh, name: null }],
    ['a type that is not one', { ...fresh, customer_type: 'VIP' }],
    ['the walk-in type', { ...fresh, customer_type: 'WALK_IN' }],
    ['a null type', { ...fresh, customer_type: null }],
    ['an active switch that is not a boolean', { ...fresh, is_active: 'maybe' }],
    ['a birthday', { ...fresh, date_of_birth: '2001-12-31' }],
    ['a birthday typed the local way', { ...fresh, date_of_birth: '31/12/2001' }],
    ['a birthday that is not a day', { ...fresh, date_of_birth: '2001-02-30' }],
    ['a null birthday', { ...fresh, date_of_birth: null }],
    ['a blank birthday', { ...fresh, date_of_birth: '' }],
    ['a birthday in the future', { ...fresh, date_of_birth: '2099-01-01' }],
    ['null notes', { ...fresh, notes: null }],
    ['tags that are a word', { ...fresh, tags: 'vip' }],
    ['tags that are an object', { ...fresh, tags: { a: [1, 2.5, true] } }],
    ['tags that are a number', { ...fresh, tags: 7 }],
    [
      'tags with a float and a long integer',
      `{"name":"Parity New Face","phone":"01911000399","tags":[1.0,2.50,12345678901234567890,1e2]}`,
    ],
    ['null tags', { ...fresh, tags: null }],
    [
      'every field wrong',
      {
        name: '',
        phone: 'x',
        email: 'y',
        customer_type: 'z',
        is_active: 'w',
        date_of_birth: 'v',
        notes: [],
        tags: null,
      },
    ],
    ['a body that is a list', [fresh]],
    ['broken JSON', '{"name":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`add a customer: ${name}`, CUSTOMERS, body);
  }
  for (const who of everyone)
    write(`[${who}] edit a customer`, LADY, { notes: 'Buys by the pallet' }, who, 'PATCH');
  for (const [name, target, body] of [
    ['renamed', lady, { name: 'Parity Ledger Madam' }],
    ['renamed to nothing', lady, { name: '' }],
    ['a new phone', lady, { phone: '01911-000398' }],
    ['their own phone, spelled another way', lady, { phone: '+8801911000301' }],
    ['another customer’s phone', lady, { phone: '01911000302' }],
    ['the phone taken off', lady, { phone: '' }],
    ['the phone nulled', lady, { phone: null }],
    ['the email taken off', lady, { email: '' }],
    ['the phone and the email taken off', lady, { phone: '', email: null }],
    ['the email taken off one who has no phone', emailOnly, { email: '' }],
    ['the phone taken off one who has no email', single, { phone: '' }],
    ['the notes of one who has no phone', emailOnly, { notes: 'x' }],
    ['a phone given to one who had none', emailOnly, { phone: '01911000397', email: '' }],
    ['another customer’s email', lady, { email: 'email.only@parity.test' }],
    ['another customer’s email, in another case', lady, { email: 'EMAIL.ONLY@parity.test' }],
    ['their own email, in another case', lady, { email: 'LEDGER.LADY@PARITY.TEST' }],
    ['a new type', lady, { customer_type: 'REGISTERED' }],
    ['deactivated', lady, { is_active: false }],
    ['brought back', gone, { is_active: true }],
    ['the birthday taken off', lady, { date_of_birth: null }],
    ['new tags', lady, { tags: ['wholesale'] }],
    ['tags emptied', lady, { tags: [] }],
    ['null tags', lady, { tags: null }],
    ['what it may not state', lady, { is_walk_in: true, total_spent: '1.00', loyalty_points: 50 }],
    ['nothing at all', lady, {}],
    ['a body that is a list', lady, []],
    ['broken JSON', lady, '{'],
    ['the walk-in record', customer('Walk-in (DHK1)'), { name: 'Anyone' }],
  ] as [string, string, unknown][]) {
    write(`edit a customer: ${name}`, `${CUSTOMERS}${target}/`, body, 'owner', 'PATCH');
  }
  for (const [name, body] of [
    ['a name alone', { name: 'Parity Ledger Madam' }],
    [
      'everything restated',
      {
        name: 'Parity Ledger Lady',
        phone: '01911000301',
        email: 'ledger.lady@parity.test',
        customer_type: 'WHOLESALE',
        tags: [],
      },
    ],
    ['nothing', {}],
  ] as [string, unknown][]) {
    write(`edit a customer, by PUT: ${name}`, LADY, body, 'owner', 'PUT');
  }
  write(
    'edit a customer: one who is not there',
    `${CUSTOMERS}${MISSING}/`,
    { name: 'x' },
    'owner',
    'PATCH',
  );
  write(
    'edit a customer: one who is not there, with broken JSON',
    `${CUSTOMERS}${MISSING}/`,
    '{',
    'owner',
    'PATCH',
  );
  write('edit a customer: searched out', `${LADY}?search=zzzz`, { notes: 'x' }, 'owner', 'PATCH');
  for (const who of everyone) write(`[${who}] delete a customer`, LADY, undefined, who, 'DELETE');
  write(
    'delete a customer: one already deactivated',
    `${CUSTOMERS}${gone}/`,
    undefined,
    'owner',
    'DELETE',
  );
  write(
    'delete a customer: one with orders',
    `${CUSTOMERS}${customer('Imran Chowdhury')}/`,
    undefined,
    'owner',
    'DELETE',
  );
  write(
    'delete a customer: one who is not there',
    `${CUSTOMERS}${MISSING}/`,
    undefined,
    'owner',
    'DELETE',
  );
  write('delete a customer: filtered out', `${LADY}?is_active=false`, undefined, 'owner', 'DELETE');

  // === Addresses ===============================================================================
  const home = {
    recipient_name: 'Ledger Lady',
    phone: '01911000301',
    line1: 'House 5',
    city: 'Dhaka',
  };
  const shop = address('Parity Ledger Lady Shop');
  const godown = address('Parity Ledger Lady Godown');
  const only = address('Parity One Address House 1, Road 1');
  for (const who of everyone) write(`[${who}] add an address`, `${LADY}addresses/`, home, who);
  for (const [name, target, body] of [
    ['the fields it needs', lady, home],
    [
      'everything stated',
      lady,
      {
        ...home,
        label: 'Flat',
        address_type: 'BILLING',
        phone: '+880 1911 000301',
        line2: 'Lane 2',
        area: 'Banani',
        district: 'Dhaka',
        postal_code: '1213',
        country: 'Bangladesh',
        is_default: true,
        notes: 'Third floor',
      },
    ],
    ['made the default', lady, { ...home, is_default: true }],
    ['not made the default', lady, { ...home, is_default: false }],
    ['the first address of a customer', emailOnly, { ...home, is_default: false }],
    ['for a deactivated customer', gone, home],
    ['a customer stated in the body', lady, { ...home, customer: single, id: MISSING }],
    ['a phone that is not a mobile', lady, { ...home, phone: '02-9612345' }],
    ['a blank phone', lady, { ...home, phone: '' }],
    ['no phone', lady, { recipient_name: 'L', line1: 'H', city: 'D' }],
    ['a type that is not one', lady, { ...home, address_type: 'WORK' }],
    ['a label of 41 characters', lady, { ...home, label: 'l'.repeat(41) }],
    ['a null country', lady, { ...home, country: null }],
    ['a blank country', lady, { ...home, country: '' }],
    ['nothing', lady, {}],
    ['a body that is a list', lady, [home]],
    ['broken JSON', lady, '{'],
    ['for a customer who is not there', MISSING, home],
    ['for a customer who is not there, with a body that is wrong', MISSING, {}],
  ] as [string, string, unknown][]) {
    write(`add an address: ${name}`, `${CUSTOMERS}${target}/addresses/`, body);
  }
  for (const who of everyone)
    write(
      `[${who}] edit an address`,
      `${LADY}addresses/${godown}/`,
      { area: 'Tongi' },
      who,
      'PATCH',
    );
  for (const [name, target, id, body] of [
    ['its city', lady, godown, { city: 'Tongi' }],
    ['made the default', lady, godown, { is_default: true }],
    ['the default un-defaulted', lady, shop, { is_default: false }],
    ['the only address un-defaulted', single, only, { is_default: false }],
    ['its phone, spelled another way', lady, godown, { phone: '+8801911000301' }],
    ['a phone that is not a mobile', lady, godown, { phone: '12345' }],
    ['its type', lady, godown, { address_type: 'BILLING' }],
    ['a customer stated in the body', lady, godown, { customer: single }],
    ['nothing at all', lady, godown, {}],
    ['a body that is a list', lady, godown, []],
    ['broken JSON', lady, godown, '{'],
    ['another customer’s address', lady, only, { city: 'X' }],
    ['one that is not there', lady, MISSING, { city: 'X' }],
    ['one that is not a uuid', lady, 'abc', { city: 'X' }],
    ['one that is not a uuid, with broken JSON', lady, 'abc', '{'],
    ['of a customer who is not there', MISSING, godown, { city: 'X' }],
  ] as [string, string, string, unknown][]) {
    write(
      `edit an address: ${name}`,
      `${CUSTOMERS}${target}/addresses/${id}/`,
      body,
      'owner',
      'PATCH',
    );
  }
  write('edit an address: by PUT', `${LADY}addresses/${godown}/`, { city: 'X' }, 'owner', 'PUT');
  write(
    'edit an address: [manager] by PUT',
    `${LADY}addresses/${godown}/`,
    { city: 'X' },
    'manager',
    'PUT',
  );
  write('edit an address: by POST', `${LADY}addresses/${godown}/`, { city: 'X' }, 'owner', 'POST');
  for (const who of everyone)
    write(`[${who}] delete an address`, `${LADY}addresses/${godown}/`, undefined, who, 'DELETE');
  for (const [name, target, id] of [
    ['the default, with another on file', lady, shop],
    ['the only one', single, only],
    ['another customer’s', lady, only],
    ['one that is not there', lady, MISSING],
    ['one that is not a uuid', lady, 'abc'],
    ['of a customer who is not there', MISSING, shop],
  ] as [string, string, string][]) {
    write(
      `delete an address: ${name}`,
      `${CUSTOMERS}${target}/addresses/${id}/`,
      undefined,
      'owner',
      'DELETE',
    );
  }

  // === Notes ===================================================================================
  for (const who of everyone)
    write(`[${who}] add a note`, `${LADY}notes/`, { body: 'Prefers a call before delivery' }, who);
  for (const [name, target, body] of [
    ['a body alone', lady, { body: 'Prefers a call before delivery' }],
    ['pinned', lady, { body: '  Credit limit 50,000  ', is_pinned: true }],
    ['a long body', lady, { body: 'n'.repeat(5000) }],
    ['a body in Bengali', lady, { body: 'সন্ধ্যার পরে ফোন করবেন' }],
    ['a blank body', lady, { body: '' }],
    ['a body of spaces', lady, { body: '   ' }],
    ['no body field', lady, { is_pinned: true }],
    ['a null body', lady, { body: null }],
    ['a body that is a number', lady, { body: 42 }],
    ['a pin that is not a boolean', lady, { body: 'x', is_pinned: 'maybe' }],
    [
      'what it may not state',
      lady,
      { body: 'x', customer: single, created_by_email: 'x@y.z', created_at: '2020-01-01' },
    ],
    ['a body that is a list', lady, ['x']],
    ['broken JSON', lady, '{'],
    ['for a deactivated customer', gone, { body: 'x' }],
    ['for a customer who is not there', MISSING, { body: 'x' }],
  ] as [string, string, unknown][]) {
    write(`add a note: ${name}`, `${CUSTOMERS}${target}/notes/`, body);
  }
  const pinned = note('Parity: pays on the 5th of the month');
  for (const who of everyone)
    write(`[${who}] delete a note`, `${LADY}notes/${pinned}/`, undefined, who, 'DELETE');
  for (const [name, target, id] of [
    ['one not pinned', lady, note('Parity: asked for a catalogue')],
    ['another customer’s', single, pinned],
    ['one that is not there', lady, MISSING],
    ['one that is not a uuid', lady, 'abc'],
    ['of a customer who is not there', MISSING, pinned],
  ] as [string, string, string][]) {
    write(
      `delete a note: ${name}`,
      `${CUSTOMERS}${target}/notes/${id}/`,
      undefined,
      'owner',
      'DELETE',
    );
  }
  write('edit a note', `${LADY}notes/${pinned}/`, { body: 'x' }, 'owner', 'PATCH');

  // === The call-back list ======================================================================
  const LEADS = '/api/v1/abandoned-checkouts/';
  const open = lead('8801711000078');
  const recovered = lead('8801911000311');
  const lost = lead('8801911000312');
  const away = lead('8801911000313');
  for (const who of everyone) {
    read(`[${who}] the call-back list`, LEADS, who);
    read(`[${who}] a lead`, `${LEADS}${open}/`, who);
    read(`[${who}] another branch’s lead`, `${LEADS}${away}/`, who);
  }
  for (const query of [
    'status=OPEN',
    'status=RECOVERED',
    'status=LOST',
    'status=open',
    'status=',
    `branch=${branch('DHK1')}`,
    `branch=${branch('PAR3')}`,
    `branch=${MISSING}`,
    'branch=abc',
    `status=OPEN&branch=${branch('PAR3')}`,
    'status=x&branch=y',
    'ordering=phone',
    'ordering=-phone',
    'ordering=name,phone',
    'ordering=email,phone',
    'ordering=status,phone',
    'ordering=-cart_total',
    'ordering=item_count,phone',
    'ordering=branch__code,phone',
    'ordering=-branch__code,phone',
    'ordering=branch_code,phone',
    'ordering=branch',
    'ordering=last_seen_at',
    'ordering=recovered_at,phone',
    'ordering=-recovered_at,phone',
    'ordering=recovered_order__number,phone',
    'ordering=recovered_order_number',
    'ordering=note,phone',
    'ordering=created_at',
    'ordering=id',
    'search=parity',
    'page_size=2',
    'page_size=2&page=2',
    'page=99',
  ]) {
    read(`the call-back list ?${query}`, `${LEADS}?${query}`);
  }
  for (const [name, id] of [
    ['recovered', recovered],
    ['written off', lost],
  ] as const)
    read(`a lead ${name}`, `${LEADS}${id}/`);
  read('a lead that is not there', `${LEADS}${MISSING}/`);
  read('a lead that is not a uuid', `${LEADS}abc/`);
  read('a lead, filtered out', `${LEADS}${open}/?status=LOST`);
  read('[mirpur] their own branch’s lead', `${LEADS}${away}/`, 'mirpur');
  read('DELETE a lead', `${LEADS}${open}/`, 'owner', { method: 'DELETE' });
  read('[cashier] DELETE a lead', `${LEADS}${open}/`, 'cashier', { method: 'DELETE' });
  read('POST the call-back list', LEADS, 'owner', { method: 'POST' });
  read('GET lost', `${LEADS}${open}/lost/`);
  for (const who of everyone) {
    write(`[${who}] note a lead`, `${LEADS}${open}/`, { note: 'Called, no answer' }, who, 'PATCH');
    write(`[${who}] write a lead off`, `${LEADS}${open}/lost/`, { note: 'Not interested' }, who);
  }
  for (const [name, id, body, method] of [
    ['a padded note', open, { note: '  Called twice  ' }, 'PATCH'],
    ['a blank note', recovered, { note: '' }, 'PATCH'],
    ['a null note', open, { note: null }, 'PATCH'],
    ['a note that is a number', open, { note: 5 }, 'PATCH'],
    [
      'what it may not state',
      open,
      { status: 'RECOVERED', phone: '01700000000', cart_total: '1.00', note: 'x' },
      'PATCH',
    ],
    ['nothing at all', open, {}, 'PATCH'],
    ['a recovered lead', recovered, { note: 'Thanked them' }, 'PATCH'],
    ['a body that is a list', open, [], 'PATCH'],
    ['broken JSON', open, '{', 'PATCH'],
    ['by PUT', open, { note: 'Called, no answer' }, 'PUT'],
    ['by PUT, nothing', open, {}, 'PUT'],
    ['by PUT, a recovered lead', recovered, { note: 'Thanked them' }, 'PUT'],
    ['one that is not there', MISSING, { note: 'x' }, 'PATCH'],
    ['one that is not there, with broken JSON', MISSING, '{', 'PATCH'],
  ] as [string, string, unknown, string][]) {
    write(`note a lead: ${name}`, `${LEADS}${id}/`, body, 'owner', method);
  }
  write(
    'note a lead: filtered out',
    `${LEADS}${open}/?status=LOST`,
    { note: 'x' },
    'owner',
    'PATCH',
  );
  write(
    'note a lead: [manager] another branch’s',
    `${LEADS}${away}/`,
    { note: 'x' },
    'manager',
    'PATCH',
  );
  for (const [name, id, body] of [
    ['with a note', open, { note: '  Not interested  ' }],
    ['with no note', open, {}],
    ['with no body', open, undefined],
    ['with a blank note', lost, { note: '' }],
    ['with a note of spaces', lost, { note: '   ' }],
    ['with a null note', open, { note: null }],
    ['with a note that is a number', open, { note: 5 }],
    ['with a note that is a list', open, { note: ['a', 1] }],
    ['with a note that is false', open, { note: false }],
    ['one already written off', lost, { note: 'Again' }],
    ['one already recovered', recovered, { note: 'Changed their mind' }],
    ['with a body that is a list', open, ['x']],
    ['with broken JSON', open, '{'],
    ['one that is not there', MISSING, { note: 'x' }],
    ['one that is not there, with a body that is a list', MISSING, []],
  ] as [string, string, unknown][]) {
    write(`write a lead off: ${name}`, `${LEADS}${id}/lost/`, body);
  }
  write('write a lead off: filtered out', `${LEADS}${open}/lost/?status=LOST`, { note: 'x' });
  write(
    'write a lead off: [manager] another branch’s',
    `${LEADS}${away}/lost/`,
    { note: 'x' },
    'manager',
  );
  return cases;
}
