/**
 * Parity cases for the audit log (phase 7 part 1): `/audit-logs/`, the list
 * and one entry. Read-only: who may read it, which branch's entries a reader
 * sees, the date window, the search, the filters, the ordering and the pages.
 *
 * The run writes audit entries of its own and deletes them by time, so the
 * cases that look at what comes back keep to the March 2025 window that
 * fixture_audit.py dated its entries in.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { type Case, token } from './run.ts';

const MISSING = '00000000-0000-4000-8000-000000000000';
const AUDITOR = 'parity.auditor@rangon.test';

export async function auditCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const staff = await staffHeaders(db);
  const found = new Map(
    (
      await db.query<{ key: string; id: string }>(
        `SELECT entity_label AS key, id FROM core_auditlog WHERE entity_label ILIKE 'Parity audit %'`,
      )
    ).rows.map((row) => [row.key, row.id]),
  );
  const auditor = (
    await db.query<{ id: string; password: string }>(
      `SELECT id, password FROM accounts_user WHERE email = $1`,
      [AUDITOR],
    )
  ).rows[0];
  if (!found.has('Parity audit one') || !auditor) {
    await db.end();
    console.log('SKIP  audit log: fixture_audit.py has not been applied');
    return [];
  }
  const idOf = async (table: string, column: string, value: string) => {
    const row = (
      await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${column} = $1`, [value])
    ).rows[0];
    if (!row) throw new Error(`audit-cases: no ${table} with ${column} ${value}`);
    return row.id;
  };
  const branches = {
    dhaka: await idOf('accounts_branch', 'code', 'DHK1'),
    mirpur: await idOf('accounts_branch', 'code', 'PAR3'),
    spare: await idOf('accounts_branch', 'code', 'PAR9'),
  };
  const users = {
    owner: await idOf('accounts_user', 'email', 'owner@rangon.test'),
    accountant: await idOf('accounts_user', 'email', 'accounts@rangon.test'),
    mirpur: await idOf('accounts_user', 'email', 'parity.mirpur@rangon.test'),
    cashier: await idOf('accounts_user', 'email', 'cashier@rangon.test'),
  };
  await db.end();

  // A name the fixture does not hold is a mistake in this file, not a case.
  const entry = (label: string) => {
    const id = found.get(label === 'six' ? 'PARITY AUDIT SIX' : `Parity audit ${label}`);
    if (!id) throw new Error(`audit-cases: no entry called Parity audit ${label}`);
    return id;
  };
  const auditorHeaders = {
    authorization: `Bearer ${token(auditor, { exp: Math.floor(Date.now() / 1000) + 6 * 3600 })}`,
  };
  type Reader = Who | 'auditor';
  const auth = (who: Reader) => (who === 'auditor' ? auditorHeaders : staff(who));

  const cases: Case[] = [];
  const LOGS = '/api/v1/audit-logs/';
  /** The fixture's days, and nothing the run wrote. */
  const WINDOW = 'date_from=2025-03-10&date_to=2025-03-12';
  const one = (label: string) => `${LOGS}${entry(label)}/`;
  const read = (name: string, path: string, who: Reader = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `audit log: ${name}`, path, headers: auth(who), ...extra });
  const everyone: Reader[] = [...(Object.keys(STAFF) as Who[]), 'auditor'];

  // === Who may read it, and what a method the view does not serve answers ======================
  for (const who of everyone) {
    read(`[${who}] the list`, `${LOGS}?${WINDOW}`, who);
    read(`[${who}] the newest entries`, `${LOGS}?page_size=3`, who);
    read(`[${who}] an entry at the reader's branch`, one('one'), who);
    read(`[${who}] an entry at another branch`, one('two'), who);
    read(`[${who}] an entry with no branch`, one('three'), who);
    read(`[${who}] POST to the list`, LOGS, who, {
      method: 'POST',
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: '{}',
    });
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      read(`[${who}] ${method} an entry`, one('one'), who, { method });
    }
  }

  // === The branch a reader is bound to ==========================================================
  for (const who of ['owner', 'admin', 'super', 'accountant', 'auditor'] as Reader[]) {
    for (const branch of ['dhaka', 'mirpur', 'spare'] as const) {
      read(
        `[${who}] the entries of ${branch}`,
        `${LOGS}?${WINDOW}&branch=${branches[branch]}`,
        who,
      );
    }
    read(`[${who}] searching for another branch's entry`, `${LOGS}?search=under_score`, who);
    read(`[${who}] an entry through its own filters`, `${one('two')}?action=SALE_CREATED`, who);
  }

  // === The window ===============================================================================
  for (const window of [
    'date_from=2025-03-10',
    'date_to=2025-03-10',
    'date_from=2025-03-10&date_to=2025-03-10',
    'date_from=2025-03-11&date_to=2025-03-11',
    'date_from=2025-03-12&date_to=2025-03-12',
    'date_from=2025-03-11&date_to=2025-03-10',
    'date_from=2025-03-09&date_to=2025-03-09',
    // An exact moment at either end, naive (the shop's clock) and with an offset.
    'date_from=2025-03-10T00:00:00&date_to=2025-03-10T23:59:59.999999',
    'date_from=2025-03-10T00:00:00.000001&date_to=2025-03-10T23:59:59.999998',
    'date_from=2025-03-10T23:59:59.999999%2B06:00&date_to=2025-03-11T00:00:00%2B06:00',
    'date_from=2025-03-10T18:00:00Z&date_to=2025-03-10T18:00:00Z',
    'date_from=2025-03-09T18:00:00%2B00:00&date_to=2025-03-12',
    'date_from=2025-03-11%2012:00&date_to=2025-03-11%2012:00',
    'date_from=20250310&date_to=20250312',
    'date_from=2025-W11-1&date_to=2025-W11-3',
    'date_from=%202025-03-10%20&date_to=%202025-03-12%20',
    'date_from=&date_to=2025-03-12',
    'date_from=2025-03-10&date_to=',
    'date_from=2025-03-10&date_from=2025-03-12&date_to=2025-03-12',
    'date_from=nope',
    'date_to=2025-02-30',
    'date_from=2025-03-10&date_to=tomorrow',
    'date_from=10/03/2025',
    'date_from=a%00b',
    // A date it cannot read is refused before any filter is looked at.
    'date_from=nope&action=NOPE&actor=abc',
  ]) {
    read(`the window ${window}`, `${LOGS}?${window}&page_size=100`);
  }
  read('one entry, a date that is not one', `${one('one')}?date_from=nope`);
  read('one entry, a window that holds it', `${one('one')}?${WINDOW}`);
  read('one entry, a window that does not', `${one('one')}?date_from=2025-03-11`);

  // === The search: what was touched, why, and by whom ===========================================
  for (const search of [
    'Parity audit',
    'parity AUDIT six',
    'audit t',
    'damaged box',
    '100%',
    '%',
    '100_',
    '_',
    'under_score',
    'underXscore',
    'back\\slash',
    '\\',
    'back\\\\slash',
    '  one  ',
    '',
    '   ',
    'owner@rangon.test',
    'parity.searcher',
    'parity.deleted',
    'প্যারিটি',
    'ভুল',
    'ParityThing',
    'parityreq0001',
    'nothing matches this',
    "o'brien",
  ]) {
    read(
      `the search ${JSON.stringify(search)}`,
      `${LOGS}?${WINDOW}&search=${encodeURIComponent(search)}`,
    );
  }
  read('the search, twice (the last wins)', `${LOGS}?${WINDOW}&search=one&search=two`);
  read('the search, a NUL', `${LOGS}?${WINDOW}&search=a%00b`);
  read('one entry, a search that finds it', `${one('six')}?search=parity.searcher`);
  read('one entry, a search that does not', `${one('six')}?search=damaged`);
  read('one entry, a NUL in the search', `${one('six')}?search=%00`);

  // === The filters ==============================================================================
  for (const filter of [
    ...[
      'STOCK_ADJUSTMENT',
      'SALE_CREATED',
      'LOGIN_FAILED',
      'UPDATE',
      'SETTINGS_CHANGED',
      'PRICE_OVERRIDE',
      // In the table, not in the choices: there is no asking for it.
      'PARITY_CUSTOM',
      'update',
      '%20UPDATE',
      'NOPE',
      '',
    ].map((action) => `action=${action}`),
    ...[
      'ParityThing',
      'User',
      'Organization',
      'paritything',
      '%20ParityThing%20',
      'Nope',
      '',
      'a%00b',
    ].map((type) => `entity_type=${type}`),
    ...['parity-1', 'parity-4', '%20parity-4%09', 'PARITY-4', 'nope', '', '%00'].map(
      (id) => `entity_id=${id}`,
    ),
    ...[
      users.owner,
      users.accountant,
      users.mirpur,
      users.cashier,
      users.owner.replaceAll('-', ''),
      users.owner.toUpperCase(),
      `%20${users.owner}`,
      MISSING,
      'abc',
      '',
    ].map((actor) => `actor=${actor}`),
    ...[
      branches.dhaka,
      branches.mirpur,
      branches.spare,
      branches.dhaka.replaceAll('-', ''),
      MISSING,
      'abc',
      'null',
      '',
    ].map((branch) => `branch=${branch}`),
    `action=UPDATE&entity_type=ParityThing&entity_id=parity-4&actor=${users.accountant}&branch=${branches.dhaka}`,
    `entity_id=parity-4&actor=${users.owner}`,
    'entity_type=ParityThing&search=audit&ordering=created_at',
    'action=NOPE&entity_type=%00&entity_id=%00&actor=zzz&branch=' + MISSING,
    'action=NOPE&actor=abc&branch=abc',
    'action=UPDATE&action=NOPE',
    'action=NOPE&action=UPDATE',
    // Not a filter: ignored.
    'request_id=parityreq0001&reason=x&ip_address=10.1.2.3&actor_label=x',
  ]) {
    read(`the filter ${filter}`, `${LOGS}?${WINDOW}&${filter}`);
  }
  read('one entry, a filter that holds it', `${one('five')}?action=UPDATE&entity_id=parity-4`);
  read('one entry, a filter that does not', `${one('five')}?action=LOGIN`);
  read('one entry, its actor', `${one('five')}?actor=${users.accountant}`);
  read('one entry, another actor', `${one('five')}?actor=${users.owner}`);
  read('one entry with nobody behind it, any actor', `${one('three')}?actor=${users.owner}`);
  read('one entry, a filter it cannot read', `${one('five')}?action=NOPE&branch=abc`);

  // === The ordering =============================================================================
  for (const ordering of [
    'created_at',
    '-created_at',
    'created_at,-created_at',
    '-created_at,created_at',
    '%20created_at%20',
    'id',
    '-id',
    'entity_type,created_at',
    'action',
    'nope',
    '',
    '-',
    'created_at,',
  ]) {
    read(`ordering=${ordering}`, `${LOGS}?${WINDOW}&ordering=${ordering}`);
    read(
      `ordering=${ordering}, two to a page`,
      `${LOGS}?${WINDOW}&ordering=${ordering}&page_size=2&page=2`,
    );
  }
  read('one entry, an ordering', `${one('four')}?ordering=created_at`);

  // === The pages ================================================================================
  for (const page of [
    'page_size=2',
    'page_size=2&page=2',
    'page_size=2&page=3',
    'page_size=2&page=4',
    'page_size=4&page=last',
    'page_size=1&page=6',
    'page=2',
    'page=0',
    'page=abc',
    'page_size=0',
    'page_size=abc',
    'page_size=1000',
    'page_size=5&page=1&search=audit&ordering=-created_at',
  ]) {
    read(`the page ${page}`, `${LOGS}?${WINDOW}&${page}`);
  }
  read('the whole log, the first page', LOGS);
  read('the whole log, a hundred to a page', `${LOGS}?page_size=100`);
  read('the whole log, oldest first', `${LOGS}?ordering=created_at&page_size=10`);
  read('the whole log, the last page', `${LOGS}?page=last&page_size=7`);

  // === One entry ================================================================================
  for (const label of ['one', 'two', 'three', 'four', 'five', 'six']) {
    read(`the entry "${label}"`, one(label));
  }
  read('one that is not there', `${LOGS}${MISSING}/`);
  read('a key that is no id', `${LOGS}abc/`);
  read('a key with no hyphens', `${LOGS}${entry('one').replaceAll('-', '')}/`);
  read('a key in capitals', `${LOGS}${entry('one').toUpperCase()}/`);
  read('a key in braces', `${LOGS}%7B${entry('one')}%7D/`);
  read('no trailing slash', LOGS.slice(0, -1));
  read('an entry, no trailing slash', one('one').slice(0, -1));
  read('the list, as CSV', `${LOGS}?${WINDOW}&format=csv`);
  read('the list, as JSON', `${LOGS}?${WINDOW}&format=json`);

  return cases;
}
