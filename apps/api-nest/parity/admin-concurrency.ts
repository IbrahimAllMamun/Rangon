/**
 * Race checks for the staff endpoints (phase 4), run by run.ts after the
 * comparison cases beside parity/concurrency.ts. Each restores what it wrote.
 *
 * `POST /attribute-values/<id>/move/` locks every value of the attribute
 * (`ORDER BY position, value ... FOR UPDATE`) before it swaps. Simultaneous
 * moves cannot show that lock reliably, so the harness makes the conflict on
 * purpose: it takes the lock itself, starts one move, waits until that move
 * is queued on the lock, reorders the values and commits. The move must then
 * act on the order the harness committed. Each API is checked the same way.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const ORDER = `SELECT string_agg(v.value || v.position, ' ' ORDER BY v.position, v.value) AS positions
  FROM catalog_attributevalue v JOIN catalog_attribute a ON a.id = v.attribute_id
 WHERE a.code = 'parity-order'`;

export async function adminConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const auth = await staffHeaders(db);
    const values = new Map(
      (
        await db.query<{ value: string; id: string }>(
          `SELECT v.value, v.id FROM catalog_attributevalue v
             JOIN catalog_attribute a ON a.id = v.attribute_id WHERE a.code = 'parity-order'`,
        )
      ).rows.map((row) => [row.value, row.id]),
    );
    if (values.size !== 4) return [];
    const setPositions = async (client: pg.Client, positions: Record<string, number>) => {
      for (const [value, position] of Object.entries(positions)) {
        await client.query(`UPDATE catalog_attributevalue SET position = $2 WHERE id = $1`, [
          values.get(value),
          position,
        ]);
      }
    };
    const original = { a: 0, b: 0, c: 0, d: 0 };

    /**
     * Hold the lock, start one move on `api`, wait for it to queue, apply
     * `committed` and commit, then read the order the move left.
     */
    const midFlight = async (
      api: URL,
      start: Record<string, number>,
      moved: string,
      direction: string,
      committed: Record<string, number>,
    ): Promise<{ waited: boolean; status: number; positions: string }> => {
      await setPositions(db, start);
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(
        `SELECT v.id FROM catalog_attributevalue v JOIN catalog_attribute a ON a.id = v.attribute_id
          WHERE a.code = 'parity-order' ORDER BY v.position, v.value FOR UPDATE OF v`,
      );
      const pending = send(api, {
        name: 'move held',
        method: 'POST',
        path: `/api/v1/attribute-values/${values.get(moved)}/move/`,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      let waited = false;
      for (let attempt = 0; attempt < 100 && !waited; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const row = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query ILIKE '%catalog_attributevalue%FOR UPDATE%'`,
        );
        waited = Number(row.rows[0]?.count ?? 0) > 0;
      }
      await setPositions(holder, committed);
      await holder.query('COMMIT');
      await holder.end();
      const response = await pending;
      const positions = (await db.query<{ positions: string }>(ORDER)).rows[0]?.positions ?? '';
      await setPositions(db, original);
      return { waited, status: response.status, positions };
    };

    // PostgreSQL sorts a locking SELECT before it waits: a move that queued
    // on the lock gets every value's committed position, in the order the
    // values had before. The checks are written for that.
    //
    // 1. The lock holds. From a0 b1 c2 d3, "a down" waits while the harness
    //    sends b to the end (b5) and commits. With the lock the move reads
    //    b's committed 5 and swaps it: b0 c2 d3 a5. Without it, it read b1
    //    first and wrote a1 b0 over the harness's change: b0 a1 c2 d3.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      const result = await midFlight(api, { a: 0, b: 1, c: 2, d: 3 }, 'a', 'down', { b: 5 });
      const expected = 'b0 c2 d3 a5';
      checks.push({
        name: `attribute values: a move (${side}) that meets a reorder mid-flight acts on the committed positions -- the lock holds`,
        passed: result.waited && result.status === 200 && result.positions === expected,
        detail: `move ${result.status}, ${result.waited ? 'waited on the lock' : 'never waited'}, left ${result.positions} (expected ${expected})`,
      });
    }

    // 2. D118, copied: the moved value's own position is read before the lock.
    //    From a0 b1 c2 d3, "c down" waits while the harness moves c up past b
    //    (c1 b2) and commits. The move swaps c with d from c's stale 2, not
    //    its committed 1, so d lands on 2 beside b. Both APIs leave the same
    //    duplicate, and so agree until Django is fixed.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      const result = await midFlight(api, { a: 0, b: 1, c: 2, d: 3 }, 'c', 'down', { c: 1, b: 2 });
      const expected = 'a0 b2 d2 c3';
      checks.push({
        name: `attribute values: a move (${side}) of a value moved mid-flight swaps from its stale position (D118, copied)`,
        passed: result.waited && result.status === 200 && result.positions === expected,
        detail: `move ${result.status}, ${result.waited ? 'waited on the lock' : 'never waited'}, left ${result.positions} (expected ${expected})`,
      });
    }
  } finally {
    await db.end();
  }
  return checks;
}
