/**
 * Rate limits, compared live: both APIs with throttling on, driven past each
 * limit, the sequence of statuses and the refusal compared.
 *
 *   docker compose -p rangon-nest -f docker-compose.nest.yml --profile throttle run --rm throttle-check
 *
 * Each API keeps its own buckets, so each gets the same budget from zero.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:http';

import { Redis } from 'ioredis';
import pg from 'pg';

const APIS = {
  django: new URL(process.env.DJANGO_BASE ?? 'http://django-throttled:8000'),
  nest: new URL(process.env.NEST_BASE ?? 'http://nest-throttled:3000'),
};

function call(
  base: URL,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method: payload ? 'POST' : 'GET',
        agent: false,
        headers: {
          host: 'localhost',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Runs of equal statuses: "60x200 2x429". */
function runs(statuses: number[]): string {
  const out: string[] = [];
  let count = 0;
  statuses.forEach((status, index) => {
    count += 1;
    if (statuses[index + 1] !== status) {
      out.push(`${count}x${status}`);
      count = 0;
    }
  });
  return out.join(' ');
}

async function main(): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379/0');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const user = (
    await db.query<{ id: string; password: string; email: string }>(
      `SELECT id, password, email FROM accounts_user ORDER BY email LIMIT 1`,
    )
  ).rows[0];
  const cashier = (
    await db.query<{ id: string; password: string; email: string }>(
      `SELECT id, password, email FROM accounts_user WHERE email = 'cashier@rangon.test'`,
    )
  ).rows[0];
  await db.end();
  if (!user || !cashier) throw new Error('No user to authenticate as.');

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const key = process.env.DJANGO_SECRET_KEY ?? '';
  const sign = (account: { id: string; password: string }) => {
    const body = encode({
      token_type: 'access',
      exp: now + 600,
      iat: now,
      jti: randomUUID().replaceAll('-', ''),
      user_id: account.id,
      hash_password: createHash('md5').update(account.password).digest('hex').toUpperCase(),
    });
    return `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`;
  };
  const token = sign(user);
  const cashierToken = sign(cashier);

  const scenarios = [
    // anon 60/min; a spoofed X-Forwarded-For must not buy a fresh bucket.
    {
      name: 'anonymous, 62 requests, spoofed X-Forwarded-For',
      count: 62,
      path: '/api/v1/shop/categories/',
      spoof: true,
    },
    // Signed in: no anon bucket; the `search` scope (120/min) refuses first.
    {
      name: 'signed in, 122 searches',
      count: 122,
      path: '/api/v1/shop/search/suggest/?q=sh',
      auth: true,
    },
    // Plain Django views are never throttled.
    { name: 'health, 70 requests', count: 70, path: '/api/health/' },
    // The `auth` scope, 10/min, refuses before the anon budget does.
    {
      name: 'sign-in, 12 wrong passwords',
      count: 12,
      path: '/api/v1/auth/login/',
      body: { email: user.email, password: 'not-the-password' },
    },
    // `throttle_classes = [ScopedRateThrottle]`: the `auth` scope alone, per account.
    {
      name: 'password change, 12 wrong guesses',
      count: 12,
      path: '/api/v1/auth/password/change/',
      auth: true,
      body: { current_password: 'not-the-password', new_password: 'Kantha-Stitch-77' },
    },
    // No throttle at all: a 429 would leave the session alive.
    {
      name: 'logout, 70 requests',
      count: 70,
      path: '/api/v1/auth/logout/',
      body: { refresh: 'abc' },
    },
    // A webhook skips authentication, not throttling: the anonymous 60/min,
    // keyed by address, as DRF applies it to a view with no authenticators.
    {
      name: 'payment webhook, 62 requests',
      count: 62,
      path: '/api/v1/shop/payments/manual/webhook/',
      body: {},
    },
    // The `checkout` scope, 20/hour. The throttle runs before the body is
    // read, so a refused body spends a try too. Nothing here writes.
    {
      name: 'checkout, 22 empty bodies',
      count: 22,
      path: '/api/v1/shop/checkout/',
      body: {},
    },
    // Taking a lead spends from the same bucket: alternating buys no more tries.
    // The fixture's empty cart, so no cart is made; no phone, so no lead is held.
    {
      name: 'lead and checkout alternating, 22 requests',
      count: 22,
      path: ['/api/v1/shop/checkout/lead/', '/api/v1/shop/checkout/'],
      headers: { 'x-cart-token': 'parity-cart-empty' },
      body: {},
    },
    // The register: the `pos` scope allows 1200/min, but the `user` rate of
    // 600/min counts the same requests and refuses first (D139).
    {
      name: 'the register, 602 scans by a cashier',
      count: 602,
      path: '/api/v1/pos/lookup/?code=NOPE',
      cashier: true,
    },
    // Permissions are checked before throttles: a role that may not use the
    // register is refused every time and never throttled.
    {
      name: 'the register, 602 scans by a role without it',
      count: 602,
      path: '/api/v1/pos/lookup/?code=NOPE',
      auth: true,
    },
  ] as {
    name: string;
    count: number;
    path: string | string[];
    spoof?: boolean;
    auth?: boolean;
    cashier?: boolean;
    headers?: Record<string, string>;
    body?: unknown;
  }[];

  let failed = 0;
  for (const scenario of scenarios) {
    const results: Record<string, { statuses: number[]; refusal: string }> = {};
    for (const [name, base] of Object.entries(APIS)) {
      await redis.flushdb();
      const statuses: number[] = [];
      let refusal = '';
      for (let i = 0; i < scenario.count; i++) {
        const headers: Record<string, string> = { ...scenario.headers };
        if (scenario.spoof) headers['x-forwarded-for'] = `198.51.100.${i % 250}`;
        if (scenario.auth) headers.authorization = `Bearer ${token}`;
        if (scenario.cashier) headers.authorization = `Bearer ${cashierToken}`;
        const path = Array.isArray(scenario.path)
          ? (scenario.path[i % scenario.path.length] as string)
          : scenario.path;
        const response = await call(base, path, headers, scenario.body);
        statuses.push(response.status);
        if (response.status === 429 && !refusal) {
          const error = (JSON.parse(response.body) as { error: { code: string; message: string } })
            .error;
          // The wait depends on the second the run happened in; compare its shape.
          refusal = `${error.code}: ${error.message.replace(/\d+ seconds?/, 'N seconds')}`;
        }
      }
      results[name] = { statuses, refusal };
    }
    const django = results.django as { statuses: number[]; refusal: string };
    const nest = results.nest as { statuses: number[]; refusal: string };
    const same = runs(django.statuses) === runs(nest.statuses) && django.refusal === nest.refusal;
    if (!same) failed += 1;
    console.log(`${same ? 'MATCH' : 'DIFF '} ${scenario.name}`);
    console.log(`      django: ${runs(django.statuses)}  ${django.refusal}`);
    console.log(`      nest:   ${runs(nest.statuses)}  ${nest.refusal}`);
  }
  redis.disconnect();
  process.exitCode = failed ? 1 : 0;
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => process.exit());
