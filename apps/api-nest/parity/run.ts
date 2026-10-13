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
import { auditCases } from './audit-cases.ts';
import { cartCases } from './cart-cases.ts';
import { attributeCases } from './attribute-cases.ts';
import { catalogAdminCases } from './catalog-admin-cases.ts';
import { checkoutCases } from './checkout-cases.ts';
import { paymentCases } from './payment-cases.ts';
import { adminConcurrencyChecks } from './admin-concurrency.ts';
import { inventoryConcurrencyChecks } from './inventory-concurrency.ts';
import { djangoOnlyCases } from './django-only-cases.ts';
import { jobsCases } from './jobs-cases.ts';
import { mediaCases } from './media-cases.ts';
import { jobsConcurrencyChecks } from './jobs-concurrency.ts';
import { contentConcurrencyChecks } from './content-concurrency.ts';
import { merchandisingConcurrencyChecks } from './merchandising-concurrency.ts';
import { posConcurrencyChecks } from './pos-concurrency.ts';
import { posSaleConcurrencyChecks } from './pos-sale-concurrency.ts';
import { concurrencyChecks } from './concurrency.ts';
import { BUCKET_MODE, fileNames, storedObjects } from './bucket.ts';
import { type Captured, compare, describeTokens, type Difference, diffJson } from './compare.ts';
import { KNOWN_DIFFERENCES } from './known-differences.ts';
import { notificationsCases } from './notifications-cases.ts';
import { notificationsConcurrencyChecks } from './notifications-concurrency.ts';
import { orderCases } from './orders-cases.ts';
import { productCases } from './product-cases.ts';
import { variantCases } from './variant-cases.ts';
import { imageCases } from './image-cases.ts';
import { inventoryCases } from './inventory-cases.ts';
import { stockDocumentCases } from './stock-document-cases.ts';
import { importCases } from './import-cases.ts';
import { contentAdminCases } from './content-admin-cases.ts';
import { couponsCases } from './coupons-cases.ts';
import { couponsConcurrencyChecks } from './coupons-concurrency.ts';
import { shippingCases } from './shipping-cases.ts';
import { shippingConcurrencyChecks } from './shipping-concurrency.ts';
import { reviewsCases } from './reviews-cases.ts';
import { reviewsConcurrencyChecks } from './reviews-concurrency.ts';
import { teamCases } from './team-cases.ts';
import { teamConcurrencyChecks } from './team-concurrency.ts';
import { customersCases } from './customers-cases.ts';
import { customersConcurrencyChecks } from './customers-concurrency.ts';
import { merchandisingCases } from './merchandising-cases.ts';
import { posCases } from './pos-cases.ts';
import { posQuoteCases } from './pos-quote-cases.ts';
import { posSaleCases } from './pos-sale-cases.ts';
import { posVoidCases } from './pos-void-cases.ts';
import { reportsCases } from './reports-cases.ts';
import { returnsCases } from './returns-cases.ts';
import { returnsConcurrencyChecks } from './returns-concurrency.ts';
import { expensesCases } from './expenses-cases.ts';
import { purchaseOrderCases } from './purchase-order-cases.ts';
import { purchaseOrderConcurrencyChecks } from './purchase-order-concurrency.ts';
import { purchasingCases } from './purchasing-cases.ts';
import {
  kept,
  mergedTies,
  type Moment,
  Names,
  Pace,
  parityMode,
  plain,
  beginWhereRecorded,
  readRecording,
  readTies,
  Recorder,
  settled,
  type Tied,
  tiesBetween,
} from './recording.ts';
import { supplierPaymentCases } from './supplier-payment-cases.ts';
import { sweepConcurrencyChecks } from './sweep-concurrency.ts';
import { supplierPaymentConcurrencyChecks } from './supplier-payment-concurrency.ts';
import { purchasingConcurrencyChecks } from './purchasing-concurrency.ts';
import { expensesConcurrencyChecks } from './expenses-concurrency.ts';
import { financeCases } from './finance-cases.ts';
import { financeConcurrencyChecks } from './finance-concurrency.ts';
import { labelsCases, labelsConcurrencyChecks } from './labels-cases.ts';
import { staffOrdersCases } from './staff-orders-cases.ts';
import { staffOrdersConcurrencyChecks } from './staff-orders-concurrency.ts';

