/**
 * Parity cases for accounts and the cash book (phase 6 part 1): `/accounts/`
 * with its cash book, cash position, manual movements and integrity check,
 * `/account-transactions/` and `/account-transfers/`. A balance is a cache
 * over the ledger, so every write is compared by the accounts it changed,
 * every balance, the movements and transfers it made, the audit log and the
 * number sequences.
 *
 * The accounts are the demo seed's and fixture_finance.py's.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const FINANCE_TABLES = [
  'finance_accounttransaction',
  'finance_accounttransfer',
  'finance_account',
];
const CHANGED = (alias: string, table: string) =>
  `to_jsonb(${alias}) IS DISTINCT FROM (SELECT to_jsonb(s) FROM "snap_${table}" s WHERE s.id = ${alias}.id)`;
/** A moment a request stated, or the word for "when it was made". */
const WHEN = (column: string) =>
  `CASE WHEN ${column} < $1 THEN (${column} AT TIME ZONE 'UTC')::text ELSE 'now' END`;

export const FINANCE_EFFECTS = [
  // 0. Accounts a request made or changed, apart from their balance.
  `SELECT b.code AS branch, a.name, a.kind, a.account_number, a.bank_name, a.balance::text,
          a.is_active, a.is_default, a.allow_overdraft, a.notes, u.email AS created_by,
          a.id NOT IN (SELECT id FROM "snap_finance_account") AS made,
          a.updated_at > (SELECT s.updated_at FROM "snap_finance_account" s WHERE s.id = a.id)
            AS touched
     FROM finance_account a JOIN accounts_branch b ON b.id = a.branch_id
     LEFT JOIN accounts_user u ON u.id = a.created_by_id
    WHERE ${CHANGED('a', 'finance_account')} ORDER BY b.code, a.name`,
  // 1. Every balance, and which account is each kind's default.
  `SELECT b.code AS branch, a.name, a.balance::text, a.is_default, a.is_active
     FROM finance_account a JOIN accounts_branch b ON b.id = a.branch_id ORDER BY b.code, a.name`,
  // 2. The movements made.
  `SELECT a.name AS account, t.transaction_type, t.amount::text, t.balance_after::text,
          t.reference_type,
          COALESCE((SELECT x.number FROM finance_accounttransfer x WHERE x.id::text = t.reference_id),
                   (SELECT x.name FROM finance_account x WHERE x.id::text = t.reference_id),
                   t.reference_id) AS reference,
          t.reason, t.notes, u.email AS created_by, t.idempotency_key,
          ${WHEN('t.occurred_at')} AS occurred
     FROM finance_accounttransaction t JOIN finance_account a ON a.id = t.account_id
     LEFT JOIN accounts_user u ON u.id = t.created_by_id
    WHERE t.id NOT IN (SELECT id FROM "snap_finance_accounttransaction")
    ORDER BY t.created_at, a.name`,
  // 3. The transfers made.
  `SELECT x.number, s.name AS source, t.name AS target, x.amount::text, x.notes,
          u.email AS created_by, x.idempotency_key, ${WHEN('x.occurred_at')} AS occurred
     FROM finance_accounttransfer x JOIN finance_account s ON s.id = x.source_account_id
     JOIN finance_account t ON t.id = x.target_account_id
     LEFT JOIN accounts_user u ON u.id = x.created_by_id
    WHERE x.id NOT IN (SELECT id FROM "snap_finance_accounttransfer") ORDER BY x.number`,
  // 4. The audit log, and the number sequences.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label, a.old_values::text AS old_values,
          a.new_values::text AS new_values, a.reason, b.code AS branch
     FROM core_auditlog a LEFT JOIN accounts_branch b ON b.id = a.branch_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
  `SELECT key, last_value FROM core_numbersequence ORDER BY key`,
];

