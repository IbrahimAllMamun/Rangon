/**
 * Concurrency checks: invariants that hold only if a write takes the right
 * lock, driven with simultaneous requests -- across both APIs at once, which
 * is how they will run while paths are cut over one at a time.
 *
 * Run by run.ts after the comparison cases; each check restores what it wrote.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

import pg from 'pg';

import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function bearer(user: { id: string; password: string }, key: string, type = 'access', extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    token_type: type,
    exp: now + 600,
    iat: now,
    jti: `parity${randomBytes(13).toString('hex')}`,
    user_id: user.id,
    hash_password: createHash('md5').update(user.password).digest('hex').toUpperCase(),
    ...extra,
  })}`;
  return `${head}.${createHmac('sha256', key).update(head).digest('base64url')}`;
}

export async function concurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
  SIGNING_KEY: string;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const many = (
      await db.query<{ id: string; password: string; customer_id: string }>(
        `SELECT u.id, u.password, c.id AS customer_id FROM accounts_user u
           JOIN customers_customer c ON c.user_id = u.id WHERE u.email = 'parity.many@rangon.test'`,
      )
    ).rows[0];
    if (!many) return [];
    const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]?.now;

    // 1. One default address per customer. Twenty "add as the default"
    //    requests at once, half to each API: `add_address` locks the customer
    //    row, so they queue, and exactly one default must remain.
    const before = await db.query<{ id: string; is_default: boolean }>(
      `SELECT id, is_default FROM customers_customeraddress WHERE customer_id = $1`,
      [many.customer_id],
    );
    const token = bearer(many, apis.SIGNING_KEY);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        send(index % 2 ? apis.NEST : apis.DJANGO, {
          name: 'concurrent default',
          method: 'POST',
          path: '/api/v1/shop/account/addresses/',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            recipient_name: `Race ${index}`,
            phone: '01711000006',
            line1: 'Road',
            city: 'Dhaka',
            is_default: true,
          }),
        }).then((response) => response.status),
      ),
    );
    const after = await db.query<{ defaults: string; total: string }>(
      `SELECT count(*) FILTER (WHERE is_default) AS defaults, count(*) AS total
         FROM customers_customeraddress WHERE customer_id = $1`,
      [many.customer_id],
    );
    const { defaults, total } = after.rows[0] ?? { defaults: '?', total: '?' };
    checks.push({
      name: 'addresses: 20 simultaneous defaults across both APIs leave exactly one',
      passed:
        statuses.every((status) => status === 201) &&
        defaults === '1' &&
        Number(total) === before.rows.length + 20,
      detail: `statuses ${[...new Set(statuses)].join('/')}, ${defaults} default of ${total}`,
    });
    await db.query(
      `DELETE FROM customers_customeraddress WHERE customer_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [many.customer_id, before.rows.map((row) => row.id)],
    );
    for (const row of before.rows) {
      await db.query(`UPDATE customers_customeraddress SET is_default = $2 WHERE id = $1`, [
        row.id,
        row.is_default,
      ]);
    }

    // 2. A refresh token is spent once. Eight refreshes of one token at once
    //    to the Nest API: exactly one gets a new pair (Django's get_or_create
    //    can let several through; a documented difference).
    const refresh = bearer(many, apis.SIGNING_KEY, 'refresh', {
      exp: Math.floor(Date.now() / 1000) + 86400,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        send(apis.NEST, {
          name: 'concurrent refresh',
          method: 'POST',
          path: '/api/v1/auth/refresh/',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh }),
        }).then((response) => response.status),
      ),
    );
    const granted = results.filter((status) => status === 200).length;
    checks.push({
      name: 'refresh: 8 simultaneous uses of one token, exactly one rotates (Nest)',
      passed: granted === 1 && results.every((status) => status === 200 || status === 401),
      detail: `${granted} granted, statuses ${results.join(',')}`,
    });

    await db.query(`DELETE FROM token_blacklist_blacklistedtoken WHERE blacklisted_at >= $1`, [
      since,
    ]);
    await db.query(
      `DELETE FROM token_blacklist_outstandingtoken WHERE created_at >= $1 OR (created_at IS NULL AND jti LIKE 'parity%')`,
      [since],
    );
    await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
  } finally {
    await db.end();
  }
  return checks;
}
