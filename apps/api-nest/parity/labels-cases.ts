/**
 * Parity cases for the barcode label sheet (phase 5 part 7):
 * `GET` and `POST /products/<id>/labels/`. The sheet lists every variant of
 * a product beside the stock a branch holds and whether its labels are
 * printed; a POST ticks variants off or back on, each tick a new row, and
 * answers with the sheet as it then stands.
 *
 * The marks come from fixture_labels.py.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';
import { send } from './run.ts';

const TABLES = ['inventory_labelprint', 'inventory_inventory'];
const EFFECTS = [
  // The marks a request made.
  `SELECT b.code, v.sku, l.printed, l.quantity, l.on_hand, u.email AS marked_by
     FROM inventory_labelprint l JOIN accounts_branch b ON b.id = l.branch_id
     JOIN catalog_productvariant v ON v.id = l.variant_id
     LEFT JOIN accounts_user u ON u.id = l.created_by_id
    WHERE l.id NOT IN (SELECT id FROM "snap_inventory_labelprint")
    ORDER BY l.created_at, v.sku`,
  // Nothing here moves stock, or is audited.
  `SELECT count(*)::int AS movements FROM inventory_inventorytransaction WHERE created_at >= $1`,
  `SELECT action, entity_type FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at`,
];
const reset = (client: pg.Client) => restoreTables(client, TABLES);
const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

async function setting(db: pg.Client) {
  const map = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const variant = await map(`SELECT sku AS key, id FROM catalog_productvariant`);
  const branch = await map(`SELECT code AS key, id FROM accounts_branch`);
  const product = await map(
    `SELECT v.sku AS key, v.product_id AS id FROM catalog_productvariant v`,
  );
  const marked = (await db.query(`SELECT 1 FROM inventory_labelprint LIMIT 1`)).rowCount;
  return { variant, branch, product, marked };
}

export async function labelsCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const { variant, branch, product, marked } = await setting(db);
  const backpack = product.get('RGN-EVE-BLA-20L');
  const lipstick = product.get('RGN-MAT-NUD');
  const shirt = product.get('RGN-CLA-M-NAV');
  if (!marked || !backpack || !lipstick || !shirt) {
    await db.end();
    console.log('SKIP  labels: fixture_labels.py has not been applied');
    return [];
  }
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM catalog_productvariant UNION ALL SELECT id::text FROM catalog_product
       UNION ALL SELECT id::text FROM accounts_branch`,
    )
  ).rows.map((row) => row.id);
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const blank = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const sheet = (id: string, query = '') => `/api/v1/products/${id}/labels/${query}`;
  const v = (sku: string) => variant.get(sku) as string;

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `labels: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
    path = sheet(backpack),
  ) =>
    cases.push({
      name: `labels: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE },
      body: text(body),
      reset,
      effects: EFFECTS,
      normalize: blank,
      ...extra,
    });
  const everyone = Object.keys(STAFF) as Who[];

  // === The sheet ==============================================================================
  for (const who of everyone) read(`[${who}] the sheet`, sheet(backpack), who);
  read('a product with marks, one by someone since gone', sheet(lipstick));
  read('a product nobody has marked', sheet(shirt));
  read('at the home branch, asked for', sheet(backpack, `?branch=${branch.get('DHK1')}`));
  read('at a branch that holds none of it', sheet(backpack, `?branch=${branch.get('PAR3')}`));
  read(
    'at a branch that holds none and marked none',
    sheet(shirt, `?branch=${branch.get('PAR3')}`),
  );
  read(
    'at another branch, by a branch manager',
    sheet(backpack, `?branch=${branch.get('PAR3')}`),
    'manager',
  );
  read('at their own branch, by its manager', sheet(backpack), 'mirpur');
  read(
    'at the home branch, by the other manager',
    sheet(backpack, `?branch=${branch.get('DHK1')}`),
    'mirpur',
  );
  read('at a branch that is not there', sheet(backpack, `?branch=${MISSING}`));
  read('at a branch that is not a uuid', sheet(backpack, '?branch=abc'));
  read('at a blank branch', sheet(backpack, '?branch='));
  read('a product that is not there', sheet(MISSING));
  read('a product that is not a uuid', sheet('abc'));
  read('filtered to its own status', sheet(backpack, '?status=ACTIVE'));
  read('filtered to another status', sheet(backpack, '?status=DRAFT'));
  read('with a filter that is not a status', sheet(backpack, '?status=NOPE'));
  read('with a search the list would not match', sheet(backpack, '?search=zzzz-nothing'));
  read('with the list’s never-ordered filter', sheet(backpack, '?never_ordered=true'));
  read('with an ordering', sheet(backpack, '?ordering=-name'));
  read('no trailing slash', `/api/v1/products/${backpack}/labels`);
  const shelf = (sku: string, set: string) =>
    `UPDATE inventory_inventory SET ${set}
      WHERE variant_id = (SELECT id FROM catalog_productvariant WHERE sku = '${sku}')
        AND branch_id = (SELECT id FROM accounts_branch WHERE code = 'DHK1')`;
  read('a shelf oversold below nothing', sheet(backpack), 'owner', {
    reset,
    prepare: after(
      shelf('RGN-EVE-OLI-25L', 'on_hand = -3'),
      shelf('RGN-EVE-BLA-20L', 'on_hand = -1'),
    ),
  });
  read('a shelf of 800', sheet(backpack), 'owner', {
    reset,
    prepare: after(shelf('RGN-EVE-OLI-25L', 'on_hand = 800')),
  });
  read('fewer on the shelf than came in since the mark', sheet(backpack), 'owner', {
    reset,
    prepare: after(shelf('RGN-EVE-BLA-20L', 'on_hand = 6')),
  });
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    read(`${method} the sheet`, sheet(backpack), 'owner', { method });
    read(`[cashier] ${method} the sheet`, sheet(backpack), 'cashier', { method });
  }

  // === Marking ================================================================================
  const mark = (sku: string, printed: unknown = true, extra: Record<string, unknown> = {}) => ({
    variant: v(sku),
    printed,
    ...extra,
  });
  const marks = (...list: unknown[]) => ({ marks: list });
  for (const who of everyone)
    write(
      `[${who}] mark one variant printed`,
      marks(mark('RGN-EVE-OLI-25L', true, { quantity: 57 })),
      who,
    );
  for (const [name, body] of [
    [
      'every variant printed',
      marks(
        ...['RGN-EVE-BLA-20L', 'RGN-EVE-BLA-25L', 'RGN-EVE-OLI-20L', 'RGN-EVE-OLI-25L'].map(
          (sku, n) => mark(sku, true, { quantity: n + 1 }),
        ),
      ),
    ],
    ['a printed variant un-marked', marks(mark('RGN-EVE-BLA-20L', false))],
    ['a variant un-marked with a count', marks(mark('RGN-EVE-BLA-20L', false, { quantity: 9 }))],
    ['a variant marked with no count', marks(mark('RGN-EVE-OLI-25L'))],
    [
      'a variant marked again, after stock came in',
      marks(mark('RGN-EVE-BLA-20L', true, { quantity: 20 })),
    ],
    ['a never-marked variant un-marked', marks(mark('RGN-EVE-OLI-25L', false))],
    [
      'one marked and one un-marked',
      marks(mark('RGN-EVE-OLI-25L', true, { quantity: 5 }), mark('RGN-EVE-BLA-25L', false)),
    ],
    ['a count of nothing', marks(mark('RGN-EVE-OLI-25L', true, { quantity: 0 }))],
    ['a count of 500', marks(mark('RGN-EVE-OLI-25L', true, { quantity: 500 }))],
    ['a count of 501', marks(mark('RGN-EVE-OLI-25L', true, { quantity: 501 }))],
    ['a count below nothing', marks(mark('RGN-EVE-OLI-25L', true, { quantity: -1 }))],
    ['a count as text', marks(mark('RGN-EVE-OLI-25L', true, { quantity: '7' }))],
    [
      'a count of 7.0',
      `{"marks":[{"variant":"${v('RGN-EVE-OLI-25L')}","printed":true,"quantity":7.0}]}`,
    ],
    ['a count of 7.5', marks(mark('RGN-EVE-OLI-25L', true, { quantity: 7.5 }))],
    ['a count of true', marks(mark('RGN-EVE-OLI-25L', true, { quantity: true }))],
    ['a null count', marks(mark('RGN-EVE-OLI-25L', true, { quantity: null }))],
    ['printed as "yes"', marks(mark('RGN-EVE-OLI-25L', 'yes'))],
    ['printed as "no"', marks(mark('RGN-EVE-OLI-25L', 'no'))],
    ['printed as 1', marks(mark('RGN-EVE-OLI-25L', 1))],
    ['printed as 0', marks(mark('RGN-EVE-OLI-25L', 0))],
    ['printed as "maybe"', marks(mark('RGN-EVE-OLI-25L', 'maybe'))],
    ['printed as null', marks(mark('RGN-EVE-OLI-25L', null))],
    ['printed left out', marks({ variant: v('RGN-EVE-OLI-25L') })],
    ['a variant that is not a uuid', marks({ variant: 'abc', printed: true })],
    ['a null variant', marks({ variant: null, printed: true })],
    ['no variant', marks({ printed: true })],
    ['a variant that is not there', marks({ variant: MISSING, printed: true })],
    ['a variant of another product', marks(mark('RGN-MAT-NUD'))],
    [
      'one of its own and one of another product',
      marks(mark('RGN-EVE-OLI-25L'), mark('RGN-MAT-NUD'), { variant: MISSING, printed: true }),
    ],
    ['the same variant twice', marks(mark('RGN-EVE-OLI-25L'), mark('RGN-EVE-OLI-25L', false))],
    [
      'the same variant twice, once in capitals',
      marks(mark('RGN-EVE-OLI-25L'), {
        variant: v('RGN-EVE-OLI-25L').toUpperCase(),
        printed: true,
      }),
    ],
    ['no marks', {}],
    ['marks that are empty', marks()],
    ['marks that are null', { marks: null }],
    ['marks that are an object', { marks: mark('RGN-EVE-OLI-25L') }],
    ['marks that are a string', { marks: 'all' }],
    ['a mark that is null', marks(null)],
    ['a mark that is a string', marks('x')],
    ['a mark that is empty', marks({})],
    [
      'a good mark and a bad one',
      marks(mark('RGN-EVE-OLI-25L'), { variant: 'x', printed: 'maybe', quantity: 9999 }),
    ],
    ['201 marks', marks(...Array.from({ length: 201 }, () => mark('RGN-EVE-OLI-25L')))],
    [
      '200 marks of one variant',
      marks(...Array.from({ length: 200 }, () => mark('RGN-EVE-OLI-25L'))),
    ],
    [
      'at the home branch, said so',
      { branch: branch.get('DHK1'), ...marks(mark('RGN-EVE-OLI-25L')) },
    ],
    ['at a null branch', { branch: null, ...marks(mark('RGN-EVE-OLI-25L')) }],
    [
      'at another branch, by a branch manager',
      { branch: branch.get('PAR3'), ...marks(mark('RGN-EVE-OLI-25L')) },
    ],
    ['at a branch that is not there', { branch: MISSING, ...marks(mark('RGN-EVE-OLI-25L')) }],
    ['at a branch that is not a uuid', { branch: 'abc', ...marks(mark('RGN-EVE-OLI-25L')) }],
    ['a body that is a list', [mark('RGN-EVE-OLI-25L')]],
    ['a body that is null', 'null'],
    ['broken JSON', '{"marks":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(name, body);
  }
  write(
    'at a branch that holds none of it, by the owner',
    { branch: branch.get('PAR3'), ...marks(mark('RGN-EVE-OLI-25L', true, { quantity: 4 })) },
    'owner',
  );
  write('at their own branch, by its manager', marks(mark('RGN-EVE-BLA-20L', false)), 'mirpur');
  write(
    'with the branch in the query string, not the body',
    marks(mark('RGN-EVE-OLI-25L')),
    'owner',
    {},
    sheet(backpack, `?branch=${branch.get('PAR3')}`),
  );
  write(
    'a product that is not there',
    marks(mark('RGN-EVE-OLI-25L')),
    'manager',
    {},
    sheet(MISSING),
  );
  write('a product that is not there, with a bad body', {}, 'manager', {}, sheet(MISSING));
  write(
    'filtered to another status',
    marks(mark('RGN-EVE-OLI-25L')),
    'manager',
    {},
    sheet(backpack, '?status=DRAFT'),
  );
  write(
    'a shelf oversold below nothing',
    marks(mark('RGN-EVE-OLI-25L', true, { quantity: 1 })),
    'manager',
    {
      prepare: after(shelf('RGN-EVE-OLI-25L', 'on_hand = -3')),
    },
  );
  return cases;
}

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * `mark_labels` takes no lock, and needs none: a mark is a new row and the
 * newest is the state. Six marks of one variant at once, across both APIs,
 * are six rows.
 */