const DJANGO = new URL(process.env.DJANGO_BASE ?? 'http://django:8000');
const NEST = new URL(process.env.NEST_BASE ?? 'http://nest:3000');
const HOST = process.env.PARITY_HOST ?? 'localhost';
const SIGNING_KEY = process.env.JWT_SIGNING_KEY || process.env.DJANGO_SECRET_KEY || '';
const ONLY = process.env.PARITY_ONLY ?? '';
/** With `PARITY_ONLY=concurrency`: only the race groups whose name contains this. */
const RACES = process.env.PARITY_RACES ?? '';
// PARITY_VERBOSE=1: print each case's status and side effects, to check a case tests what it says.
const VERBOSE = Boolean(process.env.PARITY_VERBOSE);

export type Side = 'django' | 'nest';

export interface Case {
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** Sent as is (a string as UTF-8); give the Content-Type in `headers`. */
  body?: string | Buffer;
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
  /** Adjust the `Location` header the same way: a stored file's random suffix. */
  normalizeLocation?: (location: string) => string;
  /**
   * Compare what each API's request sent to the parity sink (sink.ts): mail,
   * decoded to what a reader sees, and storefront revalidations. `refuse`
   * has the sink turn mail or revalidations away for this case.
   */
  sink?: boolean | { mail?: 'refuse'; revalidate?: 'refuse' };
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

/**
 * `PARITY_NEST_JOBS=pgboss`: the Nest side queues its jobs in PostgreSQL
 * (ADR-0016), so they are read from `pgboss.job`. A transaction's jobs share
 * one timestamp there, so in this mode both sides' jobs are compared sorted.
 */
const NEST_JOBS_IN_PGBOSS = process.env.PARITY_NEST_JOBS === 'pgboss';

async function emptyJobs(db: pg.Client): Promise<void> {
  await broker.del('celery');
  if (NEST_JOBS_IN_PGBOSS) await db.query(`DELETE FROM pgboss.job`);
}

/** What one side queued, as Celery's `(task, args, kwargs)`. */
async function rawJobs(db: pg.Client, side: Side): Promise<[string, unknown[], unknown][]> {
  if (NEST_JOBS_IN_PGBOSS && side === 'nest') {
    const rows = await db.query<{ name: string; data: { args: unknown[] } }>(
      `SELECT name, data FROM pgboss.job WHERE state = 'created' ORDER BY created_on, id`,
    );
    await db.query(`DELETE FROM pgboss.job`);
    return rows.rows.map((row) => [row.name, row.data.args, {}]);
  }
  const raw = await broker.lrange('celery', 0, -1);
  await broker.del('celery');
  return raw.reverse().map((entry) => {
    const message = JSON.parse(entry) as { headers: { task: string }; body: string };
    const [args, kwargs] = JSON.parse(Buffer.from(message.body, 'base64').toString('utf8')) as [
      unknown[],
      unknown,
    ];
    return [message.headers.task, args, kwargs];
  });
}

const SINK = process.env.PARITY_SINK ?? 'http://sink:8025';

/** Everything the sink has kept since it was last asked, which it then forgets. */
async function sinkTake(): Promise<unknown> {
  return (await fetch(`${SINK}/take`)).json();
}

async function sinkMode(mode: { mail?: string; revalidate?: string }): Promise<void> {
  await fetch(`${SINK}/mode`, { method: 'POST', body: JSON.stringify(mode) });
}

/** The jobs queued since the queue was emptied, oldest first, their ids made readable. */
async function queuedJobs(db: pg.Client, side: Side): Promise<unknown[]> {
  const jobs: unknown[] = [];
  for (const [task, args, kwargs] of await rawJobs(db, side)) {
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
      // A notice's id is minted by whichever API wrote it: read as who it is for.
      const notice = await db.query<{ email: string | null; title: string }>(
        `SELECT u.email, n.title FROM notifications_notification n
           LEFT JOIN accounts_user u ON u.id = n.user_id WHERE n.id::text = $1`,
        [arg],
      );
      readable.push(
        order.rows[0]
          ? `order:${order.rows[0].number}`
          : stock.rows[0]
            ? `inventory:${stock.rows[0].sku}`
            : notice.rows[0]
              ? `notice:${notice.rows[0].email ?? ''}:${notice.rows[0].title}`
              : arg,
      );
    }
    jobs.push({ task, args: readable, kwargs });
  }
  if (NEST_JOBS_IN_PGBOSS) {
    return jobs
      .map((job) => JSON.stringify(job))
      .sort()
      .map((job) => JSON.parse(job) as unknown);
  }
  return jobs;
}

