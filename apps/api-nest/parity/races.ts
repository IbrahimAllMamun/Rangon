/**
 * What the phase 6 race checks share: the result of a check, and `behind`,
 * which makes a conflict happen on purpose -- the harness takes a row lock,
 * starts the requests, waits until PostgreSQL shows them queued behind it,
 * writes the competing change and commits.
 */
import pg from 'pg';

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Answer {
  status: number;
  body: string;
}

/** The envelope's message, or nothing for a body that is not one. */
export function message(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    return '';
  }
}

export const statuses = (responses: { status: number }[]) =>
  responses.map((response) => response.status).sort((a, b) => a - b);

/**
 * Hold `lock` in a transaction of the harness's own, start `requests`, and
 * wait until that many statements matching `waitsOn` are waiting on a lock.
 * Then run `change` on the holding connection and commit. `queued` is how
 * many requests were seen waiting: a request that never waits took no lock.
 */
export async function behind(
  db: pg.Client,
  lock: [sql: string, values: unknown[]],
  waitsOn: string,
  requests: (() => Promise<Answer>)[],
  change: (holder: pg.Client) => Promise<void> = async () => {},
): Promise<{ queued: number; responses: Answer[] }> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query(lock[0], lock[1]);
  const pending = requests.map((request) => request());
  let queued = 0;
  for (let attempt = 0; attempt < 160 && queued < requests.length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active'
          AND query ILIKE $1 AND query NOT ILIKE '%pg_stat_activity%'`,
      [waitsOn],
    );
    queued = Number(waiting.rows[0]?.count ?? 0);
  }
  await change(holder);
  await holder.query('COMMIT');
  await holder.end();
  return { queued, responses: await Promise.all(pending) };
}
