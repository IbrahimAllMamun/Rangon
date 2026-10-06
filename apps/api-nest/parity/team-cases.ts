/**
 * Parity cases for staff accounts and the organisation (phase 6 part 10):
 * `/branches/`, `/users/`, `/roles/`, `/permissions/`, `/organization/` and
 * `/organization/tax/`. Each write is compared by the accounts, profiles,
 * branches and organisations it made or changed, by the sessions it ended,
 * by what a deleted branch took with it, and by the audit log.
 *
 * The accounts come from fixture_team.py, the demo seed and the earlier
 * fixtures.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const TEAM_TABLES = [
  'accounts_staffprofile',
  'accounts_user',
  'accounts_branch',
  'accounts_organization',
  'orders_heldsale',
  'notifications_notification',
  'core_auditlog',
];
/** A row a request made or changed: told by its snapshot, never by time. */
const CHANGED = (alias: string) =>
  `(snap.id IS NULL OR to_jsonb(${alias}) IS DISTINCT FROM to_jsonb(snap))`;
const SNAP = (alias: string, table: string) =>
  `LEFT JOIN "snap_${table}" snap ON snap.id = ${alias}.id`;
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TIME_RE = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}(\\.[0-9]+)?(\\+[0-9:]{5}|Z)';
/** Audit values with what each API mints -- ids, times -- read as placeholders. */
const BLANKED = (column: string) =>
  `regexp_replace(regexp_replace(${column}::text, '${UUID_RE}', '<id>', 'g'), '${TIME_RE}', '<time>', 'g')`;