export function send(base: URL, testCase: Case): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const body =
      testCase.body === undefined
        ? undefined
        : Buffer.isBuffer(testCase.body)
          ? testCase.body
          : Buffer.from(testCase.body, 'utf8');
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

  // --- Content negotiation: settled before a DRF view authenticates -------------
  const brands = '/api/v1/shop/brands/';
  for (const format of ['json', '', 'xml', 'JSON', 'csv', '%20json', 'json%20', 'j%00']) {
    add(`negotiation: format=${format}`, `${brands}?format=${format}`);
  }
  add('negotiation: format twice, the last one known', `${brands}?format=xml&format=json`);
  add('negotiation: format twice, the last one not', `${brands}?format=json&format=xml`);
  add('negotiation: an unknown format and a bad token', `${brands}?format=xml`, {
    headers: { authorization: 'Bearer abc' },
  });
  add('negotiation: an unknown format and a method with no handler', `${brands}?format=xml`, {
    method: 'POST',
  });
  add(
    'negotiation: an unknown format on a staff view, nobody signed in',
    '/api/v1/brands/?format=xml',
  );
  add(
    'negotiation: an unknown format on a staff view, no such method',
    '/api/v1/brands/?format=xml',
    {
      method: 'PUT',
    },
  );
  add('negotiation: an unknown format at sign-out', '/api/v1/auth/logout/?format=xml', {
    method: 'POST',
  });
  add('negotiation: an unknown format at sign-in', '/api/v1/auth/login/?format=xml', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  add(
    'negotiation: an unknown format at a webhook',
    '/api/v1/shop/payments/paritypay/webhook/?format=xml',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  add('negotiation: the feed is no csv renderer', '/api/v1/shop/feed.csv?format=csv', {
    flushCache: true,
  });
  add('negotiation: the feed as json', '/api/v1/shop/feed.csv?format=json', { flushCache: true });
  add('negotiation: a plain view takes any format', '/api/health/?format=xml');
  add('negotiation: no slash, an unknown format', '/api/v1/shop/brands?format=xml');
  add('negotiation: no such path, an unknown format', '/api/v1/nope/?format=xml');
  // The converter refuses the path in Django before any view negotiates.
  add(
    'negotiation: a path no converter takes, and an unknown format',
    '/api/v1/shop/products/not%20a%20slug/?format=xml',
  );
  for (const accept of [
    'application/json',
    'APPLICATION/JSON',
    '*/*',
    'application/*',
    '*/json',
    'application/json;q=0',
    'application/json; indent=4',
    'application/json; charset=utf-8',
    'image/png, application/json',
    'image/png, */*;q=0.1',
    'image/png',
    'application/xml',
    'application/xml, text/csv',
    'json',
    'application',
    '',
    ',',
  ]) {
    add(`negotiation: Accept ${JSON.stringify(accept)}`, `${brands}?page_size=1`, {
      headers: { accept },
    });
  }
  add('negotiation: nothing acceptable and a bad token', brands, {
    headers: { accept: 'image/png', authorization: 'Bearer abc' },
  });
  add('negotiation: nothing acceptable and a method with no handler', brands, {
    method: 'POST',
    headers: { accept: 'image/png' },
  });
  add('negotiation: nothing acceptable, a known format', `${brands}?format=json`, {
    headers: { accept: 'image/png' },
  });
  add('negotiation: nothing acceptable, an unknown format', `${brands}?format=xml`, {
    headers: { accept: 'image/png' },
  });
  add('negotiation: nothing acceptable on a staff view', '/api/v1/brands/', {
    headers: { accept: 'image/png' },
  });
  add('negotiation: nothing acceptable at sign-out', '/api/v1/auth/logout/', {
    method: 'POST',
    headers: { accept: 'image/png' },
  });
  // The feed is a DRF view with JSON's renderer alone: asked for XML by name, it refuses.
  add('negotiation: the XML feed asked for as XML', '/api/v1/shop/feed.xml', {
    flushCache: true,
    headers: { accept: 'application/xml' },
  });
  add('negotiation: the CSV feed asked for as CSV', '/api/v1/shop/feed.csv', {
    flushCache: true,
    headers: { accept: 'text/csv' },
  });
  add('negotiation: the XML feed asked for as anything', '/api/v1/shop/feed.xml', {
    flushCache: true,
    headers: { accept: 'application/xml, */*;q=0.5' },
  });
  add('negotiation: a plain view accepts anything', '/api/health/', {
    headers: { accept: 'image/png' },
  });

  // An empty Content-Type: nothing to parse with no body, no parser for one with.
  add('an empty Content-Type and no body', '/api/v1/auth/logout/', {
    method: 'POST',
    headers: { 'content-type': '' },
  });
  add('an empty Content-Type and a body', '/api/v1/auth/logout/', {
    method: 'POST',
    headers: { 'content-type': '' },
    body: '{"refresh": "abc"}',
  });

  // --- A method the view does not serve: its checks run before the 405 ----------
  // DRF authenticates, checks the view's permissions and throttles in
  // `initial()`, and only then looks for the method's handler.
  for (const [method, path] of [
    ['POST', '/api/v1/auth/me/'],
    ['GET', '/api/v1/auth/password/change/'],
    ['PUT', '/api/v1/shop/account/orders/'],
    ['PUT', '/api/v1/shop/account/addresses/'],
    ['DELETE', '/api/v1/organization/'],
    ['POST', '/api/v1/organization/tax/'],
    // Public views: nothing to refuse before the method.
    ['PUT', '/api/v1/shop/cart/'],
    ['GET', '/api/v1/shop/checkout/'],
    ['GET', '/api/v1/auth/login/'],
    ['GET', '/api/v1/auth/logout/'],
    ['GET', '/api/v1/shop/payments/paritypay/webhook/'],
    ['POST', '/api/v1/shop/feed.xml'],
  ] as const) {
    add(`no such method: ${method} ${path}, nobody signed in`, path, { method });
    // A view with no authentication classes never reads the token.
    add(`no such method: ${method} ${path}, a bad token`, path, {
      method,
      headers: { authorization: 'Bearer abc' },
    });
    if (user) {
      // Staff, where the view is a customer's: refused before the method is.
      add(`no such method: ${method} ${path}, staff signed in`, path, {
        method,
        headers: { authorization: `Bearer ${token(user)}` },
      });
    }
  }

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
  cases.push(...(await attributeCases()));
  cases.push(...(await productCases()));
  cases.push(...(await variantCases()));
  cases.push(...(await imageCases()));
  cases.push(...(await inventoryCases()));
  cases.push(...(await stockDocumentCases()));
  cases.push(...(await importCases()));
  cases.push(...(await contentAdminCases()));
  cases.push(...(await merchandisingCases()));
  cases.push(...(await posCases()));
  cases.push(...(await posQuoteCases({ DJANGO, NEST })));
  cases.push(...(await posSaleCases()));
  cases.push(...(await posVoidCases()));
  cases.push(...(await returnsCases()));
  cases.push(...(await staffOrdersCases()));
  cases.push(...(await labelsCases()));
  cases.push(...(await financeCases()));
  cases.push(...(await expensesCases()));
  cases.push(...(await purchasingCases()));
  cases.push(...(await purchaseOrderCases()));
  cases.push(...(await supplierPaymentCases()));
  cases.push(...(await customersCases()));
  cases.push(...(await couponsCases()));
  cases.push(...(await shippingCases()));
  cases.push(...(await reviewsCases()));
  cases.push(...(await teamCases()));
  cases.push(...(await auditCases()));
  cases.push(...(await notificationsCases()));
  cases.push(...(await reportsCases()));
  cases.push(...(await jobsCases()));
  cases.push(...mediaCases());
  cases.push(...djangoOnlyCases());

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
): Promise<{ response: Captured; effects: unknown[][]; at: string }> {
  const writes = testCase.reset !== undefined;
  if (writes) await testCase.reset?.(db);
  const sent = { ...testCase, ...(await testCase.prepare?.(side)) };
  // As text, microseconds and all. Read as a timestamp it becomes a JavaScript
  // Date, which keeps milliseconds: a row a case arranged in the same
  // millisecond, just before, then counted as written by the request. That
  // failed one case in one CI run (2026-10-08) and none here.
  const since = (await db.query<{ now: string }>(`SELECT clock_timestamp()::text AS now`)).rows[0]
    ?.now;
  // The same moment by this process's clock, which is the database's: kept
  // with a recorded answer, for a replay to keep in step with (recording.ts).
  const at = new Date().toISOString();
  // With uploads in a bucket (`PARITY_S3=1`), what a write stored there is an
  // effect like any other: the rows say where, the bucket says what.
  const filesBefore = writes && BUCKET_MODE ? await fileNames(db) : null;
  if (testCase.jobs) await emptyJobs(db);
  if (testCase.sink) {
    await sinkMode(typeof testCase.sink === 'object' ? testCase.sink : {});
    await sinkTake();
  }
  const response = normalizeBody(await send(base, sent), testCase);
  const effects: unknown[][] = [];
  for (const query of testCase.effects ?? []) {
    const parameters = query.includes('$1') ? [since] : [];
    effects.push((await db.query(query, parameters)).rows);
  }
  if (testCase.jobs) effects.push(await queuedJobs(db, side));
  if (testCase.sink) {
    effects.push([await sinkTake()]);
    await sinkMode({});
  }
  if (filesBefore) effects.push(await storedObjects(db, filesBefore));
  if (writes) await undoWrites(db, since as string);
  return { response, effects, at };
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

/**
 * Every moment any row holds from a few minutes back to some hours ahead,
 * and the midnights in that stretch (the shop's and UTC's): what is "today",
 * and whether a dated row has happened yet, change at those and nowhere else.
 */
async function momentsAhead(db: pg.Client): Promise<string[]> {
  const columns = await db.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('timestamp with time zone', 'timestamp without time zone')
      ORDER BY 1, 2`,
  );
  const WINDOW = `> clock_timestamp() - interval '10 minutes' AND at < clock_timestamp() + interval '6 hours'`;
  const moments = new Set<string>();
  for (const { table_name: table, column_name: column } of columns.rows) {
    const found = await db.query<{ at: Date }>(
      `SELECT DISTINCT at FROM (SELECT "${column}"::timestamptz AS at FROM "${table}") dated WHERE at ${WINDOW}`,
    );
    for (const row of found.rows) moments.add(row.at.toISOString());
  }
  const midnights = await db.query<{ at: Date }>(
    `SELECT at FROM (
       SELECT (date_trunc('day', clock_timestamp() AT TIME ZONE zone) + interval '1 day') AT TIME ZONE zone AS at
         FROM unnest(ARRAY['UTC', $1]) AS zone
     ) midnight WHERE at ${WINDOW}`,
    [process.env.DJANGO_TIME_ZONE || 'Asia/Dhaka'],
  );
  for (const row of midnights.rows) moments.add(row.at.toISOString());
  return [...moments].sort();
}

interface TurnMark {
  now: string;
  outstanding: string;
  blacklisted: string;
  /** The search-term log as it stood, as JSON: a search counts itself there. */
  searched: string;
}

/** Where the session tables and the log stand before an API's turn at a case. */
async function turnMark(db: pg.Client): Promise<TurnMark> {
  return (
    await db.query<TurnMark>(
      `SELECT clock_timestamp()::text AS now,
              (SELECT COALESCE(max(id), 0) FROM token_blacklist_outstandingtoken)::text AS outstanding,
              (SELECT COALESCE(max(id), 0) FROM token_blacklist_blacklistedtoken)::text AS blacklisted,
              (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM catalog_searchterm t)::text AS searched`,
    )
  ).rows[0] as TurnMark;
}

/**
 * That turn taken away again, as far as these tables go. By row id, not by
 * time: the tokens a case registers for itself are dated a minute back, on
 * purpose, so that `undoWrites` leaves them for the request to find.
 */
async function undoTurn(db: pg.Client, mark: TurnMark): Promise<void> {
  await db.query(
    `DELETE FROM token_blacklist_blacklistedtoken
      WHERE id > $1 OR token_id IN (SELECT id FROM token_blacklist_outstandingtoken WHERE id > $2)`,
    [mark.blacklisted, mark.outstanding],
  );
  await db.query(`DELETE FROM token_blacklist_outstandingtoken WHERE id > $1`, [mark.outstanding]);
  await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [mark.now]);
  // Every storefront search adds one to its term's count, and the "popular"
  // list is ordered by those counts: two APIs' turns would count each search
  // twice, and a term searched in more cases than another would overtake it.
  await db.query(
    `DELETE FROM catalog_searchterm
      WHERE id NOT IN (SELECT (was->>'id')::uuid FROM jsonb_array_elements($1::jsonb) AS was)`,
    [mark.searched],
  );
  await db.query(
    `UPDATE catalog_searchterm t
        SET hits = was.hits, last_result_count = was.last_result_count,
            last_searched_at = was.last_searched_at, updated_at = was.updated_at
       FROM jsonb_to_recordset($1::jsonb) AS was(
              id uuid, hits integer, last_result_count integer,
              last_searched_at timestamptz, updated_at timestamptz)
      WHERE t.id = was.id
        AND (t.hits, t.last_result_count, t.last_searched_at, t.updated_at)
            IS DISTINCT FROM (was.hits, was.last_result_count, was.last_searched_at, was.updated_at)`,
    [mark.searched],
  );
}

/** Tokens described rather than compared (each API mints its own), then the case's own adjustments. */
function normalizeBody(response: Captured, testCase: Case): Captured {
  const location = response.headers.location;
  if (location !== undefined && testCase.normalizeLocation) {
    response = {
      ...response,
      headers: { ...response.headers, location: testCase.normalizeLocation(location) },
    };
  }
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
  // `record` keeps the Nest API's answer wherever the two agree; `replay`
  // asks the Nest API alone and compares with what was kept (recording.ts).
  // In a replay `DJANGO_BASE` names a second Nest process: the cases that
  // carry a token from one API to the other, and every race, still have two.
  const mode = parityMode();
  // The cases are built from the clock, so a replay begins where its
  // recording began (recording.ts, "The clock").
  const began = await beginWhereRecorded(mode);
  if (began) console.log(`the replay ${began}`);
  const cases = await buildCases();
  let failed = 0;
  let known = 0;
  const knownReasons = new Map<string, number>();
  const names = new Names();
  const recorder = mode === 'record' ? new Recorder() : null;
  const recording = mode === 'replay' ? readRecording('answers') : null;
  const replayed = new Set<string>();
  const reference = recording ? 'recorded' : 'django';
  // Rows a list's ordering does not tell apart, which come back as the heap
  // holds them (recording.ts, "Tied rows"). `PARITY_TIES=mark` in a replay
  // keeps where an answer is the recorded one with such rows permuted; every
  // replay lets rows change places there, and nowhere else.
  const tied = recording ? readTies() : new Map<string, Tied>();
  const marking = Boolean(recording) && process.env.PARITY_TIES === 'mark';
  let marked = 0;

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379/0');
  // The clock (recording.ts): the moments the database holds in the hours
  // ahead, kept when recording; a replay waits where it would pass a case
  // before one of them that the recording had already passed.
  if (recorder) {
    const moments = new Recorder<Moment>();
    for (const moment of await momentsAhead(db)) moments.add({ name: moment });
    console.log(
      `${moments.size} moments in the database fall in the hours ahead (kept in ${moments.write('moments').path})`,
    );
  }
  const pace = new Pace(recording ? readRecording<Moment>('moments').keys() : []);
  for (const testCase of cases) {
    if (testCase.flushCache) await redis.flushdb();
    for (const statement of testCase.setup ?? []) await db.query(statement);
    const key = names.key(testCase.name);
    let differences: Difference[];
    let nest: { response: Captured; effects: unknown[][] };
    let asked: string;
    try {
      // The answer the Nest API's is held against: Django's, or the one kept.
      let expected: { response: Captured; effects: unknown[][]; at?: string } | undefined;
      if (recording) {
        expected = recording.get(key);
        replayed.add(key);
        // In step with the recording past every moment the database holds.
        const recordedAt = expected?.at ? Date.parse(expected.at) : NaN;
        const wait = Number.isNaN(recordedAt) ? 0 : pace.wait(recordedAt, Date.now());
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      } else {
        // A recording is of one API answering. What Django's turn leaves
        // behind that no reset takes away -- the sign-ins a case makes to get
        // its tokens, their audit entries -- is taken away here, so that the
        // Nest API's turn finds what it will find in a replay.
        const before = recorder ? await turnMark(db) : undefined;
        expected = await run(db, DJANGO, 'django', testCase);
        if (before) await undoTurn(db, before);
      }
      const answer = await run(db, NEST, 'nest', testCase);
      asked = answer.at;
      nest = recording
        ? { response: answer.response, effects: plain(answer.effects) as unknown[][] }
        : answer;
      const held = (theirs: { response: Captured; effects: unknown[][] }, ours: typeof nest) => {
        const found = compare(theirs.response, ours.response, testCase.headers?.['x-request-id']);
        if (theirs.effects.length !== ours.effects.length) {
          found.push({
            path: 'effects.length',
            django: theirs.effects.length,
            nest: ours.effects.length,
          });
        }
        theirs.effects.forEach((rows, index) =>
          found.push(...diffJson(rows, ours.effects[index], `effects[${index}]`)),
        );
        return found;
      };
      if (!expected) {
        differences = [
          {
            path: 'recording',
            django: '<no answer recorded for this case>',
            nest: nest.response.status,
          },
        ];
      } else if (!recording) {
        differences = held(expected, nest);
      } else {
        const known = tied.get(key)?.ties ?? [];
        const asKnown = settled(expected, nest, known);
        differences = held(expected, asKnown);
        if (differences.length && marking) {
          // The recorded rows in another order? Then where, and held to that.
          const found = tiesBetween(expected, asKnown);
          if (found) {
            const ties = mergedTies(known, found);
            const again = held(expected, settled(expected, nest, ties));
            if (!again.length) {
              tied.set(key, { name: key, ties });
              marked += 1;
              differences = again;
            }
          }
        }
      }
      if (VERBOSE) {
        const shown = expected ?? nest;
        console.log(
          `CASE  ${testCase.name}: ${shown.response.status} ${shown.response.body.slice(0, 160)}`,
        );
        for (const rows of shown.effects)
          console.log(`      ${JSON.stringify(rows).slice(0, 400)}`);
      }
    } finally {
      for (const statement of testCase.teardown ?? []) await db.query(statement);
      await testCase.reset?.(db);
    }
    const unexplained = differences.filter((difference) => {
      // The documented differences are between the two APIs. A recording
      // is this API's own answer: nothing excuses a departure from it.
      const reason = recording ? null : isKnown(testCase, difference);
      if (reason) knownReasons.set(reason, (knownReasons.get(reason) ?? 0) + 1);
      return !reason;
    });
    if (unexplained.length) {
      failed += 1;
      console.log(`DIFF  ${key}  [${testCase.method ?? 'GET'} ${testCase.path}]`);
      for (const difference of unexplained.slice(0, 12)) {
        console.log(
          `      ${difference.path}: ${reference}=${JSON.stringify(difference.django)} nest=${JSON.stringify(difference.nest)}`,
        );
      }
      if (unexplained.length > 12) console.log(`      ... and ${unexplained.length - 12} more`);
    } else if (differences.length) {
      known += 1;
    }
    // Kept only where the two agreed (a deliberate difference is agreement
    // of a kind: what is kept is this API's side of it).
    if (recorder && !unexplained.length) {
      recorder.add({
        name: key,
        request: `${testCase.method ?? 'GET'} ${testCase.path}`,
        at: asked,
        response: kept(nest.response),
        effects: plain(nest.effects) as unknown[][],
      });
    }
  }

  if (marking) {
    const ties = new Recorder<Tied>();
    for (const entry of tied.values()) ties.add(entry);
    console.log(
      `${marked} cases answered with the recorded rows, tied ones in another order: marked (${tied.size} cases hold ties, in ${ties.write('ties').path})`,
    );
  } else if (recording) {
    console.log(`${tied.size} cases hold tied rows, which may come back in either order`);
  }
  if (recording) {
    console.log(
      `kept in step with the recording: waited ${Math.round(pace.waited / 1000)} s in all, ${pace.waits} times, for a moment the database holds` +
        (pace.ahead
          ? `; ${pace.ahead} cases were reached after a moment the recording had not yet passed`
          : ''),
    );
  }

  // An answer on file that no case asked for: a case was removed or renamed,
  // and the recording was not taken again. Only a whole run can tell.
  let unasked = 0;
  if (recording && !ONLY) {
    for (const name of recording.keys()) {
      if (replayed.has(name)) continue;
      unasked += 1;
      if (unasked <= 12) console.log(`GONE  ${name}: recorded, and no case of that name ran`);
    }
    if (unasked > 12) console.log(`      ... and ${unasked - 12} more`);
  }

  // Before the races, which are no part of it: the answers are whole once the
  // last case has run, and a race that fails afterwards does not unmake them.
  let recordedLine = '';
  if (recorder) {
    // A recording with a hole in it would pass a replay that skips the hole.
    if (failed) {
      recordedLine = `not recorded: ${failed} cases differ, and a recording is of a run that agrees`;
    } else {
      const { path, bytes } = recorder.write('answers');
      recordedLine = `recorded ${recorder.size} answers (${names.repeated} under a repeated name) in ${path}, ${bytes} bytes`;
    }
    console.log(recordedLine);
  }

  // Invariants that hold only under the right lock, driven concurrently.
  let racesFailed = 0;
  if (!ONLY || 'concurrency'.includes(ONLY)) {
    // `PARITY_RACES=returns` runs only the groups whose name contains the text.
    const groups: [string, () => Promise<{ name: string; passed: boolean; detail: string }[]>][] = [
      ['checkout', () => concurrencyChecks({ DJANGO, NEST, SIGNING_KEY })],
      ['admin', () => adminConcurrencyChecks({ DJANGO, NEST })],
      ['inventory', () => inventoryConcurrencyChecks({ DJANGO, NEST })],
      ['content', () => contentConcurrencyChecks({ DJANGO, NEST })],
      ['merchandising', () => merchandisingConcurrencyChecks({ DJANGO, NEST })],
      ['pos', () => posConcurrencyChecks({ DJANGO, NEST })],
      ['pos-sale', () => posSaleConcurrencyChecks({ DJANGO, NEST })],
      ['returns', () => returnsConcurrencyChecks({ DJANGO, NEST })],
      ['staff-orders', () => staffOrdersConcurrencyChecks({ DJANGO, NEST })],
      ['labels', () => labelsConcurrencyChecks({ DJANGO, NEST })],
      ['finance', () => financeConcurrencyChecks({ DJANGO, NEST })],
      ['expenses', () => expensesConcurrencyChecks({ DJANGO, NEST })],
      ['purchasing', () => purchasingConcurrencyChecks({ DJANGO, NEST })],
      ['purchase-orders', () => purchaseOrderConcurrencyChecks({ DJANGO, NEST })],
      ['supplier-payments', () => supplierPaymentConcurrencyChecks({ DJANGO, NEST })],
      ['customers', () => customersConcurrencyChecks({ DJANGO, NEST })],
      ['coupons', () => couponsConcurrencyChecks({ DJANGO, NEST })],
      ['shipping', () => shippingConcurrencyChecks({ DJANGO, NEST })],
      ['reviews', () => reviewsConcurrencyChecks({ DJANGO, NEST })],
      ['team', () => teamConcurrencyChecks({ DJANGO, NEST })],
      ['notifications', () => notificationsConcurrencyChecks({ DJANGO, NEST })],
      ['sweep', () => sweepConcurrencyChecks({ DJANGO, NEST })],
      // Only when the Nest side queues in pg-boss (`run-jobs`): nothing otherwise.
      ['jobs', () => jobsConcurrencyChecks({ NEST })],
    ];
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    for (const [group, run] of groups) {
      if (!RACES || group.includes(RACES)) checks.push(...(await run()));
    }
    for (const check of checks) {
      if (!check.passed) racesFailed += 1;
      // In a replay the second API is a second Nest process, and the checks'
      // names were written for Django: say what was actually raced.
      const name = recording
        ? check.name
            .replaceAll('across both APIs', 'across two Nest processes')
            .replaceAll('one per API', 'one per Nest process')
            .replaceAll('Django', 'the second Nest process')
        : check.name;
      console.log(`${check.passed ? 'RACE ' : 'FAIL '} ${name}: ${check.detail}`);
    }
  }

  console.log('');
  if (recording) {
    console.log(
      `${cases.length} cases against the recording: ${cases.length - failed} as recorded, ${failed} differ, ${unasked} recorded and not asked`,
    );
  } else {
    console.log(
      `${cases.length} cases: ${cases.length - failed} match (${known} only by documented differences), ${failed} differ`,
    );
  }
  for (const [reason, count] of knownReasons) console.log(`  documented (${count}x): ${reason}`);
  if (recordedLine) console.log(recordedLine);
  process.exitCode = failed || racesFailed || unasked ? 1 : 0;
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
