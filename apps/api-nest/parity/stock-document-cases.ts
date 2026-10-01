/**
 * Parity cases for stock transfers and stock counts (phase 4 part 4b): the
 * lists from either end of a transfer, every ordering `OrderingFilter`
 * allows (a reverse relation repeats rows), a transfer's every refusal and
 * its idempotency key, and a count from creation through `record`, `apply`,
 * `cancel`, edits and deletion.
 *
 * Counts in each state and a transfer with a claimed key come from
 * fixture_inventory.py. Every write case puts the stock, the ledger, the two
 * documents with their lines, the variants' latest cost and the number
 * sequences back before each API's request, and is compared by what it
 * leaves there, the audit entries it writes and the jobs it queues.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { STOCK_EFFECTS, STOCK_TABLES } from './inventory-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const DOCUMENT_TABLES = [
  ...STOCK_TABLES,
  'inventory_stocktransfer',
  'inventory_stocktransferitem',
  'inventory_stockcount',
  'inventory_stockcountitem',
  'catalog_productvariant',
];

const DOCUMENT_EFFECTS = [
  ...STOCK_EFFECTS,
  `SELECT t.number, s.code AS source, d.code AS target, t.status, t.notes, u.email AS created_by,
          t.received_at, t.idempotency_key, t.created_at >= $1 AS created, t.updated_at >= $1 AS touched
     FROM inventory_stocktransfer t JOIN accounts_branch s ON s.id = t.source_branch_id
     JOIN accounts_branch d ON d.id = t.target_branch_id LEFT JOIN accounts_user u ON u.id = t.created_by_id
    ORDER BY t.number`,
  `SELECT t.number, v.sku, i.quantity, i.unit_cost::text AS unit_cost
     FROM inventory_stocktransferitem i JOIN inventory_stocktransfer t ON t.id = i.transfer_id
     JOIN catalog_productvariant v ON v.id = i.variant_id ORDER BY t.number, v.sku`,
  `SELECT c.number, b.code AS branch, c.status, c.notes, u.email AS created_by,
          c.applied_at IS NOT NULL AS applied, a.email AS applied_by,
          c.created_at >= $1 AS created, c.updated_at >= $1 AS touched
     FROM inventory_stockcount c JOIN accounts_branch b ON b.id = c.branch_id
     LEFT JOIN accounts_user u ON u.id = c.created_by_id LEFT JOIN accounts_user a ON a.id = c.applied_by_id
    ORDER BY c.number`,
  `SELECT c.number, v.sku, i.expected_quantity, i.counted_quantity, i.notes,
          i.created_at >= $1 AS created, i.updated_at >= $1 AS touched
     FROM inventory_stockcountitem i JOIN inventory_stockcount c ON c.id = i.stock_count_id
     JOIN catalog_productvariant v ON v.id = i.variant_id ORDER BY c.number, v.sku`,
  // A transfer sets the variant's latest cost to what the units cost the source.
  `SELECT sku, cost::text AS cost, updated_at >= $1 AS touched FROM catalog_productvariant ORDER BY sku`,
  `SELECT key, last_value FROM core_numbersequence WHERE key IN ('stock_transfer', 'stock_count') ORDER BY key`,
];

export async function resetDocuments(client: pg.Client): Promise<void> {
  await restoreTables(client, DOCUMENT_TABLES);
  await restoreSequences(client);
}

export async function stockDocumentCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const ids = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const branches = await ids(`SELECT code AS key, id FROM accounts_branch`);
  const variants = await ids(`SELECT sku AS key, id FROM catalog_productvariant`);
  const transfers = await ids(`SELECT number AS key, id FROM inventory_stocktransfer`);
  const counts = await ids(`SELECT notes AS key, id FROM inventory_stockcount`);
  const known = new Set(
    [
      ...(await ids(`SELECT id::text AS key, id FROM inventory_stocktransfer`)).values(),
      ...(await ids(`SELECT id::text AS key, id FROM inventory_stockcount`)).values(),
      ...(await ids(`SELECT id::text AS key, id FROM inventory_stocktransferitem`)).values(),
      ...(await ids(`SELECT id::text AS key, id FROM inventory_stockcountitem`)).values(),
    ].map(String),
  );
  await db.end();
  if (!counts.has('Parity counting')) {
    console.log('SKIP  stock documents: fixture_inventory.py has not been applied');
    return [];
  }
  const B = (code: string) => branches.get(code) as string;
  const V = (sku: string) => variants.get(sku) as string;
  const K = (notes: string) => `/api/v1/stock-counts/${counts.get(notes)}/`;
  const missing = '00000000-0000-4000-8000-000000000000';

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', method = 'GET') =>
    cases.push({ name: `admin stock documents: ${name}`, method, path, headers: auth(who) });
  // New documents and lines are each API's own: their ids and times.
  const mask = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(mask);
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (typeof row.id === 'string' && !known.has(row.id)) {
        row.id = '<minted>';
        if ('created_at' in row) row.created_at = '<now>';
      }
      if (row.applied_at) row.applied_at = '<now>';
      Object.values(row).forEach(mask);
    }
  };
  const write = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    who: Who = 'owner',
    headers: Record<string, string> = {},
  ) =>
    cases.push({
      name: `admin stock documents: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: resetDocuments,
      effects: DOCUMENT_EFFECTS,
      jobs: true,
      normalize: mask,
    });

  // --- Reading -----------------------------------------------------------------------------
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
    read(`[${who}] transfers`, '/api/v1/stock-transfers/', who);
    read(`[${who}] counts`, '/api/v1/stock-counts/', who);
    read(`[${who}] a DHK1 count`, K('Parity counting'), who);
    read(`[${who}] a PAR3 count`, K('Parity Mirpur counting'), who);
    read(
      `[${who}] PUT a transfer`,
      `/api/v1/stock-transfers/${transfers.get('TRF-000001')}/`,
      who,
      'PUT',
    );
    read(
      `[${who}] DELETE a transfer`,
      `/api/v1/stock-transfers/${transfers.get('TRF-000001')}/`,
      who,
      'DELETE',
    );
    read(`[${who}] GET apply`, `${K('Parity counting')}apply/`, who);
  }
  for (const query of [
    '',
    '?ordering=items',
    '?ordering=-items',
    '?ordering=number',
    '?ordering=-number',
    '?ordering=source_branch',
    '?ordering=-target_branch,number',
    '?ordering=source_branch__code,-created_at',
    '?ordering=target_branch__code',
    '?ordering=status,-received_at',
    '?ordering=notes',
    '?ordering=source_code',
    '?ordering=id',
    '?page=2',
    '?page_size=1&page=2',
  ]) {
    read(`transfers ${query || '(all)'}`, `/api/v1/stock-transfers/${query}`);
  }
  for (const query of [
    '',
    '?ordering=items',
    '?ordering=-items&page_size=3',
    '?ordering=branch',
    '?ordering=-branch,number',
    '?ordering=branch__code',
    '?ordering=status,notes',
    '?ordering=applied_at',
    '?ordering=-applied_at',
    '?ordering=branch_code',
    '?page=2',
    '?page_size=2&page=2',
  ]) {
    read(`counts ${query || '(all)'}`, `/api/v1/stock-counts/${query}`);
  }
  read('transfers as the PAR3 manager', '/api/v1/stock-transfers/', 'mirpur');
  read('counts as the PAR3 manager', '/api/v1/stock-counts/', 'mirpur');
  for (const [number, id] of transfers)
    read(`transfer ${number}`, `/api/v1/stock-transfers/${id}/`);
  for (const [notes, id] of counts) read(`count ${notes}`, `/api/v1/stock-counts/${id}/`);
  read('transfer, not a uuid', '/api/v1/stock-transfers/abc/');
  read('transfer, not there', `/api/v1/stock-transfers/${missing}/`);
  read('count, not there', `/api/v1/stock-counts/${missing}/`);
  read('a DHK1 count as the PAR3 manager', K('Parity counting'), 'mirpur');
  read('a PAR3 count as a DHK1 manager', K('Parity Mirpur counting'), 'manager');

  // --- Transfers --------------------------------------------------------------------------------
  const T = '/api/v1/stock-transfers/';
  const transfer = (
    name: string,
    body: unknown,
    who: Who = 'owner',
    headers: Record<string, string> = {},
  ) => write(`transfer ${name}`, 'POST', T, body, who, headers);
  const line = (sku: string, quantity: unknown) => ({ variant: V(sku), quantity });
  transfer('two lines, DHK1 to PAR3', {
    source_branch: B('DHK1'),
    target_branch: B('PAR3'),
    lines: [line('RGN-CLA-L-WHI', 3), line('RGN-ESS-XL-WHI', 2)],
    notes: ' For the weekend ',
  });
  transfer(
    'PAR3 to DHK1 by its manager, into low stock',
    {
      source_branch: B('PAR3'),
      target_branch: B('DHK1'),
      lines: [line('RGN-BLO-L-BEI', 3)],
    },
    'mirpur',
  );
  transfer('a variant DHK1 has never held, to it', {
    source_branch: B('PAR3'),
    target_branch: B('DHK1'),
    lines: [line('PAR-TEE-S-WHT', 4)],
  });
  transfer(
    'with a new key',
    {
      source_branch: B('DHK1'),
      target_branch: B('PAR3'),
      lines: [line('RGN-CLA-L-WHI', 1)],
    },
    'owner',
    { 'idempotency-key': 'parity-transfer-new' },
  );
  transfer(
    'replaying a claimed key with another body',
    {
      source_branch: B('PAR3'),
      target_branch: B('DHK1'),
      lines: [line('RGN-BLO-L-BEI', 1)],
    },
    'owner',
    { 'idempotency-key': 'parity-fixture-transfer' },
  );
  transfer(
    'a key past 80 characters',
    {
      source_branch: B('DHK1'),
      target_branch: B('PAR3'),
      lines: [line('RGN-CLA-L-WHI', 1)],
    },
    'owner',
    { 'idempotency-key': 'k'.repeat(81) },
  );
  transfer('to the same branch', {
    source_branch: B('DHK1'),
    target_branch: B('DHK1'),
    lines: [line('RGN-CLA-L-WHI', 1)],
  });
  transfer(
    'to the same branch, with a claimed key',
    {
      source_branch: B('DHK1'),
      target_branch: B('DHK1'),
      lines: [line('RGN-CLA-L-WHI', 1)],
    },
    'owner',
    { 'idempotency-key': 'parity-fixture-transfer' },
  );
  transfer('to an inactive branch', {
    source_branch: B('DHK1'),
    target_branch: B('PAR2'),
    lines: [line('RGN-CLA-L-WHI', 1)],
  });
  transfer('to a branch that is not there', {
    source_branch: B('DHK1'),
    target_branch: missing,
    lines: [line('RGN-CLA-L-WHI', 1)],
  });
  transfer('from an inactive branch', {
    source_branch: B('PAR2'),
    target_branch: B('DHK1'),
    lines: [line('RGN-CLA-L-WHI', 1)],
  });
  transfer(
    'from DHK1 by the PAR3 manager',
    {
      source_branch: B('DHK1'),
      target_branch: B('PAR3'),
      lines: [line('RGN-CLA-L-WHI', 1)],
    },
    'mirpur',
  );
  transfer(
    'as a cashier',
    {
      source_branch: B('DHK1'),
      target_branch: B('PAR3'),
      lines: [line('RGN-CLA-L-WHI', 1)],
    },
    'cashier',
  );
  transfer('more than the shelf holds', {
    source_branch: B('PAR3'),
    target_branch: B('DHK1'),
    lines: [line('RGN-BLO-L-BEI', 2), line('RGN-ESS-XL-WHI', 1)],
  });
  transfer('a variant that is not there', {
    source_branch: B('DHK1'),
    target_branch: B('PAR3'),
    lines: [{ variant: missing, quantity: 1 }],
  });
  transfer('the same variant twice', {
    source_branch: B('DHK1'),
    target_branch: B('PAR3'),
    lines: [line('RGN-CLA-L-WHI', 1), line('RGN-CLA-L-WHI', 2)],
  });
  transfer('no lines', { source_branch: B('DHK1'), target_branch: B('PAR3'), lines: [] });
  transfer('lines not a list', {
    source_branch: B('DHK1'),
    target_branch: B('PAR3'),
    lines: { variant: V('RGN-CLA-L-WHI') },
  });
  transfer('bad lines', {
    source_branch: B('DHK1'),
    target_branch: B('PAR3'),
    lines: [line('RGN-CLA-L-WHI', 0), { variant: 'x', quantity: 'many' }, null, {}],
    notes: 7,
  });
  transfer(
    'a huge quantity',
    `{"source_branch": "${B('DHK1')}", "target_branch": "${B('PAR3')}", "lines": [{"variant": "${V('RGN-CLA-L-WHI')}", "quantity": 100000000000000000000}]}`,
  );
  transfer('nothing', {});
  transfer('a list', []);
  transfer('broken JSON', '{"lines":');

  // --- Counts: create, edit, delete -------------------------------------------------------------------
  const counting = K('Parity counting');
  const mirpur = K('Parity Mirpur counting');
  const nothing = K('Parity nothing counted');
  const abandoned = K('Parity abandoned');
  const applied = K('Parity cycle count');
  write('create a count at DHK1', 'POST', '/api/v1/stock-counts/', {
    branch: B('DHK1'),
    notes: 'Quarterly',
  });
  write(
    'create a count at PAR3 by its manager',
    'POST',
    '/api/v1/stock-counts/',
    { branch: B('PAR3') },
    'mirpur',
  );
  write(
    'create a count at DHK1 by the PAR3 manager',
    'POST',
    '/api/v1/stock-counts/',
    { branch: B('DHK1') },
    'mirpur',
  );
  write('create a count at an inactive branch', 'POST', '/api/v1/stock-counts/', {
    branch: B('PAR2'),
  });
  write('create a count at a branch that is not there', 'POST', '/api/v1/stock-counts/', {
    branch: missing,
  });
  write('create a count with a status and number', 'POST', '/api/v1/stock-counts/', {
    branch: B('DHK1'),
    status: 'APPLIED',
    number: 'SC-999999',
    items: [],
  });
  write('create a count with null notes', 'POST', '/api/v1/stock-counts/', {
    branch: B('DHK1'),
    notes: null,
  });
  write(
    'create a count as a cashier',
    'POST',
    '/api/v1/stock-counts/',
    { branch: B('DHK1') },
    'cashier',
  );
  write('create a count from a list', 'POST', '/api/v1/stock-counts/', []);
  for (const [name, path, body, method, who] of [
    ['edit the notes', counting, { notes: 'Recounted' }, 'PATCH', 'owner'],
    ['move a count to PAR3', counting, { branch: B('PAR3') }, 'PATCH', 'owner'],
    ['move an applied count', applied, { branch: B('PAR3'), notes: 'Moved' }, 'PATCH', 'owner'],
    ['PUT without a branch', counting, { notes: 'x' }, 'PUT', 'owner'],
    ['PUT with a branch', counting, { branch: B('DHK1'), notes: 'Full' }, 'PUT', 'owner'],
    ['a null branch', counting, { branch: null }, 'PATCH', 'owner'],
    ['a branch that is not there', counting, { branch: missing }, 'PATCH', 'owner'],
    ['edit as the PAR3 manager, a DHK1 count', counting, { notes: 'x' }, 'PATCH', 'mirpur'],
    ['edit as the PAR3 manager, own count', mirpur, { branch: B('DHK1') }, 'PATCH', 'mirpur'],
    ['edit as a cashier', counting, { notes: 'x' }, 'PATCH', 'cashier'],
    ['delete as the owner', counting, undefined, 'DELETE', 'owner'],
    ['delete an applied count as the owner', applied, undefined, 'DELETE', 'owner'],
    ['delete as a superuser', abandoned, undefined, 'DELETE', 'super'],
    ['delete as a manager', counting, undefined, 'DELETE', 'manager'],
    ['delete as an administrator', counting, undefined, 'DELETE', 'admin'],
  ] as [string, string, unknown, string, Who][]) {
    write(name, method, path, body, who);
  }

  // --- Counts: record, cancel, apply ------------------------------------------------------------------
  const record = (name: string, path: string, body: unknown, who: Who = 'owner') =>
    write(`record ${name}`, 'POST', `${path}record/`, body, who);
  record('two figures', counting, {
    lines: [
      { variant: V('RGN-ESS-XL-WHI'), counted_quantity: 4, notes: ' Back shelf ' },
      { variant: V('RGN-CLA-L-WHI'), counted_quantity: 0 },
    ],
  });
  record('a figure twice', counting, {
    lines: [
      { variant: V('RGN-ESS-XL-WHI'), counted_quantity: 4 },
      { variant: V('RGN-ESS-XL-WHI').toUpperCase(), counted_quantity: 5 },
    ],
  });
  record('a variant not on the sheet', counting, {
    lines: [
      { variant: V('RGN-ESS-XL-WHI'), counted_quantity: 4 },
      { variant: V('PAR-TWA'), counted_quantity: 1 },
      { variant: missing, counted_quantity: 1 },
    ],
  });
  record('no lines', counting, { lines: [] });
  record('lines not a list', counting, { lines: 'all' });
  record('bad figures', counting, {
    lines: [
      { variant: V('RGN-ESS-XL-WHI'), counted_quantity: -1 },
      { variant: 'x', counted_quantity: '3', notes: 'n'.repeat(256) },
      { counted_quantity: 1 },
    ],
  });
  record('null notes', counting, {
    lines: [{ variant: V('RGN-ESS-XL-WHI'), counted_quantity: 1, notes: null }],
  });
  record('nothing', counting, {});
  record('a list', counting, []);
  record('on a cancelled count', abandoned, {
    lines: [{ variant: V('RGN-BLO-L-BEI'), counted_quantity: 1 }],
  });
  record('on an applied count', applied, { lines: [] });
  record(
    'as the PAR3 manager, own count',
    mirpur,
    {
      lines: [{ variant: V('PAR-TEE-S-WHT'), counted_quantity: 9 }],
    },
    'mirpur',
  );
  record('as a cashier', counting, { lines: [] }, 'cashier');
  for (const [name, path, who] of [
    ['a count being counted', counting, 'owner'],
    ['a cancelled count', abandoned, 'owner'],
    ['an applied count', applied, 'owner'],
    ['as the PAR3 manager, a DHK1 count', counting, 'mirpur'],
    ['as a cashier', counting, 'cashier'],
  ] as [string, string, Who][]) {
    write(`cancel ${name}`, 'POST', `${path}cancel/`, {}, who);
  }
  for (const [name, path, who] of [
    ['a count, up and down', counting, 'owner'],
    ['a count with a line never received', mirpur, 'owner'],
    ['a count with nothing counted', nothing, 'owner'],
    ['a cancelled count', abandoned, 'owner'],
    ['an applied count', applied, 'owner'],
    ['as a stock keeper', counting, 'stock'],
    ['as the PAR3 manager, a DHK1 count', counting, 'mirpur'],
    ['as an accountant', counting, 'accountant'],
  ] as [string, string, Who][]) {
    write(`apply ${name}`, 'POST', `${path}apply/`, {}, who);
  }

  return cases;
}
