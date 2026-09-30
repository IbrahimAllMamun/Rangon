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

function get(
  base: URL,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        path,
        agent: false,
        headers: { host: 'localhost', ...headers },
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
    req.end();
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
    await db.query<{ id: string; password: string }>(
      `SELECT id, password FROM accounts_user ORDER BY email LIMIT 1`,
    )
  ).rows[0];
  await db.end();
  if (!user) throw new Error('No user to authenticate as.');

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({
    token_type: 'access',
    exp: now + 600,
    iat: now,
    jti: randomUUID().replaceAll('-', ''),
    user_id: user.id,
    hash_password: createHash('md5').update(user.password).digest('hex').toUpperCase(),
  });
  const key = process.env.DJANGO_SECRET_KEY ?? '';
  const token = `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`;

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
  ];

  let failed = 0;
  for (const scenario of scenarios) {
    const results: Record<string, { statuses: number[]; refusal: string }> = {};
    for (const [name, base] of Object.entries(APIS)) {
      await redis.flushdb();
      const statuses: number[] = [];
      let refusal = '';
      for (let i = 0; i < scenario.count; i++) {
        const headers: Record<string, string> = {};
        if (scenario.spoof) headers['x-forwarded-for'] = `198.51.100.${i % 250}`;
        if (scenario.auth) headers.authorization = `Bearer ${token}`;
        const response = await get(base, scenario.path, headers);
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
