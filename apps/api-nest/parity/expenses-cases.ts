/**
 * Parity cases for expenses and the party ledger (phase 6 part 2):
 * `/expense-categories/`, `/expenses/` -- with its summary, a receipt's
 * download and `void` -- and `/party-ledger/`. An expense is a document and a
 * movement written together, so each write is compared by the cash book's
 * queries and by the categories and expenses it changed.
 *
 * The expenses are the demo seed's and fixture_finance.py's.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { FINANCE_EFFECTS, FINANCE_TABLES } from './finance-cases.ts';
import { multipart, type Part } from './image-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const TABLES = ['finance_expense', 'finance_expensecategory', ...FINANCE_TABLES];
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(s) FROM "snap_${table}" s WHERE s.id = ${alias}.id)`;
const AUDIT = 4;

export const EXPENSE_EFFECTS = [
  ...FINANCE_EFFECTS.slice(0, AUDIT),
  // The audit log: an expense's `spent_at` is the moment it was recorded
  // unless the request stated one, so a fresh one is compared by its shape.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          (a.new_values - 'spent_at')::text AS new_values,
          CASE WHEN (a.new_values->>'spent_at')::timestamptz >= $1
               THEN regexp_replace(a.new_values->>'spent_at', '[0-9]', 'd', 'g')
               ELSE a.new_values->>'spent_at' END AS spent_at,
          a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
  ...FINANCE_EFFECTS.slice(AUDIT + 1),
  // Categories a request made or changed.
  `SELECT c.name, c.code, c.description, c.is_active, u.email AS created_by,
          c.id NOT IN (SELECT id FROM "snap_finance_expensecategory") AS made,
          c.updated_at > (SELECT s.updated_at FROM "snap_finance_expensecategory" s WHERE s.id = c.id)
            AS touched
     FROM finance_expensecategory c LEFT JOIN accounts_user u ON u.id = c.created_by_id
    WHERE ${CHANGED('c', 'finance_expensecategory')} ORDER BY c.name`,
  // Expenses a request made or changed, each beside its two movements.
  `SELECT e.number, b.code AS branch, c.code AS category, a.name AS account, e.amount::text,
          CASE WHEN e.spent_at < $1 THEN (e.spent_at AT TIME ZONE 'UTC')::text ELSE 'now' END AS spent,
          e.note, e.status, e.void_reason, e.idempotency_key,
          regexp_replace(e.attachment, '[0-9a-f]{32}', '<name>') AS attachment,
          regexp_replace(regexp_replace(e.attachment, '[0-9a-f]{32}.*$', ''), '[0-9]', 'd', 'g') AS folder,
          u.email AS created_by, v.email AS voided_by, e.voided_at IS NOT NULL AS voided,
          (SELECT t.transaction_type || ' ' || t.amount FROM finance_accounttransaction t
            WHERE t.id = e.transaction_id) AS movement,
          (SELECT t.transaction_type || ' ' || t.amount FROM finance_accounttransaction t
            WHERE t.id = e.reversal_id) AS reversal,
          e.id NOT IN (SELECT id FROM "snap_finance_expense") AS made
     FROM finance_expense e JOIN accounts_branch b ON b.id = e.branch_id
     JOIN finance_expensecategory c ON c.id = e.category_id
     JOIN finance_account a ON a.id = e.account_id
     LEFT JOIN accounts_user u ON u.id = e.created_by_id
     LEFT JOIN accounts_user v ON v.id = e.voided_by_id
    WHERE ${CHANGED('e', 'finance_expense')} ORDER BY e.number`,
];

export async function resetExpenses(client: pg.Client): Promise<void> {
  const snapped = await client.query(`SELECT to_regclass('pg_temp.snap_finance_account') AS t`);
  if (snapped.rows[0]?.t) {
    await client.query(
      `UPDATE finance_account SET is_default = false
        WHERE is_default AND id NOT IN (SELECT id FROM "snap_finance_account" WHERE is_default)`,
    );
  }
  await restoreTables(client, TABLES);
  await restoreSequences(client);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';
const BOUNDARY = 'ParityBoundary7MA4YWxkTrZu0gW';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export async function expensesCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const account = await map(`SELECT name AS key, id FROM finance_account`);
  const branch = await map(`SELECT code AS key, id FROM accounts_branch`);
  const category = await map(`SELECT code AS key, id FROM finance_expensecategory`);
  const expense = await map(
    `SELECT split_part(note, ':', 1) AS key, id FROM finance_expense WHERE note LIKE 'Parity %'`,
  );
  if (!category.has('PARITY_RETIRED') || !expense.has('Parity receipt')) {
    await db.end();
    console.log('SKIP  expenses: fixture_finance.py has not been applied');
    return [];
  }
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM finance_account UNION ALL SELECT id::text FROM finance_accounttransaction
       UNION ALL SELECT id::text FROM finance_expense UNION ALL SELECT id::text FROM finance_expensecategory
       UNION ALL SELECT id::text FROM accounts_branch`,
    )
  ).rows.map((row) => row.id);
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  // A new expense's receipt is served from a path that carries its new id.
  const blank = (body: unknown) => {
    const payload = body as Record<string, unknown> | null;
    if (payload && typeof payload === 'object') {
      for (const key of ['attachment', 'attachment_url']) {
        const value = payload[key];
        if (typeof value === 'string' && !everyId.some((id) => value.includes(id)))
          payload[key] = value.replace(/[0-9a-f-]{36}/, '<minted>');
      }
    }
    minted(body);
  };
  const text = (body: unknown) =>
    body === undefined
      ? undefined
      : typeof body === 'string' || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `expenses: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'accountant',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `expenses: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body) as string | Buffer | undefined,
      reset: resetExpenses,
      effects: EXPENSE_EFFECTS,
      normalize: blank,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const drawer = account.get('Counter Cash Drawer') as string;
  const bank = account.get('City Bank Current') as string;
  const till = account.get('Parity Mirpur Till') as string;
  const supplies = category.get('SUPPLIES') as string;
  const home = branch.get('DHK1') as string;

  // === Categories ==============================================================================
  const CATEGORIES = '/api/v1/expense-categories/';
  for (const who of everyone) {
    read(`[${who}] categories`, CATEGORIES, who);
    read(`[${who}] a category`, `${CATEGORIES}${supplies}/`, who);
  }
  for (const query of [
    'is_active=true',
    'is_active=false',
    'is_active=maybe',
    'search=rent',
    'search=PARITY',
    'search=no%20longer',
    'search=zzzz',
    'search=a%00b',
    'ordering=name',
    'ordering=-name',
    'ordering=created_at,name',
    'ordering=code',
    'page_size=4&page=2',
    'page=99',
  ]) {
    read(`categories ?${query}`, `${CATEGORIES}?${query}`);
  }
  read('a retired category', `${CATEGORIES}${category.get('PARITY_RETIRED')}/`);
  read('a category that is not there', `${CATEGORIES}${MISSING}/`);
  read('a category that is not a uuid', `${CATEGORIES}abc/`);
  read('a category, filtered out', `${CATEGORIES}${supplies}/?is_active=false`);
  read('DELETE a category', `${CATEGORIES}${supplies}/`, 'owner', { method: 'DELETE' });
  for (const who of everyone)
    write(`[${who}] add a category`, CATEGORIES, { name: 'Parity Tea' }, who);
  for (const [name, body] of [
    ['a name alone', { name: 'Parity Tea' }],
    ['a name of two words', { name: 'Parity tea and biscuits' }],
    ['a name longer than a code', { name: 'Parity the long name of a category of spending' }],
    ['a name and a code', { name: 'Parity Tea', code: 'tea  money' }],
    ['a padded name', { name: '  Parity Tea  ' }],
    ['a name in Bengali', { name: 'চা নাস্তা' }],
    [
      'everything stated',
      { name: 'Parity Tea', code: 'TEA', description: 'Tea and snacks', is_active: false },
    ],
    ['a name another category has', { name: 'Rent' }],
    ['a name another category has, in another case', { name: 'rent' }],
    ['a name another has in another case, and a code of its own', { name: 'rent', code: 'LEASE' }],
    ['a code another category has', { name: 'Parity Tea', code: 'RENT' }],
    ['a code another has, in another case', { name: 'Parity Tea', code: 'rent' }],
    ['a name whose code another category has', { name: 'salary', code: '' }],
    ['a blank code', { name: 'Parity Tea', code: '' }],
    ['a code of spaces', { name: 'Parity Tea', code: '   ' }],
    ['a null code', { name: 'Parity Tea', code: null }],
    ['a code of 32 characters', { name: 'Parity Tea', code: 'C'.repeat(32) }],
    ['a code of 33 characters', { name: 'Parity Tea', code: 'C'.repeat(33) }],
    ['a blank name', { name: '' }],
    ['a name of spaces', { name: '   ' }],
    ['a name of 120 characters', { name: 'n'.repeat(120) }],
    ['a name of 121 characters', { name: 'n'.repeat(121) }],
    ['a null name', { name: null }],
    ['no name', { code: 'TEA' }],
    ['a description of 256 characters', { name: 'Parity Tea', description: 'd'.repeat(256) }],
    ['an active switch that is not a boolean', { name: 'Parity Tea', is_active: 'maybe' }],
    ['a count stated', { name: 'Parity Tea', expense_count: 9 }],
    ['a body that is a list', [{ name: 'Parity Tea' }]],
    ['broken JSON', '{"name":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`add a category: ${name}`, CATEGORIES, body);
  }
  const editCategory = (
    name: string,
    id: string,
    body: unknown,
    who: Who = 'accountant',
    method = 'PATCH',
  ) => write(`edit a category: ${name}`, `${CATEGORIES}${id}/`, body, who, { method });
  for (const who of everyone)
    editCategory(`[${who}] its description`, supplies, { description: 'Paper and pens' }, who);
  for (const [name, body] of [
    ['renamed', { name: 'Stationery' }],
    ['renamed to what it is called', { name: 'Office supplies' }],
    ['renamed to its own name in another case', { name: 'office SUPPLIES' }],
    ['renamed to another’s name', { name: 'Rent' }],
    ['renamed to another’s name in another case', { name: 'RENT' }],
    ['renamed with padding', { name: '  Stationery  ' }],
    ['renamed to nothing', { name: '' }],
    ['retired', { is_active: false }],
    ['its code changed', { code: 'STATIONERY' }],
    ['its code changed to another’s', { code: 'RENT' }],
    ['its code changed to nothing', { code: '' }],
    ['nothing at all', {}],
    ['everything it has, restated', { name: 'Office supplies', description: '', is_active: true }],
    ['a description of 256 characters', { description: 'd'.repeat(256) }],
    ['a body that is a list', []],
    ['broken JSON', '{"name":'],
  ] as [string, unknown][]) {
    editCategory(name, supplies, body);
    if (['renamed', 'nothing at all', 'retired'].includes(name))
      editCategory(`${name}, by PUT`, supplies, body, 'accountant', 'PUT');
  }
  editCategory('a retired one brought back', category.get('PARITY_RETIRED') as string, {
    is_active: true,
  });
  editCategory('one that is not there', MISSING, { name: 'x' });
  editCategory('one that is not there, with broken JSON', MISSING, '{"name":');

  // === Expenses: reading =======================================================================
  const EXPENSES = '/api/v1/expenses/';
  for (const who of everyone) {
    read(`[${who}] expenses`, `${EXPENSES}?page_size=4`, who);
    read(`[${who}] an expense`, `${EXPENSES}${expense.get('Parity receipt')}/`, who);
    read(`[${who}] the summary`, `${EXPENSES}summary/`, who);
    read(`[${who}] a receipt`, `${EXPENSES}${expense.get('Parity receipt')}/attachment/`, who);
    read(`[${who}] the party ledger`, '/api/v1/party-ledger/', who);
  }
  const WINDOWS = [
    'date_from=2026-09-01',
    'date_to=2026-09-15',
    'date_from=2026-09-01&date_to=2026-09-30',
    'date_from=2026-09-01T10:30:00%2B06:00',
    'date_from=2099-01-01',
    'date_from=abc',
    'date_to=2026-02-30',
    'date_from=',
  ];
  for (const query of [
    '',
    'include_void=false',
    'include_void=FALSE',
    'include_void=true',
    'include_void=0',
    'include_void=',
    'status=RECORDED',
    'status=VOID',
    'status=void',
    'status=VOID&include_void=false',
    `branch=${home}`,
    `branch=${branch.get('PAR3')}`,
    `branch=${MISSING}`,
    'branch=abc',
    `category=${supplies}`,
    `category=${category.get('PARITY_RETIRED')}`,
    `category=${MISSING}`,
    'category=abc',
    `account=${drawer}`,
    `account=${bank}`,
    `account=${MISSING}`,
    'status=NOPE&branch=x&category=y&account=z',
    ...WINDOWS,
    'search=EXP-00001',
    'search=parity',
    'search=printer%20paper',
    'search=supplies',
    'search=transport,courier',
    'search=zzzz',
    'search=a%00b',
    'ordering=spent_at',
    'ordering=-spent_at',
    'ordering=amount,spent_at',
    'ordering=-amount,spent_at',
    'ordering=created_at',
    'ordering=number',
    'page_size=3&page=2',
    'page=99',
    `category=${supplies}&status=RECORDED&ordering=-amount&search=parity`,
  ]) {
    read(`expenses ?${query}`, `${EXPENSES}?page_size=6&${query}`);
  }
  read('expenses, the other branch’s manager', EXPENSES, 'mirpur');
  read(
    'expenses, another branch asked for by a branch accountant',
    `${EXPENSES}?branch=${branch.get('PAR3')}`,
    'accountant',
  );
  for (const key of ['Parity receipt', 'Parity dated', 'Parity voided', 'Parity mirpur']) {
    const id = expense.get(key) as string;
    read(`the expense "${key}"`, `${EXPENSES}${id}/`);
    read(`the receipt of "${key}"`, `${EXPENSES}${id}/attachment/`);
  }
  const receipt = expense.get('Parity receipt') as string;
  read(
    'another branch’s expense, by a branch accountant',
    `${EXPENSES}${expense.get('Parity mirpur')}/`,
    'accountant',
  );
  read('an expense at their own branch', `${EXPENSES}${expense.get('Parity mirpur')}/`, 'mirpur');
  read('an expense that is not there', `${EXPENSES}${MISSING}/`);
  read('an expense that is not a uuid', `${EXPENSES}abc/`);
  read(
    'a voided expense, voided ones left out',
    `${EXPENSES}${expense.get('Parity voided')}/?include_void=false`,
  );
  read('an expense, with a date that is not one', `${EXPENSES}${receipt}/?date_from=abc`);
  read('an expense, spent before the window', `${EXPENSES}${receipt}/?date_from=2099-01-01`);
  read('an expense, filtered to another status', `${EXPENSES}${receipt}/?status=VOID`);
  read(
    'another branch’s receipt, by a branch accountant',
    `${EXPENSES}${expense.get('Parity mirpur')}/attachment/`,
    'accountant',
  );
  read('a receipt of an expense that is not there', `${EXPENSES}${MISSING}/attachment/`);
  read('a receipt, with a date that is not one', `${EXPENSES}${receipt}/attachment/?date_from=abc`);
  read('a receipt whose file has gone', `${EXPENSES}${receipt}/attachment/`, 'owner', {
    reset: resetExpenses,
    prepare: after(
      `UPDATE finance_expense SET attachment = 'expenses/2026/10/gone.png' WHERE id = '${receipt}'`,
    ),
  });
  read('a receipt with an extension nobody knows', `${EXPENSES}${receipt}/attachment/`, 'owner', {
    reset: resetExpenses,
    prepare: after(
      `UPDATE finance_expense SET attachment = 'expenses/2026/10/gone.xyz' WHERE id = '${receipt}'`,
    ),
  });
  for (const method of ['PUT', 'PATCH', 'DELETE'])
    read(`${method} an expense`, `${EXPENSES}${receipt}/`, 'owner', { method });
  read('POST a receipt', `${EXPENSES}${receipt}/attachment/`, 'owner', { method: 'POST' });
  read('GET void', `${EXPENSES}${receipt}/void/`);

  // === The summary, and the party ledger =======================================================
  for (const query of [
    `branch=${home}`,
    `branch=${branch.get('PAR3')}`,
    `branch=${branch.get('PAR2')}`,
    `branch=${MISSING}`,
    'branch=abc',
    ...WINDOWS,
    `branch=${home}&date_from=2026-10-01`,
    'include_void=true',
  ]) {
    read(`the summary ?${query}`, `${EXPENSES}summary/?${query}`);
  }
  read('the summary, the other branch’s manager', `${EXPENSES}summary/`, 'mirpur');
  read(
    'the summary, another branch asked for by a branch accountant',
    `${EXPENSES}summary/?branch=${branch.get('PAR3')}`,
    'accountant',
  );
  read('the summary, an admin', `${EXPENSES}summary/`, 'admin');
  const LEDGER = '/api/v1/party-ledger/';
  for (const query of [
    `branch=${home}`,
    `branch=${branch.get('PAR3')}`,
    `branch=${branch.get('PAR2')}`,
    `branch=${MISSING}`,
    'branch=abc',
    'branch=',
    'date_from=abc',
  ])
    read(`the party ledger ?${query}`, `${LEDGER}?${query}`);
  read('the party ledger, the other branch’s manager', LEDGER, 'mirpur');
  read('the party ledger, an admin', LEDGER, 'admin');
  read(
    'the party ledger, another branch asked for by a branch manager',
    `${LEDGER}?branch=${branch.get('PAR3')}`,
    'manager',
  );
  for (const method of ['POST', 'PUT', 'DELETE'])
    read(`${method} the party ledger`, LEDGER, 'owner', { method });
  // Moments fixed as the cases are built: each API is then shown the same one.
  const ago = (days: number) =>
    `'${new Date(Date.now() - days * 86_400_000).toISOString()}'::timestamptz`;
  const ledgerState = (name: string, ...statements: string[]) =>
    read(`the party ledger, ${name}`, LEDGER, 'owner', {
      reset: resetLedger,
      prepare: after(...statements),
    });
  /**
   * A supplier's documents in a stable order, for a state that gives every
   * purchase order one date: `payables` orders by `ordered_at` alone, so they
   * come back as the heap holds them -- and the restore and the `UPDATE` that
   * arrange the state before each API's request move the rows in it. Django
   * asked twice answers in two orders; the statement is its own either way.
   */
  const byNumber = (body: unknown) => {
    const parties = (body as { payable?: { parties?: { documents?: { number: string }[] }[] } })
      ?.payable?.parties;
    for (const party of parties ?? []) {
      party.documents?.sort((a, b) => a.number.localeCompare(b.number));
    }
  };
  const ledgerTie = (name: string, ...statements: string[]) =>
    read(`the party ledger, ${name}`, LEDGER, 'owner', {
      reset: resetLedger,
      prepare: after(...statements),
      normalize: byNumber,
    });
  ledgerState(
    'an order placed 45 days ago',
    `UPDATE orders_order SET placed_at = ${ago(45)} WHERE number = 'RGN-PARITY-S01'`,
  );
  ledgerState(
    'an order placed 75 days ago',
    `UPDATE orders_order SET placed_at = ${ago(75)} WHERE number = 'RGN-PARITY-S01'`,
  );
  ledgerState(
    'an order placed 200 days ago',
    `UPDATE orders_order SET placed_at = ${ago(200)} WHERE number = 'RGN-PARITY-S01'`,
  );
  ledgerState(
    'an order placed tomorrow',
    `UPDATE orders_order SET placed_at = ${ago(-1)} WHERE number = 'RGN-PARITY-S01'`,
  );
  ledgerState(
    'an order overpaid',
    `UPDATE orders_order SET paid_total = grand_total + 10 WHERE number = 'RGN-PARITY-S01'`,
  );
  ledgerState(
    'a customer with no name and no phone',
    `UPDATE customers_customer SET name = '', phone = NULL WHERE email = 'parity.customer@rangon.test'`,
  );
  ledgerState(
    'a supplier on sixty-day terms',
    `UPDATE purchasing_supplier SET payment_terms_days = 60`,
  );
  ledgerTie(
    'every purchase order raised 100 days ago',
    `UPDATE purchasing_purchaseorder SET ordered_at = ${ago(100)}, completed_at = NULL`,
  );
  ledgerState(
    'a purchase order settled by credit',
    `UPDATE purchasing_purchaseorder SET credited_total = grand_total - paid_total`,
  );
  ledgerTie(
    'every purchase order with no order date',
    `UPDATE purchasing_purchaseorder SET ordered_at = NULL, completed_at = NULL`,
  );

  // === Recording an expense ====================================================================
  const spend = (extra: Record<string, unknown> = {}) => ({
    category: supplies,
    account: drawer,
    amount: '150.00',
    ...extra,
  });
  for (const who of everyone)
    write(`[${who}] record`, EXPENSES, spend({ note: 'Parity pens' }), who);
  for (const [name, body] of [
    ['a category, an account and an amount', spend()],
    ['with a note', spend({ note: 'Printer toner' })],
    ['with a note in Bengali', spend({ note: 'প্রিন্টারের কালি' })],
    ['from the bank', spend({ account: bank })],
    ['at the home branch, said so', spend({ branch: home })],
    ['with a null branch', spend({ branch: null })],
    [
      'at another branch, by a branch accountant',
      spend({ branch: branch.get('PAR3'), account: till }),
    ],
    ['from another branch’s account', spend({ account: till })],
    ['at a branch that is not there', spend({ branch: MISSING })],
    ['at a branch that is not a uuid', spend({ branch: 'abc' })],
    ['an amount as a number', spend({ amount: 150 })],
    ['all the drawer holds', spend({ amount: '70010.00' })],
    ['more than the drawer holds', spend({ amount: '999999.00' })],
    [
      'more than an account holds that may go overdrawn',
      spend({ account: account.get('Parity Petty Cash'), amount: '9000.00' }),
    ],
    ['from a closed account', spend({ account: account.get('Parity Closed Bank') })],
    ['an amount of nothing', spend({ amount: '0' })],
    ['an amount below nothing', spend({ amount: '-5' })],
    ['an amount of three places', spend({ amount: '1.005' })],
    ['an amount of 0.004', spend({ amount: '0.004' })],
    ['an amount that is not a number', spend({ amount: 'lots' })],
    ['no amount', { category: supplies, account: drawer }],
    ['under a retired category', spend({ category: category.get('PARITY_RETIRED') })],
    ['a category that is not there', spend({ category: MISSING })],
    ['a category that is not a uuid', spend({ category: 'abc' })],
    ['no category', { account: drawer, amount: '1.00' }],
    ['an account that is not there', spend({ account: MISSING })],
    ['no account', { category: supplies, amount: '1.00' }],
    ['dated last month', spend({ spent_at: '2026-09-10T09:30:00+06:00' })],
    ['dated last month, with no zone', spend({ spent_at: '2026-09-10T09:30:00' })],
    ['dated last month, to the microsecond', spend({ spent_at: '2026-09-10T03:30:00.123456Z' })],
    ['dated in the future', spend({ spent_at: '2099-01-01T00:00:00Z' })],
    ['dated with a null', spend({ spent_at: null })],
    ['dated with nonsense', spend({ spent_at: 'yesterday' })],
    ['a null note', spend({ note: null })],
    ['a receipt named in JSON', spend({ attachment: 'receipt.png' })],
    ['a null receipt', spend({ attachment: null })],
    ['a status stated', spend({ status: 'VOID', number: 'EXP-999999' })],
    [
      'everything wrong at once',
      { branch: 'x', category: 'x', account: null, amount: 'x', spent_at: 'x', note: null },
    ],
    ['a body that is a list', [spend()]],
    ['a body that is null', 'null'],
    ['broken JSON', '{"amount":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`record: ${name}`, EXPENSES, body);
  }
  write(
    'record: at another branch, by an owner',
    EXPENSES,
    spend({ branch: branch.get('PAR3'), account: till }),
    'owner',
  );
  write(
    'record: at another branch from the home drawer, by an owner',
    EXPENSES,
    spend({ branch: branch.get('PAR3') }),
    'owner',
  );
  write(
    'record: at their own branch, by its manager',
    EXPENSES,
    spend({ account: till, amount: '10.00' }),
    'mirpur',
  );
  for (const [name, key, body] of [
    ['a key of its own', 'parity-expense-new', spend()],
    ['an empty key', '', spend()],
    ['a key already used', 'parity-expense-keyed', spend({ amount: '325.50' })],
    [
      'a key already used, for another amount and account',
      'parity-expense-keyed',
      spend({ amount: '1.00', account: bank }),
    ],
    ['a key already used, with a body that will not do', 'parity-expense-keyed', {}],
    ['a key a movement holds', 'parity-move-deposit', spend()],
  ] as [string, string, unknown][]) {
    write(`record: with ${name}`, EXPENSES, body, 'accountant', {
      headers: { 'idempotency-key': key },
    });
  }
  write('record: the drawer since emptied', EXPENSES, spend(), 'accountant', {
    prepare: after(
      `UPDATE finance_account SET balance = 100.00 WHERE name = 'Counter Cash Drawer'`,
    ),
  });
  // --- With a receipt, as a form -----------------------------------------------------------------
  const form = (name: string, parts: Part[], who: Who = 'accountant', extra: Partial<Case> = {}) =>
    write(`record, as a form: ${name}`, EXPENSES, multipart(parts), who, {
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      ...extra,
    });
  const fields: Part[] = [
    ['category', supplies],
    ['account', drawer],
    ['amount', '150.00'],
  ];
  const file = (filename: string, type: string, bytes: Buffer = PIXEL): Part => [
    'attachment',
    { filename, type, bytes },
  ];
  form('no receipt', fields);
  form('a PNG receipt', [...fields, ['note', 'Parity toner'], file('receipt.png', 'image/png')]);
  form('a receipt whose name is in capitals', [...fields, file('IMG_0412.PNG', 'image/png')]);
  form('a JPEG receipt', [...fields, file('bill.jpeg', 'image/jpeg')]);
  form('a PDF receipt', [...fields, file('bill.pdf', 'application/pdf', PDF)]);
  form('a receipt with two extensions', [...fields, file('bill.tar.pdf', 'application/pdf', PDF)]);
  form('a receipt with a path in its name', [...fields, file('../../etc/bill.png', 'image/png')]);
  form('a receipt with no extension', [...fields, file('receipt', 'image/png')]);
  form('a text file', [...fields, file('notes.txt', 'text/plain', Buffer.from('hello'))]);
  form('a script named as a picture', [
    ...fields,
    file('run.png', 'application/x-sh', Buffer.from('#!/bin/sh')),
  ]);
  form('a picture named as a script', [...fields, file('run.sh', 'image/png')]);
  form('a picture with a type in capitals', [...fields, file('receipt.png', 'IMAGE/PNG')]);
  form('a receipt with no type', [...fields, file('receipt.png', '')]);
  // In a bucket (`PARITY_S3=1`) a receipt is stored with a type: the one the
  // client claimed, else the one its extension has in Python's table, else
  // `binary/octet-stream`. These three are the fallbacks.
  form('a PDF receipt with no type', [...fields, file('bill.pdf', '', PDF)]);
  form('a WebP receipt with no type', [...fields, file('scan.webp', '')]);
  form('a PDF receipt whose type has a parameter', [
    ...fields,
    file('bill.pdf', 'application/pdf; charset=binary', PDF),
  ]);
  form('an empty receipt', [...fields, file('receipt.png', 'image/png', Buffer.alloc(0))]);
  form('a receipt sent as text', [...fields, ['attachment', 'receipt.png']]);
  form('a receipt and a refused amount', [
    ['category', supplies],
    ['account', drawer],
    ['amount', '0'],
    file('receipt.png', 'image/png'),
  ]);
  form('a receipt and more than the drawer holds', [
    ['category', supplies],
    ['account', drawer],
    ['amount', '999999.00'],
    file('receipt.png', 'image/png'),
  ]);
  form('a blank branch and a blank date', [...fields, ['branch', ''], ['spent_at', '']]);
  form('a date, a note and a branch', [
    ...fields,
    ['branch', home],
    ['spent_at', '2026-09-10T09:30:00'],
    ['note', 'From a form'],
  ]);
  form('nothing at all', []);
  write(
    'record, as a form: urlencoded',
    EXPENSES,
    `category=${supplies}&account=${drawer}&amount=150.00&note=From+a+form`,
    'accountant',
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    },
  );
  form(
    'a receipt, under a key already used',
    [...fields, file('receipt.png', 'image/png')],
    'accountant',
    {
      headers: {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': 'parity-expense-keyed',
      },
    },
  );

  // === Voiding =================================================================================
  const VOID = (key: string) => `${EXPENSES}${expense.get(key)}/void/`;
  for (const who of everyone)
    write(`[${who}] void`, VOID('Parity receipt'), { reason: 'Bought twice' }, who);
  for (const key of ['Parity receipt', 'Parity dated', 'Parity voided', 'Parity mirpur'])
    write(`void "${key}"`, VOID(key), { reason: 'Entered in error' }, 'owner');
  for (const [name, body] of [
    ['a reason', { reason: 'Entered in error' }],
    ['a padded reason', { reason: '  Entered in error \n' }],
    ['a reason in Bengali', { reason: 'ভুল এন্ট্রি' }],
    ['a reason of 3000 characters', { reason: 'r'.repeat(3000) }],
    ['a blank reason', { reason: '' }],
    ['a reason of spaces', { reason: '   ' }],
    ['a null reason', { reason: null }],
    ['a reason that is a number', { reason: 5 }],
    ['a reason that is a list', { reason: ['x'] }],
    ['no reason', {}],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"reason":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`void: ${name}`, VOID('Parity receipt'), body);
  }
  write('void: another branch’s, by a branch accountant', VOID('Parity mirpur'), { reason: 'x' });
  write(
    'void: at their own branch, by its manager',
    VOID('Parity mirpur'),
    { reason: 'Wrong fare' },
    'mirpur',
  );
  write('void: one that is not there', `${EXPENSES}${MISSING}/void/`, { reason: 'x' });
  write('void: one that is not there, with no reason', `${EXPENSES}${MISSING}/void/`, {});
  write('void: voided ones left out', `${VOID('Parity receipt')}?include_void=false`, {
    reason: 'x',
  });
  write('void: with a date that is not one', `${VOID('Parity receipt')}?date_from=abc`, {
    reason: 'x',
  });
  write(
    'void: its account since closed',
    VOID('Parity receipt'),
    { reason: 'Entered in error' },
    'accountant',
    {
      prepare: after(
        `UPDATE finance_account SET is_active = false WHERE name = 'Counter Cash Drawer'`,
      ),
    },
  );
  write(
    'void: its category since retired',
    VOID('Parity receipt'),
    { reason: 'Entered in error' },
    'accountant',
    {
      prepare: after(
        `UPDATE finance_expensecategory SET is_active = false WHERE code = 'SUPPLIES'`,
      ),
    },
  );
  write('void: as a form', VOID('Parity receipt'), 'reason=From+a+form', 'accountant', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return cases;
}

/** The party ledger reads orders, customers, purchase orders and suppliers. */
async function resetLedger(client: pg.Client): Promise<void> {
  await restoreTables(client, [
    'orders_order',
    'customers_customer',
    'purchasing_purchaseorder',
    'purchasing_supplier',
  ]);
}