export async function resetFinance(client: pg.Client): Promise<void> {
  // One default per branch and kind is a unique index, checked row by row: a
  // default a case made steps down before the snapshot's own is put back.
  const snapped = await client.query(`SELECT to_regclass('pg_temp.snap_finance_account') AS t`);
  if (snapped.rows[0]?.t) {
    await client.query(
      `UPDATE finance_account SET is_default = false
        WHERE is_default AND id NOT IN (SELECT id FROM "snap_finance_account" WHERE is_default)`,
    );
  }
  await restoreTables(client, FINANCE_TABLES);
  await restoreSequences(client);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function financeCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const map = async (sql: string) =>
    new Map(
      (await db.query<{ key: string; id: string }>(sql)).rows.map((row) => [row.key, row.id]),
    );
  const account = await map(`SELECT name AS key, id FROM finance_account`);
  const branch = await map(`SELECT code AS key, id FROM accounts_branch`);
  const transfer = await map(
    `SELECT COALESCE(NULLIF(notes, ''), 'unnamed') AS key, id FROM finance_accounttransfer`,
  );
  const entry = await map(
    `SELECT t.transaction_type || ' ' || a.name AS key, t.id FROM finance_accounttransaction t
       JOIN finance_account a ON a.id = t.account_id ORDER BY t.created_at`,
  );
  const acc = (name: string) => account.get(name) as string;
  if (!account.has('Parity Petty Cash') || !transfer.has('Evening bank run')) {
    await db.end();
    console.log('SKIP  finance: fixture_finance.py has not been applied');
    return [];
  }
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM finance_account UNION ALL SELECT id::text FROM finance_accounttransaction
       UNION ALL SELECT id::text FROM finance_accounttransfer UNION ALL SELECT id::text FROM accounts_branch`,
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

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `finance: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'accountant',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `finance: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetFinance,
      effects: FINANCE_EFFECTS,
      normalize: blank,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const ACCOUNTS = '/api/v1/accounts/';
  const drawer = acc('Counter Cash Drawer');
  const bank = acc('City Bank Current');
  const petty = acc('Parity Petty Cash');
  const closed = acc('Parity Closed Bank');
  const till = acc('Parity Mirpur Till');
  const DATES = [
    'date_from=2026-09-01',
    'date_to=2026-09-15',
    'date_from=2026-09-01&date_to=2026-09-30',
    'date_from=2026-09-01T10:30:00',
    'date_from=2026-09-01T10:30:00%2B06:00',
    'date_from=2026-09-01%2010:30',
    'date_to=2026-09-15T23:59:59Z',
    'date_from=20260901',
    'date_from=2026-9-1',
    'date_from=2026-02-30',
    'date_from=2026-02-30T10:00:00',
    'date_from=2026-09-01T25:00:00',
    'date_from=abc',
    'date_to=abc',
    'date_from=',
    'date_from=01/09/2026',
  ];

  // === Accounts: reading =======================================================================
  for (const who of everyone) {
    read(`[${who}] accounts`, ACCOUNTS, who);
    read(`[${who}] an account`, `${ACCOUNTS}${drawer}/`, who);
    read(`[${who}] an account's cash book`, `${ACCOUNTS}${drawer}/transactions/?page_size=3`, who);
    read(`[${who}] cash position`, `${ACCOUNTS}cash-position/`, who);
    read(`[${who}] the cash book`, '/api/v1/account-transactions/?page_size=3', who);
    read(`[${who}] transfers`, '/api/v1/account-transfers/', who);
  }
  for (const query of [
    'kind=CASH',
    'kind=BANK',
    'kind=MFS',
    'kind=OTHER',
    'kind=cash',
    'kind=NOPE',
    'is_active=true',
    'is_active=false',
    'is_active=1',
    'is_active=0',
    'is_active=maybe',
    'is_active=',
    `branch=${branch.get('DHK1')}`,
    `branch=${branch.get('PAR3')}`,
    `branch=${MISSING}`,
    'branch=abc',
    'kind=NOPE&branch=abc',
    'search=parity',
    'search=Bank',
    'search=bank%20city',
    'search=city,current',
    'search=%22Cash%20Drawer%22',
    'search=zzzz',
    'search=%25',
    'search=a%00b',
    'search=',
    'ordering=name',
    'ordering=-name',
    'ordering=balance,name',
    'ordering=-balance,name',
    'ordering=created_at',
    'ordering=kind',
    'ordering=',
    'page_size=2',
    'page_size=2&page=2',
    'page=99',
    'kind=BANK&is_active=true&search=bank&ordering=-balance',
  ]) {
    read(`accounts ?${query}`, `${ACCOUNTS}?${query}`);
  }
  read('accounts, the other branch’s manager', ACCOUNTS, 'mirpur');
  read(
    'accounts, another branch asked for by a branch accountant',
    `${ACCOUNTS}?branch=${branch.get('PAR3')}`,
    'accountant',
  );
  for (const name of [
    'Counter Cash Drawer',
    'City Bank Current',
    'bKash Merchant',
    'Parity Petty Cash',
    'Parity Float',
    'Parity Closed Bank',
    'Parity Mirpur Till',
  ])
    read(`the account ${name}`, `${ACCOUNTS}${acc(name)}/`);
  read('another branch’s account, by a branch accountant', `${ACCOUNTS}${till}/`, 'accountant');
  read('an account at their own branch', `${ACCOUNTS}${till}/`, 'mirpur');
  read('an account that is not there', `${ACCOUNTS}${MISSING}/`);
  read('an account that is not a uuid', `${ACCOUNTS}abc/`);
  read('an account, filtered to its own kind', `${ACCOUNTS}${drawer}/?kind=CASH`);
  read('an account, filtered to another kind', `${ACCOUNTS}${drawer}/?kind=BANK`);
  read('an account, with a filter that is not a kind', `${ACCOUNTS}${drawer}/?kind=NOPE`);
  read('an account, searched for by another’s name', `${ACCOUNTS}${drawer}/?search=bkash`);
  for (const method of ['DELETE']) {
    read(`${method} an account`, `${ACCOUNTS}${drawer}/`, 'owner', { method });
    read(`[cashier] ${method} an account`, `${ACCOUNTS}${drawer}/`, 'cashier', { method });
  }
  read('GET record-movement', `${ACCOUNTS}record-movement/`);
  read('GET verify-integrity', `${ACCOUNTS}verify-integrity/`);
  read('POST cash-position', `${ACCOUNTS}cash-position/`, 'owner', { method: 'POST' });

  // === An account's cash book ==================================================================
  const book = (id: string, query = '') =>
    `${ACCOUNTS}${id}/transactions/${query ? `?${query}` : ''}`;
  for (const query of [
    '',
    'page_size=5&page=2',
    'page=99',
    ...DATES,
    'transaction_type=SALE_PAYMENT',
    'transaction_type=REFUND',
    'transaction_type=TRANSFER_OUT',
    'transaction_type=sale_payment',
    'transaction_type=NOPE',
    'transaction_type=',
    'transaction_type=REFUND&date_from=2026-09-01',
    'ordering=amount',
    'kind=CASH',
    'kind=BANK',
  ]) {
    read(`the drawer's cash book ?${query}`, book(drawer, query));
  }
  read('the petty cash book', book(petty));
  read('an empty cash book', book(closed));
  read('another branch’s cash book, by a branch accountant', book(till), 'accountant');
  read('a cash book that is not there', book(MISSING));

  // === Cash position ===========================================================================
  for (const query of [
    `branch=${branch.get('DHK1')}`,
    `branch=${branch.get('PAR3')}`,
    `branch=${branch.get('PAR2')}`,
    `branch=${MISSING}`,
    'branch=abc',
    'branch=',
    'date_from=2026-09-01',
    'date_to=2026-09-15',
    'date_from=2026-09-01&date_to=2026-09-30',
    'date_from=2026-09-01T10:30:00%2B06:00',
    'date_from=abc',
    'date_to=2026-02-30',
    'date_from=2099-01-01',
    `branch=${branch.get('DHK1')}&date_from=2026-10-01`,
  ]) {
    read(`cash position ?${query}`, `${ACCOUNTS}cash-position/?${query}`);
  }
  read('cash position, the other branch’s manager', `${ACCOUNTS}cash-position/`, 'mirpur');
  read(
    'cash position, another branch asked for by a branch accountant',
    `${ACCOUNTS}cash-position/?branch=${branch.get('PAR3')}`,
    'accountant',
  );
  read('cash position, an admin', `${ACCOUNTS}cash-position/`, 'admin');

  // === The whole cash book =====================================================================
  const LEDGER = '/api/v1/account-transactions/';
  for (const query of [
    `account=${drawer}`,
    `account=${petty}`,
    `account=${till}`,
    `account=${MISSING}`,
    'account=abc',
    ...[
      'OPENING',
      'SALE_PAYMENT',
      'REFUND',
      'SUPPLIER_PAYMENT',
      'EXPENSE',
      'TRANSFER_IN',
      'TRANSFER_OUT',
      'DEPOSIT',
      'WITHDRAWAL',
      'ADJUSTMENT',
      'NOPE',
      '',
    ].map((v) => `transaction_type=${v}`),
    ...[
      'payment',
      'refund',
      'manual',
      'account',
      'account_transfer',
      'nope',
      '',
      '%20manual%20',
      'a%00b',
    ].map((v) => `reference_type=${v}`),
    ...DATES,
    'ordering=occurred_at',
    'ordering=-occurred_at',
    'ordering=amount,occurred_at',
    'ordering=-amount,occurred_at',
    'ordering=balance_after',
    'page_size=4&page=3',
    'page=999',
    `account=${drawer}&transaction_type=REFUND&ordering=amount`,
    'transaction_type=NOPE&account=abc',
  ]) {
    read(`the cash book ?${query}`, `${LEDGER}?page_size=6&${query}`);
  }
  read('the cash book, the other branch’s manager', LEDGER, 'mirpur');
  const anEntry = entry.get('DEPOSIT Parity Petty Cash') as string;
  const mirpurEntry = entry.get('TRANSFER_OUT Parity Mirpur Till') as string;
  read('a movement', `${LEDGER}${anEntry}/`);
  read('a movement, as a branch accountant', `${LEDGER}${anEntry}/`, 'accountant');
  read(
    'another branch’s movement, by a branch accountant',
    `${LEDGER}${mirpurEntry}/`,
    'accountant',
  );
  read('a movement at their own branch', `${LEDGER}${mirpurEntry}/`, 'mirpur');
  read('a movement that is not there', `${LEDGER}${MISSING}/`);
  read('a movement that is not a uuid', `${LEDGER}abc/`);
  read('a movement, filtered to another type', `${LEDGER}${anEntry}/?transaction_type=REFUND`);
  read('a movement, with a date that is not one', `${LEDGER}${anEntry}/?date_from=abc`);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    read(`${method} the cash book`, method === 'POST' ? LEDGER : `${LEDGER}${anEntry}/`, 'owner', {
      method,
    });
  }

  // === Transfers: reading ======================================================================
  const TRANSFERS = '/api/v1/account-transfers/';
  for (const query of [
    'ordering=occurred_at',
    'ordering=-amount',
    'ordering=amount',
    'ordering=number',
    'page_size=1&page=2',
    'page=9',
  ])
    read(`transfers ?${query}`, `${TRANSFERS}?${query}`);
  read('transfers, the other branch’s manager', TRANSFERS, 'mirpur');
  read('a transfer', `${TRANSFERS}${transfer.get('Evening bank run')}/`);
  read('a transfer with no notes', `${TRANSFERS}${transfer.get('unnamed')}/`);
  read(
    'another branch’s transfer, by a branch accountant',
    `${TRANSFERS}${transfer.get('Mirpur takings')}/`,
    'accountant',
  );
  read(
    'a transfer at their own branch',
    `${TRANSFERS}${transfer.get('Mirpur takings')}/`,
    'mirpur',
  );
  read('a transfer that is not there', `${TRANSFERS}${MISSING}/`);
  read('a transfer that is not a uuid', `${TRANSFERS}abc/`);
  for (const method of ['PUT', 'PATCH', 'DELETE'])
    read(`${method} a transfer`, `${TRANSFERS}${transfer.get('Evening bank run')}/`, 'owner', {
      method,
    });

  // === Opening an account ======================================================================
  const home = branch.get('DHK1');
  const open = (extra: Record<string, unknown> = {}) => ({
    branch: home,
    name: 'Parity New Account',
    ...extra,
  });
  for (const who of everyone) write(`[${who}] open an account`, ACCOUNTS, open(), who);
  for (const [name, body] of [
    ['with nothing but a branch and a name', open()],
    ...['CASH', 'BANK', 'MFS', 'OTHER'].map(
      (kind) => [`of kind ${kind}`, open({ kind })] as [string, unknown],
    ),
    ['with an opening balance', open({ opening_balance: '2500.50' })],
    ['with an opening balance of nothing', open({ opening_balance: '0' })],
    ['with an opening balance as a number', open({ opening_balance: 2500 })],
    ['with an opening balance below nothing', open({ opening_balance: '-100.00' })],
    [
      'with an opening balance below nothing, overdraft allowed',
      open({ opening_balance: '-100.00', allow_overdraft: true }),
    ],
    ['with an opening balance of three places', open({ opening_balance: '1.005' })],
    ['with an opening balance of fifteen digits', open({ opening_balance: '1234567890123.45' })],
    ['with an opening balance that is not a number', open({ opening_balance: 'lots' })],
    ['with a null opening balance', open({ opening_balance: null })],
    ['as the default cash account', open({ kind: 'CASH', is_default: true })],
    ['as the default of a kind that has none', open({ kind: 'OTHER', is_default: true })],
    [
      'as the default bank account, with an opening balance',
      open({ kind: 'BANK', is_default: true, opening_balance: '10.00' }),
    ],
    ['closed from the start', open({ is_active: false })],
    [
      'with everything stated',
      open({
        kind: 'BANK',
        account_number: '0123-456-789',
        bank_name: 'Dutch-Bangla',
        notes: 'Payroll',
        is_default: false,
        allow_overdraft: true,
        opening_balance: '100.00',
      }),
    ],
    ['with a name another account at the branch has', open({ name: 'Counter Cash Drawer' })],
    ['with a name another account has, in another case', open({ name: 'counter cash drawer' })],
    ['with a name an account at another branch has', open({ name: 'Parity Mirpur Till' })],
    ['with a padded name', open({ name: '  Parity Padded  ' })],
    ['with a padded name another account has', open({ name: '  Counter Cash Drawer ' })],
    ['with a blank name', open({ name: '' })],
    ['with a name of spaces', open({ name: '   ' })],
    ['with a name of 120 characters', open({ name: 'n'.repeat(120) })],
    ['with a name of 121 characters', open({ name: 'n'.repeat(121) })],
    ['with a name in Bengali', open({ name: 'খুচরা ক্যাশ' })],
    ['with a null name', open({ name: null })],
    ['with a name that is a number', open({ name: 5 })],
    ['with no name', { branch: home }],
    ['with no branch', { name: 'Parity New Account' }],
    ['with a null branch', open({ branch: null })],
    ['with a branch that is not there', open({ branch: MISSING })],
    ['with a branch that is not a uuid', open({ branch: 'abc' })],
    ['at another branch, by a branch accountant', open({ branch: branch.get('PAR3') })],
    ['with a kind it does not know', open({ kind: 'CRYPTO' })],
    ['with a kind in lower case', open({ kind: 'cash' })],
    ['with an account number of 64 characters', open({ account_number: '9'.repeat(64) })],
    ['with an account number of 65 characters', open({ account_number: '9'.repeat(65) })],
    ['with a bank name of 121 characters', open({ bank_name: 'b'.repeat(121) })],
    ['with null notes', open({ notes: null })],
    ['with a default that is not a boolean', open({ is_default: 'maybe' })],
    ['with a balance stated', open({ balance: '999999.00' })],
    ['with an id stated', open({ id: MISSING })],
    ['a body that is a list', [open()]],
    ['a body that is null', 'null'],
    ['broken JSON', '{"name":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`open an account: ${name}`, ACCOUNTS, body);
  }
  write(
    'open an account at another branch, by an owner',
    ACCOUNTS,
    open({ branch: branch.get('PAR3') }),
    'owner',
  );
  write(
    'open an account at another branch, by an admin',
    ACCOUNTS,
    open({ branch: branch.get('PAR3'), is_default: true, kind: 'CASH' }),
    'admin',
  );

  // === Editing an account ======================================================================
  const edit = (
    name: string,
    id: string,
    body: unknown,
    who: Who = 'accountant',
    extra: Partial<Case> = {},
    method = 'PATCH',
  ) => write(`edit an account: ${name}`, `${ACCOUNTS}${id}/`, body, who, { method, ...extra });
  for (const who of everyone) {
    edit(`[${who}] PATCH its notes`, petty, { notes: 'Counted weekly' }, who);
    edit(`[${who}] PUT its notes`, petty, { notes: 'Counted weekly' }, who, {}, 'PUT');
  }
  for (const [name, id, body] of [
    ['renamed', petty, { name: 'Parity Petty Cash Box' }],
    ['renamed to what it is called', petty, { name: 'Parity Petty Cash' }],
    ['renamed to another account’s name', petty, { name: 'Counter Cash Drawer' }],
    ['renamed to a name at another branch', petty, { name: 'Parity Mirpur Till' }],
    ['renamed with padding', petty, { name: '  Parity Padded ' }],
    ['renamed to nothing', petty, { name: '' }],
    ['its kind changed', petty, { kind: 'CASH' }],
    ['a default’s kind changed to one that has a default', drawer, { kind: 'BANK' }],
    ['a default’s kind changed to one that has none', drawer, { kind: 'OTHER' }],
    ['made the default of its kind', petty, { is_default: true }],
    ['made the default where there is one', acc('Parity Float'), { is_default: true }],
    [
      'made the default, its kind changed with it',
      acc('Parity Float'),
      { is_default: true, kind: 'BANK' },
    ],
    ['a default made not the default', drawer, { is_default: false }],
    ['a default told it is the default', drawer, { is_default: true }],
    ['closed', petty, { is_active: false }],
    ['a closed account reopened', closed, { is_active: true }],
    ['its overdraft withdrawn while overdrawn', petty, { allow_overdraft: false }],
    ['its numbers stated', bank, { account_number: '1101-22-333', bank_name: 'City Bank PLC' }],
    ['its branch changed', petty, { branch: branch.get('PAR3') }],
    ['its branch changed to one that is not there', petty, { branch: MISSING }],
    ['its opening balance stated', petty, { opening_balance: '99999.00' }],
    ['its balance stated', petty, { balance: '99999.00' }],
    ['nothing at all', petty, {}],
    [
      'everything it has, restated',
      petty,
      {
        name: 'Parity Petty Cash',
        kind: 'OTHER',
        notes: 'Tea, tips and tape',
        allow_overdraft: true,
      },
    ],
    ['a kind it does not know', petty, { kind: 'CRYPTO' }],
    ['a name of 121 characters', petty, { name: 'n'.repeat(121) }],
    ['a null name', petty, { name: null }],
    ['a body that is a list', petty, []],
    ['a body that is null', petty, 'null'],
    ['broken JSON', petty, '{"name":'],
    ['no body', petty, undefined],
  ] as [string, string, unknown][]) {
    edit(name, id, body);
    if (['renamed', 'nothing at all', 'made the default of its kind'].includes(name))
      edit(`${name}, by PUT`, id, body, 'accountant', {}, 'PUT');
  }
  edit('another branch’s, by a branch accountant', till, { notes: 'x' });
  edit(
    'another branch’s, by an owner',
    till,
    { notes: 'Counted nightly', is_default: true },
    'owner',
  );
  edit('one that is not there', MISSING, { notes: 'x' });
  edit('one that is not there, with broken JSON', MISSING, '{"name":');
  edit('one that is not a uuid', 'abc', { notes: 'x' });
  write(
    'edit an account: filtered to another kind',
    `${ACCOUNTS}${petty}/?kind=CASH`,
    { notes: 'x' },
    'accountant',
    { method: 'PATCH' },
  );

  // === A movement by hand ======================================================================
  const MOVE = `${ACCOUNTS}record-movement/`;
  const move = (type: unknown, amount: unknown, extra: Record<string, unknown> = {}) => ({
    account: drawer,
    transaction_type: type,
    amount,
    ...extra,
  });
  for (const who of everyone) write(`[${who}] a deposit`, MOVE, move('DEPOSIT', '100.00'), who);
  for (const [name, body] of [
    ['a deposit', move('DEPOSIT', '100.00', { notes: 'Float from the owner' })],
    ['a deposit as a number', move('DEPOSIT', 100)],
    ['a deposit of nothing', move('DEPOSIT', '0')],
    ['a deposit below nothing', move('DEPOSIT', '-5.00')],
    ['a deposit of three places', move('DEPOSIT', '1.005')],
    ['a deposit of fifteen digits', move('DEPOSIT', '1234567890123.45')],
    ['a deposit of twelve digits', move('DEPOSIT', '999999999999.99')],
    ['a withdrawal', move('WITHDRAWAL', '100.00', { reason: 'Banked' })],
    ['a withdrawal with no reason', move('WITHDRAWAL', '100.00')],
    ['a withdrawal with a reason of spaces', move('WITHDRAWAL', '100.00', { reason: '   ' })],
    ['a withdrawal of all it holds', move('WITHDRAWAL', '75010.00', { reason: 'Banked' })],
    ['a withdrawal of more than it holds', move('WITHDRAWAL', '999999.00', { reason: 'Banked' })],
    [
      'a withdrawal past nothing, where overdraft is allowed',
      move('WITHDRAWAL', '5000.00', { reason: 'Advance', account: petty }),
    ],
    ['a correction upwards', move('ADJUSTMENT', '12.50', { reason: 'Counted over' })],
    ['a correction downwards', move('ADJUSTMENT', '-12.50', { reason: 'Counted short' })],
    ['a correction of nothing', move('ADJUSTMENT', '0.00', { reason: 'Nothing' })],
    ['a correction with no reason', move('ADJUSTMENT', '5.00')],
    ['a correction below what it holds', move('ADJUSTMENT', '-999999.00', { reason: 'Gone' })],
    ['into a closed account', move('DEPOSIT', '100.00', { account: closed })],
    [
      'into another branch’s account, by a branch accountant',
      move('DEPOSIT', '100.00', { account: till }),
    ],
    ['a type that is not made by hand', move('SALE_PAYMENT', '100.00')],
    ['a type that is not a type', move('GIFT', '100.00')],
    ['a type in lower case', move('deposit', '100.00')],
    ['no type', { account: drawer, amount: '1.00' }],
    ['no account', { transaction_type: 'DEPOSIT', amount: '1.00' }],
    ['an account that is not there', move('DEPOSIT', '1.00', { account: MISSING })],
    ['an account that is not a uuid', move('DEPOSIT', '1.00', { account: 'abc' })],
    ['a null account', move('DEPOSIT', '1.00', { account: null })],
    ['no amount', { account: drawer, transaction_type: 'DEPOSIT' }],
    ['an amount that is not a number', move('DEPOSIT', 'lots')],
    ['a null amount', move('DEPOSIT', null)],
    ['dated last month', move('DEPOSIT', '100.00', { occurred_at: '2026-09-10T09:30:00+06:00' })],
    [
      'dated last month, with no zone',
      move('DEPOSIT', '100.00', { occurred_at: '2026-09-10T09:30:00' }),
    ],
    ['dated in UTC', move('DEPOSIT', '100.00', { occurred_at: '2026-09-10T03:30:00Z' })],
    ['dated by a day alone', move('DEPOSIT', '100.00', { occurred_at: '2026-09-10' })],
    ['dated in the future', move('DEPOSIT', '100.00', { occurred_at: '2099-01-01T00:00:00Z' })],
    ['dated with a null', move('DEPOSIT', '100.00', { occurred_at: null })],
    ['dated with nonsense', move('DEPOSIT', '100.00', { occurred_at: 'yesterday' })],
    ['a null reason', move('DEPOSIT', '100.00', { reason: null })],
    ['null notes', move('DEPOSIT', '100.00', { notes: null })],
    ['a reason in Bengali', move('WITHDRAWAL', '100.00', { reason: 'ব্যাংকে জমা' })],
    [
      'a reference stated',
      move('DEPOSIT', '100.00', { reference_type: 'payment', reference_id: 'x' }),
    ],
    [
      'everything wrong at once',
      {
        account: 'x',
        transaction_type: 'X',
        amount: 'x',
        reason: null,
        notes: null,
        occurred_at: 'x',
      },
    ],
    ['a body that is a list', [move('DEPOSIT', '1.00')]],
    ['a body that is null', 'null'],
    ['broken JSON', '{"account":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`a movement: ${name}`, MOVE, body);
  }
  write(
    'a movement: into another branch’s account, by an owner',
    MOVE,
    move('DEPOSIT', '100.00', { account: till }),
    'owner',
  );
  write(
    'a movement: at their own branch, by its manager',
    MOVE,
    move('WITHDRAWAL', '100.00', { account: till, reason: 'Banked' }),
    'mirpur',
  );
  for (const [name, key, body] of [
    ['a key of its own', 'parity-move-new', move('DEPOSIT', '100.00')],
    ['an empty key', '', move('DEPOSIT', '100.00')],
    [
      'a key already used, for the same movement',
      'parity-move-deposit',
      move('DEPOSIT', '250.00', { account: petty }),
    ],
    [
      'a key already used, for another account and amount',
      'parity-move-deposit',
      move('WITHDRAWAL', '9.00', { reason: 'x' }),
    ],
    [
      'a key already used, for a withdrawal the account can no longer cover',
      'parity-move-withdrawal',
      move('WITHDRAWAL', '999999.00', { reason: 'x' }),
    ],
    ['a key already used, with a body that will not do', 'parity-move-deposit', {}],
    ['a key of 64 characters', 'k'.repeat(64), move('DEPOSIT', '100.00')],
    ['a key of 65 characters', 'k'.repeat(65), move('DEPOSIT', '100.00')],
  ] as [string, string, unknown][]) {
    write(`a movement: with ${name}`, MOVE, body, 'accountant', {
      headers: { 'idempotency-key': key },
    });
  }
  write(
    'a movement: a withdrawal, the drawer since emptied',
    MOVE,
    move('WITHDRAWAL', '500.00', { reason: 'Banked' }),
    'accountant',
    {
      prepare: after(
        `UPDATE finance_account SET balance = 100.00 WHERE name = 'Counter Cash Drawer'`,
      ),
    },
  );
  write(
    'a movement: a withdrawal, the drawer since allowed to go overdrawn',
    MOVE,
    move('WITHDRAWAL', '500.00', { reason: 'Banked' }),
    'accountant',
    {
      prepare: after(
        `UPDATE finance_account SET balance = 100.00, allow_overdraft = true WHERE name = 'Counter Cash Drawer'`,
      ),
    },
  );

  // === The integrity check =====================================================================
  const VERIFY = `${ACCOUNTS}verify-integrity/`;
  const drift = after(
    `UPDATE finance_account SET balance = balance + 12.34 WHERE name = 'Counter Cash Drawer'`,
    `UPDATE finance_account SET balance = balance - 0.01 WHERE name = 'Parity Mirpur Till'`,
  );
  for (const who of everyone) write(`[${who}] verify`, VERIFY, {}, who);
  for (const [name, body] of [
    ['every branch', {}],
    ['one branch', { branch: home }],
    ['another branch', { branch: branch.get('PAR3') }],
    ['a branch that is not there', { branch: MISSING }],
    ['a branch that is not a uuid', { branch: 'abc' }],
    ['a blank branch', { branch: '' }],
    ['a null branch', { branch: null }],
    ['a branch of zero', { branch: 0 }],
    ['a branch that is a list', { branch: [home] }],
    ['a body that is a list', []],
    ['a body that is null', 'null'],
    ['broken JSON', '{"branch":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`verify: ${name}`, VERIFY, body, 'owner');
    write(`verify, two accounts drifted: ${name}`, VERIFY, body, 'owner', { prepare: drift });
  }
  write(
    'verify: another branch, by a branch-bound admin',
    VERIFY,
    { branch: branch.get('PAR3') },
    'admin',
    { prepare: drift },
  );

  // === A transfer ==============================================================================
  const send = (
    source: unknown,
    target: unknown,
    amount: unknown,
    extra: Record<string, unknown> = {},
  ) => ({ source_account: source, target_account: target, amount, ...extra });
  for (const who of everyone)
    write(`[${who}] a transfer`, TRANSFERS, send(drawer, bank, '1000.00'), who);
  for (const [name, body] of [
    ['the drawer to the bank', send(drawer, bank, '1000.00', { notes: 'Bank run' })],
    ['the bank to the drawer', send(bank, drawer, '1000.00')],
    ['to the wallet', send(drawer, acc('bKash Merchant'), '250.50')],
    ['an amount as a number', send(drawer, bank, 1000)],
    ['all the drawer holds', send(drawer, bank, '75010.00')],
    ['more than the drawer holds', send(drawer, bank, '999999.00')],
    ['out of an account allowed to go overdrawn', send(petty, drawer, '5000.00')],
    ['out of an account that holds nothing', send(acc('Parity Float'), drawer, '301.00')],
    ['an amount of nothing', send(drawer, bank, '0')],
    ['an amount below nothing', send(drawer, bank, '-1')],
    ['an amount of three places', send(drawer, bank, '1.005')],
    ['an amount that is not a number', send(drawer, bank, 'lots')],
    ['no amount', { source_account: drawer, target_account: bank }],
    ['an account to itself', send(drawer, drawer, '10.00')],
    ['an account to itself, for nothing', send(drawer, drawer, '0')],
    ['into a closed account', send(drawer, closed, '10.00')],
    ['out of a closed account', send(closed, drawer, '10.00')],
    ['to another branch, by a branch accountant', send(drawer, till, '10.00')],
    ['from another branch, by a branch accountant', send(till, drawer, '10.00')],
    ['a source that is not there', send(MISSING, bank, '10.00')],
    ['a target that is not there', send(drawer, MISSING, '10.00')],
    ['a source that is not a uuid', send('abc', bank, '10.00')],
    ['no source', { target_account: bank, amount: '10.00' }],
    ['no target', { source_account: drawer, amount: '10.00' }],
    ['dated last month', send(drawer, bank, '10.00', { occurred_at: '2026-09-10T09:30:00+06:00' })],
    ['dated with nonsense', send(drawer, bank, '10.00', { occurred_at: 'yesterday' })],
    ['dated with a null', send(drawer, bank, '10.00', { occurred_at: null })],
    ['null notes', send(drawer, bank, '10.00', { notes: null })],
    ['notes in Bengali', send(drawer, bank, '10.00', { notes: 'ব্যাংকে জমা' })],
    ['a number stated', send(drawer, bank, '10.00', { number: 'ATR-999999' })],
    [
      'everything wrong at once',
      { source_account: 'x', target_account: null, amount: 'x', notes: null, occurred_at: 'x' },
    ],
    ['a body that is a list', [send(drawer, bank, '1.00')]],
    ['a body that is null', 'null'],
    ['broken JSON', '{"amount":'],
    ['no body', undefined],
  ] as [string, unknown][]) {
    write(`a transfer: ${name}`, TRANSFERS, body);
  }
  write(
    'a transfer: to another branch, by an owner',
    TRANSFERS,
    send(drawer, till, '10.00'),
    'owner',
  );
  write(
    'a transfer: at their own branch, by its manager',
    TRANSFERS,
    send(till, acc('Parity Mirpur Bank'), '10.00'),
    'mirpur',
  );
  write(
    'a transfer: from the home branch, by the other manager',
    TRANSFERS,
    send(drawer, bank, '10.00'),
    'mirpur',
  );
  for (const [name, key, body] of [
    ['a key of its own', 'parity-transfer-new', send(drawer, bank, '10.00')],
    ['an empty key', '', send(drawer, bank, '10.00')],
    [
      'a key already used, for the same transfer',
      'parity-transfer-banked',
      send(drawer, bank, '5000.00'),
    ],
    [
      'a key already used, for other accounts and another amount',
      'parity-transfer-banked',
      send(bank, drawer, '1.00'),
    ],
    [
      'a key already used, for more than the source holds',
      'parity-transfer-banked',
      send(drawer, bank, '999999.00'),
    ],
    ['a key a movement holds', 'parity-move-deposit', send(drawer, bank, '10.00')],
  ] as [string, string, unknown][]) {
    write(`a transfer: with ${name}`, TRANSFERS, body, 'accountant', {
      headers: { 'idempotency-key': key },
    });
  }
  return cases;
}
