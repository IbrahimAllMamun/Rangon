/**
 * Parity cases for the back office's coupons (phase 6 part 7): `/coupons/`
 * and a coupon's redemptions. What a coupon is worth at a checkout was
 * phase 3; this is the screen that makes and edits them. Each write is
 * compared by the coupons made, changed or deleted, by every coupon's
 * category and product restrictions, and by the carts and orders a delete
 * leaves without a coupon.
 *
 * The coupons are the demo seed's and the earlier fixtures'.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const COUPON_TABLES = [
  'promotions_coupon_categories',
  'promotions_coupon_products',
  'orders_cart',
  'orders_order',
  'promotions_coupon',
];
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(snap) FROM "snap_${table}" snap WHERE snap.id = ${alias}.id)`;

export const COUPON_EFFECTS = [
  // 0. Coupons a request made or changed.
  `SELECT c.code, c.description, c.discount_type, c.value::text, c.minimum_order_value::text,
          c.maximum_discount::text, (c.starts_at AT TIME ZONE 'UTC')::text AS starts,
          (c.ends_at AT TIME ZONE 'UTC')::text AS ends, c.usage_limit, c.usage_limit_per_customer,
          c.used_count, c.channels::text AS channels, c.is_active, u.email AS created_by,
          c.id NOT IN (SELECT id FROM "snap_promotions_coupon") AS made
     FROM promotions_coupon c LEFT JOIN accounts_user u ON u.id = c.created_by_id
    WHERE ${CHANGED('c', 'promotions_coupon')} ORDER BY c.code`,
  // 1. Every coupon's restrictions.
  `SELECT c.code, 'category' AS kind, k.slug FROM promotions_coupon_categories x
     JOIN promotions_coupon c ON c.id = x.coupon_id JOIN catalog_category k ON k.id = x.category_id
   UNION ALL
   SELECT c.code, 'product', p.slug FROM promotions_coupon_products x
     JOIN promotions_coupon c ON c.id = x.coupon_id JOIN catalog_product p ON p.id = x.product_id
   ORDER BY 1, 2, 3`,
  // 2. Coupons deleted.
  `SELECT x.code FROM "snap_promotions_coupon" x
    WHERE x.id NOT IN (SELECT id FROM promotions_coupon) ORDER BY x.code`,
  // 3. Carts and orders left without the coupon they named.
  `SELECT 'cart' AS kind, x.id::text AS what FROM orders_cart x JOIN "snap_orders_cart" s ON s.id = x.id
    WHERE x.coupon_id IS DISTINCT FROM s.coupon_id
   UNION ALL
   SELECT 'order', x.number FROM orders_order x JOIN "snap_orders_order" s ON s.id = x.id
    WHERE x.coupon_id IS DISTINCT FROM s.coupon_id ORDER BY 1, 2`,
  // 4. The audit log.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason
     FROM core_auditlog a WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

export async function resetCoupons(client: pg.Client): Promise<void> {
  await restoreTables(client, COUPON_TABLES);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function couponsCases(): Promise<Case[]> {
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
      if (!id) throw new Error(`coupons-cases: no ${what} called ${key}`);
      return id;
    };
  };
  const coupon = await map('coupon', `SELECT code AS key, id FROM promotions_coupon`);
  const categories = (
    await db.query<{ id: string }>(`SELECT id FROM catalog_category ORDER BY slug LIMIT 3`)
  ).rows.map((row) => row.id);
  const products = (
    await db.query<{ id: string }>(`SELECT id FROM catalog_product ORDER BY slug LIMIT 3`)
  ).rows.map((row) => row.id);
  const carted = (
    await db.query<{ code: string }>(
      `SELECT c.code FROM promotions_coupon c
        WHERE EXISTS (SELECT 1 FROM orders_cart x WHERE x.coupon_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM promotions_couponredemption r WHERE r.coupon_id = c.id)
        ORDER BY c.code LIMIT 1`,
    )
  ).rows[0]?.code;
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM promotions_coupon UNION ALL SELECT id::text FROM catalog_category
       UNION ALL SELECT id::text FROM catalog_product UNION ALL SELECT id::text FROM orders_order
       UNION ALL SELECT id::text FROM customers_customer
       UNION ALL SELECT id::text FROM promotions_couponredemption`,
    )
  ).rows.map((row) => row.id);
  await db.end();
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const COUPONS = '/api/v1/coupons/';
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `coupons: ${name}`, path, headers: auth(who), ...extra });
  const write = (name: string, path: string, body: unknown, who: Who = 'owner', method = 'POST') =>
    cases.push({
      name: `coupons: ${name}`,
      method,
      path,
      headers: { ...auth(who), ...JSON_TYPE },
      body: text(body),
      reset: resetCoupons,
      effects: COUPON_EFFECTS,
      normalize: minted,
    });
  const everyone = Object.keys(STAFF) as Who[];
  const plain = coupon('PARITY-BIG');
  const byCategory = coupon('PARITY-CAT');
  const byProduct = coupon('PARITY-PRODUCT');
  const used = coupon('PARITY-ONCE');
  const PLAIN = `${COUPONS}${plain}/`;

  // === Reading =================================================================================
  for (const who of everyone) {
    read(`[${who}] the list`, `${COUPONS}?page_size=3`, who);
    read(`[${who}] a coupon`, PLAIN, who);
    read(`[${who}] a coupon's redemptions`, `${COUPONS}${used}/redemptions/`, who);
  }
  for (const query of [
    '',
    'is_active=true&page_size=4',
    'is_active=false',
    'is_active=maybe&page_size=4',
    'discount_type=PERCENTAGE',
    'discount_type=FIXED&page_size=4',
    'discount_type=FREE_SHIPPING',
    'discount_type=percentage',
    'discount_type=',
    'is_active=true&discount_type=FREE_SHIPPING',
    'ordering=created_at&page_size=5',
    'ordering=-created_at&page_size=5',
    'ordering=used_count,created_at&page_size=5',
    'ordering=-used_count,created_at&page_size=5',
    'ordering=code&page_size=5',
    'search=PARITY&page_size=2',
    'page_size=4&page=2',
    'page_size=100',
    'page=99',
  ]) {
    read(`the list ?${query}`, `${COUPONS}?${query}`);
  }
  for (const code of [
    'PARITY-CAT',
    'PARITY-PRODUCT',
    'PARITY-ONCE',
    'PARITY-TWICE',
    'PARITY-STR',
    'PARITY-OFF',
    'PARITY-USED',
    'FREESHIP',
    'RANGON10',
    'STORE100',
    'EXPIRED50',
  ]) {
    read(`the coupon ${code}`, `${COUPONS}${coupon(code)}/`);
    read(`the redemptions of ${code}`, `${COUPONS}${coupon(code)}/redemptions/`);
  }
  read('a coupon that is not there', `${COUPONS}${MISSING}/`);
  read('a coupon that is not a uuid', `${COUPONS}abc/`);
  read('a coupon by its code', `${COUPONS}RANGON10/`);
  read('a coupon, filtered out', `${PLAIN}?is_active=false`);
  read('a coupon, filtered in and ordered', `${PLAIN}?discount_type=FIXED&ordering=used_count`);
  read('a coupon with a filter that is not a choice', `${PLAIN}?discount_type=nope`);
  read('the redemptions of a coupon that is not there', `${COUPONS}${MISSING}/redemptions/`);
  read(
    'the redemptions of a coupon, filtered out',
    `${COUPONS}${used}/redemptions/?is_active=false`,
  );
  read('POST the redemptions', `${COUPONS}${used}/redemptions/`, 'owner', { method: 'POST' });

  // === Making ==================================================================================
  const fixed = { code: 'PARITY-NEW', discount_type: 'FIXED', value: '50' };
  for (const who of everyone) write(`[${who}] make a coupon`, COUPONS, fixed, who);
  for (const [name, body] of [
    ['a fixed amount', fixed],
    ['a percentage', { code: 'PARITY-NEW', discount_type: 'PERCENTAGE', value: '12.5' }],
    ['free delivery', { code: 'PARITY-NEW', discount_type: 'FREE_SHIPPING' }],
    [
      'free delivery with an amount beside it',
      { code: 'PARITY-NEW', discount_type: 'FREE_SHIPPING', value: '55' },
    ],
    [
      'free delivery with an amount below zero',
      { code: 'PARITY-NEW', discount_type: 'FREE_SHIPPING', value: '-5' },
    ],
    [
      'everything stated',
      {
        code: '  parity-new  ',
        description: 'A tenth off shirts',
        discount_type: 'PERCENTAGE',
        value: '10',
        minimum_order_value: '1500',
        maximum_discount: '300.5',
        starts_at: '2026-11-01T00:00:00+06:00',
        ends_at: '2026-12-01T23:59:59+06:00',
        usage_limit: 100,
        usage_limit_per_customer: 2,
        categories: [categories[1], categories[0], categories[1]],
        products: [products[0], products[2]],
        channels: ['ONLINE', 'POS', 'ONLINE'],
        is_active: false,
      },
    ],
    [
      'what it may not state',
      { ...fixed, used_count: 9, is_exhausted: true, id: MISSING, created_at: '2020-01-01' },
    ],
    ['a code in lower case', { ...fixed, code: 'parity-new' }],
    ['a code another coupon has', { ...fixed, code: 'RANGON10' }],
    ['a code another has, in lower case', { ...fixed, code: 'rangon10' }],
    ['a code another has, padded', { ...fixed, code: ' RANGON10 ' }],
    ['a code with a space inside', { ...fixed, code: 'PARITY NEW' }],
    ['a code of 32 characters', { ...fixed, code: 'C'.repeat(32) }],
    ['a code of 33 characters', { ...fixed, code: 'C'.repeat(33) }],
    ['a blank code', { ...fixed, code: '' }],
    ['no code', { discount_type: 'FIXED', value: '50' }],
    ['a description of 256 characters', { ...fixed, description: 'd'.repeat(256) }],
    ['no type', { code: 'PARITY-NEW', value: '50' }],
    ['a type that is not one', { ...fixed, discount_type: 'BOGO' }],
    ['no value', { code: 'PARITY-NEW', discount_type: 'FIXED' }],
    ['a null value', { ...fixed, value: null }],
    ['a value of nothing', { ...fixed, value: '0' }],
    ['a value below zero', { ...fixed, value: '-1' }],
    ['a value to three places', { ...fixed, value: '1.005' }],
    ['a value of nine whole digits', { ...fixed, value: '123456789' }],
    ['a value of eight whole digits', { ...fixed, value: '12345678.99' }],
    ['a percentage of 100', { code: 'PARITY-NEW', discount_type: 'PERCENTAGE', value: '100' }],
    ['a percentage past 100', { code: 'PARITY-NEW', discount_type: 'PERCENTAGE', value: '100.01' }],
    ['a minimum below zero', { ...fixed, minimum_order_value: '-1' }],
    ['a null minimum', { ...fixed, minimum_order_value: null }],
    ['a null cap', { ...fixed, maximum_discount: null }],
    ['a blank cap', { ...fixed, maximum_discount: '' }],
    ['a cap below zero', { ...fixed, maximum_discount: '-1' }],
    [
      'a window',
      { ...fixed, starts_at: '2026-11-01T00:00:00+06:00', ends_at: '2026-11-02T00:00:00+06:00' },
    ],
    ['a window of bare days', { ...fixed, starts_at: '2026-11-01', ends_at: '2026-11-02' }],
    [
      'a window that ends as it starts',
      { ...fixed, starts_at: '2026-11-01T00:00:00+06:00', ends_at: '2026-11-01T00:00:00+06:00' },
    ],
    [
      'a window that ends as it starts, in two zones',
      { ...fixed, starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-01T06:00:00+06:00' },
    ],
    [
      'a window that ends before it starts',
      { ...fixed, starts_at: '2026-11-02T00:00:00+06:00', ends_at: '2026-11-01T00:00:00+06:00' },
    ],
    ['a start alone', { ...fixed, starts_at: '2026-11-01T00:00:00+06:00' }],
    ['an end alone, long past', { ...fixed, ends_at: '2001-01-01T00:00:00Z' }],
    ['a null window', { ...fixed, starts_at: null, ends_at: null }],
    ['a start that is not a moment', { ...fixed, starts_at: 'next week' }],
    [
      'a window that is wrong and a value that is wrong',
      { ...fixed, value: '0', starts_at: '2026-11-02', ends_at: '2026-11-01' },
    ],
    ['a limit of nothing', { ...fixed, usage_limit: 0 }],
    ['a limit below zero', { ...fixed, usage_limit: -1 }],
    ['a limit past an int', { ...fixed, usage_limit: 2147483648 }],
    ['a null limit', { ...fixed, usage_limit: null }],
    ['a null limit each', { ...fixed, usage_limit_per_customer: null }],
    ['a limit each of nothing', { ...fixed, usage_limit_per_customer: 0 }],
    ['a limit that is a word', { ...fixed, usage_limit: 'many' }],
    ['categories', { ...fixed, categories }],
    ['no categories', { ...fixed, categories: [] }],
    ['null categories', { ...fixed, categories: null }],
    ['categories that are a word', { ...fixed, categories: 'shirts' }],
    ['categories that are an object', { ...fixed, categories: { a: 1 } }],
    ['a category that is not there', { ...fixed, categories: [categories[0], MISSING] }],
    ['a category that is not a uuid', { ...fixed, categories: ['abc'] }],
    ['a category that is null', { ...fixed, categories: [null] }],
    ['a category that is true', { ...fixed, categories: [true] }],
    ['a category that is a number', { ...fixed, categories: [7] }],
    ['a category that is a product', { ...fixed, categories: [products[0]] }],
    ['products', { ...fixed, products }],
    ['a product that is not there', { ...fixed, products: [MISSING] }],
    ['a category and a product both wrong', { ...fixed, categories: ['abc'], products: [null] }],
    ['channels', { ...fixed, channels: ['SOCIAL', 'POS'] }],
    [
      'every channel, in any order',
      { ...fixed, channels: ['OTHER', 'SOCIAL', 'PHONE', 'ONLINE', 'POS'] },
    ],
    ['no channels', { ...fixed, channels: [] }],
    ['blank channels', { ...fixed, channels: '' }],
    ['null channels', { ...fixed, channels: null }],
    ['channels that are a word', { ...fixed, channels: 'POS' }],
    ['channels that are an object', { ...fixed, channels: { POS: true } }],
    ['channels that are a number', { ...fixed, channels: 0 }],
    ['channels that are false', { ...fixed, channels: false }],
    ['a channel that is not one', { ...fixed, channels: ['POS', 'WEB', 'APP', 'APP'] }],
    ['a channel in lower case', { ...fixed, channels: ['pos'] }],
    ['a channel that is a number', { ...fixed, channels: ['POS', 1] }],
    ['an active switch that is not a boolean', { ...fixed, is_active: 'maybe' }],
    [
      'every field wrong',
      {
        code: '',
        discount_type: 'x',
        value: 'y',
        minimum_order_value: 'z',
        maximum_discount: 'w',
        starts_at: 'v',
        ends_at: 'u',
        usage_limit: 't',
        usage_limit_per_customer: 's',
        categories: 'r',
        products: 'q',
        channels: 'p',
        is_active: 'o',
      },
    ],
    ['a body that is a list', [fixed]],
    ['broken JSON', '{"code":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`make a coupon: ${name}`, COUPONS, body);
  }

  // === Editing =================================================================================
  for (const who of everyone)
    write(`[${who}] edit a coupon`, PLAIN, { description: 'A big one' }, who, 'PATCH');
  for (const [name, code, body] of [
    ['its description', 'PARITY-BIG', { description: 'A big one' }],
    ['its code', 'PARITY-BIG', { code: 'parity-bigger' }],
    ['its code to another’s', 'PARITY-BIG', { code: 'RANGON10' }],
    ['its code to another’s, in lower case', 'PARITY-BIG', { code: 'rangon10' }],
    ['its own code, in lower case', 'PARITY-BIG', { code: 'parity-big' }],
    ['its value', 'PARITY-BIG', { value: '75.50' }],
    ['its value to nothing', 'PARITY-BIG', { value: '0' }],
    ['a fixed coupon made a percentage', 'PARITY-BIG', { discount_type: 'PERCENTAGE' }],
    [
      'a fixed coupon made a percentage, with a value',
      'PARITY-BIG',
      { discount_type: 'PERCENTAGE', value: '15' },
    ],
    ['a coupon made free delivery', 'PARITY-BIG', { discount_type: 'FREE_SHIPPING' }],
    ['free delivery given a value', 'FREESHIP', { value: '40' }],
    ['free delivery made a fixed amount', 'FREESHIP', { discount_type: 'FIXED' }],
    [
      'free delivery made a fixed amount, with a value',
      'FREESHIP',
      { discount_type: 'FIXED', value: '40' },
    ],
    ['a percentage raised past 100', 'RANGON10', { value: '101' }],
    ['an end before its stored start', 'RANGON10', { ends_at: '2020-01-01T00:00:00Z' }],
    ['a start after its stored end', 'RANGON10', { starts_at: '2099-01-01T00:00:00Z' }],
    ['its window taken off', 'RANGON10', { starts_at: null, ends_at: null }],
    [
      'its window moved',
      'RANGON10',
      { starts_at: '2026-10-01T00:00:00+06:00', ends_at: '2027-01-01T00:00:00+06:00' },
    ],
    ['its limits', 'PARITY-BIG', { usage_limit: 5, usage_limit_per_customer: null }],
    ['a limit below what was used', 'PARITY-ONCE', { usage_limit: 0 }],
    ['new categories', 'PARITY-CAT', { categories: [categories[2]] }],
    ['its categories emptied', 'PARITY-CAT', { categories: [] }],
    ['its categories restated and added to', 'PARITY-CAT', { categories }],
    ['null categories', 'PARITY-CAT', { categories: null }],
    ['new products', 'PARITY-PRODUCT', { products: [products[1]] }],
    ['its products emptied', 'PARITY-PRODUCT', { products: [] }],
    ['a product that is not there', 'PARITY-PRODUCT', { products: [MISSING] }],
    ['its channels', 'PARITY-BIG', { channels: ['PHONE'] }],
    ['channels stored as a word, restated as a list', 'PARITY-STR', { channels: ['POS'] }],
    ['a coupon whose channels are a word, its description', 'PARITY-STR', { description: 'x' }],
    ['switched off', 'PARITY-BIG', { is_active: false }],
    ['switched on', 'PARITY-OFF', { is_active: true }],
    ['what it may not state', 'PARITY-BIG', { used_count: 99, is_exhausted: true }],
    ['nothing at all', 'PARITY-BIG', {}],
    ['a body that is a list', 'PARITY-BIG', []],
    ['broken JSON', 'PARITY-BIG', '{'],
  ] as [string, string, unknown][]) {
    write(`edit a coupon: ${name}`, `${COUPONS}${coupon(code)}/`, body, 'owner', 'PATCH');
  }
  for (const [name, code, body] of [
    ['a code and a type', 'PARITY-BIG', { code: 'PARITY-BIG', discount_type: 'FIXED' }],
    [
      'everything restated',
      'PARITY-CAT',
      {
        code: 'PARITY-CAT',
        discount_type: 'PERCENTAGE',
        value: '20',
        categories: [],
        products: [],
        channels: [],
      },
    ],
    [
      'a code, a type and a value, the restrictions unsaid',
      'PARITY-CAT',
      { code: 'PARITY-CAT', discount_type: 'PERCENTAGE', value: '25' },
    ],
    ['nothing', 'PARITY-BIG', {}],
  ] as [string, string, unknown][]) {
    write(`edit a coupon, by PUT: ${name}`, `${COUPONS}${coupon(code)}/`, body, 'owner', 'PUT');
  }
  write(
    'edit a coupon: one that is not there',
    `${COUPONS}${MISSING}/`,
    { description: 'x' },
    'owner',
    'PATCH',
  );
  write(
    'edit a coupon: one that is not there, with broken JSON',
    `${COUPONS}${MISSING}/`,
    '{',
    'owner',
    'PATCH',
  );
  write(
    'edit a coupon: filtered out',
    `${PLAIN}?is_active=false`,
    { description: 'x' },
    'owner',
    'PATCH',
  );

  // === Deleting ================================================================================
  for (const who of everyone) write(`[${who}] delete a coupon`, PLAIN, undefined, who, 'DELETE');
  for (const [name, id] of [
    ['one never used', plain],
    ['one restricted to a category', byCategory],
    ['one restricted to a product', byProduct],
    ['one used once', used],
    ['one used and switched off already', coupon('PARITY-TWICE')],
    ['one already off', coupon('PARITY-OFF')],
    ...(carted ? ([['one a cart still names', coupon(carted)]] as [string, string][]) : []),
    ['one that is not there', MISSING],
    ['one that is not a uuid', 'abc'],
  ] as [string, string][]) {
    write(`delete a coupon: ${name}`, `${COUPONS}${id}/`, undefined, 'owner', 'DELETE');
  }
  write('delete a coupon: filtered out', `${PLAIN}?is_active=false`, undefined, 'owner', 'DELETE');
  return cases;
}
