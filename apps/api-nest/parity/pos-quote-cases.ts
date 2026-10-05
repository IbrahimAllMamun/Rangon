/**
 * Parity cases for the counter's two questions before a sale (phase 5 part 2):
 * what a basket comes to (`pos/quote/`) and whether a manager lets a discount
 * through (`pos/elevate/`). A quote writes nothing; an approval writes an
 * audit entry and may upgrade the approver's password hash.
 *
 * A manager's approval is a token signed as `django.core.signing` signs it.
 * The harness mints its own -- good ones and every kind of bad one -- just
 * before each request, since one lasts five minutes; and for two cases it
 * asks one API to approve and the other to honour it.
 *
 * Accounts and coupons come from fixture_pos.py and the earlier fixtures.
 */
import { createHash, createHmac } from 'node:crypto';

import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import { type Case, send, type Side, token } from './run.ts';

const PASSWORD = 'Parity-Pass-2026!';
const OVERRIDE = 'sales.discount_override';
const SALT = 'orders.pos.approval';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function b62(value: number): string {
  let rest = value;
  let out = '';
  do {
    out = BASE62[rest % 62] + out;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  return out;
}

/** `signing.dumps(payload, salt=...)`, stamped `age` seconds ago. */
function sign(
  payload: unknown,
  options: { age?: number; salt?: string; key?: string } = {},
): string {
  const key = options.key ?? process.env.DJANGO_SECRET_KEY ?? '';
  const data = Buffer.from(JSON.stringify(payload), 'latin1').toString('base64url');
  const stamped = `${data}:${b62(Math.floor(Date.now() / 1000) - (options.age ?? 0))}`;
  const derived = createHash('sha256')
    .update(`${options.salt ?? SALT}signer${key}`)
    .digest();
  return `${stamped}:${createHmac('sha256', derived).update(stamped).digest('base64url')}`;
}

/** An approval token read back for comparison: its payload, and whether it has the three parts. */
function describeApproval(token: unknown): unknown {
  if (typeof token !== 'string') return token;
  const parts = token.split(':');
  try {
    return {
      parts: parts.length,
      payload: JSON.parse(
        Buffer.from(parts[0] as string, 'base64url').toString('latin1'),
      ) as unknown,
    };
  } catch {
    return { parts: parts.length, payload: '<unreadable>' };
  }
}

const AUDIT_EFFECTS = [
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
  // An approval checks a password, which upgrades an old hash whoever holds it.
  `SELECT email, split_part(password, '$', 1) AS hasher, is_active, last_login IS NOT NULL AS signed_in
     FROM accounts_user WHERE email LIKE 'parity.%' ORDER BY email`,
];

export async function posQuoteCases(apis: { DJANGO: URL; NEST: URL }): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const userRows = await db.query<{ email: string; id: string }>(
    `SELECT email, id FROM accounts_user`,
  );
  const branchRows = await db.query<{ code: string; id: string }>(
    `SELECT code, id FROM accounts_branch`,
  );
  const variantRows = await db.query<{ sku: string; id: string }>(
    `SELECT sku, id FROM catalog_productvariant`,
  );
  const customerRows = await db.query<{ email: string | null; id: string; is_walk_in: boolean }>(
    `SELECT email, id, is_walk_in FROM customers_customer`,
  );
  // The till-only account is not one of the shared roles: sign it here.
  const till = await db.query<{ id: string; email: string; password: string }>(
    `SELECT id, email, password FROM accounts_user WHERE email = 'parity.till@rangon.test'`,
  );
  await db.end();
  const user = new Map(userRows.rows.map((row) => [row.email, row.id]));
  const branch = new Map(branchRows.rows.map((row) => [row.code, row.id]));
  const variant = new Map(variantRows.rows.map((row) => [row.sku, row.id]));
  if (!user.has('parity.till@rangon.test') || !till.rows[0]) {
    console.log('SKIP  pos quote: fixture_pos.py has not been applied');
    return [];
  }
  const tillHeader = `Bearer ${token(till.rows[0], { exp: Math.floor(Date.now() / 1000) + 6 * 3600 })}`;
  const headers = (who: Who | 'till') =>
    who === 'till' ? { authorization: tillHeader } : auth(who);

  const V = (sku: string) => variant.get(sku) as string;
  const U = (email: string) => user.get(email) as string;
  const mirpur = branch.get('PAR3') as string;
  const missing = '00000000-0000-4000-8000-000000000000';
  const shopper = customerRows.rows.find((row) => row.email === 'customer@rangon.test')?.id;
  const walkIn = customerRows.rows.find((row) => row.is_walk_in)?.id;
  const SHIRT = V('RGN-CLA-L-WHI'); // 2450.00
  const KURTI = V('RGN-BLO-L-BEI'); // 1890.00
  const TEE = V('PAR-TEE-S-WHT'); // 1100.00
  const one = [{ variant: SHIRT, quantity: 1 }];

  const cases: Case[] = [];
  type Body = unknown | (() => unknown | Promise<unknown>);
  const quote = (
    name: string,
    body: Body,
    who: Who | 'till' = 'cashier',
    extra: Partial<Case> = {},
  ) => {
    const fixed = typeof body !== 'function';
    cases.push({
      name: `pos quote: ${name}`,
      method: 'POST',
      path: '/api/v1/pos/quote/',
      headers: { ...headers(who), 'content-type': 'application/json' },
      body: fixed ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      // A token is minted just before each API's request.
      prepare: fixed
        ? undefined
        : async () => ({ body: JSON.stringify(await (body as () => unknown)()) }),
      ...extra,
    });
  };

  // --- Who may ask ------------------------------------------------------------------
  for (const who of [...(Object.keys(STAFF) as Who[]), 'till' as const]) {
    quote(`[${who}] a shirt`, { lines: one }, who);
    quote(`[${who}] a shirt, a tenth off`, { lines: one, manual_discount_percent: 10 }, who);
    quote(`[${who}] a shirt, half off`, { lines: one, manual_discount_percent: 50 }, who);
  }
  cases.push({
    name: 'pos quote: GET',
    path: '/api/v1/pos/quote/',
    headers: auth('cashier'),
  });

  // --- The basket's shape ---------------------------------------------------------------
  for (const [name, body] of [
    ['nothing', {}],
    ['no lines', { lines: [] }],
    ['lines that are not a list', { lines: { variant: SHIRT, quantity: 1 } }],
    ['null lines', { lines: null }],
    ['a null line and a string', { lines: [null, 'x', { variant: SHIRT, quantity: 1 }] }],
    ['a line with nothing in it', { lines: [{}] }],
    ['a variant that is not a uuid', { lines: [{ variant: 'abc', quantity: 1 }] }],
    ['a variant that is a number', { lines: [{ variant: 5, quantity: 1 }] }],
    ['a variant that is not there', { lines: [{ variant: missing, quantity: 1 }] }],
    [
      'two variants that are not there, one twice',
      {
        lines: [
          { variant: missing, quantity: 1 },
          { variant: SHIRT, quantity: 1 },
          { variant: '00000000-0000-4000-8000-000000000001', quantity: 1 },
          { variant: missing.toUpperCase(), quantity: 2 },
        ],
      },
    ],
    ['a quantity of zero', { lines: [{ variant: SHIRT, quantity: 0 }] }],
    ['a negative quantity', { lines: [{ variant: SHIRT, quantity: -1 }] }],
    ['a quantity with a fraction', { lines: [{ variant: SHIRT, quantity: 1.5 }] }],
    ['a quantity as text', { lines: [{ variant: SHIRT, quantity: ' 3 ' }] }],
    ['a quantity as a whole float', '{"lines":[{"variant":"' + SHIRT + '","quantity":2.0}]}'],
    ['a boolean quantity', { lines: [{ variant: SHIRT, quantity: true }] }],
    ['a null quantity', { lines: [{ variant: SHIRT, quantity: null }] }],
    ['a quantity past 2^53', '{"lines":[{"variant":"' + SHIRT + '","quantity":9007199254740993}]}'],
    [
      'a quantity of 10^22',
      '{"lines":[{"variant":"' + SHIRT + '","quantity":10000000000000000000000}]}',
    ],
    [
      'a quantity of 10^30',
      '{"lines":[{"variant":"' + SHIRT + '","quantity":1000000000000000000000000000000}]}',
    ],
    ['a negative line discount', { lines: [{ variant: SHIRT, quantity: 1, line_discount: -1 }] }],
    [
      'a line discount with three places',
      { lines: [{ variant: SHIRT, quantity: 1, line_discount: '1.005' }] },
    ],
    [
      'a line discount that is not a number',
      { lines: [{ variant: SHIRT, quantity: 1, line_discount: 'x' }] },
    ],
    ['a null line discount', { lines: [{ variant: SHIRT, quantity: 1, line_discount: null }] }],
    [
      'a line discount past the line',
      { lines: [{ variant: SHIRT, quantity: 2, line_discount: '4900.01' }] },
    ],
    [
      'a line discount of the whole line',
      { lines: [{ variant: SHIRT, quantity: 2, line_discount: '4900.00' }] },
    ],
    ['a customer that is not a uuid', { lines: one, customer: 'abc' }],
    ['a null customer', { lines: one, customer: null }],
    ['a customer that is not there', { lines: one, customer: missing }],
    ['a negative discount', { lines: one, manual_discount: '-0.01' }],
    ['a discount that is not a number', { lines: one, manual_discount: 'ten' }],
    ['a null discount', { lines: one, manual_discount: null }],
    ['a discount past fourteen digits', { lines: one, manual_discount: '1234567890123.00' }],
    ['a percentage below zero', { lines: one, manual_discount_percent: -1 }],
    ['a percentage past a hundred', { lines: one, manual_discount_percent: '100.01' }],
    ['a percentage with three places', { lines: one, manual_discount_percent: '9.999' }],
    ['a percentage that is not a number', { lines: one, manual_discount_percent: 'ten' }],
    ['a blank percentage', { lines: one, manual_discount_percent: '' }],
    [
      'a null percentage and an amount',
      { lines: one, manual_discount_percent: null, manual_discount: 5 },
    ],
    ['an amount and a percentage', { lines: one, manual_discount: 5, manual_discount_percent: 5 }],
    [
      'a zero amount and a percentage',
      { lines: one, manual_discount: 0, manual_discount_percent: 5 },
    ],
    [
      'an amount and a zero percentage',
      { lines: one, manual_discount: 5, manual_discount_percent: 0 },
    ],
    ['a coupon past 32 characters', { lines: one, coupon_code: 'C'.repeat(33) }],
    ['a null coupon', { lines: one, coupon_code: null }],
    ['a coupon that is a number', { lines: one, coupon_code: 12 }],
    ['a token past 512 characters', { lines: one, approval_token: 't'.repeat(513) }],
    ['a branch that is not a uuid', { lines: one, branch: 'abc' }],
    ['a list', []],
    ['null', 'null'],
    ['broken JSON', '{"lines":'],
    [
      'fields nobody reads',
      { lines: one, payments: 'x', register: 5, unit_price: '1.00', total: 1 },
    ],
  ] as [string, unknown][]) {
    quote(name, body);
  }

  // --- Pricing -----------------------------------------------------------------------------
  const basket = [
    { variant: SHIRT, quantity: 2 },
    { variant: KURTI, quantity: 1, line_discount: '90.00' },
    { variant: TEE, quantity: 3 },
  ];
  for (const [name, body, who] of [
    ['three lines', { lines: basket }, 'cashier'],
    [
      'one SKU on two lines',
      { lines: [...one, { variant: SHIRT, quantity: 2, line_discount: 10 }] },
      'cashier',
    ],
    ['a free item', { lines: [{ variant: V('PAR-FREE'), quantity: 4 }] }, 'cashier'],
    [
      'a free item, discounted',
      { lines: [{ variant: V('PAR-FREE'), quantity: 1 }], manual_discount_percent: 100 },
      'cashier',
    ],
    ['an archived SKU', { lines: [{ variant: V('PAR-TEE-M-BLK'), quantity: 1 }] }, 'cashier'],
    ['a SKU of a draft product', { lines: [{ variant: V('PAR-DRAFT'), quantity: 1 }] }, 'cashier'],
    ['more than the shelf holds', { lines: [{ variant: SHIRT, quantity: 5000 }] }, 'cashier'],
    ['a named customer', { lines: one, customer: shopper }, 'cashier'],
    ['the walk-in record', { lines: one, customer: walkIn }, 'cashier'],
    ['a discount at the threshold', { lines: one, manual_discount: '490.00' }, 'cashier'],
    ['a discount a paisa past the threshold', { lines: one, manual_discount: '490.01' }, 'cashier'],
    [
      'a line discount past the threshold',
      { lines: [{ variant: SHIRT, quantity: 1, line_discount: 500 }] },
      'cashier',
    ],
    [
      'line and sale discounts that pass it together',
      { lines: [{ variant: SHIRT, quantity: 1, line_discount: 250 }], manual_discount: 250 },
      'cashier',
    ],
    ['a percentage at the threshold', { lines: basket, manual_discount_percent: 20 }, 'cashier'],
    ['a percentage that rounds', { lines: basket, manual_discount_percent: '12.34' }, 'cashier'],
    ['a third off, as a manager', { lines: basket, manual_discount_percent: '33.33' }, 'manager'],
    ['a third off, as an owner', { lines: basket, manual_discount_percent: '33.33' }, 'owner'],
    ['everything off, as a manager', { lines: basket, manual_discount_percent: 100 }, 'manager'],
    ['a discount past the sale', { lines: one, manual_discount: '2450.01' }, 'manager'],
    ['a discount of the sale', { lines: one, manual_discount: '2450.00' }, 'manager'],
    ['a small discount without the right', { lines: one, manual_discount: '1.00' }, 'till'],
    [
      'a line discount without the right',
      { lines: [{ variant: SHIRT, quantity: 1, line_discount: 1 }] },
      'till',
    ],
    [
      'a zero discount without the right',
      { lines: one, manual_discount: 0, manual_discount_percent: 0 },
      'till',
    ],
    ['at another branch, as an owner', { lines: basket, branch: mirpur }, 'owner'],
    ['at another branch, as a cashier', { lines: basket, branch: mirpur }, 'cashier'],
    ['as the other branch’s manager', { lines: basket }, 'mirpur'],
  ] as [string, unknown, Who | 'till'][]) {
    quote(name, body, who);
  }

  // --- Coupons at the counter ------------------------------------------------------------------
  for (const [name, body, who] of [
    ['a store coupon', { lines: one, coupon_code: 'STORE100' }, 'cashier'],
    [
      'a store coupon, padded and in lower case',
      { lines: one, coupon_code: '  store100 ' },
      'cashier',
    ],
    [
      'a store coupon under its minimum',
      { lines: [{ variant: V('PAR-TWA'), quantity: 1 }], coupon_code: 'STORE100' },
      'cashier',
    ],
    ['a blank coupon', { lines: one, coupon_code: '   ' }, 'cashier'],
    ['a coupon nobody made', { lines: one, coupon_code: 'NOPE' }, 'cashier'],
    ['an online-only coupon', { lines: one, coupon_code: 'RANGON10' }, 'cashier'],
    ['a free-delivery coupon', { lines: one, coupon_code: 'FREESHIP' }, 'cashier'],
    ['an expired coupon', { lines: one, coupon_code: 'EXPIRED50' }, 'cashier'],
    ['a coupon not yet started', { lines: one, coupon_code: 'PARITY-SOON' }, 'cashier'],
    ['a coupon switched off', { lines: one, coupon_code: 'PARITY-OFF' }, 'cashier'],
    ['a coupon used up', { lines: one, coupon_code: 'PARITY-USED' }, 'cashier'],
    ['a once-each coupon with no customer', { lines: one, coupon_code: 'PARITY-ONCE' }, 'cashier'],
    [
      'a once-each coupon for the walk-in record',
      { lines: one, coupon_code: 'PARITY-ONCE', customer: walkIn },
      'cashier',
    ],
    [
      'a once-each coupon with a customer',
      { lines: one, coupon_code: 'PARITY-ONCE', customer: shopper },
      'cashier',
    ],
    [
      'a twice-each coupon with no customer',
      { lines: one, coupon_code: 'PARITY-TWICE' },
      'cashier',
    ],
    [
      'a three-times coupon with no customer',
      { lines: one, coupon_code: 'PARITY-THRICE' },
      'cashier',
    ],
    [
      'a three-times coupon with a customer',
      { lines: basket, coupon_code: 'PARITY-THRICE', customer: shopper },
      'cashier',
    ],
    ['a coupon larger than the sale', { lines: one, coupon_code: 'PARITY-BIG' }, 'cashier'],
    [
      'a coupon larger than the sale, and a discount',
      { lines: one, coupon_code: 'PARITY-BIG', manual_discount: 1 },
      'manager',
    ],
    ['a capped coupon', { lines: basket, coupon_code: 'PARITY-CAP', customer: shopper }, 'cashier'],
    [
      'a category coupon on nothing eligible',
      { lines: one, coupon_code: 'PARITY-CAT', customer: shopper },
      'cashier',
    ],
    [
      'a category coupon',
      { lines: basket, coupon_code: 'PARITY-CAT', customer: shopper },
      'cashier',
    ],
    [
      'a product coupon',
      { lines: basket, coupon_code: 'PARITY-PRODUCT', customer: shopper },
      'cashier',
    ],
    ['a coupon whose channels are a string', { lines: one, coupon_code: 'PARITY-STR' }, 'cashier'],
    [
      'a coupon and a percentage after it',
      { lines: one, coupon_code: 'STORE100', manual_discount_percent: 10 },
      'cashier',
    ],
    [
      'a coupon and a percentage past the threshold',
      { lines: one, coupon_code: 'STORE100', manual_discount_percent: 25 },
      'cashier',
    ],
    [
      'a refused coupon and a refused discount',
      { lines: one, coupon_code: 'RANGON10', manual_discount_percent: 50 },
      'cashier',
    ],
    [
      'a refused coupon and a discount past the sale',
      { lines: one, coupon_code: 'NOPE', manual_discount: '2450.01' },
      'manager',
    ],
  ] as [string, unknown, Who | 'till'][]) {
    quote(`coupon: ${name}`, body, who);
  }

  // --- VAT -----------------------------------------------------------------------------------
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
  const discounted = { lines: basket, manual_discount: '333.33', coupon_code: 'STORE100' };
  quote('VAT added, 15%', discounted, 'cashier', tax('EXCLUSIVE', '0.1500', null));
  quote('VAT inside the price, 15%', discounted, 'cashier', tax('INCLUSIVE', '0.1500', null));
  quote(
    'VAT added, a category at 7.5% under a default of 5%',
    discounted,
    'cashier',
    tax('EXCLUSIVE', '0.0500', '0.0750'),
  );
  quote(
    'VAT added, a category at 5% under a default of 7.5%',
    discounted,
    'cashier',
    tax('EXCLUSIVE', '0.0750', '0.0500'),
  );
  quote(
    'VAT inside, a category at nothing',
    discounted,
    'cashier',
    tax('INCLUSIVE', '0.1000', '0.0000'),
  );
  quote(
    'VAT added, one line, a category rate equal to the default',
    { lines: [{ variant: TEE, quantity: 1 }] },
    'cashier',
    tax('EXCLUSIVE', '0.0750', '0.0750'),
  );
  quote(
    'VAT added on a sale discounted to nothing',
    { lines: basket, manual_discount_percent: 100 },
    'manager',
    tax('EXCLUSIVE', '0.1500', null),
  );

  // --- A manager's approval, carried by its token -------------------------------------------------
  const cashier = U('cashier@rangon.test');
  const approver = U('parity.approver@rangon.test');
  const half = { lines: one, manual_discount_percent: 50 };
  const approval = (fields: Record<string, unknown> = {}) => ({
    approver,
    cashier,
    permission: OVERRIDE,
    max_percent: '50.00',
    ...fields,
  });
  for (const [name, mint, who] of [
    ['a good approval', () => sign(approval()), 'cashier'],
    ['an approval for more', () => sign(approval({ max_percent: '75.00' })), 'cashier'],
    ['an approval for less', () => sign(approval({ max_percent: '49.99' })), 'cashier'],
    ['an approval with no ceiling', () => sign(approval({ max_percent: null })), 'cashier'],
    ['an approval four minutes old', () => sign(approval(), { age: 240 }), 'cashier'],
    ['an approval six minutes old', () => sign(approval(), { age: 360 }), 'cashier'],
    ['an approval from the future', () => sign(approval(), { age: -600 }), 'cashier'],
    [
      'an approval signed with another key',
      () => sign(approval(), { key: 'not-the-key' }),
      'cashier',
    ],
    [
      'an approval signed for another purpose',
      () => sign(approval(), { salt: 'something.else' }),
      'cashier',
    ],
    [
      'an approval with its payload changed',
      () =>
        sign(approval()).replace(
          /^[^:]+/,
          Buffer.from(JSON.stringify(approval({ max_percent: '99.00' }))).toString('base64url'),
        ),
      'cashier',
    ],
    ['an approval cut short', () => sign(approval()).slice(0, -3), 'cashier'],
    ['an approval with no parts', () => 'not-a-token', 'cashier'],
    ['an approval of two parts', () => 'abc:def', 'cashier'],
    ['an approval in Bengali', () => 'অনুমোদন:১:২', 'cashier'],
    [
      'an approval given to another cashier',
      () => sign(approval({ cashier: U('manager@rangon.test') })),
      'cashier',
    ],
    [
      'an approval for another permission',
      () => sign(approval({ permission: 'sales.refund' })),
      'cashier',
    ],
    ['an approval by a cashier', () => sign(approval({ approver: cashier })), 'cashier'],
    [
      'an approval by an inactive manager',
      () => sign(approval({ approver: U('parity.gone@rangon.test') })),
      'cashier',
    ],
    ['an approval by nobody', () => sign(approval({ approver: missing })), 'cashier'],
    [
      'an approval by something that is not a uuid',
      () => sign(approval({ approver: 'abc' })),
      'cashier',
    ],
    [
      'an approval by the other branch’s manager',
      () => sign(approval({ approver: U('parity.mirpur@rangon.test') })),
      'cashier',
    ],
    [
      'an approval by an owner',
      () => sign(approval({ approver: U('owner@rangon.test') })),
      'cashier',
    ],
    [
      'an approval by an administrator',
      () => sign(approval({ approver: U('parity.admin@rangon.test') })),
      'cashier',
    ],
    ['an approval nobody needed', () => sign(approval()), 'manager'],
    [
      'an approval for a till that may not discount',
      () => sign(approval({ cashier: U('parity.till@rangon.test') })),
      'till',
    ],
  ] as [string, () => string, Who | 'till'][]) {
    quote(`approval: ${name}`, () => ({ ...half, approval_token: mint() }), who);
  }
  quote('approval: a bad token on a discount under the threshold', {
    lines: one,
    manual_discount_percent: 5,
    approval_token: 'not-a-token',
  });
  quote(
    'approval: a good approval at another branch, as an owner without the need',
    () => ({
      ...half,
      branch: mirpur,
      approval_token: sign(approval({ cashier: U('owner@rangon.test') })),
    }),
    'owner',
  );
  // Each API honours what the other approved.
  const other = (side: Side) => (side === 'django' ? apis.NEST : apis.DJANGO);
  const elevated = async (side: Side, percent: string) => {
    const response = await send(other(side), {
      name: 'elevate for a quote',
      method: 'POST',
      path: '/api/v1/pos/elevate/',
      headers: { ...auth('cashier'), 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'parity.approver@rangon.test',
        password: PASSWORD,
        permission: OVERRIDE,
        discount_percent: percent,
      }),
    });
    return (JSON.parse(response.body) as { approval_token?: string }).approval_token ?? '';
  };
  const auditReset = { reset: async () => {}, effects: [AUDIT_EFFECTS[0] as string] };
  cases.push({
    name: 'pos quote: approval: one the other API gave, for enough',
    method: 'POST',
    path: '/api/v1/pos/quote/',
    headers: { ...auth('cashier'), 'content-type': 'application/json' },
    prepare: async (side) => ({
      body: JSON.stringify({ ...half, approval_token: await elevated(side, '50') }),
    }),
    ...auditReset,
  });
  cases.push({
    name: 'pos quote: approval: one the other API gave, for too little',
    method: 'POST',
    path: '/api/v1/pos/quote/',
    headers: { ...auth('cashier'), 'content-type': 'application/json' },
    prepare: async (side) => ({
      body: JSON.stringify({ ...half, approval_token: await elevated(side, '49.5') }),
    }),
    ...auditReset,
  });

  // --- Asking a manager -----------------------------------------------------------------------------
  const elevate = (
    name: string,
    body: unknown,
    who: Who | 'till' = 'cashier',
    extra: Partial<Case> = {},
  ) =>
    cases.push({
      name: `pos elevate: ${name}`,
      method: 'POST',
      path: '/api/v1/pos/elevate/',
      headers: { ...headers(who), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, ['accounts_user']),
      effects: AUDIT_EFFECTS,
      normalize: (response) => {
        const row = response as { approval_token?: unknown } | null;
        if (row && typeof row === 'object' && 'approval_token' in row)
          row.approval_token = describeApproval(row.approval_token);
      },
      ...extra,
    });
  const ask = (fields: Record<string, unknown> = {}) => ({
    email: 'parity.approver@rangon.test',
    password: PASSWORD,
    permission: OVERRIDE,
    discount_percent: '35',
    ...fields,
  });
  for (const who of [...(Object.keys(STAFF) as Who[]), 'till' as const]) {
    elevate(`[${who}] a discount`, ask(), who);
  }
  cases.push({ name: 'pos elevate: GET', path: '/api/v1/pos/elevate/', headers: auth('cashier') });
  for (const [name, body] of [
    ['a discount of 35.555%', ask({ discount_percent: '35.555' })],
    ['a discount of 35.5%', ask({ discount_percent: 35.5 })],
    ['a discount of nothing', ask({ discount_percent: 0 })],
    ['a discount of everything', ask({ discount_percent: 100 })],
    ['a discount past everything', ask({ discount_percent: '100.01' })],
    ['a discount below nothing', ask({ discount_percent: -1 })],
    ['a discount that is not a number', ask({ discount_percent: 'lots' })],
    ['a discount with no percentage', ask({ discount_percent: undefined })],
    ['a discount with a null percentage', ask({ discount_percent: null })],
    ['a discount with a blank percentage', ask({ discount_percent: '' })],
    [
      'a refund, with no percentage',
      ask({ permission: 'sales.refund', discount_percent: undefined }),
    ],
    ['a refund, with a percentage', ask({ permission: 'sales.refund' })],
    ['something a manager may not approve', ask({ permission: 'sales.refund_override' })],
    ['something nobody holds', ask({ permission: 'nothing.at_all' })],
    [
      'something nobody holds, by an owner',
      ask({ email: 'owner@rangon.test', password: 'not-known', permission: 'nothing.at_all' }),
    ],
    ['a permission past 64 characters', ask({ permission: 'p'.repeat(65) })],
    ['a blank permission', ask({ permission: '' })],
    ['a padded permission', ask({ permission: ` ${OVERRIDE} ` })],
    ['a wrong password', ask({ password: 'not-the-password' })],
    ['a padded password', ask({ password: ` ${PASSWORD} ` })],
    ['a blank password', ask({ password: '' })],
    ['a null password', ask({ password: null })],
    ['a password that is a number', ask({ password: 12345678 })],
    ['an email in capitals', ask({ email: 'PARITY.APPROVER@RANGON.TEST' })],
    ['a padded email', ask({ email: '  parity.approver@rangon.test ' })],
    ['an email nobody has', ask({ email: 'nobody@rangon.test' })],
    ['something that is not an email', ask({ email: 'parity.approver' })],
    ['a cashier’s own credentials', ask({ email: 'cashier@rangon.test', password: 'not-known' })],
    ['an inactive manager', ask({ email: 'parity.gone@rangon.test' })],
    ['a customer', ask({ email: 'parity.customer@rangon.test' })],
    ['a customer with an old password hash', ask({ email: 'parity.pbkdf2@rangon.test' })],
    ['the other branch’s manager', ask({ email: 'parity.mirpur@rangon.test' })],
    ['an administrator', ask({ email: 'parity.admin@rangon.test' })],
    ['a superuser whose role is cashier', ask({ email: 'parity.super@rangon.test' })],
    ['an account with no role', ask({ email: 'parity.norole@rangon.test' })],
    ['nothing', {}],
    ['a list', []],
    ['broken JSON', '{"email":'],
    ['a secret in the permission', ask({ permission: 'password', discount_percent: undefined })],
  ] as [string, unknown][]) {
    elevate(name, body);
  }
  elevate(
    'an administrator, non-ASCII permission by a superuser',
    ask({ email: 'parity.super@rangon.test', permission: 'ছাড় "x"', discount_percent: undefined }),
  );
  elevate(
    'by a manager, for themselves',
    ask({ email: 'manager@rangon.test', password: 'not-known' }),
    'manager',
  );
  elevate('asked by the other branch’s manager', ask(), 'mirpur');
  return cases;
}
