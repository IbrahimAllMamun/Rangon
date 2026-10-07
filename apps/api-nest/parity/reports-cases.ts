/**
 * Parity cases for the reports (phase 7 part 3): the eleven views under
 * `/reports/`, as JSON and as CSV. Read-only: who may read each, which
 * branch a reader is given, the window -- a preset, a custom range, or half
 * of one -- and what every answer becomes once CSV has been negotiated.
 *
 * The figures that test the arithmetic are fixture_reports.py's, dated
 * January to March 2025; the presets read whatever the demo seed traded.
 * A preset's window ends at the request's own instant, so `range.end` and
 * `period.end` are compared by their form.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { type Case, token } from './run.ts';

const MISSING = '00000000-0000-4000-8000-000000000000';
const AUDITOR = 'parity.auditor@rangon.test';
const READER = 'parity.reader@rangon.test';

const REPORTS = [
  'dashboard',
  'sales',
  'products/performance',
  'inventory/valuation',
  'inventory/movement',
  'purchases',
  'returns',
  'profit',
  'expenses',
  'business-summary',
  'vat',
] as const;

/** `timezone.now()` as DRF's encoder prints it: UTC, with a fraction unless it is zero. */
const NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/;

/**
 * Blank the ends of a window that were read off the clock: the end of a
 * preset's, and whichever end a custom window leaves out. An end the request
 * named is compared as it is.
 */
