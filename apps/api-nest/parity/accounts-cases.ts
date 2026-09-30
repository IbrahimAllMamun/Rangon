/**
 * Parity cases for `/api/v1/auth/`: sign-in, token refresh and sign-out,
 * `me`, registration and password change.
 *
 * These write, so each is a write case (`reset` in run.ts): both APIs start
 * from the same rows, and what each wrote -- audit entries, sign-in stamps,
 * password hashes, issued and blacklisted tokens, new accounts -- is read back
 * and compared, not just the response.
 *
 * Accounts come from fixture_accounts.py, whose test password is below.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

import pg from 'pg';

import { type Case, send, type Side, token } from './run.ts';

const PARITY_PASSWORD = 'Parity-Pass-2026!';
// `PBKDF2PasswordHasher().encode(PARITY_PASSWORD, "paritysaltparitysalt22", 1000)`.
const PBKDF2_HASH =
  'pbkdf2_sha256$1000$paritysaltparitysalt22$XrdDHsXFF+/NZ9xUr3hpVPzeZwyn2bLyDKliY0SgcNM=';
const NEW_EMAIL = 'parity.new@rangon.test';

const AUDIT = `SELECT action, entity_type, entity_id, entity_label, actor_id, actor_label,
  old_values, new_values, reason, host(ip_address) AS ip, user_agent, request_id
  FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action`;
const SIGN_INS = `SELECT email, last_login >= $1 AS signed_in, host(last_login_ip) AS ip
  FROM accounts_user WHERE email LIKE 'parity.%' ORDER BY email`;
// The hash's scheme and parameters, and its length: salt and digest differ by design.
const HASHES = `SELECT email, regexp_replace(password, '\\$[^$]*\\$[^$]*$', '') AS scheme,
  length(password) AS length FROM accounts_user WHERE email LIKE 'parity.%' ORDER BY email`;
const TOKENS = `SELECT
  (SELECT count(*) FROM token_blacklist_outstandingtoken WHERE created_at >= $1) AS issued,
  (SELECT count(*) FROM token_blacklist_outstandingtoken
    WHERE created_at >= $1 AND user_id IS NOT NULL
      AND expires_at - created_at BETWEEN interval '13 days 23 hours' AND interval '14 days') AS for_14_days,
  (SELECT count(*) FROM token_blacklist_blacklistedtoken WHERE blacklisted_at >= $1) AS blacklisted,
  (SELECT count(*) FROM token_blacklist_outstandingtoken WHERE created_at IS NULL) AS unrecorded`;
const REGISTERED = `SELECT u.email, u.first_name, u.last_name, u.phone, u.status, u.is_active,
  u.is_staff, u.is_superuser, u.last_login, r.code AS role, u.organization_id IS NOT NULL AS in_org,
  u.password LIKE 'argon2$argon2id$v=19$m=102400,t=2,p=8$%' AS argon2,
  c.name, c.phone AS customer_phone, c.email AS customer_email, c.customer_type, c.is_walk_in,
  c.is_active AS customer_active, c.tags, c.total_orders, c.total_spent, c.loyalty_points, c.notes
  FROM accounts_user u JOIN accounts_role r ON r.id = u.role_id
  LEFT JOIN customers_customer c ON c.user_id = u.id
  WHERE u.email = '${NEW_EMAIL}' OR c.email = 'parity.guest@rangon.test'
  ORDER BY u.email`;

interface Account {
  id: string;
  email: string;
  password: string;
}

export async function accountCases(apis: {
  DJANGO: URL;
  NEST: URL;
  SIGNING_KEY: string;
}): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const rows = await db.query<Account>(
    `SELECT id, email, password FROM accounts_user
      WHERE email LIKE 'parity.%' OR email = 'owner@rangon.test'`,
  );
  const accounts = new Map(rows.rows.map((row) => [row.email.split('@')[0] as string, row]));
  const customer = accounts.get('parity.customer');
  const staff = accounts.get('parity.staff');
  const inactive = accounts.get('parity.inactive');
  const owner = accounts.get('owner');
  if (!customer || !staff || !inactive || !owner) {
    await db.end();
    console.log('SKIP  accounts: fixture_accounts.py has not been applied');
    return [];
  }

  /** A refresh token SimpleJWT would issue, recorded as outstanding unless told not to. */
  const refreshToken = async (
    user: Account,
    claims: Record<string, unknown> = {},
    options: { record?: boolean; blacklist?: boolean } = {},
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      token_type: 'refresh',
      exp: now + 14 * 86400,
      iat: now,
      jti: `parity${randomBytes(13).toString('hex')}`,
      user_id: user.id,
      hash_password: createHash('md5').update(user.password).digest('hex').toUpperCase(),
      ...claims,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
    const signed = `${head}.${createHmac('sha256', apis.SIGNING_KEY).update(head).digest('base64url')}`;
    if (options.record ?? true) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO token_blacklist_outstandingtoken (user_id, jti, token, created_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 minute', to_timestamp($4)) RETURNING id`,
        [user.id, payload.jti, signed, payload.exp],
      );
      if (options.blacklist) {
        await db.query(
          `INSERT INTO token_blacklist_blacklistedtoken (token_id, blacklisted_at)
           VALUES ($1, now() - interval '1 minute')`,
          [inserted.rows[0]?.id],
        );
      }
    }
    return signed;
  };

  /** Sign in on one API, for a token the other must accept. */
  const signIn = async (base: URL, email: string): Promise<{ access: string; refresh: string }> => {
    const response = await send(base, {
      name: 'sign in',
      method: 'POST',
      path: '/api/v1/auth/login/',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PARITY_PASSWORD }),
    });
    if (response.status !== 200)
      throw new Error(`Sign-in on ${base.href} answered ${response.status}`);
    return JSON.parse(response.body) as { access: string; refresh: string };
  };
  const other = (side: Side) => (side === 'django' ? apis.NEST : apis.DJANGO);

  const reset = async (client: pg.Client) => {
    await client.query(
      `UPDATE accounts_user SET last_login = NULL, last_login_ip = NULL WHERE email LIKE 'parity.%'`,
    );
    await client.query(
      `UPDATE accounts_user SET password = $1 WHERE email = 'parity.pbkdf2@rangon.test'`,
      [PBKDF2_HASH],
    );
    await client.query(`UPDATE accounts_user SET password = $1 WHERE id = $2`, [
      customer.password,
      customer.id,
    ]);
    const created = `SELECT id FROM accounts_user WHERE email = '${NEW_EMAIL}'`;
    await client.query(`DELETE FROM token_blacklist_blacklistedtoken WHERE token_id IN
      (SELECT id FROM token_blacklist_outstandingtoken WHERE user_id IN (${created}))`);
    await client.query(
      `DELETE FROM token_blacklist_outstandingtoken WHERE user_id IN (${created})`,
    );
    await client.query(
      `DELETE FROM customers_customer WHERE user_id IN (${created}) AND phone IS DISTINCT FROM '8801711000099'`,
    );
    await client.query(
      `UPDATE customers_customer SET user_id = NULL, customer_type = 'GUEST' WHERE phone = '8801711000099'`,
    );
    await client.query(`DELETE FROM accounts_user WHERE email = '${NEW_EMAIL}'`);
  };

  const cases: Case[] = [];
  let sequence = 0;
  const post = (name: string, path: string, body: unknown, extra: Partial<Case> = {}) => {
    sequence += 1;
    cases.push({
      name,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'rangon-parity',
        'x-request-id': `parity-accounts-${sequence}`,
        ...extra.headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset,
      ...extra,
      ...(extra.headers
        ? { headers: { 'x-request-id': `parity-accounts-${sequence}`, ...extra.headers } }
        : {}),
    });
  };
  const bearer = (user: Account) => ({
    authorization: `Bearer ${token(user)}`,
    'content-type': 'application/json',
    'user-agent': 'rangon-parity',
  });

  // --- Sign-in -----------------------------------------------------------------
  const login = '/api/v1/auth/login/';
  const signInEffects = { effects: [AUDIT, SIGN_INS, TOKENS] };
  post(
    'login: staff, email spaced and capitalised',
    login,
    { email: ' Parity.Staff@rangon.test ', password: PARITY_PASSWORD },
    signInEffects,
  );
  post(
    'login: customer',
    login,
    { email: 'parity.customer@rangon.test', password: PARITY_PASSWORD },
    signInEffects,
  );
  post(
    'login: owner, wrong password',
    login,
    { email: 'owner@rangon.test', password: 'wrong' },
    signInEffects,
  );
  post(
    'login: wrong password',
    login,
    { email: 'parity.customer@rangon.test', password: 'Parity-Pass-2026' },
    signInEffects,
  );
  post(
    'login: password is not trimmed',
    login,
    { email: 'parity.customer@rangon.test', password: ` ${PARITY_PASSWORD}` },
    signInEffects,
  );
  post(
    'login: unknown email',
    login,
    { email: 'nobody@rangon.test', password: PARITY_PASSWORD },
    signInEffects,
  );
  post(
    'login: deactivated',
    login,
    { email: 'parity.inactive@rangon.test', password: PARITY_PASSWORD },
    signInEffects,
  );
  post(
    'login: PBKDF2 hash upgraded to Argon2',
    login,
    { email: 'parity.pbkdf2@rangon.test', password: PARITY_PASSWORD },
    { effects: [AUDIT, SIGN_INS, TOKENS, HASHES] },
  );
  post(
    'login: PBKDF2, wrong password, not upgraded',
    login,
    { email: 'parity.pbkdf2@rangon.test', password: 'nope' },
    { effects: [AUDIT, HASHES] },
  );
  post(
    'login: not an email',
    login,
    { email: 'parity.customer', password: PARITY_PASSWORD },
    signInEffects,
  );
  post('login: empty object', login, {}, signInEffects);
  post('login: email a number', login, { email: 5, password: PARITY_PASSWORD }, signInEffects);
  post(
    'login: email a float',
    login,
    { email: 4.0, password: PARITY_PASSWORD },
    { effects: [AUDIT], body: '{"email": 4.0, "password": "x"}' },
  );
  post('login: email a list', login, { email: ["a'b", 'c'], password: 'x' }, signInEffects);
  post('login: email null', login, { email: null, password: 'x' }, signInEffects);
  post(
    'login: password a number',
    login,
    { email: 'parity.customer@rangon.test', password: 12345 },
    signInEffects,
  );
  post('login: body a list', login, [1], { effects: [AUDIT] });
  post('login: body null', login, 'null', { effects: [AUDIT] });
  post('login: no body', login, '', { effects: [AUDIT] });
  post('login: malformed JSON', login, '{"email": ', { effects: [AUDIT] });
  post('login: text/plain', login, 'email=x', {
    headers: { 'content-type': 'text/plain' },
    effects: [AUDIT],
  });
  post('login: no content type', login, '{}', {
    headers: { 'user-agent': 'rangon-parity' },
    effects: [AUDIT],
  });
  post('login: GET', login, '', { method: 'GET' });

  // --- Refresh -------------------------------------------------------------------
  const refresh = '/api/v1/auth/refresh/';
  const rotation = { effects: [TOKENS] };
  const withRefresh = (make: () => Promise<string>, extra: Partial<Case> = {}): Partial<Case> => ({
    ...rotation,
    ...extra,
    prepare: async () => ({ body: JSON.stringify({ refresh: await make() }) }),
  });
  post(
    'refresh: rotates',
    refresh,
    {},
    withRefresh(() => refreshToken(customer)),
  );
  post(
    'refresh: token never recorded as outstanding',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, {}, { record: false })),
  );
  post(
    'refresh: token without a password claim is honoured',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, { hash_password: undefined })),
  );
  post(
    'refresh: blacklisted',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, {}, { blacklist: true })),
  );
  post(
    'refresh: password changed since',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, { hash_password: 'STALE' })),
  );
  post(
    'refresh: deactivated account',
    refresh,
    {},
    withRefresh(() => refreshToken(inactive)),
  );
  post(
    'refresh: expired',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, { exp: Math.floor(Date.now() / 1000) - 5 })),
  );
  post(
    'refresh: an access token',
    refresh,
    {},
    withRefresh(async () => token(customer)),
  );
  post(
    'refresh: unknown user',
    refresh,
    {},
    withRefresh(() =>
      refreshToken(
        { ...customer, id: '00000000-0000-4000-8000-000000000000' },
        {},
        { record: false },
      ),
    ),
  );
  post(
    'refresh: user id not a UUID',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, { user_id: 'not-a-uuid' }, { record: false })),
  );
  post(
    'refresh: user id an integer',
    refresh,
    {},
    withRefresh(() => refreshToken(customer, { user_id: 7 }, { record: false })),
  );
  post('refresh: garbage', refresh, { refresh: 'abc' }, rotation);
  post('refresh: a number', refresh, { refresh: 5 }, rotation);
  for (const [label, value] of [
    ['missing', {}],
    ['blank', { refresh: '' }],
    ['zero', { refresh: 0 }],
    ['empty list', { refresh: [] }],
  ] as const) {
    post(`refresh: ${label}`, refresh, value, rotation);
  }
  post('refresh: body a list', refresh, [1]);
  post(
    'refresh: a bad access token is refused first',
    refresh,
    { refresh: 'abc' },
    { headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } },
  );

  // --- Sign-out ----------------------------------------------------------------
  const logout = '/api/v1/auth/logout/';
  const signOut = { effects: [AUDIT, TOKENS] };
  post(
    'logout: ends the session',
    logout,
    {},
    {
      ...signOut,
      prepare: async () => ({ body: JSON.stringify({ refresh: await refreshToken(customer) }) }),
    },
  );
  post(
    'logout: already signed out',
    logout,
    {},
    {
      ...signOut,
      prepare: async () => ({
        body: JSON.stringify({ refresh: await refreshToken(customer, {}, { blacklist: true }) }),
      }),
    },
  );
  post(
    'logout: user id not a UUID',
    logout,
    {},
    {
      ...signOut,
      prepare: async () => ({
        body: JSON.stringify({
          refresh: await refreshToken(customer, { user_id: 'x' }, { record: false }),
        }),
      }),
    },
  );
  post('logout: garbage', logout, { refresh: 'abc' }, signOut);
  post('logout: nothing to end', logout, {}, signOut);
  post('logout: no body', logout, '', signOut);
  post(
    'logout: a bad access token is not read',
    logout,
    { refresh: 'abc' },
    { ...signOut, headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } },
  );
  post('logout: body a list', logout, [1]);

  // --- me --------------------------------------------------------------------------
  const me = '/api/v1/auth/me/';
  cases.push(
    { name: 'me: customer', path: me, headers: { authorization: `Bearer ${token(customer)}` } },
    {
      name: 'me: staff with a branch',
      path: me,
      headers: { authorization: `Bearer ${token(staff)}` },
    },
    { name: 'me: owner', path: me, headers: { authorization: `Bearer ${token(owner)}` } },
    { name: 'me: anonymous', path: me },
    {
      name: 'me: POST',
      path: me,
      method: 'POST',
      headers: { authorization: `Bearer ${token(customer)}` },
    },
  );

  // --- Tokens work across the two APIs -------------------------------------------
  cases.push({
    name: 'tokens: an access token from the other API',
    path: me,
    prepare: async (side) => ({
      headers: {
        authorization: `Bearer ${(await signIn(other(side), 'parity.customer@rangon.test')).access}`,
      },
    }),
    reset,
  });
  post(
    'tokens: a refresh token from the other API',
    refresh,
    {},
    {
      effects: [TOKENS],
      prepare: async (side) => ({
        body: JSON.stringify({
          refresh: (await signIn(other(side), 'parity.customer@rangon.test')).refresh,
        }),
      }),
    },
  );

  // --- Registration --------------------------------------------------------------------
  const register = '/api/v1/auth/register/';
  const created = {
    effects: [REGISTERED, TOKENS, AUDIT],
    // A new account's id is each API's own.
    normalize: (body: unknown) => {
      const user = (body as { user?: { id?: unknown } } | null)?.user;
      if (user && typeof user.id === 'string') user.id = '<new account>';
      for (const key of ['access', 'refresh']) {
        const described = (body as Record<string, { jwt?: { user_id?: unknown } }> | null)?.[key]
          ?.jwt;
        if (described) described.user_id = '<new account>';
      }
    },
  };
  post(
    'register: new customer',
    register,
    {
      email: ` ${NEW_EMAIL.toUpperCase()}`,
      password: 'Kantha-Stitch-77',
      first_name: 'Nabila',
      last_name: 'Rahman',
      phone: '+880 1811-000001',
    },
    created,
  );
  post(
    'register: no names, no phone',
    register,
    { email: NEW_EMAIL, password: 'Kantha-Stitch-77' },
    created,
  );
  post(
    'register: phone of a guest customer links it',
    register,
    { email: NEW_EMAIL, password: 'Kantha-Stitch-77', first_name: 'Guest', phone: '01711000099' },
    created,
  );
  post(
    "register: a guest customer's email, no phone: 409",
    register,
    { email: 'parity.guest@rangon.test', password: 'Kantha-Stitch-77' },
    created,
  );
  post(
    'register: every field wrong',
    register,
    { email: 'bad', password: 'short', first_name: 'x'.repeat(81), last_name: null, phone: '123' },
    created,
  );
  post(
    'register: taken, any case; common and numeric',
    register,
    { email: 'PARITY.TAKEN@rangon.test', password: '1234567890' },
    created,
  );
  post(
    'register: password too common',
    register,
    { email: NEW_EMAIL, password: 'password123' },
    created,
  );
  post(
    'register: password with a null character',
    register,
    { email: NEW_EMAIL, password: 'Kantha-\u0000-Stitch' },
    created,
  );
  post(
    'register: names too long for the customer row',
    register,
    {
      email: NEW_EMAIL,
      password: 'Kantha-Stitch-77',
      first_name: 'A'.repeat(80),
      last_name: 'B'.repeat(80),
    },
    created,
  );
  post(
    'register: blank phone',
    register,
    { email: NEW_EMAIL, password: 'Kantha-Stitch-77', phone: '  ' },
    created,
  );
  post('register: body a list', register, [1], created);
  post('register: body null', register, 'null', created);
  post('register: text/plain', register, 'x', {
    ...created,
    headers: { 'content-type': 'text/plain' },
  });

  // --- Password change ---------------------------------------------------------------------
  const change = '/api/v1/auth/password/change/';
  // `PasswordChangeView` names its own throttle, which the parity settings
  // leave on: ten a minute per account, on both APIs. Each case starts both
  // buckets empty.
  const changed = { effects: [AUDIT, TOKENS, HASHES], flushCache: true };
  const asCustomer = { headers: bearer(customer) };
  post(
    'password change: anonymous',
    change,
    { current_password: PARITY_PASSWORD, new_password: 'Kantha-Stitch-77' },
    changed,
  );
  post(
    'password change: staff may too',
    change,
    { current_password: 'wrong', new_password: 'Kantha-Stitch-77' },
    { ...changed, headers: bearer(staff) },
  );
  post(
    'password change: success ends every session',
    change,
    { current_password: PARITY_PASSWORD, new_password: 'Kantha-Stitch-77' },
    { ...changed, ...asCustomer },
  );
  post(
    'password change: wrong current password',
    change,
    { current_password: 'Parity-Pass-2025!', new_password: 'Kantha-Stitch-77' },
    { ...changed, ...asCustomer },
  );
  post(
    'password change: current password not a string',
    change,
    { current_password: ['x'], new_password: 'Kantha-Stitch-77' },
    { ...changed, ...asCustomer },
  );
  post(
    'password change: blank current password',
    change,
    { current_password: ' ', new_password: 'Kantha-Stitch-77' },
    { ...changed, ...asCustomer },
  );
  post(
    'password change: new too short',
    change,
    { current_password: PARITY_PASSWORD, new_password: 'short' },
    { ...changed, ...asCustomer },
  );
  post(
    'password change: new like the last name',
    change,
    { current_password: PARITY_PASSWORD, new_password: 'Sultana2026' },
    { ...changed, ...asCustomer },
  );
  post(
    'password change: new the same as current',
    change,
    { current_password: PARITY_PASSWORD, new_password: PARITY_PASSWORD },
    { ...changed, ...asCustomer },
  );
  post('password change: nothing sent', change, {}, { ...changed, ...asCustomer });
  post('password change: body null', change, 'null', { ...changed, ...asCustomer });

  return cases;
}
