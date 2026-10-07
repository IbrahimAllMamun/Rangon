/**
 * The worker itself (phase 7 part 4b, ADR-0016): `src/worker.ts` in a
 * container of its own, on what the Nest API queues in pg-boss.
 *
 *   scripts/nest-parity.sh worker
 *
 * The comparison cases run each handler on demand, beside its Celery task.
 * What they cannot show is the queue between: that a row in `pgboss.job` is
 * taken up, that a send the mail server refused is tried again when the
 * queue says and not before, and that a job which cannot succeed is closed
 * rather than tried forever. Django has no such queue; these are the port's
 * alone. The worker here fires no schedule (`RANGON_JOBS_SCHEDULE=0`).
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

import pg from 'pg';

const NEST = process.env.NEST_BASE ?? 'http://nest-jobs:3000';
const SINK = process.env.PARITY_SINK ?? 'http://sink:8025';
const EMAIL = 'notifications.tasks.send_order_email';
const REVALIDATE = 'content.tasks.revalidate_storefront';

interface JobRow {
  id: string;
  state: string;
  retry_count: number;
  retry_limit: number;
  retry_delay: number;
  wait: number;
  output: { result?: string | null; error?: string } | null;
}
interface Kept {
  mail: { to?: string; subject?: string; refused?: string }[];
  pings: { body?: { tags?: string[] }; secret?: string }[];
}

async function main(): Promise<number> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]
    ?.now as string;
  const results: { name: string; passed: boolean; detail: string }[] = [];
  const check = (name: string, passed: boolean, detail: string) =>
    results.push({ name, passed, detail });

  const take = async () => (await (await fetch(`${SINK}/take`)).json()) as Kept;
  const mode = (wanted: { mail?: string }) =>
    fetch(`${SINK}/mode`, { method: 'POST', body: JSON.stringify(wanted) });
  const queue = (task: string, args: unknown[]) =>
    fetch(`${NEST}/parity/jobs/queue/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, args }),
    });
  const jobs = async (task: string, args: unknown[]) =>
    (
      await db.query<JobRow>(
        `SELECT id, state::text, retry_count, retry_limit, retry_delay, output,
                round(extract(epoch FROM start_after - now()))::int AS wait
           FROM pgboss.job WHERE name = $1 AND data->'args' = $2::jsonb ORDER BY created_on`,
        [task, JSON.stringify(args)],
      )
    ).rows;
  /** The job, once it is in `state`; whatever it is in after twenty seconds otherwise. */
  const settled = async (task: string, args: unknown[], state: string) => {
    let row: JobRow | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      row = (await jobs(task, args)).at(-1);
      if (row?.state === state) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return row;
  };
  const describe = (row: JobRow | undefined) =>
    row
      ? `${row.state} ${JSON.stringify(row.output)} after ${row.retry_count} of ${row.retry_limit} retries`
      : 'no such job';
  const order = async (number: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM orders_order WHERE number = $1`, [number]))
      .rows[0]?.id as string;

  try {
    await mode({});
    await take();

    // 1. A staff write through the API: the job it queues is run by the worker.
    const owner = (
      await db.query<{ id: string; password: string }>(
        `SELECT id, password FROM accounts_user WHERE email = 'owner@rangon.test'`,
      )
    ).rows[0];
    if (!owner) throw new Error('No owner to authenticate as.');
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode({
      token_type: 'access',
      exp: now + 600,
      iat: now,
      jti: randomUUID().replaceAll('-', ''),
      user_id: owner.id,
      hash_password: createHash('md5').update(owner.password).digest('hex').toUpperCase(),
    });
    const signature = createHmac('sha256', process.env.DJANGO_SECRET_KEY ?? '')
      .update(`${head}.${body}`)
      .digest('base64url');
    const added = await fetch(`${NEST}/api/v1/storefront-banners/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${head}.${body}.${signature}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ placement: 'ANNOUNCEMENT', message: 'Parity: the worker check' }),
    });
    const tags = ['navigation', 'home'];
    const pinged = await settled(REVALIDATE, [tags], 'completed');
    let kept = await take();
    check(
      'worker: a banner added through the API -- the revalidation it queued is taken up by the worker, the web app is asked once, with the secret, and the job is closed as sent',
      added.status === 201 &&
        pinged?.state === 'completed' &&
        pinged.output?.result === 'sent' &&
        kept.pings.length === 1 &&
        JSON.stringify(kept.pings[0]?.body?.tags) === JSON.stringify(tags) &&
        kept.pings[0]?.secret === 'parity-revalidate-secret',
      `banner ${added.status}; job ${describe(pinged)}; ${kept.pings.length} ping(s) ${JSON.stringify(kept.pings[0]?.body ?? null)}`,
    );

    // 2. An order's email, queued as the API queues one.
    const first = await order('PAR-JOB-0001');
    await queue(EMAIL, [first, 'ORDER_CONFIRMED']);
    const sent = await settled(EMAIL, [first, 'ORDER_CONFIRMED'], 'completed');
    kept = await take();
    check(
      "worker: an order's confirmation email, queued -- sent once, to the customer, and the job closed as sent",
      sent?.state === 'completed' &&
        sent.output?.result === 'sent' &&
        sent.retry_count === 0 &&
        kept.mail.length === 1 &&
        kept.mail[0]?.to === 'parity.jobs.mobile@rangon.test' &&
        (kept.mail[0]?.subject ?? '').includes('PAR-JOB-0001'),
      `job ${describe(sent)}; ${kept.mail.length} message(s), to ${kept.mail[0]?.to ?? 'nobody'}: ${kept.mail[0]?.subject ?? ''}`,
    );

    // 3. The mail server refusing: the job waits its two minutes, as the Celery
    //    task does, and is sent when it is next delivered.
    const fourth = await order('PAR-JOB-0004');
    await mode({ mail: 'refuse' });
    await queue(EMAIL, [fourth, 'ORDER_SHIPPED']);
    const waiting = await settled(EMAIL, [fourth, 'ORDER_SHIPPED'], 'retry');
    // Two polls later it has still been tried once: nothing retries at once.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const refusals = (await take()).mail;
    await mode({});
    await db.query(`UPDATE pgboss.job SET start_after = now() WHERE id = $1`, [waiting?.id]);
    const delivered = await settled(EMAIL, [fourth, 'ORDER_SHIPPED'], 'completed');
    kept = await take();
    check(
      'worker: the mail server refusing -- the job is tried once and left to wait two minutes with three retries in hand; brought forward with the server back, it is sent on its first retry',
      waiting?.state === 'retry' &&
        // pg-boss counts a retry when it is delivered, not when it is owed.
        waiting.retry_count === 0 &&
        waiting.retry_limit === 3 &&
        waiting.retry_delay === 120 &&
        waiting.wait > 100 &&
        waiting.wait <= 120 &&
        refusals.length === 1 &&
        Boolean(refusals[0]?.refused) &&
        delivered?.state === 'completed' &&
        delivered.output?.result === 'sent' &&
        delivered.retry_count === 1 &&
        kept.mail.length === 1 &&
        kept.mail[0]?.to === 'parity.jobs.nophone@rangon.test',
      `refused: ${waiting?.state} with ${waiting?.retry_count} of ${waiting?.retry_limit} retries used, next in ${waiting?.wait}s, ${refusals.length} attempt(s) at the server; then ${describe(delivered)}, ${kept.mail.length} message(s) to ${kept.mail[0]?.to ?? 'nobody'}`,
    );

    // 4. A job that cannot succeed: closed with its reason, and not tried again
    //    though its queue allows three retries.
    await queue(EMAIL, ['not-an-order', 'ORDER_CONFIRMED']);
    const closed = await settled(EMAIL, ['not-an-order', 'ORDER_CONFIRMED'], 'completed');
    kept = await take();
    check(
      "worker: an order's email for a key that is no key -- failed once, closed with the reason on its row, and not retried: Celery fails such a task and does not run it again",
      closed?.state === 'completed' &&
        closed.output?.result === null &&
        Boolean(closed.output.error) &&
        closed.retry_count === 0 &&
        kept.mail.length === 0,
      `job ${describe(closed)}; ${kept.mail.length} message(s)`,
    );

    // 5. Nothing else ran, and nothing is scheduled by a worker told not to.
    const left = (
      await db.query<{ state: string; count: string }>(
        `SELECT state::text, count(*) AS count FROM pgboss.job GROUP BY 1 ORDER BY 1`,
      )
    ).rows;
    const scheduled = (
      await db.query<{ count: string }>(`SELECT count(*) AS count FROM pgboss.schedule`)
    ).rows[0]?.count;
    check(
      'worker: four jobs queued, four closed, none left waiting -- and no schedule from a worker started with RANGON_JOBS_SCHEDULE=0',
      JSON.stringify(left) === JSON.stringify([{ state: 'completed', count: '4' }]) &&
        scheduled === '0',
      `${left.map((row) => `${row.count} ${row.state}`).join(', ') || 'no jobs'}; ${scheduled} scheduled`,
    );
  } finally {
    await mode({});
    // Test data, in the parity database only: the banner, what was written
    // about it, and the jobs.
    await db.query(
      `DELETE FROM content_storefrontbanner WHERE message = 'Parity: the worker check'`,
    );
    await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    await db.query(`DELETE FROM pgboss.job`);
    await db.end();
  }

  for (const result of results) {
    console.log(`${result.passed ? 'WORKER' : 'FAIL  '} ${result.name}: ${result.detail}`);
  }
  const failed = results.filter((result) => !result.passed).length;
  console.log(`\n${results.length} worker checks: ${results.length - failed} pass, ${failed} fail`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
