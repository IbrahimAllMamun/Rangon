/**
 * Parity harness: the same requests to the Django API and the NestJS API,
 * over the same database, and every difference between the answers.
 *
 *   docker compose -p rangon-nest -f docker-compose.nest.yml run --rm parity
 *
 * Runs on Node's own TypeScript support (type stripping), so it needs no
 * build. Exit status is non-zero when any difference is not a documented one.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:http';

import { Redis } from 'ioredis';
import pg from 'pg';

import { accountCases } from './accounts-cases.ts';
import { cartCases } from './cart-cases.ts';
import { catalogAdminCases } from './catalog-admin-cases.ts';
import { checkoutCases } from './checkout-cases.ts';
import { paymentCases } from './payment-cases.ts';
import { concurrencyChecks } from './concurrency.ts';
import { type Captured, compare, describeTokens, type Difference, diffJson } from './compare.ts';
import { KNOWN_DIFFERENCES } from './known-differences.ts';
import { orderCases } from './orders-cases.ts';

const DJANGO = new URL(process.env.DJANGO_BASE ?? 'http://django:8000');
const NEST = new URL(process.env.NEST_BASE ?? 'http://nest:3000');
const HOST = process.env.PARITY_HOST ?? 'localhost';
const SIGNING_KEY = process.env.JWT_SIGNING_KEY || process.env.DJANGO_SECRET_KEY || '';
const ONLY = process.env.PARITY_ONLY ?? '';
// PARITY_VERBOSE=1: print each case's status and side effects, to check a case tests what it says.
const VERBOSE = Boolean(process.env.PARITY_VERBOSE);

export type Side = 'django' | 'nest';

export interface Case {
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** Sent as is; give the Content-Type in `headers`. */
  body?: string;
  /** SQL run before the pair of requests, and undone by `teardown` after. */
  setup?: string[];
  teardown?: string[];
  /** Empty the shared Redis first: both APIs' page caches live there. */
  flushCache?: boolean;

  // --- Writes: each API gets the same starting state ----------------------
  /**
   * Put the rows this case changes back as they were: run before each API's
   * request and once after both. Its presence makes the case a write case,
   * whose side effects are undone after each request (see `undoWrites`).
   */
  reset?: (db: pg.Client) => Promise<void>;
  /** Per-API request details made fresh for each side: a newly minted token, say. */
  prepare?: (side: Side) => Promise<Partial<Pick<Case, 'headers' | 'body' | 'path'>>>;
  /**
   * Queries whose rows, read after each API's request, must match: what the
   * request wrote. `$1` is the instant just before the request.
   */
  effects?: string[];
  /** Adjust a parsed JSON body before comparing: blank out a value each API mints (a new id). */
  normalize?: (body: unknown) => void;
  /**
   * Compare the Celery jobs each API queued (task and arguments, ids read as
   * the order number or the variant they name), emptying the queue around it.
   */
  jobs?: boolean;
}

// Where both APIs queue Celery jobs. No worker takes them in this stack.
const broker = new Redis(process.env.CELERY_BROKER_URL ?? 'redis://redis:6379/1', {
  lazyConnect: true,
});

/** The jobs queued since the queue was emptied, oldest first, their ids made readable. */
async function queuedJobs(db: pg.Client): Promise<unknown[]> {
  const raw = await broker.lrange('celery', 0, -1);
  await broker.del('celery');
  const jobs: unknown[] = [];
  for (const entry of raw.reverse()) {
    const message = JSON.parse(entry) as { headers: { task: string }; body: string };
    const [args, kwargs] = JSON.parse(Buffer.from(message.body, 'base64').toString('utf8')) as [
      unknown[],
      unknown,
    ];
    const readable: unknown[] = [];
    for (const arg of args) {
      const order = await db.query<{ number: string }>(
        `SELECT number FROM orders_order WHERE id::text = $1`,
        [arg],
      );
      const stock = await db.query<{ sku: string }>(
        `SELECT v.sku FROM inventory_inventory i JOIN catalog_productvariant v ON v.id = i.variant_id WHERE i.id::text = $1`,
        [arg],
      );
      readable.push(
        order.rows[0]
          ? `order:${order.rows[0].number}`
          : stock.rows[0]
            ? `inventory:${stock.rows[0].sku}`
            : arg,
      );
    }
    jobs.push({ task: message.headers.task, args: readable, kwargs });
  }
  return jobs;
}

