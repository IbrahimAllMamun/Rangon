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

import { type Captured, compare, type Difference } from './compare.ts';
import { KNOWN_DIFFERENCES } from './known-differences.ts';

const DJANGO = new URL(process.env.DJANGO_BASE ?? 'http://django:8000');
const NEST = new URL(process.env.NEST_BASE ?? 'http://nest:3000');
const HOST = process.env.PARITY_HOST ?? 'localhost';
const SIGNING_KEY = process.env.JWT_SIGNING_KEY || process.env.DJANGO_SECRET_KEY || '';
const ONLY = process.env.PARITY_ONLY ?? '';

export interface Case {
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** SQL run before the pair of requests, and undone by `teardown` after. */
  setup?: string[];
  teardown?: string[];
  /** Empty the shared Redis first: both APIs' page caches live there. */
  flushCache?: boolean;
}

function send(base: URL, testCase: Case): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        method: testCase.method ?? 'GET',
        path: testCase.path,
        // One connection per request: Node's keep-alive agent would otherwise
        // hold the Nest API's sockets open and keep this process from exiting.
        agent: false,
        headers: { host: HOST, accept: 'application/json', ...testCase.headers },
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
    req.end();
  });
}

async function json<T>(path: string): Promise<T> {
  const response = await send(DJANGO, { name: 'discover', path });
  if (response.status !== 200) throw new Error(`Discovery ${path} answered ${response.status}`);
  return JSON.parse(response.body) as T;
}

/** An access token SimpleJWT would have issued for this user. */
function token(
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
    setup: [`UPDATE content_navigationitem SET is_active = false WHERE placement = 'HEADER'`],
    teardown: [`UPDATE content_navigationitem SET is_active = true WHERE placement = 'HEADER'`],
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

  return ONLY ? cases.filter((c) => c.name.includes(ONLY)) : cases;
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
    let django: Captured;
    let nest: Captured;
    try {
      django = await send(DJANGO, testCase);
      nest = await send(NEST, testCase);
    } finally {
      for (const statement of testCase.teardown ?? []) await db.query(statement);
    }
    const differences = compare(django, nest, testCase.headers?.['x-request-id']);
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

  console.log('');
  console.log(
    `${cases.length} cases: ${cases.length - failed} match (${known} only by documented differences), ${failed} differ`,
  );
  for (const [reason, count] of knownReasons) console.log(`  documented (${count}x): ${reason}`);
  process.exitCode = failed ? 1 : 0;
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => process.exit());
