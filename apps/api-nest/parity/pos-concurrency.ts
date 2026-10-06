/**
 * Race checks for the counter (phase 5), run by run.ts after the comparison
 * cases. Each puts its tables back.
 *
 * Held sales take no lock (D142): `resume` reads the hold and then deletes
 * it, and an edit reads it and then saves it. Nothing in the port may be
 * stricter, so the harness shows the gap the same way on both APIs: it holds
 * the hold's row, starts the requests, waits until they are queued behind it
 * -- each has read the hold by then -- and lets go.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const HOLD_TABLES = ['orders_heldsale'];

export async function posConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const hold = (
      await db.query<{ id: string }>(`SELECT id FROM orders_heldsale WHERE label = 'H04'`)
    ).rows[0]?.id;
    if (!hold) return [];
    const auth = await staffHeaders(db);
    const sides = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    const call = (api: URL, method: string, path: string, body: unknown) =>
      send(api, {
        name: 'pos write',
        method,
        path,
        headers: { ...auth('cashier'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    /** How many requests are queued on the hold's row lock. */
    const queued = async () =>
      Number(
        (
          await db.query<{ count: string }>(
            `SELECT count(*) AS count FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND state = 'active'
                AND (query ILIKE 'UPDATE "orders_heldsale"%'
                  OR query ILIKE 'DELETE FROM "orders_heldsale"%')`,
          )
        ).rows[0]?.count ?? 0,
      );
    /** Hold the row, start the requests, wait for them all to queue, run `change`, commit. */
    const behindTheRow = async <T>(
      requests: (() => Promise<T>)[],
      change: (holder: pg.Client) => Promise<void>,
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM orders_heldsale WHERE id = $1 FOR UPDATE`, [hold]);
      const pending = requests.map((request) => request());
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting < requests.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        waiting = await queued();
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { waiting, responses: await Promise.all(pending) };
    };

    // 1. Two registers resume one hold, one on each API. Both read it before
    //    either deletes it, so both are handed the cart.
    await restoreTables(db, HOLD_TABLES);
    const resumed = await behindTheRow(
      sides.map(
        ([, api]) =>
          () =>
            call(api, 'POST', `/api/v1/pos/holds/${hold}/resume/`, {}),
      ),
      async () => {},
    );
    const carts = resumed.responses.filter(
      (response) => response.status === 200 && response.body.includes('"payload"'),
    ).length;
    const left = Number(
      (await db.query(`SELECT count(*) AS count FROM orders_heldsale WHERE id = $1`, [hold]))
        .rows[0]?.count,
    );
    checks.push({
      name: 'holds: two resumes of one hold that both read it, one per API, both get the cart (D142, copied)',
      passed: resumed.waiting === 2 && carts === 2 && left === 0,
      detail: `statuses ${resumed.responses.map((response) => response.status).join(',')}, ${resumed.waiting} queued on the row, ${carts} cart(s) handed back, ${left} hold(s) left`,
    });

    // 2. An edit that read the hold before a resume deleted it: its UPDATE
    //    finds no row, and `save()` inserts the hold again.
    for (const [side, api] of sides) {
      await restoreTables(db, HOLD_TABLES);
      const edited = await behindTheRow(
        [() => call(api, 'PATCH', `/api/v1/pos/holds/${hold}/`, { label: 'Edited late' })],
        async (holder) => {
          await holder.query(`DELETE FROM orders_heldsale WHERE id = $1`, [hold]);
        },
      );
      const row = (
        await db.query<{ label: string; register: string; created_by: string | null }>(
          `SELECT h.label, h.register, u.email AS created_by FROM orders_heldsale h
             LEFT JOIN accounts_user u ON u.id = h.created_by_id WHERE h.id = $1`,
          [hold],
        )
      ).rows[0];
      const status = edited.responses[0]?.status;
      checks.push({
        name: `holds: an edit (${side}) that meets a resume mid-flight puts the hold back (D142, copied)`,
        passed:
          edited.waiting === 1 &&
          status === 200 &&
          row?.label === 'Edited late' &&
          row.register === 'R1' &&
          row.created_by === 'cashier@rangon.test',
        detail: `${status}, ${edited.waiting ? 'waited on the row' : 'never waited'}, ${row ? `the hold is back as "${row.label}"` : 'the hold is gone'}`,
      });
    }
    await restoreTables(db, HOLD_TABLES);
  } finally {
    await db.end();
  }
  return checks;
}