function blankNow(query: string): (body: unknown) => void {
  const params = new URLSearchParams(query);
  const from = Boolean(params.getAll('date_from').at(-1));
  const to = Boolean(params.getAll('date_to').at(-1));
  const clock = from || to ? [...(from ? [] : ['start']), ...(to ? [] : ['end'])] : ['end'];
  return (body) => {
    if (!body || typeof body !== 'object') return;
    for (const key of ['range', 'period']) {
      const window = (body as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      if (!window || typeof window !== 'object') continue;
      for (const end of clock) {
        if (typeof window[end] === 'string' && NOW.test(window[end])) window[end] = '<now>';
      }
    }
  };
}

export async function reportsCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const staff = await staffHeaders(db);
  const extra = new Map(
    (
      await db.query<{ id: string; email: string; password: string }>(
        `SELECT id, email, password FROM accounts_user WHERE email = ANY($1)`,
        [[AUDITOR, READER]],
      )
    ).rows.map((row) => [row.email, row]),
  );
  const seeded =
    (await db.query(`SELECT 1 FROM orders_order WHERE number = 'PAR-RPT-0001'`)).rows.length > 0;
  const branchId = async (code: string) => {
    const row = (
      await db.query<{ id: string }>(`SELECT id FROM accounts_branch WHERE code = $1`, [code])
    ).rows[0];
    if (!row) throw new Error(`reports-cases: no branch ${code}`);
    return row.id;
  };
  if (!seeded || !extra.has(AUDITOR) || !extra.has(READER)) {
    await db.end();
    console.log('SKIP  reports: fixture_reports.py has not been applied');
    return [];
  }
  const branches = {
    dhaka: await branchId('DHK1'),
    mirpur: await branchId('PAR3'),
    spare: await branchId('PAR9'),
  };
  await db.end();

  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  const signed = (email: string) => ({
    authorization: `Bearer ${token(extra.get(email) as { id: string; password: string }, { exp })}`,
  });
  type Reader = Who | 'auditor' | 'reader';
  const auth = (who: Reader) =>
    who === 'auditor' ? signed(AUDITOR) : who === 'reader' ? signed(READER) : staff(who);

  const cases: Case[] = [];
  const path = (report: string, query = '') =>
    `/api/v1/reports/${report}/${query ? `?${query}` : ''}`;
  /** The fixture's quarter: taxed sales, returns, purchases and expenses, and nothing else. */
  const QUARTER = 'date_from=2025-01-01&date_to=2025-03-31';
  const read = (
    name: string,
    report: string,
    query: string,
    who: Reader = 'owner',
    extraCase: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extraCase;
    cases.push({
      name: `reports: ${name}`,
      path: path(report, query),
      headers: { ...auth(who), ...(headers ?? {}) },
      normalize: blankNow(query),
      ...rest,
    });
  };
  /** An export is asked for as a browser asks: anything will do. */
  const ANY = { accept: '*/*' };
  const everyone: Reader[] = [...(Object.keys(STAFF) as Who[]), 'auditor', 'reader'];

  // === Who may read each report, export it, and what another method answers ===================
  for (const report of REPORTS) {
    for (const who of everyone) {
      read(`[${who}] ${report}`, report, QUARTER, who);
      read(`[${who}] ${report} as CSV`, report, `${QUARTER}&format=csv`, who, { headers: ANY });
      read(`[${who}] ${report}, POST`, report, QUARTER, who, { method: 'POST', body: '{}' });
    }
    read(`[owner] ${report}, DELETE asked for as CSV`, report, 'format=csv', 'owner', {
      method: 'DELETE',
      headers: ANY,
    });
  }

  // === The branch a reader is given =============================================================
  for (const report of ['dashboard', 'sales', 'inventory/valuation', 'business-summary', 'vat']) {
    for (const who of ['owner', 'admin', 'super', 'manager', 'mirpur', 'auditor'] as Reader[]) {
      for (const [name, branch] of [
        ['Dhaka', branches.dhaka],
        ['Mirpur', branches.mirpur],
        ['a closed branch', branches.spare],
        ['a branch that is not there', MISSING],
        ['a branch that is no id', 'abc'],
        ['a blank branch', ''],
      ] as const) {
        read(`[${who}] ${report} at ${name}`, report, `${QUARTER}&branch=${branch}`, who);
      }
    }
    read(
      `${report} at a branch with no hyphens`,
      report,
      `${QUARTER}&branch=${branches.mirpur.replaceAll('-', '')}`,
    );
    read(
      `${report} at a branch in capitals and braces`,
      report,
      `${QUARTER}&branch=%7B${branches.mirpur.toUpperCase()}%7D`,
    );
    read(
      `${report} at two branches (the last wins)`,
      report,
      `${QUARTER}&branch=${branches.dhaka}&branch=${branches.mirpur}`,
    );
  }
  // Which refusal comes first: the branch, except where the window is read before it.
  for (const report of REPORTS) {
    read(`${report}, a bad branch and a bad date`, report, 'branch=abc&date_from=nope');
    read(
      `${report}, a branch not one's own and a bad date`,
      report,
      `branch=${branches.dhaka}&date_from=nope`,
      'mirpur',
    );
  }

  // === The window ================================================================================
  for (const report of REPORTS) {
    for (const preset of [
      'today',
      'yesterday',
      '7d',
      '30d',
      '90d',
      'month',
      'last_month',
      'year',
      // Not presets: the default, which says so.
      'nope',
      'TODAY',
      '',
    ]) {
      read(`${report} range=${preset}`, report, `range=${preset}`);
    }
    read(`${report} with no window`, report, '');
    read(`${report} with no window, at Mirpur`, report, '', 'mirpur');
    for (const window of [
      'date_from=2025-01-01&date_to=2025-01-31',
      'date_from=2025-02-01&date_to=2025-02-28',
      'date_from=2025-02-10&date_to=2025-02-10',
      // The half-hour that is February in Dhaka and January in UTC.
      'date_from=2025-02-01T00:00:00&date_to=2025-02-01T00:59:59',
      'date_from=2025-01-31T18:00:00Z&date_to=2025-01-31T18:59:59Z',
      'date_from=2025-01-31T18:30:00%2B00:00&date_to=2025-01-31T18:30:00%2B00:00',
      'date_from=2025-01-31T18:30:00.000001Z&date_to=2025-03-31',
      'date_from=2025-03-31&date_to=2025-01-01',
      'date_from=2024-12-01&date_to=2024-12-31',
      // Half a window: the other end is the clock's.
      'date_from=2025-01-01',
      'date_to=2025-03-31',
      'date_from=2025-01-01&date_to=',
      'date_from=&date_to=2025-03-31',
      'date_from=&date_to=',
      // A date beats a preset.
      'date_from=2025-01-01&date_to=2025-03-31&range=today',
      'date_from=20250101&date_to=20250331',
      'date_from=%202025-01-01%20&date_to=%202025-03-31%20',
      'date_from=nope',
      'date_to=nope',
      'date_from=2025-02-30&date_to=2025-03-31',
      'date_from=%20',
      'date_from=2025-01-01&date_to=a%00b',
    ]) {
      read(`${report} ${window}`, report, window);
    }
  }
  // The dashboard's days: filled to the day up to 370 of them, left as they traded past that.
  for (const window of [
    'date_from=2025-01-01&date_to=2026-01-05',
    'date_from=2025-01-01&date_to=2026-01-06',
    'date_from=2025-01-01T23:59:59.999999&date_to=2025-01-02T00:00:00',
    'date_from=2025-01-09T18:00:00Z&date_to=2025-01-10T17:59:59Z',
    'date_from=0001-01-01&date_to=0001-01-03',
    'date_from=0001-01-01&date_to=2025-03-31',
    'date_from=9999-12-30&date_to=9999-12-31',
    'date_from=2025-01-01&date_to=9999-12-31',
    'date_from=9999-12-31T23:59:59-01:00&date_to=9999-12-31T23:59:59-01:00',
    'date_from=0001-01-01T00:00:00%2B14:00&date_to=0001-01-01T00:00:00%2B14:00',
  ]) {
    read(`dashboard, the days of ${window}`, 'dashboard', window);
    read(`vat, the months of ${window}`, 'vat', window);
  }

  // === The sales report's channel ================================================================
  for (const channel of [
    'POS',
    'ONLINE',
    'PHONE',
    'SOCIAL',
    'OTHER',
    'pos',
    'NOPE',
    '',
    '%20POS',
    'a%00b',
  ]) {
    read(`sales channel=${channel}`, 'sales', `${QUARTER}&channel=${channel}`);
    read(
      `sales channel=${channel}, as CSV`,
      'sales',
      `${QUARTER}&channel=${channel}&format=csv`,
      'owner',
      {
        headers: ANY,
      },
    );
  }
  read('sales, two channels (the last wins)', 'sales', `${QUARTER}&channel=POS&channel=PHONE`);
  read('a channel on a report that takes none', 'dashboard', `${QUARTER}&channel=PHONE`);

  // === What an answer becomes once CSV is negotiated ==============================================
  for (const report of REPORTS) {
    // The export itself.
    read(
      `${report}, an empty export`,
      report,
      'date_from=2020-01-01&date_to=2020-01-02&format=csv',
      'owner',
      { headers: ANY },
    );
    read(`${report}, an export at Mirpur`, report, `${QUARTER}&format=csv`, 'mirpur', {
      headers: { accept: 'text/csv' },
    });
    read(`${report}, an export over a preset`, report, 'range=year&format=csv', 'owner', {
      headers: ANY,
    });
    // Asked for by its type and no `format`: the answer is not an export.
    read(`${report}, Accept text/csv`, report, QUARTER, 'owner', {
      headers: { accept: 'text/csv' },
    });
    read(`${report}, Accept text/*`, report, QUARTER, 'owner', { headers: { accept: 'text/*' } });
    read(`${report}, Accept text/csv then JSON`, report, QUARTER, 'owner', {
      headers: { accept: 'text/csv, application/json' },
    });
    read(`${report}, Accept anything then text/csv`, report, QUARTER, 'owner', {
      headers: { accept: '*/*, text/csv' },
    });
    // Refusals, through the renderer that renders nothing.
    read(`${report}, Accept text/csv and a bad date`, report, 'date_from=nope', 'owner', {
      headers: { accept: 'text/csv' },
    });
    read(`${report}, an export with a bad date`, report, 'date_from=nope&format=csv', 'owner', {
      headers: ANY,
    });
    read(
      `${report}, an export at a branch that is not there`,
      report,
      `branch=${MISSING}&format=csv`,
      'owner',
      { headers: ANY },
    );
    read(`${report}, an export nobody signed in for`, report, 'format=csv', 'anon', {
      headers: ANY,
    });
    read(`${report}, Accept text/csv, nobody signed in`, report, '', 'anon', {
      headers: { accept: 'text/csv' },
    });
    read(`${report}, an export with a bad token`, report, 'format=csv', 'anon', {
      headers: { ...ANY, authorization: 'Bearer abc' },
    });
    // The format and the header disagree: neither renderer will do.
    read(`${report}, an export asked for as JSON`, report, `${QUARTER}&format=csv`);
    read(`${report}, JSON asked for as CSV`, report, `${QUARTER}&format=json`, 'owner', {
      headers: { accept: 'text/csv' },
    });
    read(`${report}, format=json`, report, `${QUARTER}&format=json`);
    read(`${report}, a format nobody renders`, report, `${QUARTER}&format=xml`);
    read(`${report}, format=CSV`, report, `${QUARTER}&format=CSV`, 'owner', { headers: ANY });
    read(
      `${report}, format twice (the last wins)`,
      report,
      `${QUARTER}&format=json&format=csv`,
      'owner',
      {
        headers: ANY,
      },
    );
    read(`${report}, no trailing slash`, report, '', 'owner', {
      path: `/api/v1/reports/${report}?${QUARTER}`,
    });
  }

  return cases;
}