export const TEAM_EFFECTS = [
  // 0. Accounts made or changed. The password is compared by whether it moved.
  `SELECT u.email, u.first_name, u.last_name, u.phone, u.status, u.is_active, u.is_staff,
          u.is_superuser, r.code AS role, b.code AS branch, o.name AS organization,
          u.password IS DISTINCT FROM snap.password AS password_changed,
          u.password LIKE 'argon2$argon2id$%' AS argon2,
          u.last_login IS NOT DISTINCT FROM snap.last_login AS login_as_before,
          u.date_joined IS NOT DISTINCT FROM snap.date_joined AS joined_as_before,
          u.date_joined >= $1 AS joined_now, snap.id IS NULL AS made
     FROM accounts_user u ${SNAP('u', 'accounts_user')}
     LEFT JOIN accounts_role r ON r.id = u.role_id LEFT JOIN accounts_branch b ON b.id = u.branch_id
     LEFT JOIN accounts_organization o ON o.id = u.organization_id
    WHERE ${CHANGED('u')} ORDER BY u.email`,
  // 1. Profiles made or changed.
  `SELECT u.email, p.designation, p.joined_on::text, p.date_of_birth::text, p.national_id,
          p.blood_group, p.present_address, p.permanent_address, p.emergency_contact_name,
          p.emergency_contact_relation, p.emergency_contact_phone, p.notes,
          c.email AS created_by, snap.id IS NULL AS made
     FROM accounts_staffprofile p ${SNAP('p', 'accounts_staffprofile')}
     JOIN accounts_user u ON u.id = p.user_id LEFT JOIN accounts_user c ON c.id = p.created_by_id
    WHERE ${CHANGED('p')} ORDER BY u.email`,
  // 2. Sessions ended.
  `SELECT u.email, count(*)::int AS ended
     FROM token_blacklist_blacklistedtoken x
     JOIN token_blacklist_outstandingtoken t ON t.id = x.token_id
     JOIN accounts_user u ON u.id = t.user_id
    WHERE x.blacklisted_at >= $1 GROUP BY u.email ORDER BY u.email`,
  // 3. Branches made, changed or deleted, and what went with one.
  `SELECT b.name, b.code, b.address, b.phone, b.email, b.is_default, b.fulfils_online_orders,
          b.register_count, b.status, o.name AS organization, snap.id IS NULL AS made
     FROM accounts_branch b ${SNAP('b', 'accounts_branch')}
     LEFT JOIN accounts_organization o ON o.id = b.organization_id
    WHERE ${CHANGED('b')} ORDER BY b.code, b.name`,
  `SELECT x.code FROM "snap_accounts_branch" x
    WHERE x.id NOT IN (SELECT id FROM accounts_branch) ORDER BY x.code`,
  `SELECT (SELECT count(*)::int FROM "snap_orders_heldsale" x
            WHERE x.id NOT IN (SELECT id FROM orders_heldsale)) AS holds_gone,
          (SELECT count(*)::int FROM "snap_notifications_notification" x
            WHERE x.id NOT IN (SELECT id FROM notifications_notification)) AS notices_gone,
          (SELECT count(*)::int FROM core_auditlog a JOIN "snap_core_auditlog" s ON s.id = a.id
            WHERE a.branch_id IS DISTINCT FROM s.branch_id) AS audit_entries_let_go`,
  // 6. Organisations made or changed.
  `SELECT o.name, o.slug, o.legal_name, o.status, o.email, o.phone, o.address,
          o.vat_registration, o.currency, o.logo, o.receipt_footer, o.tax_mode,
          o.default_tax_rate::text, o.tax_settled_at IS NOT NULL AS settled,
          o.tax_settled_at IS DISTINCT FROM snap.tax_settled_at AS settled_now,
          u.email AS settled_by, o.counter_sells_reserved, snap.id IS NULL AS made
     FROM accounts_organization o ${SNAP('o', 'accounts_organization')}
     LEFT JOIN accounts_user u ON u.id = o.tax_settled_by_id
    WHERE ${CHANGED('o')} ORDER BY o.created_at`,
  // 7. The audit log.
  `SELECT a.action, a.entity_type, a.entity_label, a.actor_label,
          ${BLANKED('a.old_values')} AS old_values, ${BLANKED('a.new_values')} AS new_values,
          a.reason, a.branch_id IS NULL AS no_branch,
          CASE WHEN a.entity_id = '' THEN ''
               WHEN a.entity_id IN (SELECT id::text FROM "snap_accounts_user"
                                    UNION ALL SELECT id::text FROM "snap_accounts_organization")
               THEN 'known' ELSE 'new' END AS entity
     FROM core_auditlog a WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

export async function resetTeam(client: pg.Client): Promise<void> {
  await restoreTables(client, TEAM_TABLES);
}

/** Set once the cases are built: the fixture's accounts were there when the run began. */
export const teamFixture = { seen: false };

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function teamCases(): Promise<Case[]> {
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
      if (!id) throw new Error(`team-cases: no ${what} called ${key}`);
      return id;
    };
  };
  if (
    !(await db.query(`SELECT 1 FROM accounts_user WHERE email = 'parity.owner2@rangon.test'`))
      .rowCount
  ) {
    await db.end();
    console.log('SKIP  team: fixture_team.py has not been applied');
    return [];
  }
  teamFixture.seen = true;
  const user = await map('user', `SELECT email AS key, id FROM accounts_user`);
  const branch = await map('branch', `SELECT code AS key, id FROM accounts_branch`);
  const role = await map('role', `SELECT code AS key, id FROM accounts_role`);
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM accounts_user UNION ALL SELECT id::text FROM accounts_branch
       UNION ALL SELECT id::text FROM accounts_role UNION ALL SELECT id::text FROM accounts_permission
       UNION ALL SELECT id::text FROM accounts_organization`,
    )
  ).rows.map((row) => row.id);
  // Kept open: a case's `prepare` changes rows after the reset, before its request.
  const after =
    (...statements: string[]) =>
    async () => {
      for (const statement of statements) await db.query(statement);
      return {};
    };
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `team: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    who: Who = 'owner',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `team: ${name}`,
      method,
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetTeam,
      effects: TEAM_EFFECTS,
      jobs: true,
      normalize: minted,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const BRANCHES = '/api/v1/branches/';
  const USERS = '/api/v1/users/';
  const ROLES = '/api/v1/roles/';
  const PERMISSIONS = '/api/v1/permissions/';
  const ORGANIZATION = '/api/v1/organization/';
  const TAX = '/api/v1/organization/tax/';
  const long = (n: number) => 'x'.repeat(n);
  const NOT_OBJECTS: [string, unknown][] = [
    ['a list', []],
    ['a string', '"owner"'],
    ['a number', '7'],
    ['null', 'null'],
    ['broken JSON', '{"name": '],
    ['nothing', undefined],
  ];
  const oneUser = (email: string, action = '') =>
    `${USERS}${user(email)}/${action ? `${action}/` : ''}`;
  const CLERK = 'parity.clerk@rangon.test';
  const TEMP = 'parity.temp@rangon.test';
  const OWNER = 'owner@rangon.test';
  const OWNER2 = 'parity.owner2@rangon.test';
  const ADMIN = 'parity.admin@rangon.test';
  const GONE = 'parity.gone@rangon.test';
  const NOROLE = 'parity.norole@rangon.test';
  /** Switch the second owner on: `owner@rangon.test` is then not the last. */
  const twoOwners = after(
    `UPDATE accounts_user SET status = 'ACTIVE', is_active = true WHERE email = '${OWNER2}'`,
  );
  const noOrganization = after(`UPDATE accounts_organization SET status = 'INACTIVE'`);
  // Dates around today, where the shop is (UTC+6).
  const day = (offset: number) =>
    new Date(Date.now() + 6 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

  // === Who may do what =========================================================================
  for (const who of everyone) {
    read(`[${who}] branches`, BRANCHES, who);
    read(`[${who}] a branch`, `${BRANCHES}${branch('PAR3')}/`, who);
    write(`[${who}] branches: create`, 'POST', BRANCHES, {}, who);
    write(
      `[${who}] branches: edit one that is not there`,
      'PATCH',
      `${BRANCHES}${MISSING}/`,
      {},
      who,
    );
    write(
      `[${who}] branches: delete one that is not there`,
      'DELETE',
      `${BRANCHES}${MISSING}/`,
      undefined,
      who,
    );
    read(`[${who}] staff`, `${USERS}?page_size=3`, who);
    read(`[${who}] a member of staff with a profile`, oneUser(CLERK), who);
    write(`[${who}] staff: create`, 'POST', USERS, {}, who);
    write(`[${who}] staff: replace`, 'PUT', oneUser(CLERK), {}, who);
    write(`[${who}] staff: edit one that is not there`, 'PATCH', `${USERS}${MISSING}/`, {}, who);
    write(
      `[${who}] staff: delete one that is not there`,
      'DELETE',
      `${USERS}${MISSING}/`,
      undefined,
      who,
    );
    write(
      `[${who}] staff: deactivate one that is not there`,
      'POST',
      `${USERS}${MISSING}/deactivate/`,
      {},
      who,
    );
    write(
      `[${who}] staff: activate one that is not there`,
      'POST',
      `${USERS}${MISSING}/activate/`,
      {},
      who,
    );
    write(`[${who}] staff: activate one who left`, 'POST', oneUser(GONE, 'activate'), {}, who);
    read(`[${who}] roles`, ROLES, who);
    read(`[${who}] a role`, `${ROLES}${role('MANAGER')}/`, who);
    read(`[${who}] permissions`, PERMISSIONS, who);
    read(`[${who}] the organisation`, ORGANIZATION, who);
    write(`[${who}] the organisation: edit nothing`, 'PATCH', ORGANIZATION, {}, who);
    write(
      `[${who}] the organisation: its footer`,
      'PATCH',
      ORGANIZATION,
      { receipt_footer: 'Thank you.' },
      who,
    );
    read(`[${who}] the VAT treatment`, TAX, who);
    write(`[${who}] the VAT treatment: settle nothing`, 'PATCH', TAX, {}, who);
    write(
      `[${who}] the VAT treatment: settle it as it is`,
      'PATCH',
      TAX,
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '0' },
      who,
    );
  }

  // === Branches ================================================================================
  for (const query of [
    '',
    'page_size=2',
    'page_size=2&page=2',
    'page=last&page_size=3',
    'page=9',
    'page_size=0',
    'search=Parity&status=INACTIVE&is_default=true',
    ...[
      'name',
      '-name',
      'code',
      '-code',
      'address,code',
      'phone,code',
      'email,code',
      'is_default,code',
      '-is_default,-code',
      'fulfils_online_orders,code',
      'register_count,code',
      '-register_count,code',
      'status,code',
      'created_at',
      '-created_at',
      'id',
      'organization,code',
      'nope',
      '',
    ].map((ordering) => `ordering=${ordering}`),
  ]) {
    read(`branches ${query || 'unfiltered'}`, `${BRANCHES}?${query}`);
  }
  for (const code of ['DHK1', 'PAR2', 'PAR3', 'PAR9']) {
    read(`the branch ${code}`, `${BRANCHES}${branch(code)}/`);
  }
  read('branches: one that is not there', `${BRANCHES}${MISSING}/`);
  read('branches: a key that is no id', `${BRANCHES}abc/`);
  read('branches: no trailing slash', BRANCHES.slice(0, -1));
  write('branches: the list cannot be deleted', 'DELETE', BRANCHES, undefined);
  write('branches: one cannot be posted to', 'POST', `${BRANCHES}${branch('PAR9')}/`, {});

  const newBranch = (name: string, body: unknown, who: Who = 'owner', extra: Partial<Case> = {}) =>
    write(`a new branch: ${name}`, 'POST', BRANCHES, body, who, extra);
  const outlet = { name: 'Parity Outlet', code: 'PAR7' };
  newBranch('everything', {
    ...outlet,
    address: '  12 Lake Road\nGulshan 2  ',
    phone: '01711-000111',
    email: 'Outlet@Rangon.TEST',
    is_default: false,
    fulfils_online_orders: false,
    register_count: 3,
    status: 'INACTIVE',
    organization: MISSING,
    id: MISSING,
    created_at: '2020-01-01T00:00:00Z',
  });
  newBranch('a name and a code', outlet);
  newBranch('by an administrator', outlet, 'admin');
  newBranch('nothing', {});
  newBranch('no code', { name: 'Parity Outlet' });
  newBranch('no name', { code: 'PAR7' });
  for (const [what, body] of [
    ['a blank name', { name: '  ' }],
    ['a null name', { name: null }],
    ['the longest name', { name: long(120) }],
    ['a name too long', { name: long(121) }],
    ['a name another branch has', { name: 'Parity Mirpur' }],
    ['a blank code', { code: '' }],
    ['the longest code', { code: long(16) }],
    ['a code too long', { code: long(17) }],
    ['a code another branch has', { code: 'DHK1' }],
    ['a code another branch has in other letters', { code: 'dhk1' }],
    ['a code with spaces in it', { code: ' PAR 7 ' }],
    ['a code that is a number', { code: 7 }],
    ['a mobile with its country code', { phone: '+8801711000111' }],
    ['a hotline', { phone: '16516' }],
    ['a phone in words', { phone: 'ask at the counter' }],
    ['a blank phone', { phone: '' }],
    ['a null phone', { phone: null }],
    ['a phone too long', { phone: '1'.repeat(33) }],
    ['an email that is none', { email: 'outlet at rangon' }],
    ['a blank email', { email: '' }],
    ['a null email', { email: null }],
    ['an email too long', { email: `${long(245)}@rangon.test` }],
    ['a null address', { address: null }],
    ['a second default branch', { is_default: true }],
    ['the default flag as a word', { is_default: 'main' }],
    ['the default flag as null', { is_default: null }],
    ['online orders as "no"', { fulfils_online_orders: 'no' }],
    ['no tills', { register_count: 0 }],
    ['tills below zero', { register_count: -1 }],
    ['the most tills', { register_count: 32767 }],
    ['too many tills', { register_count: 32768 }],
    ['tills in words', { register_count: 'two' }],
    ['tills with a fraction', { register_count: 1.5 }],
    ['null tills', { register_count: null }],
    ['a status of SUSPENDED', { status: 'SUSPENDED' }],
    ['a status that is none', { status: 'CLOSED' }],
    ['a status in small letters', { status: 'active' }],
    ['a null status', { status: null }],
    [
      'several things wrong',
      { name: '', code: long(17), email: 'x', register_count: -1, status: 'x' },
    ],
  ] as [string, Record<string, unknown>][]) {
    newBranch(what, { ...outlet, ...body });
  }
  newBranch('with no organisation to join', outlet, 'owner', { prepare: noOrganization });
  for (const [kind, body] of NOT_OBJECTS) newBranch(`from ${kind}`, body);

  const SPARE = `${BRANCHES}${branch('PAR9')}/`;
  const HOME = `${BRANCHES}${branch('DHK1')}/`;
  for (const [what, path, body] of [
    ['nothing', SPARE, {}],
    ['its name', SPARE, { name: 'Parity Annex' }],
    ['its code', SPARE, { code: 'PAR8' }],
    ["another branch's code", SPARE, { code: 'DHK1' }],
    ['its own code again', SPARE, { code: 'PAR9' }],
    ['opening it', SPARE, { status: 'ACTIVE', fulfils_online_orders: true, register_count: 2 }],
    ['making it the default too', SPARE, { is_default: true }],
    ['its phone and email', SPARE, { phone: '01911 000555', email: 'spare@rangon.test' }],
    ['its address', SPARE, { address: 'Opened at last' }],
    ['a status that is none', SPARE, { status: 'CLOSED' }],
    [
      'what cannot be written',
      SPARE,
      { id: MISSING, created_at: '2020-01-01T00:00:00Z', organization: MISSING },
    ],
    ['the default branch switched off', HOME, { status: 'INACTIVE' }],
    ['the default branch no longer the default', HOME, { is_default: false }],
    ['the default branch with no tills', HOME, { register_count: 0 }],
  ] as [string, string, unknown][]) {
    write(`a branch edited: ${what}`, 'PATCH', path, body);
  }
  write('a branch replaced', 'PUT', SPARE, { name: 'Parity Spare', code: 'PAR9' });
  write('a branch replaced without its code', 'PUT', SPARE, { name: 'Parity Spare' });
  write('a branch edited: a key that is no id', 'PATCH', `${BRANCHES}abc/`, { name: 'x' });
  for (const [kind, body] of NOT_OBJECTS)
    write(`a branch edited from ${kind}`, 'PATCH', SPARE, body);
  for (const code of ['PAR9', 'PAR2', 'PAR3', 'DHK1']) {
    write(`a branch deleted: ${code}`, 'DELETE', `${BRANCHES}${branch(code)}/`, undefined);
  }
  write('a branch deleted: by an administrator', 'DELETE', SPARE, { name: 'ignored' }, 'admin');
  write('a branch deleted: a key that is no id', 'DELETE', `${BRANCHES}abc/`, undefined);

  // === Roles and permissions ===================================================================
  for (const ordering of [
    '',
    'code',
    '-code',
    'name',
    '-name',
    'description,code',
    'is_staff_role,code',
    'is_system,-code',
    'id',
    'permissions',
    '-permissions',
    'permissions,-code',
    'holds_every_permission',
    'is_owner',
    'nope',
  ]) {
    read(`roles ordered by ${ordering || 'nothing'}`, `${ROLES}?ordering=${ordering}`);
  }
  read('roles: no filter or paging is offered', `${ROLES}?code=OWNER&page_size=1&search=own`);
  for (const code of [
    'OWNER',
    'ADMIN',
    'MANAGER',
    'CASHIER',
    'INVENTORY_MANAGER',
    'ACCOUNTANT',
    'CUSTOMER',
    'PARITY_TILL',
  ]) {
    read(`the role ${code}`, `${ROLES}${role(code)}/`);
  }
  read('a role, ordered by its permissions', `${ROLES}${role('MANAGER')}/?ordering=permissions`);
  read('roles: one that is not there', `${ROLES}${MISSING}/`);
  read('roles: a key that is no id', `${ROLES}abc/`);
  read('roles: a key that is a code', `${ROLES}OWNER/`);
  for (const ordering of [
    '',
    'code',
    '-code',
    'name,code',
    '-group,code',
    'description,code',
    'id',
    'roles',
    'nope',
  ]) {
    read(`permissions ordered by ${ordering || 'nothing'}`, `${PERMISSIONS}?ordering=${ordering}`);
  }
  read('permissions: no filter or paging is offered', `${PERMISSIONS}?group=sales&page_size=2`);
  read('permissions: one cannot be read', `${PERMISSIONS}${MISSING}/`);
  for (const [what, method, path] of [
    ['a role cannot be made', 'POST', ROLES],
    ['a role cannot be edited', 'PATCH', `${ROLES}${role('MANAGER')}/`],
    ['a role cannot be replaced', 'PUT', `${ROLES}${role('MANAGER')}/`],
    ['a role cannot be deleted', 'DELETE', `${ROLES}${role('PARITY_TILL')}/`],
    ['a permission cannot be made', 'POST', PERMISSIONS],
    ['the permissions cannot be deleted', 'DELETE', PERMISSIONS],
  ] as const) {
    write(what, method, path, { code: 'OWNER', name: 'x', permissions: [] });
  }

  // === Staff: reading ==========================================================================
  for (const query of [
    '',
    'page_size=5',
    'page_size=5&page=2',
    'page=last&page_size=6',
    'page=99',
    ...['ACTIVE', 'INACTIVE', 'SUSPENDED', 'active', 'NOPE', ''].map(
      (status) => `status=${status}`,
    ),
    ...['DHK1', 'PAR2', 'PAR3', 'PAR9'].map((code) => `branch=${branch(code)}`),
    `branch=${MISSING}`,
    'branch=abc',
    'branch=',
    'branch=null',
    ...['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'CUSTOMER', 'PARITY_TILL'].map(
      (code) => `role=${role(code)}`,
    ),
    `role=${MISSING}`,
    'role=abc',
    'role=OWNER',
    `status=ACTIVE&branch=${branch('DHK1')}&role=${role('MANAGER')}`,
    `status=NOPE&branch=abc&role=abc`,
    'ordering=email',
    'ordering=-email',
    'ordering=date_joined,email',
    'ordering=-date_joined,email',
    'ordering=-date_joined,-email&page_size=4',
    'ordering=first_name',
    'ordering=role',
    'ordering=status,email',
    'ordering=nope',
    'search=owner',
    'search=Parity%20Clerk',
    'email=owner@rangon.test&first_name=Parity',
  ]) {
    read(`staff ${query || 'unfiltered'}`, `${USERS}?${query}`);
  }
  read('staff, as a manager who may not see profiles', `${USERS}?page_size=50`, 'manager');
  read('staff, as an administrator', `${USERS}?page_size=50`, 'admin');
  for (const email of [
    CLERK,
    TEMP,
    OWNER,
    OWNER2,
    GONE,
    NOROLE,
    'parity.super@rangon.test',
    'parity.till@rangon.test',
  ]) {
    read(`the account ${email}`, oneUser(email));
    read(`the account ${email}, as a manager`, oneUser(email), 'manager');
  }
  read('staff: a customer is not one', oneUser('parity.customer@rangon.test'));
  read('staff: one that is not there', `${USERS}${MISSING}/`);
  read('staff: a key that is no id', `${USERS}abc/`);
  read('staff: no trailing slash', USERS.slice(0, -1));
  read(
    'an account through a filter that holds it',
    `${oneUser(CLERK)}?status=ACTIVE&branch=${branch('PAR3')}`,
  );
  read('an account through a filter that does not', `${oneUser(CLERK)}?status=INACTIVE`);
  read('an account through a filter that is wrong', `${oneUser(CLERK)}?role=abc`);
  read('an account, ordered', `${oneUser(CLERK)}?ordering=-date_joined`);
  read("an account's deactivation cannot be read", oneUser(CLERK, 'deactivate'));
  write('staff: the list cannot be deleted', 'DELETE', USERS, undefined);
  write('staff: an account cannot be posted to', 'POST', oneUser(CLERK), {});
  write('staff: an action that is none', 'POST', oneUser(CLERK, 'promote'), {});

  // === Staff: a new account ====================================================================
  const hire = (name: string, body: unknown, who: Who = 'owner', extra: Partial<Case> = {}) =>
    write(`a new account: ${name}`, 'POST', USERS, body, who, extra);
  const recruit = { email: 'parity.recruit@rangon.test', password: 'correct horse 42' };
  const wholeProfile = {
    designation: '  Senior cashier ',
    joined_on: '2025-01-05',
    date_of_birth: '1990-02-03',
    national_id: ' AB 12-3 ',
    blood_group: 'O_POS',
    present_address: 'House 1\nRoad 2',
    permanent_address: 'Sylhet',
    emergency_contact_name: 'Karim',
    emergency_contact_relation: 'Brother',
    emergency_contact_phone: '01711-000999',
    notes: 'Starts Monday.',
  };
  hire('everything', {
    email: ' Parity.Recruit@Rangon.TEST ',
    password: 'correct horse 42',
    first_name: ' New ',
    last_name: ' Person ',
    phone: '01711-000222',
    status: 'SUSPENDED',
    branch: branch('PAR3'),
    role_code: 'MANAGER',
    profile: wholeProfile,
  });
  hire('an email and a password', recruit);
  hire('by an administrator', recruit, 'admin');
  hire('nothing', {});
  hire('no password', { email: recruit.email });
  hire('no password, and other things wrong', { email: 'x', role_code: 'NOPE' });
  hire('no email', { password: recruit.password });
  hire('what cannot be written', {
    ...recruit,
    is_superuser: true,
    is_staff: true,
    is_active: false,
    organization: MISSING,
    role: role('OWNER'),
    id: MISSING,
    last_login: '2020-01-01T00:00:00Z',
    date_joined: '2020-01-01T00:00:00Z',
    full_name: 'ignored',
  });
  for (const [what, body] of [
    ['a blank email', { email: '' }],
    ['a null email', { email: null }],
    ['an email that is none', { email: 'recruit at rangon' }],
    ['an email too long', { email: `${long(245)}@rangon.test` }],
    ['an email taken', { email: 'owner@rangon.test' }],
    ['an email taken, with space around it', { email: '  owner@rangon.test ' }],
    ['an email taken in other letters', { email: 'OWNER@rangon.test' }],
    ["a customer's email", { email: 'parity.customer@rangon.test' }],
    ['an email in capitals', { email: 'RECRUIT@RANGON.TEST' }],
    ['a first name too long', { first_name: long(81) }],
    ['the longest names', { first_name: long(80), last_name: long(80) }],
    ['null names', { first_name: null, last_name: null }],
    ['a mobile with its country code', { phone: '+8801711000222' }],
    ['a hotline for a phone', { phone: '16516' }],
    ['a phone too long', { phone: '1'.repeat(33) }],
    ['a status of INACTIVE', { status: 'INACTIVE' }],
    ['a status that is none', { status: 'RETIRED' }],
    ['a branch that is not there', { branch: MISSING }],
    ['a branch that is no id', { branch: 'abc' }],
    ['a null branch', { branch: null }],
    ['a branch that is closed', { branch: branch('PAR2') }],
    ['a blank password', { password: '' }],
    ['a null password', { password: null }],
    ['a password of spaces', { password: '            ' }],
    ['a password too short', { password: 'short' }],
    ['a password of nine', { password: 'ninechars' }],
    ['a password of ten', { password: 'tenchars!x' }],
    ['a password all figures', { password: '1234567890' }],
    ['a password that is a number', { password: 1234567890123 }],
    ['a password everyone uses', { password: 'password123' }],
    ['a password everyone uses, in capitals', { password: 'PASSWORD123' }],
    ['the email as the password', { password: recruit.email }],
    ['a long password in Bengali', { password: 'পাসওয়ার্ড নিরাপদ রাখুন' }],
    ['a password with space around it', { password: '  correct horse 42  ' }],
    ['a very long password', { password: long(300) }],
    ...['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'INVENTORY_MANAGER', 'ACCOUNTANT', 'CUSTOMER'].map(
      (code) => [`the role ${code}`, { role_code: code }] as [string, Record<string, unknown>],
    ),
    ['a role made in the admin', { role_code: 'PARITY_TILL' }],
    ['a role in small letters', { role_code: 'manager' }],
    ['a null role', { role_code: null }],
    ['a blank role', { role_code: '' }],
    ['an empty profile', { profile: {} }],
    ['a null profile', { profile: null }],
    ['a profile that is a word', { profile: 'x' }],
    ['a profile that is a list', { profile: [wholeProfile] }],
    [
      'a profile of blanks',
      { profile: { designation: '', joined_on: null, notes: '', national_id: '' } },
    ],
    ['a profile with only a title', { profile: { designation: 'Helper' } }],
    ['an ID number another has', { profile: { national_id: 'PARITY NID 1' } }],
    [
      'an ID number another has, with space around it',
      { profile: { national_id: '  PARITY NID 1 ' } },
    ],
    ['an ID number another has in other letters', { profile: { national_id: 'parity nid 1' } }],
    ['an ID number with marks in it', { profile: { national_id: 'AB_12/3' } }],
    ['an ID number in Bengali', { profile: { national_id: '১২৩৪' } }],
    ['an ID number too long', { profile: { national_id: '1'.repeat(33) } }],
    [
      'an ID number taken, with marks, too long',
      { profile: { national_id: `PARITY NID 1${'_'.repeat(30)}` } },
    ],
    ['a null ID number', { profile: { national_id: null } }],
    ['born today', { profile: { date_of_birth: day(0) } }],
    ['born tomorrow', { profile: { date_of_birth: day(1) } }],
    ['born on a day that is none', { profile: { date_of_birth: '1990-02-30' } }],
    ['born on a date and time', { profile: { date_of_birth: '1990-02-03T10:00:00Z' } }],
    ['born on a number', { profile: { date_of_birth: 19900203 } }],
    [
      'joined before being born',
      { profile: { date_of_birth: '2000-01-01', joined_on: '1999-12-31' } },
    ],
    [
      'joined on the day of birth',
      { profile: { date_of_birth: '2000-01-01', joined_on: '2000-01-01' } },
    ],
    ['joined in the future', { profile: { joined_on: '2031-01-01' } }],
    ['a blood group that is none', { profile: { blood_group: 'C_POS' } }],
    ['a blood group as written', { profile: { blood_group: 'O+' } }],
    ['a blank blood group', { profile: { blood_group: '' } }],
    ['a null blood group', { profile: { blood_group: null } }],
    ['a title too long', { profile: { designation: long(81) } }],
    ['a contact name too long', { profile: { emergency_contact_name: long(121) } }],
    ['a relation too long', { profile: { emergency_contact_relation: long(61) } }],
    ['a contact hotline', { profile: { emergency_contact_phone: '999' } }],
    ['a contact phone too long', { profile: { emergency_contact_phone: '1'.repeat(33) } }],
    ['long notes and addresses', { profile: { notes: long(3000), present_address: long(1000) } }],
    [
      'a profile key that is none',
      { profile: { designation: 'Helper', salary: 1, user: MISSING } },
    ],
    [
      'several things wrong in a profile',
      {
        profile: {
          designation: null,
          joined_on: 'x',
          date_of_birth: day(2),
          national_id: 'a_b',
          blood_group: 'Z',
        },
      },
    ],
    [
      'several things wrong',
      {
        email: 'x',
        first_name: long(81),
        status: 'x',
        branch: 'abc',
        password: 'short',
        role_code: 'x',
        profile: 'x',
      },
    ],
  ] as [string, Record<string, unknown>][]) {
    hire(what, { ...recruit, ...body });
  }
  hire('with no organisation to join', recruit, 'owner', { prepare: noOrganization });
  for (const [kind, body] of NOT_OBJECTS) hire(`from ${kind}`, body);

  // === Staff: editing ==========================================================================
  const edit = (
    name: string,
    email: string,
    body: unknown,
    who: Who = 'owner',
    extra: Partial<Case> = {},
  ) => write(`an account edited: ${name}`, 'PATCH', oneUser(email), body, who, extra);
  for (const [what, body] of [
    ['nothing', {}],
    ['their names', { first_name: ' Pari ', last_name: '' }],
    ['their phone', { phone: '01911-000333' }],
    ['their phone cleared', { phone: '' }],
    ['their email', { email: 'Parity.Clerk2@Rangon.TEST' }],
    ['their own email in capitals', { email: 'PARITY.CLERK@RANGON.TEST' }],
    ["another's email", { email: 'owner@rangon.test' }],
    ["another's email in capitals", { email: 'OWNER@RANGON.TEST' }],
    ['an email that is none', { email: 'clerk' }],
    ['a new password', { password: 'another horse 43' }],
    ['a password too short', { password: 'short' }],
    ['a password all figures', { password: '9876543210' }],
    ['a blank password', { password: '' }],
    ['a null password', { password: null }],
    ['a promotion', { role_code: 'MANAGER' }],
    ['the owner role', { role_code: 'OWNER' }],
    ['their own role again', { role_code: 'CASHIER' }],
    ['the customer role', { role_code: 'CUSTOMER' }],
    ['a role that is none', { role_code: 'PARITY_TILL' }],
    ['a suspension', { status: 'SUSPENDED' }],
    ['a deactivation', { status: 'INACTIVE' }],
    ['their own status again', { status: 'ACTIVE' }],
    ['a status that is none', { status: 'RETIRED' }],
    ['their branch taken away', { branch: null }],
    ['a move to the home branch', { branch: branch('DHK1') }],
    ['a move to a closed branch', { branch: branch('PAR2') }],
    ['a move to a branch that is not there', { branch: MISSING }],
    [
      'everything at once',
      {
        first_name: 'Sab',
        password: 'another horse 43',
        role_code: 'MANAGER',
        status: 'SUSPENDED',
        branch: null,
        email: 'Clerk9@Rangon.test',
        phone: '01911000333',
        profile: { designation: 'Shift lead' },
      },
    ],
    ['a new title', { profile: { designation: 'Senior till clerk' } }],
    ['a title and notes', { profile: { designation: 'Senior till clerk', notes: '' } }],
    [
      'the profile they have, less its ID number',
      { profile: { designation: 'Till clerk', blood_group: 'B_POS', joined_on: '2024-03-01' } },
    ],
    ['their own ID number again', { profile: { national_id: 'PARITY NID 1' } }],
    [
      'their own ID number again, and a new title',
      { profile: { national_id: 'PARITY NID 1', designation: 'Lead' } },
    ],
    ['a new ID number', { profile: { national_id: ' PARITY NID 2 ' } }],
    ['their ID number cleared', { profile: { national_id: '' } }],
    ['their dates cleared', { profile: { joined_on: null, date_of_birth: null } }],
    ['joined before the birth date they have', { profile: { joined_on: '1990-01-01' } }],
    [
      'joined before a new birth date',
      { profile: { joined_on: '1990-01-01', date_of_birth: '1991-01-01' } },
    ],
    ['a contact mobile', { profile: { emergency_contact_phone: '01811-000446' } }],
    ['an empty profile', { profile: {} }],
    ['a null profile', { profile: null }],
    ['a profile key that is none', { profile: { salary: 1 } }],
    [
      'what cannot be written',
      {
        is_superuser: true,
        is_staff: true,
        is_active: false,
        role: role('OWNER'),
        organization: MISSING,
        last_login: '2020-01-01T00:00:00Z',
        id: MISSING,
      },
    ],
    [
      'several things wrong',
      {
        email: 'x',
        status: 'x',
        branch: 'abc',
        password: 'short',
        role_code: 'x',
        profile: { national_id: 'a_b' },
      },
    ],
  ] as [string, unknown][]) {
    edit(what, CLERK, body);
  }
  edit('by an administrator', CLERK, { first_name: 'By admin' }, 'admin');
  edit('through a filter that holds the account', CLERK, { first_name: 'F' }, 'owner', {
    path: `${oneUser(CLERK)}?status=ACTIVE`,
  });
  edit('through a filter that does not', CLERK, { first_name: 'F' }, 'owner', {
    path: `${oneUser(CLERK)}?status=SUSPENDED`,
  });
  edit('someone suspended, switched on', TEMP, { status: 'ACTIVE' });
  edit('someone suspended, deactivated', TEMP, { status: 'INACTIVE' });
  edit('someone given an ID number another has', TEMP, {
    profile: { national_id: 'PARITY NID 1' },
  });
  edit('someone given an ID number of their own', TEMP, {
    profile: { national_id: 'PARITY NID 9' },
  });
  edit('someone with no role, their name', NOROLE, { first_name: 'Nobody' });
  edit('someone with no role, given one', NOROLE, { role_code: 'CASHIER' });
  edit('someone who left, switched on', GONE, { status: 'ACTIVE' });
  edit('a customer is not one', 'parity.customer@rangon.test', { first_name: 'x' });
  // The two guards: not yourself, and not the last owner.
  for (const [what, body] of [
    ['their own name', { first_name: 'Boss' }],
    ['their own deactivation', { status: 'INACTIVE' }],
    ['their own suspension', { status: 'SUSPENDED' }],
    ['their own status again', { status: 'ACTIVE' }],
    ['their own demotion', { role_code: 'ADMIN' }],
    ['their own role again', { role_code: 'OWNER' }],
    ['their own demotion and suspension', { role_code: 'ADMIN', status: 'SUSPENDED' }],
    ['their own password', { password: 'another horse 43' }],
  ] as [string, unknown][]) {
    edit(`the owner, ${what}`, OWNER, body);
    edit(`the owner, ${what}, with a second owner`, OWNER, body, 'owner', { prepare: twoOwners });
  }
  for (const [what, body] of [
    ['deactivated', { status: 'INACTIVE' }],
    ['suspended', { status: 'SUSPENDED' }],
    ['demoted', { role_code: 'ADMIN' }],
    ['demoted to a customer', { role_code: 'CUSTOMER' }],
    ['demoted and suspended', { role_code: 'MANAGER', status: 'SUSPENDED' }],
    ['renamed', { first_name: 'Boss' }],
    ['given a new password', { password: 'another horse 43' }],
  ] as [string, unknown][]) {
    edit(`the last owner ${what} by an administrator`, OWNER, body, 'admin');
    edit(`one of two owners ${what} by an administrator`, OWNER, body, 'admin', {
      prepare: twoOwners,
    });
  }
  edit('an owner who is switched off, demoted', OWNER2, { role_code: 'MANAGER' });
  edit('an owner who is switched off, switched on', OWNER2, { status: 'ACTIVE' });
  edit('the second owner switched off by the first', OWNER2, { status: 'INACTIVE' }, 'owner', {
    prepare: twoOwners,
  });
  edit('the second owner demoted by the first', OWNER2, { role_code: 'CASHIER' }, 'owner', {
    prepare: twoOwners,
  });
  edit('an administrator, their own promotion to owner', ADMIN, { role_code: 'OWNER' }, 'admin');
  edit('an administrator, their own demotion', ADMIN, { role_code: 'CASHIER' }, 'admin');
  edit('an administrator, their own deactivation', ADMIN, { status: 'INACTIVE' }, 'admin');
  edit('an administrator, their own password', ADMIN, { password: 'another horse 43' }, 'admin');
  edit(
    'a superuser who is a cashier, their own demotion',
    'parity.super@rangon.test',
    { role_code: 'CUSTOMER' },
    'super',
  );
  write('an account replaced', 'PUT', oneUser(CLERK), { email: CLERK, first_name: 'Only' });
  write('an account replaced by its email alone', 'PUT', oneUser(CLERK), { email: CLERK });
  write('an account replaced without its email', 'PUT', oneUser(CLERK), { first_name: 'x' });
  write('an account replaced with a status of its own choosing', 'PUT', oneUser(OWNER), {
    email: OWNER,
    status: 'INACTIVE',
  });
  for (const [kind, body] of NOT_OBJECTS) edit(`from ${kind}`, CLERK, body);

  // === Staff: switching off and on =============================================================
  const off = (
    name: string,
    email: string,
    body: unknown,
    who: Who = 'owner',
    extra: Partial<Case> = {},
  ) => write(`deactivate: ${name}`, 'POST', oneUser(email, 'deactivate'), body, who, extra);
  for (const [what, body] of [
    ['no body', undefined],
    ['an empty object', {}],
    ['a reason', { reason: 'Left the company' }],
    ['a reason with space around it', { reason: '  Left  ' }],
    ['a blank reason', { reason: '' }],
    ['a null reason', { reason: null }],
    ['a reason that is zero', { reason: 0 }],
    ['a reason that is a number', { reason: 7 }],
    ['a reason that is a fraction', '{"reason": 1.50}'],
    ['a reason that is true', { reason: true }],
    ['a reason that is false', { reason: false }],
    ['a reason that is a list', { reason: ['left', 1, null] }],
    ['a reason that is an empty list', { reason: [] }],
    ['a reason that is an object', { reason: { why: "it's time" } }],
    ['a long reason', { reason: long(2000) }],
    ['other keys', { status: 'ACTIVE', note: 'x' }],
    ['a list', []],
    ['a string', '"left"'],
    ['a number', '7'],
    ['null', 'null'],
    ['broken JSON', '{"reason": '],
  ] as [string, unknown][]) {
    off(`a clerk, with ${what}`, CLERK, body);
  }
  off('by an administrator', CLERK, {}, 'admin');
  off('someone already off', GONE, { reason: 'Again' });
  off('someone suspended', TEMP, {});
  off('someone with no role', NOROLE, {});
  off('yourself, an owner', OWNER, {});
  off('yourself, an owner, from a list', OWNER, []);
  off('yourself, with a second owner', OWNER, {}, 'owner', { prepare: twoOwners });
  off('yourself, an administrator', ADMIN, {}, 'admin');
  off('the last owner, by an administrator', OWNER, {}, 'admin');
  off('the last owner, by an administrator, from a list', OWNER, [], 'admin');
  off('one of two owners, by an administrator', OWNER, { reason: 'Sold the shop' }, 'admin', {
    prepare: twoOwners,
  });
  off('an owner who is already off', OWNER2, {});
  off('the second owner, by the first', OWNER2, {}, 'owner', { prepare: twoOwners });
  off('a customer is not one', 'parity.customer@rangon.test', {});
  off('through a filter that does not hold the account', CLERK, {}, 'owner', {
    path: `${oneUser(CLERK, 'deactivate')}?status=INACTIVE`,
  });
  for (const [what, email, body, who, extra] of [
    ['a clerk', CLERK, undefined, 'owner', {}],
    ['a clerk, with a reason', CLERK, { reason: 'Deleted from the list' }, 'owner', {}],
    ['a clerk, from a list', CLERK, [], 'owner', {}],
    ['a clerk, by an administrator', CLERK, undefined, 'admin', {}],
    ['someone already off', GONE, undefined, 'owner', {}],
    ['yourself', OWNER, undefined, 'owner', {}],
    ['the last owner, by an administrator', OWNER, undefined, 'admin', {}],
    ['one of two owners, by an administrator', OWNER, undefined, 'admin', { prepare: twoOwners }],
    ['a customer is not one', 'parity.customer@rangon.test', undefined, 'owner', {}],
  ] as [string, string, unknown, Who, Partial<Case>][]) {
    write(`an account deleted: ${what}`, 'DELETE', oneUser(email), body, who, extra);
  }
  const on = (name: string, email: string, body: unknown, who: Who = 'owner') =>
    write(`activate: ${name}`, 'POST', oneUser(email, 'activate'), body, who);
  on('someone who left', GONE, {});
  on('someone who left, with a reason that is not used', GONE, { reason: 'Back from leave' });
  on('someone who left, from a list', GONE, []);
  on('someone who left, with no body', GONE, undefined);
  on('someone suspended', TEMP, {});
  on('someone already on', CLERK, {});
  on('an owner who is off', OWNER2, {});
  on('by an administrator', GONE, {}, 'admin');
  on('yourself', OWNER, {});
  on('a customer is not one', 'parity.customer@rangon.test', {});
  write('activate: a key that is no id', 'POST', `${USERS}abc/activate/`, {});

  // === The organisation ========================================================================
  const org = (name: string, body: unknown, who: Who = 'owner', extra: Partial<Case> = {}) =>
    write(`the organisation edited: ${name}`, 'PATCH', ORGANIZATION, body, who, extra);
  for (const [what, body] of [
    ['its name', { name: ' Rangon Fashion House ' }],
    ['a blank name', { name: '' }],
    ['a null name', { name: null }],
    ['the longest name', { name: long(200) }],
    ['a name too long', { name: long(201) }],
    ['its legal name cleared', { legal_name: '' }],
    ['its email', { email: 'Shop@Rangon.TEST' }],
    ['an email that is none', { email: 'shop' }],
    ['its email cleared', { email: '' }],
    ['a mobile for its phone', { phone: '01711-000333' }],
    ['a hotline for its phone', { phone: '09610-000000' }],
    ['a phone too long', { phone: '1'.repeat(33) }],
    ['its address', { address: 'Level 4\nBashundhara City' }],
    ['a VAT number', { vat_registration: 'BIN-000123456-0101' }],
    ['a VAT number too long', { vat_registration: long(65) }],
    ['another currency', { currency: 'USD' }],
    ['a currency in small letters', { currency: 'bdt' }],
    ['a blank currency', { currency: '' }],
    ['a currency too long', { currency: long(9) }],
    ['its footer', { receipt_footer: 'ধন্যবাদ\nExchange within 7 days.' }],
    ['its footer cleared', { receipt_footer: '' }],
    ['suspended', { status: 'SUSPENDED' }],
    ['switched off', { status: 'INACTIVE' }],
    ['a status that is none', { status: 'CLOSED' }],
    ['the counter let into reserved stock', { counter_sells_reserved: true }],
    ['the counter kept out, as it is', { counter_sells_reserved: false }],
    ['the counter flag as a word', { counter_sells_reserved: 'sometimes' }],
    ['the counter flag as null', { counter_sells_reserved: null }],
    [
      'what cannot be written',
      {
        slug: 'x',
        tax_mode: 'INCLUSIVE',
        default_tax_rate: '0.5',
        tax_settled_at: '2020-01-01T00:00:00Z',
        tax_settled_by_name: 'x',
        id: MISSING,
        branches: [],
        logo: 'x.png',
      },
    ],
    [
      'several things at once',
      {
        name: 'Rangon',
        phone: '16516',
        currency: 'BDT',
        counter_sells_reserved: true,
        receipt_footer: 'x',
      },
    ],
    ['several things wrong', { name: '', currency: '', status: 'GONE', email: 'x' }],
  ] as [string, unknown][]) {
    org(what, body);
  }
  org('by an administrator, its name', { name: 'Rangon by admin' }, 'admin');
  org(
    'by an administrator, the counter let into reserved stock',
    { counter_sells_reserved: true },
    'admin',
  );
  org(
    'by an administrator, the counter kept out as it is',
    { counter_sells_reserved: false, legal_name: 'L' },
    'admin',
  );
  org(
    'by an administrator, the counter flag as a word',
    { counter_sells_reserved: 'sometimes' },
    'admin',
  );
  org(
    'by a superuser who is a cashier, the counter let in',
    { counter_sells_reserved: true },
    'super',
  );
  const counterOpen = after(`UPDATE accounts_organization SET counter_sells_reserved = true`);
  org(
    'by an administrator, the counter shut out again',
    { counter_sells_reserved: false },
    'admin',
    { prepare: counterOpen },
  );
  org(
    'by an administrator, the counter left in as it is',
    { counter_sells_reserved: true, name: 'R' },
    'admin',
    { prepare: counterOpen },
  );
  const settled = after(
    `UPDATE accounts_organization SET tax_settled_at = '2026-09-01 10:00:00+00', tax_settled_by_id = '${user(NOROLE)}'`,
  );
  org('once its VAT is settled, its name', { name: 'Rangon settled' }, 'owner', {
    prepare: settled,
  });
  // With the organisation switched off there is none to edit: the save makes one.
  org('with none to edit, a name', { name: 'Second Rangon' }, 'owner', { prepare: noOrganization });
  org('with none to edit, nothing', {}, 'owner', { prepare: noOrganization });
  org(
    'with none to edit, everything',
    {
      name: 'Second',
      legal_name: 'S Ltd',
      status: 'SUSPENDED',
      email: 'a@b.co',
      phone: '01711000333',
      address: 'A',
      vat_registration: 'V',
      currency: 'USD',
      receipt_footer: 'F',
      counter_sells_reserved: true,
    },
    'owner',
    { prepare: noOrganization },
  );
  org(
    'with none to edit, by an administrator, the counter let in',
    { counter_sells_reserved: true },
    'admin',
    { prepare: noOrganization },
  );
  org('with none to edit, something wrong', { email: 'x' }, 'owner', { prepare: noOrganization });
  org('with none to edit, and a blank one already made', { name: 'Third' }, 'owner', {
    prepare: after(
      `UPDATE accounts_organization SET status = 'INACTIVE'`,
      `INSERT INTO accounts_organization (id, created_at, updated_at, name, slug, legal_name, status,
         email, phone, address, vat_registration, currency, logo, receipt_footer, tax_mode,
         default_tax_rate, counter_sells_reserved)
       VALUES (gen_random_uuid(), now(), now(), 'Blank', '', '', 'INACTIVE', '', '', '', '', 'BDT',
               '', '', 'EXCLUSIVE', 0, false)`,
    ),
  });
  for (const [kind, body] of NOT_OBJECTS) org(`from ${kind}`, body);
  read('the organisation, with none switched on', ORGANIZATION, 'owner', {
    reset: resetTeam,
    prepare: noOrganization,
  });
  read('the organisation, as a customer, with none switched on', ORGANIZATION, 'customer', {
    reset: resetTeam,
    prepare: noOrganization,
  });
  read('the organisation, once its VAT is settled', ORGANIZATION, 'owner', {
    reset: resetTeam,
    prepare: settled,
  });
  read('the organisation: no trailing slash', ORGANIZATION.slice(0, -1));
  for (const method of ['POST', 'PUT', 'DELETE']) {
    write(`the organisation cannot take a ${method}`, method, ORGANIZATION, { name: 'x' });
    write(`the VAT treatment cannot take a ${method}`, method, TAX, {
      tax_mode: 'INCLUSIVE',
      default_tax_rate: '0',
    });
  }

  // === The VAT treatment =======================================================================
  const vat = (name: string, body: unknown, who: Who = 'owner', extra: Partial<Case> = {}) =>
    write(`the VAT treatment settled: ${name}`, 'PATCH', TAX, body, who, extra);
  const inclusive = { tax_mode: 'INCLUSIVE', default_tax_rate: '0.075' };
  for (const [what, body] of [
    ['a change, not confirmed', inclusive],
    ['a change, confirmed', { ...inclusive, confirm: true }],
    [
      'a change, confirmed, with a reason',
      { ...inclusive, confirm: true, reason: '  NBR circular  ' },
    ],
    ['a change, confirmed as false', { ...inclusive, confirm: false }],
    ['a change, confirmed as "true"', { ...inclusive, confirm: 'true' }],
    ['a change, confirmed as 1', { ...inclusive, confirm: 1 }],
    ['a change, confirmed as "yes"', { ...inclusive, confirm: 'yes' }],
    ['a change, confirmed as "maybe"', { ...inclusive, confirm: 'maybe' }],
    ['a change, confirmed as null', { ...inclusive, confirm: null }],
    [
      'the mode alone changed, confirmed',
      { tax_mode: 'INCLUSIVE', default_tax_rate: '0', confirm: true },
    ],
    ['the mode alone changed, not confirmed', { tax_mode: 'INCLUSIVE', default_tax_rate: '0' }],
    [
      'the rate alone changed, confirmed',
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '0.15', confirm: true },
    ],
    ['the rate alone changed, not confirmed', { tax_mode: 'EXCLUSIVE', default_tax_rate: '0.15' }],
    ['nothing changed', { tax_mode: 'EXCLUSIVE', default_tax_rate: '0' }],
    [
      'nothing changed, the rate written out',
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '0.0000' },
    ],
    ['nothing changed, the rate as a number', '{"tax_mode": "EXCLUSIVE", "default_tax_rate": 0.0}'],
    [
      'nothing changed, the rate as minus nothing',
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '-0' },
    ],
    [
      'nothing changed, with a reason',
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '0', reason: 'Checked with the accountant' },
    ],
    ['nothing changed, confirmed', { tax_mode: 'EXCLUSIVE', default_tax_rate: '0', confirm: true }],
    ['a rate of one', { tax_mode: 'EXCLUSIVE', default_tax_rate: '1', confirm: true }],
    ['a rate above one', { tax_mode: 'EXCLUSIVE', default_tax_rate: '1.0001', confirm: true }],
    ['a rate below zero', { tax_mode: 'EXCLUSIVE', default_tax_rate: '-0.0001', confirm: true }],
    ['a rate as a percentage', { tax_mode: 'EXCLUSIVE', default_tax_rate: '15', confirm: true }],
    [
      'a rate with five places',
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '0.07555', confirm: true },
    ],
    [
      'a rate in exponent form',
      { tax_mode: 'EXCLUSIVE', default_tax_rate: '7.5e-2', confirm: true },
    ],
    ['a rate as a number', '{"tax_mode": "EXCLUSIVE", "default_tax_rate": 0.075, "confirm": true}'],
    ['a rate in words', { tax_mode: 'EXCLUSIVE', default_tax_rate: 'fifteen', confirm: true }],
    ['a null rate', { tax_mode: 'EXCLUSIVE', default_tax_rate: null, confirm: true }],
    ['a blank rate', { tax_mode: 'EXCLUSIVE', default_tax_rate: '', confirm: true }],
    ['no rate', { tax_mode: 'INCLUSIVE', confirm: true }],
    ['no mode', { default_tax_rate: '0.075', confirm: true }],
    ['a mode that is none', { tax_mode: 'EXEMPT', default_tax_rate: '0', confirm: true }],
    ['a mode in small letters', { tax_mode: 'inclusive', default_tax_rate: '0', confirm: true }],
    ['a null mode', { tax_mode: null, default_tax_rate: '0' }],
    ['a blank reason', { ...inclusive, confirm: true, reason: '' }],
    ['a null reason', { ...inclusive, confirm: true, reason: null }],
    ['the longest reason', { ...inclusive, confirm: true, reason: long(500) }],
    ['a reason too long', { ...inclusive, confirm: true, reason: long(501) }],
    ['a reason that is a number', { ...inclusive, confirm: true, reason: 7 }],
    [
      'other keys',
      { ...inclusive, confirm: true, tax_settled_at: '2020-01-01T00:00:00Z', is_settled: false },
    ],
    [
      'several things wrong',
      { tax_mode: 'x', default_tax_rate: '1.5', confirm: 'maybe', reason: long(501) },
    ],
    ['nothing', {}],
  ] as [string, unknown][]) {
    vat(what, body);
  }
  vat('a change, by an administrator', { ...inclusive, confirm: true }, 'admin');
  vat('a change, by a superuser who is a cashier', { ...inclusive, confirm: true }, 'super');
  vat('settled once already, changed again', { ...inclusive, confirm: true }, 'owner', {
    prepare: settled,
  });
  vat(
    'settled once already, nothing changed',
    { tax_mode: 'EXCLUSIVE', default_tax_rate: '0' },
    'owner',
    { prepare: settled },
  );
  vat('with no organisation', { ...inclusive, confirm: true }, 'owner', {
    prepare: noOrganization,
  });
  vat('with no organisation, something wrong', { tax_mode: 'x' }, 'owner', {
    prepare: noOrganization,
  });
  for (const [kind, body] of NOT_OBJECTS) vat(`from ${kind}`, body);
  read('the VAT treatment, with no organisation', TAX, 'owner', {
    reset: resetTeam,
    prepare: noOrganization,
  });
  read('the VAT treatment, with no organisation, as a cashier', TAX, 'cashier', {
    reset: resetTeam,
    prepare: noOrganization,
  });
  read('the VAT treatment, once settled on the minute by someone with no name', TAX, 'owner', {
    reset: resetTeam,
    prepare: settled,
  });
  read('the VAT treatment, once settled to the microsecond by an owner', TAX, 'owner', {
    reset: resetTeam,
    prepare: after(
      `UPDATE accounts_organization SET tax_mode = 'INCLUSIVE', default_tax_rate = 0.0750,
              tax_settled_at = '2026-09-01 10:00:00.120000+00', tax_settled_by_id = '${user(OWNER)}'`,
    ),
  });
  read('the VAT treatment, settled by someone since deleted', TAX, 'owner', {
    reset: resetTeam,
    prepare: after(`UPDATE accounts_organization SET tax_settled_at = '2026-09-01 10:00:00+00'`),
  });
  read('the VAT treatment: no trailing slash', TAX.slice(0, -1));

  return cases;
}