export function send(base: URL, testCase: Case): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const body = testCase.body === undefined ? undefined : Buffer.from(testCase.body, 'utf8');
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        method: testCase.method ?? 'GET',
        path: testCase.path,
        // One connection per request: Node's keep-alive agent would otherwise
        // hold the Nest API's sockets open and keep this process from exiting.
        agent: false,
        headers: {
          host: HOST,
          accept: 'application/json',
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...testCase.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            headers[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function json<T>(path: string): Promise<T> {
  const response = await send(DJANGO, { name: 'discover', path });
  if (response.status !== 200) throw new Error(`Discovery ${path} answered ${response.status}`);
  return JSON.parse(response.body) as T;
}

/** An access token SimpleJWT would have issued for this user. */
export function token(
  user: { id: string; password: string },
  claims: Record<string, unknown> = {},
  key = SIGNING_KEY,
): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    token_type: 'access',
    exp: now + 600,
    iat: now,
    jti: randomUUID().replaceAll('-', ''),
    user_id: user.id,
    hash_password: createHash('md5').update(user.password).digest('hex').toUpperCase(),
    ...claims,
  });
  const signature = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function buildCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const add = (name: string, path: string, extra: Partial<Case> = {}) =>
    cases.push({ name, path, ...extra });

  // --- Plumbing: routing, errors, headers --------------------------------
  add('health', '/api/health/');
  add('health: request id echoed', '/api/health/', {
    headers: { 'x-request-id': 'parity-abc123' },
  });
  add('health: long request id truncated', '/api/health/', {
    headers: { 'x-request-id': 'x'.repeat(100) },
  });
  add('unknown path', '/api/v1/nope/');
  add('unknown path, no slash', '/api/v1/nope');
  add('append slash', '/api/v1/shop/products');
  add('append slash keeps query', '/api/v1/shop/products?page_size=2&q=shirt');
  add('wrong method', '/api/v1/shop/categories/', { method: 'POST' });
  add('wrong method on detail', '/api/v1/shop/products/classic-oxford-shirt/', {
    method: 'DELETE',
  });
  // DRF authenticates before it refuses the method, and puts `Allow` on the 401.
  add('wrong method, bad token', '/api/v1/shop/categories/', {
    method: 'PUT',
    headers: { authorization: 'Bearer abc' },
  });
  // APPEND_SLASH runs before the resolver asks whether the view takes the method.
  add('append slash, a method with no handler', '/api/v1/shop/categories?x=1', { method: 'PUT' });
  add('append slash, a plain view', '/api/health', { method: 'POST' });
  // The health checks are plain Django views: `require_GET`, and CSRF-checked.
  const csrfChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const secret = 'parityCsrfSecret0123456789abcdef';
  const mask = 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe';
  const masked =
    mask +
    [...secret]
      .map(
        (char, i) =>
          csrfChars[(csrfChars.indexOf(char) + csrfChars.indexOf(mask[i] as string)) % 62],
      )
      .join('');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    add(`health: ${method}, no CSRF cookie`, '/api/health/', { method });
  }
  add('ready: OPTIONS', '/api/ready/', { method: 'OPTIONS' });
  add('health: an untrusted Origin', '/api/health/', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  add('health: a trusted Origin, no cookie', '/api/health/', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
  });
  add('health: its own origin', '/api/health/', {
    method: 'POST',
    headers: { origin: 'http://localhost', cookie: `csrftoken=${secret}`, 'x-csrftoken': secret },
  });
  add('health: cookie and header agree', '/api/health/', {
    method: 'POST',
    headers: { cookie: `a=b; csrftoken=${secret}`, 'x-csrftoken': secret },
  });
  add('health: a masked token for the cookie', '/api/health/', {
    method: 'DELETE',
    headers: { cookie: `csrftoken=${masked}`, 'x-csrftoken': masked },
  });
  add('health: cookie, no token', '/api/health/', {
    method: 'POST',
    headers: { cookie: `csrftoken=${secret}` },
  });
  add('health: a token that does not match', '/api/health/', {
    method: 'PUT',
    headers: { cookie: `csrftoken=${secret}`, 'x-csrftoken': 'x'.repeat(32) },
  });
  add('health: a malformed cookie', '/api/health/', {
    method: 'POST',
    headers: { cookie: 'csrftoken=short', 'x-csrftoken': 'short' },
  });
  add('health: the token in a form', '/api/health/', {
    method: 'POST',
    headers: {
      cookie: `csrftoken=${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `csrfmiddlewaretoken=${masked}`,
  });
  // No HEAD case: gunicorn writes a body on HEAD responses, which Node's HTTP
  // client rightly refuses to parse. HEAD is checked with curl instead.
  add('bad host', '/api/v1/shop/brands/', { headers: { host: 'bad host!' } });
  add('slug converter refuses', '/api/v1/shop/products/not%20a%20slug/');
  add('slug converter refuses (category)', '/api/v1/shop/categories/bad.slug/');

  // --- Authentication, which runs on public endpoints too -----------------
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const users = await db.query<{ id: string; password: string; is_active: boolean }>(
    `SELECT id, password, is_active FROM accounts_user ORDER BY email LIMIT 3`,
  );
  await db.end();
  const user = users.rows[0];
  if (user) {
    add('auth: valid token', '/api/v1/shop/categories/', {
      headers: { authorization: `Bearer ${token(user)}` },
    });
    add('auth: expired token', '/api/v1/shop/categories/', {
      headers: {
        authorization: `Bearer ${token(user, { exp: Math.floor(Date.now() / 1000) - 5 })}`,
      },
    });
    add('auth: wrong key', '/api/v1/shop/categories/', {
      headers: { authorization: `Bearer ${token(user, {}, 'not-the-key')}` },
    });
    add('auth: refresh token used as access', '/api/v1/shop/categories/', {
      headers: { authorization: `Bearer ${token(user, { token_type: 'refresh' })}` },
    });
    add('auth: password changed since issue', '/api/v1/shop/categories/', {
      headers: { authorization: `Bearer ${token(user, { hash_password: 'STALE' })}` },
    });
    add('auth: unknown user', '/api/v1/shop/categories/', {
      headers: { authorization: `Bearer ${token({ id: randomUUID(), password: '' })}` },
    });
    add('auth: no jti', '/api/v1/shop/categories/', {
      headers: { authorization: `Bearer ${token(user, { jti: undefined })}` },
    });
  }
  add('auth: garbage bearer', '/api/v1/shop/categories/', {
    headers: { authorization: 'Bearer abc' },
  });
  add('auth: other scheme ignored', '/api/v1/shop/categories/', {
    headers: { authorization: 'Token abc' },
  });
  add('auth: bearer alone', '/api/v1/shop/categories/', { headers: { authorization: 'Bearer' } });
  add('auth: three parts', '/api/v1/shop/categories/', {
    headers: { authorization: 'Bearer a b' },
  });
  add('auth: lower-case scheme ignored', '/api/v1/shop/categories/', {
    headers: { authorization: 'bearer abc' },
  });

  // --- Categories and brands ------------------------------------------------
  add('categories', '/api/v1/shop/categories/');
  const roots = await json<{ slug: string; children: { slug: string }[] }[]>(
    '/api/v1/shop/categories/',
  );
  for (const root of roots) {
    add(`category ${root.slug}`, `/api/v1/shop/categories/${root.slug}/`);
    for (const child of root.children)
      add(`category ${child.slug}`, `/api/v1/shop/categories/${child.slug}/`);
  }
  add('category: missing', '/api/v1/shop/categories/no-such-category/');
  // Deeper than the list shows, and one that is switched off.
  add('category: grandchild', '/api/v1/shop/categories/parity-leaf/');
  add('category: inactive', '/api/v1/shop/categories/parity-hidden/');
  add('brand: inactive', '/api/v1/shop/brands/parity-retired/');
  add('product: draft', '/api/v1/shop/products/parity-draft/');
  add('product: archived', '/api/v1/shop/products/parity-archived/');

  add('brands', '/api/v1/shop/brands/');
  for (const brand of await json<{ slug: string }[]>('/api/v1/shop/brands/')) {
    add(`brand ${brand.slug}`, `/api/v1/shop/brands/${brand.slug}/`);
  }
  add('brand: missing', '/api/v1/shop/brands/no-such-brand/');

  // --- Product listing: pagination --------------------------------------------
  const list = '/api/v1/shop/products/';
  add('products', list);
  for (const size of ['1', '5', '0', '-1', 'abc', '1000', ' 5', '5_0', '']) {
    add(
      `products page_size=${JSON.stringify(size)}`,
      `${list}?page_size=${encodeURIComponent(size)}`,
    );
  }
  for (const page of ['2', '3', 'last', '0', 'abc', '99', '', '2.0', ' 2']) {
    add(
      `products page=${JSON.stringify(page)}`,
      `${list}?page_size=5&page=${encodeURIComponent(page)}`,
    );
  }
  add('products repeated page_size (last wins)', `${list}?page_size=2&page_size=4`);
  add(
    'products next link re-sorts the query',
    `${list}?sort=newest&page_size=3&brand=rangon&brand=nokshi&q=`,
  );

  // --- Product listing: filters and sorting -----------------------------------
  for (const sort of [
    'relevance',
    'newest',
    'price_asc',
    'price_desc',
    'name_asc',
    'name_desc',
    'bogus',
    '',
    'constructor',
  ]) {
    add(`products sort=${sort}`, `${list}?sort=${sort}&page_size=100`);
  }
  for (const q of [
    'shirt',
    'cotton shirt',
    'Shirt',
    'RGN-CLA-L-WHI',
    'rgn-cla-l-whi',
    '2000000000503',
    '   ',
    'zzzz',
    'panjabi',
    '"embroidered panjabi"',
    '-cotton',
    'shi',
  ]) {
    add(`products q=${JSON.stringify(q)}`, `${list}?q=${encodeURIComponent(q)}&page_size=100`);
  }
  add('products q + sort', `${list}?q=shirt&sort=price_desc`);
  add('products q + bogus sort', `${list}?q=shirt&sort=bogus`);
  add('products exact sku ignores sort', `${list}?q=RGN-CLA-L-WHI&sort=price_desc`);
  for (const category of [
    'men',
    'women',
    'shirts',
    'no-such-category',
    'parity',
    'parity-leaf',
    'parity-hidden',
  ]) {
    add(`products category=${category}`, `${list}?category=${category}&page_size=100`);
  }
  add('products brand', `${list}?brand=rangon`);
  add('products two brands', `${list}?brand=rangon&brand=nokshi&page_size=100`);
  add('products empty brand', `${list}?brand=`);
  for (const [min, max] of [
    ['500', ''],
    ['', '1500'],
    ['1000.50', '3000'],
    ['abc', ''],
    ['NaN', ''],
    ['', 'inf'],
    ['-Infinity', ''],
    ['snan', ''],
    ['-nan', ''],
    ['1e3', ''],
    ['-5', '1_500'],
  ]) {
    add(`products price ${min}..${max}`, `${list}?page_size=100&price_min=${min}&price_max=${max}`);
  }
  add('products in_stock', `${list}?in_stock=true&page_size=100`);
  add('products in_stock=True is not true', `${list}?in_stock=True&page_size=100`);
  add('products attr size', `${list}?attr_size=M&page_size=100`);
  add('products attr colours', `${list}?attr_color=Black&attr_color=Navy&page_size=100`);
  add('products attr size+colour', `${list}?attr_size=M&attr_color=Black&page_size=100`);
  add(
    'products attr size+colour, price sort',
    `${list}?attr_size=M&attr_color=Black&sort=price_asc&page_size=100`,
  );
  add('products attr empty value', `${list}?attr_size=&page_size=100`);
  add('products attr unknown', `${list}?attr_nothing=x`);
  add(
    'products everything',
    `${list}?q=shirt&category=men&brand=rangon&attr_size=M&in_stock=true&price_min=100&sort=price_desc`,
  );
  add('products exact sku + filters', `${list}?q=RGN-CLA-L-WHI&brand=rangon&attr_size=L`);

  // --- Product detail -----------------------------------------------------------
  const products = await json<{ results: { slug: string }[] }>(`${list}?page_size=100`);
  for (const product of products.results) add(`product ${product.slug}`, `${list}${product.slug}/`);
  add('product: missing', `${list}no-such-product/`);

  // --- Facets and suggestions -------------------------------------------------------
  for (const query of [
    '',
    '?q=shirt',
    '?category=men',
    '?q=RGN-CLA-L-WHI',
    '?category=nope',
    '?q=zzzz',
    '?q=cotton&category=women',
    '?category=parity',
    '?q=tee',
  ]) {
    add(`facets ${query || '(all)'}`, `/api/v1/shop/facets/${query}`);
  }
  for (const q of [
    null,
    '',
    's',
    'sh',
    'shirt',
    'men',
    '%',
    '_',
    '  sh  ',
    'RANGON',
    'ক',
    'tee',
    '100%',
    'n_t',
    'parity',
  ]) {
    const path =
      q === null
        ? '/api/v1/shop/search/suggest/'
        : `/api/v1/shop/search/suggest/?q=${encodeURIComponent(q)}`;
    add(`suggest ${JSON.stringify(q)}`, path);
  }

  // --- Content: home, navigation, footer, pages ------------------------------
  add('home', '/api/v1/shop/home/');
  add('navigation', '/api/v1/shop/navigation/');
  // With every header override switched off, navigation falls back to the
  // category tree (ADR-0009 path 2) -- both paths checked in one run.
  add('navigation: category fallback', '/api/v1/shop/navigation/', {
    // Only the rows that were on come back on: fixture_staff.py keeps some off.
    setup: [
      `CREATE TEMP TABLE parity_header_on AS SELECT id FROM content_navigationitem
        WHERE placement = 'HEADER' AND is_active`,
      `UPDATE content_navigationitem SET is_active = false WHERE placement = 'HEADER'`,
    ],
    teardown: [
      `UPDATE content_navigationitem SET is_active = true WHERE id IN (SELECT id FROM parity_header_on)`,
      `DROP TABLE parity_header_on`,
    ],
  });
  add('site', '/api/v1/shop/site/');
  add('pages', '/api/v1/shop/pages/');
  for (const page of await json<{ slug: string }[]>('/api/v1/shop/pages/')) {
    add(`page ${page.slug}`, `/api/v1/shop/pages/${page.slug}/`);
  }
  add('page: unpublished', '/api/v1/shop/pages/parity-draft-page/');
  add('page: missing', '/api/v1/shop/pages/no-such-page/');
  add('page: slug converter refuses', '/api/v1/shop/pages/bad%24slug/');

  // --- Product feeds ------------------------------------------------------------
  // Cached for 15 minutes by both APIs, each under its own keys: flushed first,
  // so neither answers from a copy made before the data last changed.
  add('feed.xml', '/api/v1/shop/feed.xml', { flushCache: true });
  add('feed.csv', '/api/v1/shop/feed.csv', { flushCache: true });
  add('feed.xml: a trailing slash is another URL', '/api/v1/shop/feed.xml/');
  add('feed ignores a bad token', '/api/v1/shop/feed.csv', {
    flushCache: true,
    headers: { authorization: 'Bearer abc' },
  });

  // --- Accounts: sign-in, tokens, registration, password change -------------
  cases.push(...(await accountCases({ DJANGO, NEST, SIGNING_KEY })));

  // --- Orders, addresses, tracking and reviews -----------------------------------
  cases.push(...(await orderCases()));

  // --- The cart: lines, coupons, shipping options ----------------------------------
  cases.push(...(await cartCases()));

  // --- Checkout: stock reserved, money recorded, jobs queued ---------------------------
  cases.push(...(await checkoutCases({ DJANGO, NEST })));

  // --- A payment provider's webhook: capture, the cash book, replays ---------------------
  cases.push(...(await paymentCases()));

  // --- Staff: permissions, then the catalogue's admin --------------------------------------
  cases.push(...(await catalogAdminCases()));

  return ONLY ? cases.filter((c) => c.name.includes(ONLY)) : cases;
}

/**
 * One API's answer to a case -- for a write case, from the reset state, with
 * what it wrote read back and then undone, so the other API starts equal.
 */
async function run(
  db: pg.Client,
  base: URL,
  side: Side,
  testCase: Case,
): Promise<{ response: Captured; effects: unknown[][] }> {
  const writes = testCase.reset !== undefined;
  if (writes) await testCase.reset?.(db);
  const sent = { ...testCase, ...(await testCase.prepare?.(side)) };
  const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]?.now;
  if (testCase.jobs) await broker.del('celery');
  const response = normalizeBody(await send(base, sent), testCase);
  const effects: unknown[][] = [];
  for (const query of testCase.effects ?? []) {
    const parameters = query.includes('$1') ? [since] : [];
    effects.push((await db.query(query, parameters)).rows);
  }
  if (testCase.jobs) effects.push(await queuedJobs(db));
  if (writes) await undoWrites(db, since as string);
  return { response, effects };
}

/**
 * What any account request may have written since `since`: audit entries,
 * issued and blacklisted tokens. Test data in the parity database only --
 * the audit log is append-only everywhere else.
 */
async function undoWrites(db: pg.Client, since: string): Promise<void> {
  await db.query(`DELETE FROM token_blacklist_blacklistedtoken WHERE blacklisted_at >= $1`, [
    since,
  ]);
  await db.query(`DELETE FROM token_blacklist_outstandingtoken WHERE created_at >= $1`, [since]);
  // A token blacklisted without ever having been outstanding (one this
  // harness signed without recording) is recorded by `blacklist()` with no
  // creation time.
  await db.query(
    `DELETE FROM token_blacklist_outstandingtoken
      WHERE created_at IS NULL AND jti LIKE 'parity%'
        AND NOT EXISTS (SELECT 1 FROM token_blacklist_blacklistedtoken b WHERE b.token_id = token_blacklist_outstandingtoken.id)`,
  );
  await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
}

/** Tokens described rather than compared (each API mints its own), then the case's own adjustments. */
function normalizeBody(response: Captured, testCase: Case): Captured {
  if (!(response.headers['content-type'] ?? '').startsWith('application/json')) return response;
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return response;
  }
  body = describeTokens(body, SIGNING_KEY);
  // The cart token travels in a header too; compared with the body.
  if (response.headers['x-cart-token'] !== undefined && body && typeof body === 'object') {
    (body as Record<string, unknown>)['header:x-cart-token'] = response.headers['x-cart-token'];
  }
  testCase.normalize?.(body);
  return { ...response, body: JSON.stringify(body) };
}

function isKnown(testCase: Case, difference: Difference): string | null {
  for (const known of KNOWN_DIFFERENCES) {
    if (known.appliesTo(testCase, difference)) return known.reason;
  }
  return null;
}

async function main(): Promise<void> {
  const cases = await buildCases();
  let failed = 0;
  let known = 0;
  const knownReasons = new Map<string, number>();

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379/0');
  for (const testCase of cases) {
    if (testCase.flushCache) await redis.flushdb();
    for (const statement of testCase.setup ?? []) await db.query(statement);
    let differences: Difference[];
    try {
      const django = await run(db, DJANGO, 'django', testCase);
      const nest = await run(db, NEST, 'nest', testCase);
      differences = compare(django.response, nest.response, testCase.headers?.['x-request-id']);
      if (VERBOSE) {
        console.log(
          `CASE  ${testCase.name}: ${django.response.status} ${django.response.body.slice(0, 160)}`,
        );
        for (const rows of django.effects)
          console.log(`      ${JSON.stringify(rows).slice(0, 400)}`);
      }
      django.effects.forEach((rows, index) =>
        differences.push(...diffJson(rows, nest.effects[index], `effects[${index}]`)),
      );
    } finally {
      for (const statement of testCase.teardown ?? []) await db.query(statement);
      await testCase.reset?.(db);
    }
    const unexplained = differences.filter((difference) => {
      const reason = isKnown(testCase, difference);
      if (reason) knownReasons.set(reason, (knownReasons.get(reason) ?? 0) + 1);
      return !reason;
    });
    if (unexplained.length) {
      failed += 1;
      console.log(`DIFF  ${testCase.name}  [${testCase.method ?? 'GET'} ${testCase.path}]`);
      for (const difference of unexplained.slice(0, 12)) {
        console.log(
          `      ${difference.path}: django=${JSON.stringify(difference.django)} nest=${JSON.stringify(difference.nest)}`,
        );
      }
      if (unexplained.length > 12) console.log(`      ... and ${unexplained.length - 12} more`);
    } else if (differences.length) {
      known += 1;
    }
  }

  // Invariants that hold only under the right lock, driven concurrently.
  let racesFailed = 0;
  if (!ONLY || 'concurrency'.includes(ONLY)) {
    for (const check of await concurrencyChecks({ DJANGO, NEST, SIGNING_KEY })) {
      if (!check.passed) racesFailed += 1;
      console.log(`${check.passed ? 'RACE ' : 'FAIL '} ${check.name}: ${check.detail}`);
    }
  }

  console.log('');
  console.log(
    `${cases.length} cases: ${cases.length - failed} match (${known} only by documented differences), ${failed} differ`,
  );
  for (const [reason, count] of knownReasons) console.log(`  documented (${count}x): ${reason}`);
  process.exitCode = failed || racesFailed ? 1 : 0;
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => {
    broker.disconnect();
    process.exit();
  });
