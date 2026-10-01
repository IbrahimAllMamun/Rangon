/**
 * Parity cases for the inventory admin (phase 4 part 4a): stock positions by
 * branch with their filters and orderings, low stock, valuation, the
 * integrity check, the editable reorder point and bin, adjustments and
 * write-offs, and the stock ledger with its date window, movement families
 * and the documents its rows open.
 *
 * Stock and history come from fixture_inventory.py (a second branch, PAR3,
 * stocked by a transfer). Every write case puts the inventory rows and the
 * ledger back from a snapshot before each API's request (`restore.ts`) and is
 * compared by the rows it leaves, the audit entries it writes and the
 * low-stock jobs it queues.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const STOCK_TABLES = ['inventory_inventory', 'inventory_inventorytransaction'];

export const STOCK_EFFECTS = [
  `SELECT b.code, v.sku, i.on_hand, i.reserved, i.average_cost::text AS average_cost,
          i.reorder_point, i.bin_location, i.updated_at >= $1 AS touched, i.created_at >= $1 AS created
     FROM inventory_inventory i JOIN accounts_branch b ON b.id = i.branch_id
     LEFT JOIN catalog_productvariant v ON v.id = i.variant_id
    ORDER BY b.code, v.sku NULLS LAST, i.variant_id`,
  `SELECT b.code, v.sku, t.transaction_type, t.quantity, t.unit_cost::text AS unit_cost,
          t.on_hand_after, t.reserved_after, t.reference_type, t.reference_id, t.reason, t.notes,
          u.email AS created_by, t.idempotency_key
     FROM inventory_inventorytransaction t JOIN accounts_branch b ON b.id = t.branch_id
     LEFT JOIN catalog_productvariant v ON v.id = t.variant_id
     LEFT JOIN accounts_user u ON u.id = t.created_by_id
    WHERE t.created_at >= $1 ORDER BY t.created_at`,
  // An adjustment names the inventory row (minted when the request made it),
  // a write-off the variant: both read back as the SKU.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch,
          COALESCE((SELECT v.sku FROM inventory_inventory i JOIN catalog_productvariant v ON v.id = i.variant_id
                     WHERE i.id::text = a.entity_id),
                   (SELECT v.sku FROM catalog_productvariant v WHERE v.id::text = a.entity_id),
                   a.entity_id) AS entity
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

export async function resetStock(client: pg.Client): Promise<void> {
  await restoreTables(client, STOCK_TABLES);
}

export async function inventoryCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const ids = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const branches = await ids(`SELECT code AS key, id FROM accounts_branch`);
  const variants = await ids(`SELECT sku AS key, id FROM catalog_productvariant`);
  const stock = await ids(
    `SELECT b.code || ' ' || v.sku AS key, i.id FROM inventory_inventory i
       JOIN accounts_branch b ON b.id = i.branch_id JOIN catalog_productvariant v ON v.id = i.variant_id`,
  );
  const ledger = await ids(`SELECT id::text AS key, id FROM inventory_inventorytransaction`);
  const referenced = await ids(
    `SELECT reference_type || ' ' || transaction_type AS key, id FROM inventory_inventorytransaction
      WHERE reference_type IN ('stock_transfer', 'stock_count', 'product_import', 'manual')
         OR reference_id IN ('legacy-42') OR reference_id ~ '[A-F]'`,
  );
  const capitals = (
    await db.query<{ id: string }>(
      `SELECT id FROM inventory_inventorytransaction WHERE reference_id ~ '^[0-9A-F-]{36}$'
          AND reference_id ~ '[A-F]'`,
    )
  ).rows[0]?.id;
  const legacy = (
    await db.query<{ id: string }>(
      `SELECT id FROM inventory_inventorytransaction WHERE reference_id = 'legacy-42'`,
    )
  ).rows[0]?.id;
  const onHand = new Map(
    (
      await db.query<{ key: string; on_hand: number }>(
        `SELECT b.code || ' ' || v.sku AS key, i.on_hand FROM inventory_inventory i
           JOIN accounts_branch b ON b.id = i.branch_id JOIN catalog_productvariant v ON v.id = i.variant_id`,
      )
    ).rows.map((row) => [row.key, row.on_hand]),
  );
  const barcode = (
    await db.query<{ barcode: string }>(
      `SELECT barcode FROM catalog_productvariant WHERE sku = 'RGN-BLO-L-BEI'`,
    )
  ).rows[0]?.barcode as string;
  await db.end();
  if (!branches.has('PAR3')) {
    console.log('SKIP  inventory admin: fixture_inventory.py has not been applied');
    return [];
  }
  const B = (code: string) => branches.get(code) as string;
  const V = (sku: string) => variants.get(sku) as string;
  const S = (key: string) => stock.get(key) as string;
  const known = new Set([...ledger.values(), ...stock.values()]);
  const missing = '00000000-0000-4000-8000-000000000000';
  const day = new Date().toISOString().slice(0, 10);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `admin inventory: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    who: Who = 'owner',
    headers: Record<string, string> = {},
  ) =>
    cases.push({
      name: `admin inventory: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: resetStock,
      effects: STOCK_EFFECTS,
      jobs: true,
      // A new ledger row's id and time are each API's own; so is the moment
      // an update saved.
      normalize: (response) => {
        const row = response as Record<string, unknown> | null;
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        if (typeof row.id === 'string' && !known.has(row.id)) {
          row.id = '<minted>';
          row.created_at = '<now>';
        }
        if ('updated_at' in row) row.updated_at = '<now>';
      },
    });

  // --- Who may read and act ---------------------------------------------------------
  for (const who of [
    'anon',
    'customer',
    'cashier',
    'stock',
    'accountant',
    'manager',
    'mirpur',
    'admin',
    'super',
    'norole',
  ] as Who[]) {
    read(`[${who}] list`, '/api/v1/inventory/?page_size=100', who);
    read(`[${who}] low stock`, '/api/v1/inventory/low-stock/', who);
    read(`[${who}] valuation`, '/api/v1/inventory/valuation/', who);
    read(`[${who}] ledger`, '/api/v1/inventory-transactions/?page_size=100', who);
    read(`[${who}] a PAR3 row`, `/api/v1/inventory/${S('PAR3 RGN-BLO-L-BEI')}/`, who);
    read(`[${who}] a DHK1 row`, `/api/v1/inventory/${S('DHK1 RGN-BLO-L-BEI')}/`, who);
    read(`[${who}] integrity`, '/api/v1/inventory/verify-integrity/', who, {
      method: 'POST',
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: '{}',
    });
    // Methods no route takes: the view's permission check sees no action.
    read(`[${who}] DELETE a row`, `/api/v1/inventory/${S('DHK1 RGN-BLO-L-BEI')}/`, who, {
      method: 'DELETE',
    });
    read(`[${who}] POST the list`, '/api/v1/inventory/', who, { method: 'POST' });
    read(`[${who}] GET adjust`, '/api/v1/inventory/adjust/', who);
    read(`[${who}] PUT low-stock`, '/api/v1/inventory/low-stock/', who, { method: 'PUT' });
    read(`[${who}] DELETE a ledger row`, `/api/v1/inventory-transactions/${legacy}/`, who, {
      method: 'DELETE',
    });
  }

  // --- The list -----------------------------------------------------------------------
  for (const query of [
    '',
    '?page=2',
    '?page=last',
    '?page=9',
    '?page_size=5&page=3',
    '?ordering=on_hand&page_size=100',
    '?ordering=-on_hand&page_size=100',
    '?ordering=updated_at&page_size=100',
    '?ordering=-updated_at,on_hand&page_size=100',
    '?ordering=reserved',
    '?ordering=product_name,on_hand',
    '?filter=low-stock',
    '?filter=out-of-stock',
    '?filter=expiring',
    '?filter=expiring&ordering=on_hand',
    '?filter=LOW-STOCK',
    '?filter=low-stock&filter=expiring',
    '?category=kurti',
    '?category=t-shirts&filter=low-stock',
    '?category=',
    '?search=kurti',
    '?search=RGN-CLA',
    '?search=par-tee',
    `?search=${barcode}`,
    `?search=${barcode.slice(0, 6)}`,
    '?search=%25',
    '?search=_',
    '?search=%20',
    '?search=a%00b',
    '?category=a%00b',
    `?branch=${B('PAR3')}`,
    `?branch=${B('PAR3')}&ordering=on_hand`,
    `?branch=${B('PAR2')}`,
    `?branch=${missing}`,
    '?branch=x&variant=y',
    `?variant=${V('RGN-CLA-L-WHI')}`,
    `?variant=${V('RGN-CLA-L-WHI')}&branch=${B('DHK1')}`,
    `?variant=${missing}`,
    '?branch=',
  ]) {
    read(`list ${query || '(all)'}`, `/api/v1/inventory/${query}`);
  }
  read('list as the PAR3 manager', '/api/v1/inventory/?page_size=100', 'mirpur');
  read(
    'list as the PAR3 manager, DHK1 asked for',
    `/api/v1/inventory/?branch=${B('DHK1')}`,
    'mirpur',
  );
  read('list as the PAR3 manager, low stock', '/api/v1/inventory/?filter=low-stock', 'mirpur');
  read('list, a shortfall worth nothing', `/api/v1/inventory/?branch=${B('PAR3')}`, 'owner', {
    setup: [`UPDATE inventory_inventory SET on_hand = -2 WHERE id = '${S('PAR3 PAR-FREE')}'`],
    teardown: [`UPDATE inventory_inventory SET on_hand = 0 WHERE id = '${S('PAR3 PAR-FREE')}'`],
  });

  // --- Low stock -----------------------------------------------------------------------
  for (const query of [
    '',
    '?page=2',
    '?page_size=1',
    '?page_size=1&page=2',
    '?filter=out-of-stock',
    '?filter=expiring',
    '?search=tee',
    '?search=nothing-like-this',
    `?branch=${B('DHK1')}`,
    '?ordering=-on_hand',
  ]) {
    read(`low stock ${query || '(all)'}`, `/api/v1/inventory/low-stock/${query}`);
  }
  read('low stock as the PAR3 manager', '/api/v1/inventory/low-stock/', 'mirpur');
  read('low stock as a DHK1 manager', '/api/v1/inventory/low-stock/', 'manager');

  // --- Detail ---------------------------------------------------------------------------
  for (const [key, id] of stock) {
    if (key.startsWith('PAR3') || key === 'DHK1 RGN-CLA-L-WHI' || key === 'DHK1 RGN-LIN-M-WHI')
      read(`row ${key}`, `/api/v1/inventory/${id}/`);
  }
  read('row, not a uuid', '/api/v1/inventory/abc/');
  read('row, not there', `/api/v1/inventory/${missing}/`);
  read('row, filtered out', `/api/v1/inventory/${S('PAR3 RGN-BLO-L-BEI')}/?branch=${B('DHK1')}`);
  read('row, a bad filter', `/api/v1/inventory/${S('PAR3 RGN-BLO-L-BEI')}/?branch=x`);
  read('row, searched out', `/api/v1/inventory/${S('PAR3 RGN-BLO-L-BEI')}/?search=lipstick`);
  read(
    'row, out of the low-stock filter',
    `/api/v1/inventory/${S('DHK1 RGN-CLA-L-WHI')}/?filter=low-stock`,
  );
  read(
    'row of another branch, as the PAR3 manager',
    `/api/v1/inventory/${S('DHK1 RGN-BLO-L-BEI')}/`,
    'mirpur',
  );

  // --- Valuation and the integrity check ---------------------------------------------------
  read('valuation as the PAR3 manager', '/api/v1/inventory/valuation/', 'mirpur');
  read('valuation, a query string ignored', `/api/v1/inventory/valuation/?branch=${B('PAR3')}`);
  const integrity = (name: string, body: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    read(`integrity ${name}`, '/api/v1/inventory/verify-integrity/', who, {
      method: 'POST',
      headers: { ...auth(who), 'content-type': 'application/json' },
      body,
      ...extra,
    });
  integrity('(all)', '{}');
  integrity('at PAR3', JSON.stringify({ branch: B('PAR3') }));
  integrity('at an inactive branch', JSON.stringify({ branch: B('PAR2') }));
  integrity('at a branch that is not there', JSON.stringify({ branch: missing }));
  integrity('at a malformed branch', JSON.stringify({ branch: 'x' }));
  integrity('with a blank branch', JSON.stringify({ branch: '' }));
  integrity('with a list body', '[]');
  integrity('with a null body', 'null');
  integrity('with no body', '');
  integrity('with broken JSON', '{"branch":');
  integrity('as an administrator at PAR3', JSON.stringify({ branch: B('PAR3') }), 'admin');
  const drift = {
    setup: [
      `UPDATE inventory_inventory SET on_hand = on_hand + 2 WHERE id = '${S('PAR3 RGN-BLO-L-BEI')}'`,
      `UPDATE inventory_inventory SET reserved = reserved + 1 WHERE id = '${S('DHK1 RGN-LIN-M-WHI')}'`,
    ],
    teardown: [
      `UPDATE inventory_inventory SET on_hand = on_hand - 2 WHERE id = '${S('PAR3 RGN-BLO-L-BEI')}'`,
      `UPDATE inventory_inventory SET reserved = reserved - 1 WHERE id = '${S('DHK1 RGN-LIN-M-WHI')}'`,
    ],
  };
  integrity('with drift', '{}', 'owner', drift);
  integrity('with drift, at PAR3', JSON.stringify({ branch: B('PAR3') }), 'owner', drift);

  // --- The ledger -----------------------------------------------------------------------------
  const L = '/api/v1/inventory-transactions/';
  for (const query of [
    '',
    '?page=2',
    '?page=last',
    '?page_size=100&page=2',
    '?ordering=created_at',
    '?ordering=-created_at&page_size=3',
    '?ordering=quantity',
    `?date_from=${day}`,
    `?date_to=${day}`,
    `?date_from=${day}&date_to=${day}`,
    '?date_from=2026-01-01&date_to=2026-01-02T10:00Z',
    '?date_from=2020-01-01T00:00:00%2B05:30',
    '?date_from=2026W011',
    '?date_from=20260101',
    '?date_from=2026010112',
    '?date_from=2026-01-01T10:00:00.1234567x%2B05:00',
    '?date_from=0001-01-01',
    '?date_to=9999-12-31',
    '?date_from=2009-06-19T23:30',
    '?date_from=%20%202026-01-01%20',
    '?date_from=2026-13-01',
    '?date_from=yesterday',
    '?date_from=&date_to=',
    '?date_from=2026-01-01T24:00',
    '?date_from=2026-01-01T10:00%2B24:00',
    '?date_from=2026-01-01T10:00:00%2B05:00:00.5',
    '?date_from=bad&date_to=worse',
    '?date_from=2026-01-01%C3%A910:00',
    '?date_from=a%00b',
    '?types=DAMAGE,LOSS',
    '?types=damage,%20loss,',
    '?types=transfer_in,TRANSFER_OUT',
    '?types=,',
    '?types=zap,Abc,DAMAGE',
    '?types=stra%C3%9Fe',
    '?types=DAMAGE&transaction_type=LOSS',
    '?transaction_type=ADJUSTMENT',
    '?transaction_type=adjustment',
    '?transaction_type=',
    '?reference_type=stock_transfer',
    '?reference_type=%20stock_count%20',
    '?reference_type=a%00b',
    `?branch=${B('PAR3')}`,
    `?branch=${B('PAR3')}&variant=${V('RGN-CLA-L-WHI')}`,
    `?variant=${missing}`,
    '?branch=x&variant=y&transaction_type=z&reference_type=a%00b',
    '?search=tee',
    '?search=%20kurti%20',
    '?search=RGN-ESS',
    '?search=a%00b',
    '?search=%25',
    '?date_from=bad&types=zap&branch=x',
    '?types=zap&branch=x',
  ]) {
    read(`ledger ${query || '(all)'}`, `${L}${query}`);
  }
  read('ledger as the PAR3 manager', `${L}?page_size=100`, 'mirpur');
  read('ledger as the PAR3 manager, DHK1 asked for', `${L}?branch=${B('DHK1')}`, 'mirpur');
  for (const [key, id] of referenced) read(`ledger row ${key}`, `${L}${id}/`);
  read('ledger row, a reference that is not a UUID', `${L}${legacy}/`);
  if (capitals) read('ledger row, a reference in capitals', `${L}${capitals}/`);
  read('ledger row, filtered out', `${L}${legacy}/?types=LOSS`);
  read('ledger row, outside the window', `${L}${legacy}/?date_to=2001-01-01`);
  read('ledger row, a bad window', `${L}${legacy}/?date_to=never`);
  read('ledger row, not a uuid', `${L}abc/`);
  read('ledger row, not there', `${L}${missing}/`);
  read('ledger row of another branch, as the PAR3 manager', `${L}${legacy}/`, 'mirpur');

  // --- Update: the reorder point and the bin, taken as sent ----------------------------------------
  const row = `/api/v1/inventory/${S('DHK1 RGN-CLA-L-WHI')}/`;
  const low = `/api/v1/inventory/${S('PAR3 RGN-BLO-L-BEI')}/`;
  for (const [name, body] of [
    ['both', { reorder_point: 8, bin_location: 'A-3' }],
    ['a reorder point that makes it low', { reorder_point: 20 }],
    ['nothing', {}],
    ['other fields only', { on_hand: 999, reserved: 4, average_cost: '1.00', variant: missing }],
    ['a reorder point as a string', { reorder_point: '12' }],
    ['a reorder point in Bengali digits', { reorder_point: '১২' }],
    ['a reorder point that is not a number', { reorder_point: 'abc' }],
    ['a fractional reorder point', { reorder_point: 3.7 }],
    ['a small negative reorder point', { reorder_point: -0.5 }],
    ['a boolean reorder point', { reorder_point: true }],
    ['a null reorder point', { reorder_point: null }],
    ['a list reorder point', { reorder_point: [1] }],
    ['the largest reorder point', { reorder_point: 2147483647 }],
    ['a reorder point past integer', { reorder_point: 2147483648 }],
    ['an infinite reorder point', '{"reorder_point": 1e400}'],
    ['a numeric bin', { bin_location: 5 }],
    ['a float bin', { bin_location: 4.0 }],
    ['a structured bin', '{"bin_location": {"a": [1, 2.0, true, null]}}'],
    ['a null bin', { bin_location: null }],
    ['a bin past 64 characters', { bin_location: 'x'.repeat(65) }],
    ['a bin of 64 characters', { bin_location: 'y'.repeat(64) }],
    ['a list naming the field', ['reorder_point']],
    ['a list naming nothing', ['x']],
    ['an empty list', []],
    ['a string naming the field', '"reorder_point"'],
    ['a string naming nothing', '"bin"'],
    ['a number', '5'],
    ['null', 'null'],
    ['broken JSON', '{"reorder_point":'],
  ] as [string, unknown][]) {
    write(`PATCH ${name}`, 'PATCH', row, body);
  }
  write('PUT both', 'PUT', row, { reorder_point: 2, bin_location: ' B-1 ' });
  write('PUT on a low row', 'PUT', low, { reorder_point: 1 });
  write('PATCH as a cashier', 'PATCH', row, { reorder_point: 1 }, 'cashier');
  write('PATCH as the PAR3 manager, a DHK1 row', 'PATCH', row, { reorder_point: 1 }, 'mirpur');
  write('PATCH as the PAR3 manager, own row', 'PATCH', low, { reorder_point: 1 }, 'mirpur');
  write('PATCH a row filtered out', 'PATCH', `${row}?filter=low-stock`, { reorder_point: 1 });
  write('PATCH a row not there', 'PATCH', `/api/v1/inventory/${missing}/`, { reorder_point: 1 });
  write('PATCH a row not there, broken JSON', 'PATCH', `/api/v1/inventory/${missing}/`, '{');

  // --- Adjust ----------------------------------------------------------------------------------------
  const adjust = '/api/v1/inventory/adjust/';
  const adj = (name: string, body: unknown, who: Who = 'owner') =>
    write(`adjust ${name}`, 'POST', adjust, body, who);
  adj('down', { variant: V('RGN-LIN-M-WHI'), new_on_hand: 2, reason: ' Recount ' });
  adj('up, received here', { variant: V('RGN-BLO-L-BEI'), new_on_hand: 20, reason: 'Found a box' });
  adj('to the same figure', {
    variant: V('RGN-CLA-L-WHI'),
    new_on_hand: onHand.get('DHK1 RGN-CLA-L-WHI'),
    reason: 'Checked',
  });
  adj('at PAR3, into low stock', {
    variant: V('RGN-BLO-L-BEI'),
    branch: B('PAR3'),
    new_on_hand: 2,
    reason: 'Shrinkage',
  });
  adj('at PAR3, never received', {
    variant: V('PAR-FREE'),
    branch: B('PAR3'),
    new_on_hand: 3,
    reason: 'Found',
  });
  adj('at PAR3, never received, to zero', {
    variant: V('PAR-FREE'),
    branch: B('PAR3'),
    new_on_hand: 0,
    reason: 'Nothing there',
  });
  adj('a variant never stocked here', {
    variant: V('PAR-TWA'),
    new_on_hand: 1,
    reason: 'Found',
  });
  adj('a variant never stocked here, to zero', {
    variant: V('PAR-TWA'),
    new_on_hand: 0,
    reason: 'Nothing there',
  });
  adj('a variant that is not there', { variant: missing, new_on_hand: 4, reason: 'x' });
  adj('a variant that is not there, to zero', { variant: missing, new_on_hand: 0, reason: 'x' });
  adj('at an inactive branch', {
    variant: V('RGN-CLA-L-WHI'),
    branch: B('PAR2'),
    new_on_hand: 1,
    reason: 'x',
  });
  adj('at a branch that is not there', {
    variant: V('RGN-CLA-L-WHI'),
    branch: missing,
    new_on_hand: 1,
    reason: 'x',
  });
  adj(
    'as the PAR3 manager, at DHK1',
    {
      variant: V('RGN-CLA-L-WHI'),
      branch: B('DHK1'),
      new_on_hand: 1,
      reason: 'x',
    },
    'mirpur',
  );
  adj(
    'as the PAR3 manager, own branch',
    {
      variant: V('RGN-CLA-L-WHI'),
      new_on_hand: 1,
      reason: 'Recount',
    },
    'mirpur',
  );
  adj(
    'as a stock keeper',
    { variant: V('RGN-CLA-L-WHI'), new_on_hand: 14, reason: 'Recount' },
    'stock',
  );
  adj(
    'as a cashier',
    { variant: V('RGN-CLA-L-WHI'), new_on_hand: 14, reason: 'Recount' },
    'cashier',
  );
  for (const [name, value] of [
    ['negative', -1],
    ['a string', ' 7 '],
    ['a decimal string', '7.0'],
    ['a float', 1.5],
    ['a whole float', 7.0],
    ['a boolean', true],
    ['null', null],
    ['text', 'many'],
    ['huge, received here', 100000000000000000000n],
  ] as [string, unknown][]) {
    const body =
      typeof value === 'bigint'
        ? `{"variant": "${V('RGN-CLA-L-WHI')}", "new_on_hand": ${value}, "reason": "x"}`
        : { variant: V('RGN-CLA-L-WHI'), new_on_hand: value, reason: 'x' };
    adj(`new_on_hand ${name}`, body);
  }
  adj(
    'new_on_hand huge, never received',
    `{"variant": "${V('PAR-FREE')}", "branch": "${B('PAR3')}", "new_on_hand": 100000000000000000000, "reason": "x"}`,
  );
  adj('new_on_hand past integer', {
    variant: V('RGN-CLA-L-WHI'),
    new_on_hand: 2147483648,
    reason: 'x',
  });
  for (const [name, reason] of [
    ['blank', ''],
    ['spaces', '   '],
    ['too long', 'r'.repeat(256)],
    ['null', null],
    ['a number', 5],
  ] as [string, unknown][]) {
    adj(`reason ${name}`, { variant: V('RGN-CLA-L-WHI'), new_on_hand: 3, reason });
  }
  adj('nothing', {});
  adj('a malformed variant and branch', { variant: 'x', branch: 'y', new_on_hand: 1, reason: 'x' });
  adj('a null branch', { variant: V('RGN-CLA-L-WHI'), branch: null, new_on_hand: 1, reason: 'x' });
  adj('an integer variant', { variant: 5, new_on_hand: 1, reason: 'x' });
  adj('a list', []);
  adj('null', 'null');
  adj('broken JSON', '{"variant":');

  // --- Write-off -------------------------------------------------------------------------------------
  const writeOff = '/api/v1/inventory/write-off/';
  const off = (name: string, body: unknown, who: Who = 'owner', key?: string) =>
    write(
      `write-off ${name}`,
      'POST',
      writeOff,
      body,
      who,
      key === undefined ? {} : { 'idempotency-key': key },
    );
  off('damage', {
    variant: V('RGN-CLA-L-WHI'),
    quantity: 1,
    transaction_type: 'DAMAGE',
    reason: ' Torn ',
    notes: ' left sleeve ',
  });
  off('loss at PAR3, into low stock', {
    variant: V('RGN-BLO-L-BEI'),
    branch: B('PAR3'),
    quantity: 1,
    transaction_type: 'LOSS',
    reason: 'Missing',
  });
  off(
    'with a key',
    {
      variant: V('RGN-CLA-L-WHI'),
      quantity: 2,
      transaction_type: 'LOSS',
      reason: 'Stolen',
    },
    'owner',
    'parity-new-key',
  );
  off(
    'replaying a claimed key with another body',
    {
      variant: V('RGN-LIN-M-WHI'),
      quantity: 5,
      transaction_type: 'LOSS',
      reason: 'Retry',
    },
    'owner',
    'parity-fixture-write-off',
  );
  off(
    'replaying a claimed key, as the PAR3 manager',
    {
      variant: V('RGN-CLA-L-WHI'),
      quantity: 2,
      transaction_type: 'DAMAGE',
      reason: 'Retry',
    },
    'mirpur',
    'parity-fixture-write-off',
  );
  off(
    'a blank key',
    {
      variant: V('RGN-CLA-L-WHI'),
      quantity: 1,
      transaction_type: 'DAMAGE',
      reason: 'x',
    },
    'owner',
    '',
  );
  off(
    'a key past 80 characters',
    {
      variant: V('RGN-CLA-L-WHI'),
      quantity: 1,
      transaction_type: 'DAMAGE',
      reason: 'x',
    },
    'owner',
    'k'.repeat(81),
  );
  off('more than the shelf holds', {
    variant: V('RGN-ESS-XL-WHI'),
    branch: B('PAR3'),
    quantity: 1,
    transaction_type: 'DAMAGE',
    reason: 'x',
  });
  off('a variant never stocked here', {
    variant: V('PAR-TWA'),
    quantity: 1,
    transaction_type: 'DAMAGE',
    reason: 'x',
  });
  off('a variant that is not there', {
    variant: missing,
    quantity: 1,
    transaction_type: 'DAMAGE',
    reason: 'x',
  });
  off(
    'a huge quantity',
    `{"variant": "${V('RGN-CLA-L-WHI')}", "quantity": 100000000000000000000, "transaction_type": "LOSS", "reason": "x"}`,
  );
  off('the whole shelf', {
    variant: V('RGN-LIN-M-WHI'),
    quantity: 6,
    transaction_type: 'LOSS',
    reason: 'Flood',
  });
  for (const [name, body] of [
    ['quantity zero', { quantity: 0 }],
    ['quantity a string', { quantity: '2' }],
    ['an adjustment type', { transaction_type: 'ADJUSTMENT' }],
    ['a lower-case type', { transaction_type: 'damage' }],
    ['notes null', { notes: null }],
    ['notes blank', { notes: '' }],
    ['notes a number', { notes: 12 }],
    ['reason blank', { reason: ' ' }],
  ] as [string, Record<string, unknown>][]) {
    off(name, {
      variant: V('RGN-CLA-L-WHI'),
      quantity: 1,
      transaction_type: 'DAMAGE',
      reason: 'x',
      ...body,
    });
  }
  off('nothing', {});
  off(
    'as the PAR3 manager, at DHK1',
    {
      variant: V('RGN-CLA-L-WHI'),
      branch: B('DHK1'),
      quantity: 1,
      transaction_type: 'DAMAGE',
      reason: 'x',
    },
    'mirpur',
  );
  off(
    'as an accountant',
    {
      variant: V('RGN-CLA-L-WHI'),
      quantity: 1,
      transaction_type: 'DAMAGE',
      reason: 'x',
    },
    'accountant',
  );

  return cases;
}
