/**
 * Parity cases for the counter (phase 5 part 1): what the register reads to
 * open (`pos/session/`), a scan (`pos/lookup/`), the product grid
 * (`pos/products/`) and held sales (`pos/holds/`), which a cashier parks and
 * resumes. Each write to a hold is compared by the rows it leaves.
 *
 * The holds, and the till at PAR3, come from fixture_pos.py.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const HOLD_TABLES = ['orders_heldsale'];
/** The fixture's hold for a named customer, and the one whose cashier is gone. */
const PARVIN = 'Parvin, fitting room';
const GONE = 'Cashier gone';

const HOLD_EFFECTS = [
  `SELECT h.label, h.register, b.code AS branch, c.name AS customer, h.payload::text AS payload,
          u.email AS created_by, h.created_at >= $1 AS created, h.updated_at >= $1 AS touched
     FROM orders_heldsale h JOIN accounts_branch b ON b.id = h.branch_id
     LEFT JOIN customers_customer c ON c.id = h.customer_id
     LEFT JOIN accounts_user u ON u.id = h.created_by_id
    ORDER BY b.code, h.label, h.register, h.payload::text`,
];

export async function posCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const holdRows = await db.query<{ label: string; id: string; register: string }>(
    `SELECT label, id, register FROM orders_heldsale`,
  );
  const branchRows = await db.query<{ code: string; id: string }>(
    `SELECT code, id FROM accounts_branch`,
  );
  const variantRows = await db.query<{ sku: string; barcode: string | null; status: string }>(
    `SELECT sku, barcode, status FROM catalog_productvariant`,
  );
  const customerRows = await db.query<{ email: string | null; id: string; is_walk_in: boolean }>(
    `SELECT email, id, is_walk_in FROM customers_customer`,
  );
  await db.end();
  const hold = new Map(holdRows.rows.map((row) => [row.label || row.register, row.id]));
  const branch = new Map(branchRows.rows.map((row) => [row.code, row.id]));
  if (!hold.has('H01') || !branch.has('PAR3')) {
    console.log('SKIP  pos: fixture_pos.py has not been applied');
    return [];
  }
  const known = new Set(hold.values());
  const H = (label: string) => `/api/v1/pos/holds/${hold.get(label)}/`;
  const mirpur = branch.get('PAR3') as string;
  const closed = branch.get('PAR2') as string;
  const missing = '00000000-0000-4000-8000-000000000000';
  const barcoded = variantRows.rows.find((row) => row.barcode) as { sku: string; barcode: string };
  const archived = variantRows.rows.find((row) => row.status !== 'ACTIVE');
  const customer = customerRows.rows.find((row) => row.email === 'customer@rangon.test')?.id;
  const walkIn = customerRows.rows.find((row) => row.is_walk_in)?.id;

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'cashier', method = 'GET') =>
    cases.push({ name: `pos: ${name}`, method, path, headers: auth(who) });
  const write = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    who: Who = 'cashier',
    contentType = 'application/json',
  ) =>
    cases.push({
      name: `pos: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': contentType },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, HOLD_TABLES),
      effects: HOLD_EFFECTS,
      normalize: (response) => {
        const row = response as { id?: unknown; created_at?: unknown } | null;
        if (row && typeof row === 'object' && typeof row.id === 'string' && !known.has(row.id)) {
          row.id = '<minted>';
          row.created_at = '<now>';
        }
      },
    });

  // --- Who may use the register ------------------------------------------------------
  for (const who of Object.keys(STAFF) as Who[]) {
    read(`[${who}] session`, '/api/v1/pos/session/', who);
    read(`[${who}] lookup`, `/api/v1/pos/lookup/?code=${barcoded.sku}`, who);
    read(`[${who}] products`, '/api/v1/pos/products/?q=parity', who);
    read(`[${who}] holds`, '/api/v1/pos/holds/', who);
    read(`[${who}] POST session`, '/api/v1/pos/session/', who, 'POST');
    read(`[${who}] DELETE lookup`, '/api/v1/pos/lookup/', who, 'DELETE');
    read(`[${who}] PUT holds`, '/api/v1/pos/holds/', who, 'PUT');
    read(`[${who}] GET a resume`, `${H('H01')}resume/`, who);
    write(`[${who}] park a hold`, 'POST', '/api/v1/pos/holds/', { label: `By ${who}` }, who);
    write(`[${who}] resume a hold`, 'POST', `${H('H02')}resume/`, {}, who);
  }
  cases.push({
    name: 'pos: bad token',
    path: '/api/v1/pos/session/',
    headers: { authorization: 'Bearer abc' },
  });

  // --- The session ------------------------------------------------------------------
  for (const [name, query, who] of [
    ['own branch, named', `?branch=${branch.get('DHK1')}`, 'cashier'],
    ['another branch, as a cashier', `?branch=${mirpur}`, 'cashier'],
    ['another branch, as an owner', `?branch=${mirpur}`, 'owner'],
    ['another branch, as an administrator', `?branch=${mirpur}`, 'admin'],
    ['the home branch, as the other branch’s manager', `?branch=${branch.get('DHK1')}`, 'mirpur'],
    ['an inactive branch', `?branch=${closed}`, 'owner'],
    ['a branch that is not there', `?branch=${missing}`, 'owner'],
    ['a branch that is not a uuid', '?branch=abc', 'owner'],
    ['a blank branch', '?branch=', 'owner'],
    ['a branch in capitals', `?branch=${mirpur.toUpperCase()}`, 'owner'],
    ['two branches', `?branch=${missing}&branch=${mirpur}`, 'owner'],
  ] as [string, string, Who][]) {
    read(`session, ${name}`, `/api/v1/pos/session/${query}`, who);
  }

  // --- A scan ------------------------------------------------------------------------
  for (const [name, query, who] of [
    ['a barcode', `?code=${barcoded.barcode}`, 'cashier'],
    ['a SKU', `?code=${barcoded.sku}`, 'cashier'],
    ['a SKU in lower case', `?code=${barcoded.sku.toLowerCase()}`, 'cashier'],
    ['a padded SKU', `?code=%20${barcoded.sku}%09`, 'cashier'],
    ['part of a SKU', `?code=${barcoded.sku.slice(0, 5)}`, 'cashier'],
    ['an archived SKU', `?code=${archived?.sku ?? 'none'}`, 'cashier'],
    ['nothing', '', 'cashier'],
    ['a blank code', '?code=', 'cashier'],
    ['spaces', '?code=%20%20', 'cashier'],
    ['a code nothing has', '?code=NOPE-1', 'cashier'],
    ['a code with quotes', `?code=it's%20"quoted"`, 'cashier'],
    ['a Bengali code', '?code=%E0%A6%B6%E0%A6%BE%E0%A6%A1%E0%A6%BC%E0%A6%BF', 'cashier'],
    ['two codes', `?code=NOPE&code=${barcoded.sku}`, 'cashier'],
    ['at another branch, as an owner', `?code=${barcoded.sku}&branch=${mirpur}`, 'owner'],
    ['at another branch, as a cashier', `?code=${barcoded.sku}&branch=${mirpur}`, 'cashier'],
    ['nothing found, at a branch not allowed', `?code=NOPE&branch=${mirpur}`, 'cashier'],
    ['at a branch that is not a uuid', `?code=${barcoded.sku}&branch=abc`, 'owner'],
    ['as the other branch’s manager', `?code=${barcoded.sku}`, 'mirpur'],
    ['a NUL', '?code=a%00b', 'cashier'],
  ] as [string, string, Who][]) {
    read(`lookup, ${name}`, `/api/v1/pos/lookup/${query}`, who);
  }

  // --- The grid ----------------------------------------------------------------------
  for (const [name, query, who] of [
    ['everything', '', 'cashier'],
    ['a word', '?q=shirt', 'cashier'],
    ['a word in capitals', '?q=SHIRT', 'cashier'],
    ['a padded word', '?q=%20%20linen%20', 'cashier'],
    ['part of a SKU', `?q=${barcoded.sku.slice(0, 7).toLowerCase()}`, 'cashier'],
    ['a barcode', `?q=${barcoded.barcode}`, 'cashier'],
    ['part of a barcode', `?q=${barcoded.barcode.slice(0, 6)}`, 'cashier'],
    ['a percent sign', '?q=%25', 'cashier'],
    ['an underscore', '?q=_', 'cashier'],
    ['a backslash', '?q=%5C', 'cashier'],
    ['nothing matching', '?q=zzzzzz', 'cashier'],
    ['a category', '?category=shirts', 'cashier'],
    ['a padded category', '?category=%20shirts%20', 'cashier'],
    ['a category in capitals', '?category=SHIRTS', 'cashier'],
    ['a category nothing has', '?category=nope', 'cashier'],
    ['a word in a category', '?q=classic&category=shirts', 'cashier'],
    ['the parity category', '?category=parity-leaf', 'cashier'],
    ['at another branch, as an owner', `?q=parity&branch=${mirpur}`, 'owner'],
    ['at another branch, as a cashier', `?q=parity&branch=${mirpur}`, 'cashier'],
    ['as the other branch’s manager', '?q=tee', 'mirpur'],
    ['at an inactive branch', `?branch=${closed}`, 'owner'],
    ['a NUL', '?q=a%00b', 'cashier'],
  ] as [string, string, Who][]) {
    read(`products, ${name}`, `/api/v1/pos/products/${query}`, who);
  }

  // --- Held sales: reads ---------------------------------------------------------------
  for (const query of [
    '',
    '?ordering=label',
    '?ordering=-label',
    '?ordering=register,-label',
    '?ordering=branch,label',
    '?ordering=-customer,label',
    '?ordering=customer__name,-label',
    '?ordering=created_by__email,label',
    '?ordering=-created_by__email,-created_at',
    '?ordering=branch,created_by__email,label',
    '?ordering=id',
    '?ordering=-created_at',
    '?ordering=customer_name',
    '?ordering=created_by_email',
    '?ordering=created_by',
    '?ordering=updated_at',
    '?ordering=bogus,-label',
    '?page=2&page_size=5',
    '?register=R2',
  ]) {
    read(`holds ${query || '(all)'}`, `/api/v1/pos/holds/${query}`);
  }
  read('holds, as the other branch’s manager', '/api/v1/pos/holds/', 'mirpur');
  read('holds at another branch, as an owner', `/api/v1/pos/holds/?branch=${mirpur}`, 'owner');
  read('holds at another branch, as a cashier', `/api/v1/pos/holds/?branch=${mirpur}`);
  read('holds at an inactive branch', `/api/v1/pos/holds/?branch=${closed}`, 'owner');
  read('holds at a branch that is not a uuid', '/api/v1/pos/holds/?branch=abc', 'owner');
  for (const label of ['H01', PARVIN, GONE, 'H10', 'H11', 'H12', 'H13', 'R2', 'H15']) {
    read(`hold ${label}`, H(label));
  }
  read('hold, not a uuid', '/api/v1/pos/holds/abc/');
  read('hold, not there', `/api/v1/pos/holds/${missing}/`);
  read('hold at another branch', H('Mirpur 1'));
  read('hold at another branch, as an owner', H('Mirpur 1'), 'owner');
  read('hold at another branch, named, as an owner', `${H('Mirpur 1')}?branch=${mirpur}`, 'owner');
  read('hold at its branch, as its manager', H('Mirpur 1'), 'mirpur');
  read('hold, an ordering', `${H(PARVIN)}?ordering=-customer`);
  read('hold, in capitals', `/api/v1/pos/holds/${(hold.get('H01') as string).toUpperCase()}/`);

  // --- Held sales: park ----------------------------------------------------------------
  const park = (name: string, body: unknown, who: Who = 'cashier', contentType?: string) =>
    write(`park ${name}`, 'POST', '/api/v1/pos/holds/', body, who, contentType);
  park('nothing', {});
  park('a cart', {
    label: '  Table 4  ',
    register: ' R1 ',
    customer,
    payload: { lines: [{ variant: missing, quantity: 2 }], manual_discount: '10.00' },
  });
  park('for the walk-in record', { customer: walkIn, payload: { lines: [] } });
  park('a blank label and register', { label: '', register: '' });
  park('a label past 64 characters', { label: 'l'.repeat(65), register: 'r'.repeat(33) });
  park('a label of 64 Bengali characters', { label: 'শ'.repeat(64) });
  park('a null label', { label: null, register: null });
  park('a label that is a number', { label: 12, register: 1.5 });
  park('a label that is a list', { label: ['a'], register: { a: 1 } });
  park('a customer that is not there', { customer: missing });
  park('a customer that is not a uuid', { customer: 'abc' });
  park('a customer that is a boolean', { customer: true });
  park('a customer that is a number', { customer: 7 });
  park('a null customer', { customer: null });
  park('a blank customer', { customer: '' });
  park('a null payload', { payload: null });
  park('a list payload', { payload: [1, 2.5, 'x', null, true, { a: [] }] });
  park('a string payload', { payload: 'a note' });
  park('a number payload', { payload: 12 });
  park('a false payload', { payload: false });
  park(
    'floats and a long integer',
    '{"payload":{"a":1.0,"b":1e3,"c":-0.0,"d":1.50,"e":12345678901234567890,"f":1E-7}}',
  );
  park('a float past a double', '{"payload":{"a":1e400}}');
  park('a NUL in the payload', '{"payload":{"a":"x\\u0000y"}}');
  park('half a surrogate pair in the payload', '{"payload":{"a":"\\ud83d"}}');
  park('a NUL in the label', '{"label":"x\\u0000y"}');
  // `branch` is read only to the serializer, and read by the view all the same.
  park('naming another branch', { branch: mirpur, label: 'Not mine' });
  park('fields that are read only', {
    id: missing,
    created_at: '2020-01-01T00:00:00Z',
    created_by_email: 'someone@else.test',
    customer_name: 'Someone',
    label: 'Read only',
  });
  park('at another branch, as an owner', { branch: mirpur, label: 'Owner at Mirpur' }, 'owner');
  park('at an inactive branch', { branch: closed, label: 'Closed' }, 'owner');
  park('at a branch that is not there', { branch: missing, label: 'Nowhere' }, 'owner');
  park('at a branch that is not a uuid', { branch: 'abc', label: 'Nowhere' }, 'owner');
  park('at a branch that is a number', { branch: 5, label: 'Five' }, 'owner');
  park('at a branch that is a float', '{"branch":1.5,"label":"Float"}', 'owner');
  park('at a branch that is a list', { branch: [mirpur], label: 'List' }, 'owner');
  park('at a null branch', { branch: null, label: 'Null' }, 'owner');
  park(
    'at the home branch, as the other branch’s manager',
    { branch: branch.get('DHK1') },
    'mirpur',
  );
  park('as the other branch’s manager', { label: 'Mirpur 3' }, 'mirpur');
  write(
    'park with the branch in the query, which is not read',
    'POST',
    `/api/v1/pos/holds/?branch=${mirpur}`,
    { label: 'Query' },
    'owner',
  );
  park('a list', []);
  park('null', 'null');
  park('a string', '"hold"');
  park('broken JSON', '{"label":');
  park('no body', undefined);
  // A documented difference (parity/known-differences.ts): Django parks it.
  write(
    'park: a form body',
    'POST',
    '/api/v1/pos/holds/',
    'label=Form',
    'cashier',
    'application/x-www-form-urlencoded',
  );
  park('text', 'label=Text', 'cashier', 'text/plain');

  // --- Held sales: edit -----------------------------------------------------------------
  const edit = (name: string, method: string, path: string, body: unknown, who: Who = 'cashier') =>
    write(`${method === 'PUT' ? 'replace' : 'edit'} ${name}`, method, path, body, who);
  edit('a label', 'PATCH', H('H01'), { label: 'Renamed' });
  edit('nothing', 'PATCH', H(PARVIN), {});
  edit('the customer away', 'PATCH', H(PARVIN), { customer: null });
  edit('a customer in', 'PATCH', H('H01'), { customer });
  edit('the payload', 'PATCH', H('H01'), { payload: { lines: [] } });
  edit('the payload to null', 'PATCH', H('H01'), { payload: null });
  edit('a label past 64 characters', 'PATCH', H('H01'), { label: 'l'.repeat(65) });
  edit('the branch, which is read only', 'PATCH', H('H01'), { branch: mirpur, label: 'Moved?' });
  edit('a hold at another branch', 'PATCH', H('Mirpur 1'), { label: 'Reached' });
  edit(
    'a hold at another branch, as an owner',
    'PATCH',
    `${H('Mirpur 1')}?branch=${mirpur}`,
    { label: 'Owner' },
    'owner',
  );
  edit('a hold that is not there', 'PATCH', `/api/v1/pos/holds/${missing}/`, { label: 'x' });
  edit(
    'a hold that is not there, broken JSON',
    'PATCH',
    `/api/v1/pos/holds/${missing}/`,
    '{"label":',
  );
  edit('a hold, broken JSON', 'PATCH', H('H01'), '{"label":');
  edit('a hold with a list', 'PATCH', H('H01'), []);
  edit('everything', 'PUT', H(PARVIN), { label: 'New', register: 'R9', customer, payload: [1] });
  edit('with nothing', 'PUT', H(PARVIN), {});
  edit('with a label only', 'PUT', H('H13'), { label: 'Only a label' });
  edit('a hold whose cashier is gone', 'PUT', H(GONE), { label: 'Still nobody’s' });
  edit('a hold whose cashier is gone', 'PATCH', H(GONE), { label: 'Still nobody’s' });
  edit('as the manager', 'PUT', H('H01'), { label: 'Manager’s now?' }, 'manager');

  // --- Held sales: resume and delete ---------------------------------------------------------
  for (const label of ['H01', PARVIN, 'H10', 'H11', 'H12', 'H13', 'H15']) {
    write(`resume ${label}`, 'POST', `${H(label)}resume/`, {});
  }
  write('resume, with a body nobody reads', 'POST', `${H('H01')}resume/`, '{"label":');
  write('resume a hold at another branch', 'POST', `${H('Mirpur 1')}resume/`, {});
  write(
    'resume a hold at another branch, as an owner',
    'POST',
    `${H('Mirpur 1')}resume/?branch=${mirpur}`,
    {},
    'owner',
  );
  write('resume a hold that is not there', 'POST', `/api/v1/pos/holds/${missing}/resume/`, {});
  write('delete a hold', 'DELETE', H('H03'), undefined);
  write('delete a hold at another branch', 'DELETE', H('Mirpur 2'), undefined);
  write('delete a hold at its branch', 'DELETE', H('Mirpur 2'), undefined, 'mirpur');
  write('delete a hold that is not there', 'DELETE', `/api/v1/pos/holds/${missing}/`, undefined);
  return cases;
}