export async function labelsConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { variant, product, marked } = await setting(db);
    const backpack = product.get('RGN-EVE-OLI-25L');
    if (!marked || !backpack) return [];
    const auth = await staffHeaders(db);
    await reset(db);
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        send(index % 2 ? apis.NEST : apis.DJANGO, {
          name: 'mark',
          method: 'POST',
          path: `/api/v1/products/${backpack}/labels/`,
          headers: { ...auth('manager'), ...JSON_TYPE },
          body: JSON.stringify({
            marks: [
              { variant: variant.get('RGN-EVE-OLI-25L'), printed: index < 5, quantity: index },
            ],
          }),
        }),
      ),
    );
    const rows = (
      await db.query<{ made: number }>(
        `SELECT count(*)::int AS made FROM inventory_labelprint
          WHERE id NOT IN (SELECT id FROM "snap_inventory_labelprint")`,
      )
    ).rows[0]?.made;
    await reset(db);
    const statuses = responses.map((response) => response.status);
    return [
      {
        name: 'labels: 6 marks of one variant at once, across both APIs -- six rows, none lost; no lock is involved',
        passed: statuses.every((status) => status === 200) && rows === 6,
        detail: `statuses ${statuses.join(',')}, ${rows} rows`,
      },
    ];
  } finally {
    await db.end();
  }
}
