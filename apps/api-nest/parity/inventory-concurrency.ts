/**
 * Race checks for the stock writes of the inventory admin (phase 4), run by
 * run.ts after the comparison cases. Each puts the inventory rows and the
 * ledger back from a snapshot (`restore.ts`) and removes its audit entries.
 *
 * `inventory.services` locks the inventory row (`SELECT ... FOR UPDATE`)
 * before it reads the shelf. The mid-flight checks make the conflict on
 * purpose: the harness takes the row's lock, starts one request, waits until
 * that request is queued on the lock, moves stock itself -- a ledger row and
 * the cached figure, as the services write them -- and commits. The request
 * must then act on the committed figure, and the row must still agree with
 * its ledger. Without the lock the request reads the figure first, never
 * queues on the lock (only its UPDATE waits), and overwrites the harness's
 * movement: the row and its ledger disagree.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import { DOCUMENT_TABLES } from './stock-document-cases.ts';
import { send } from './run.ts';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const SIDES = (apis: { DJANGO: URL; NEST: URL }) =>
  [
    ['Django', apis.DJANGO],
    ['Nest', apis.NEST],
  ] as const;

export async function inventoryConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const rows = new Map(
      (
        await db.query<{ key: string; id: string; branch_id: string; variant_id: string }>(
          `SELECT b.code || ' ' || v.sku AS key, i.id, i.branch_id, i.variant_id
             FROM inventory_inventory i JOIN accounts_branch b ON b.id = i.branch_id
             JOIN catalog_productvariant v ON v.id = i.variant_id`,
        )
      ).rows.map((row) => [row.key, row]),
    );
    const shelf = rows.get('PAR3 RGN-CLA-L-WHI');
    const counted = rows.get('DHK1 RGN-LIN-M-WHI');
    if (!shelf || !counted) return [];
    const auth = await staffHeaders(db);
    const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]
      ?.now as string;
    const restore = async () => {
      await restoreTables(db, DOCUMENT_TABLES);
      await restoreSequences(db);
      await db.query(
        `DELETE FROM core_auditlog WHERE created_at >= $1
            AND action IN ('STOCK_ADJUSTMENT', 'STOCK_TRANSFER')`,
        [since],
      );
    };
    await restore();

    /** The row's cached figure, and what its ledger adds up to. */
    const state = async (id: string) =>
      (
        await db.query<{ on_hand: number; ledger: number }>(
          `SELECT i.on_hand, COALESCE((SELECT SUM(t.quantity) FROM inventory_inventorytransaction t
                    WHERE t.branch_id = i.branch_id AND t.variant_id = i.variant_id
                      AND t.transaction_type NOT IN ('RESERVATION', 'RESERVATION_RELEASE')), 0)::int AS ledger
             FROM inventory_inventory i WHERE i.id = $1`,
          [id],
        )
      ).rows[0] as { on_hand: number; ledger: number };

    const post = (api: URL, path: string, body: unknown, key?: string) =>
      send(api, {
        name: 'stock write',
        method: 'POST',
        path,
        headers: {
          ...auth('owner'),
          'content-type': 'application/json',
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: JSON.stringify(body),
      });

    /**
     * Hold `row`'s lock, start `request`, wait for it to queue on the lock,
     * take `moved` units off the shelf in the harness's own transaction, and
     * commit.
     */
    const midFlight = async (
      row: { id: string; branch_id: string; variant_id: string },
      moved: number,
      request: () => Promise<{ status: number; body: string }>,
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      const before = (
        await holder.query<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory_inventory WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
      ).rows[0] as { on_hand: number; reserved: number };
      const pending = request();
      let waited = false;
      for (let attempt = 0; attempt < 100 && !waited; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const found = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query ILIKE '%inventory_inventory%FOR UPDATE%' AND query NOT ILIKE '%pg_stat_activity%'`,
        );
        waited = Number(found.rows[0]?.count ?? 0) > 0;
      }
      const after = before.on_hand - moved;
      await holder.query(
        `INSERT INTO inventory_inventorytransaction
           (id, created_at, updated_at, branch_id, variant_id, transaction_type, quantity, unit_cost,
            on_hand_after, reserved_after, reference_type, reference_id, reason, notes)
         VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, $2, 'LOSS', $3, NULL, $4, $5,
                 'manual', '', 'Taken by the harness mid-flight', '')`,
        [row.branch_id, row.variant_id, -moved, after, before.reserved],
      );
      await holder.query(`UPDATE inventory_inventory SET on_hand = $2 WHERE id = $1`, [
        row.id,
        after,
      ]);
      await holder.query('COMMIT');
      await holder.end();
      return { waited, response: await pending, committed: after };
    };

    // 1. A write-off that meets a movement mid-flight is checked against the
    //    committed shelf: 6 on the shelf, the harness takes 4, the request's
    //    4 is then refused. Without the lock it read 6, took its 4 as well
    //    and wrote 2 over the harness's 2: the ledger says -2.
    for (const [side, api] of SIDES(apis)) {
      await restore();
      const { waited, response, committed } = await midFlight(shelf, 4, () =>
        post(api, '/api/v1/inventory/write-off/', {
          variant: shelf.variant_id,
          branch: shelf.branch_id,
          quantity: 4,
          transaction_type: 'DAMAGE',
          reason: 'Held',
        }),
      );
      const { on_hand, ledger } = await state(shelf.id);
      checks.push({
        name: `inventory: a write-off (${side}) that meets a movement mid-flight is checked against the committed shelf -- the lock holds`,
        passed: waited && response.status === 409 && on_hand === committed && ledger === on_hand,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, shelf ${on_hand} (expected ${committed}), ledger ${ledger}`,
      });
    }

    // 2. An adjustment that meets a movement mid-flight writes the difference
    //    from the committed figure, so the row lands on the count and its
    //    ledger agrees. Without the lock the difference was taken from the
    //    stale figure: the row reads 10, its ledger does not.
    for (const [side, api] of SIDES(apis)) {
      await restore();
      const { waited, response } = await midFlight(counted, 2, () =>
        post(api, '/api/v1/inventory/adjust/', {
          variant: counted.variant_id,
          branch: counted.branch_id,
          new_on_hand: 10,
          reason: 'Held count',
        }),
      );
      const { on_hand, ledger } = await state(counted.id);
      checks.push({
        name: `inventory: an adjustment (${side}) that meets a movement mid-flight lands on the count, its ledger agreeing -- the lock holds`,
        passed: waited && response.status === 201 && on_hand === 10 && ledger === 10,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, shelf ${on_hand}, ledger ${ledger}`,
      });
    }

    // 3. Six retries of one write-off, across both APIs at once: one ledger
    //    row, one unit off the shelf, every answer that row (D89, D90).
    await restore();
    const start = (await state(shelf.id)).on_hand;
    const retries = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(
          index % 2 ? apis.NEST : apis.DJANGO,
          '/api/v1/inventory/write-off/',
          {
            variant: shelf.variant_id,
            branch: shelf.branch_id,
            quantity: 1,
            transaction_type: 'LOSS',
            reason: 'Retried',
          },
          'parity-race-key',
        ),
      ),
    );
    const answered = new Set(
      retries.map((response) =>
        response.status === 201 ? (JSON.parse(response.body) as { id: string }).id : null,
      ),
    );
    const keyed = Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM inventory_inventorytransaction WHERE idempotency_key = 'parity-race-key'`,
        )
      ).rows[0]?.n,
    );
    const afterRetries = await state(shelf.id);
    checks.push({
      name: 'inventory: 6 simultaneous retries of one write-off across both APIs take one unit, once',
      passed:
        retries.every((response) => response.status === 201) &&
        answered.size === 1 &&
        keyed === 1 &&
        afterRetries.on_hand === start - 1 &&
        afterRetries.ledger === afterRetries.on_hand,
      detail: `statuses ${retries.map((r) => r.status).join(',')}, ${answered.size} row(s) answered, ${keyed} written, shelf ${start} -> ${afterRetries.on_hand}, ledger ${afterRetries.ledger}`,
    });

    // 4. Six write-offs of 2 from a shelf of 6, across both APIs at once:
    //    three succeed, three are refused, and nothing goes below zero.
    await restore();
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(index % 2 ? apis.NEST : apis.DJANGO, '/api/v1/inventory/write-off/', {
          variant: shelf.variant_id,
          branch: shelf.branch_id,
          quantity: 2,
          transaction_type: 'DAMAGE',
          reason: 'Burst',
        }),
      ),
    );
    const afterBurst = await state(shelf.id);
    const taken = burst.filter((response) => response.status === 201).length;
    checks.push({
      name: 'inventory: 6 simultaneous write-offs of 2 from a shelf of 6 across both APIs: 3 taken, 3 refused',
      passed:
        taken === 3 &&
        burst.filter((response) => response.status === 409).length === 3 &&
        afterBurst.on_hand === 0 &&
        afterBurst.ledger === 0,
      detail: `statuses ${burst.map((r) => r.status).join(',')}, shelf ${afterBurst.on_hand}, ledger ${afterBurst.ledger}`,
    });

    // 5. A transfer that meets a movement mid-flight is checked against the
    //    committed shelf at its source: 6 at PAR3, the harness takes 4, the
    //    transfer's 4 is refused. Without the lock it took them as well.
    const home = rows.get('DHK1 RGN-CLA-L-WHI');
    for (const [side, api] of SIDES(apis)) {
      await restore();
      const { waited, response, committed } = await midFlight(shelf, 4, () =>
        post(api, '/api/v1/stock-transfers/', {
          source_branch: shelf.branch_id,
          target_branch: home?.branch_id,
          lines: [{ variant: shelf.variant_id, quantity: 4 }],
        }),
      );
      const { on_hand, ledger } = await state(shelf.id);
      checks.push({
        name: `transfers: a transfer (${side}) that meets a movement at its source mid-flight is refused -- the lock holds`,
        passed: waited && response.status === 409 && on_hand === committed && ledger === on_hand,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, shelf ${on_hand} (expected ${committed}), ledger ${ledger}`,
      });
    }

    // 6. Six transfers of 2 from a shelf of 6, across both APIs at once:
    //    three move, three are refused; both ends agree with their ledgers.
    if (home) {
      await restore();
      const homeBefore = (await state(home.id)).on_hand;
      const moves = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          post(index % 2 ? apis.NEST : apis.DJANGO, '/api/v1/stock-transfers/', {
            source_branch: shelf.branch_id,
            target_branch: home.branch_id,
            lines: [{ variant: shelf.variant_id, quantity: 2 }],
          }),
        ),
      );
      const from = await state(shelf.id);
      const to = await state(home.id);
      const numbers = new Set(
        moves
          .filter((response) => response.status === 201)
          .map((response) => (JSON.parse(response.body) as { number: string }).number),
      );
      checks.push({
        name: 'transfers: 6 simultaneous transfers of 2 from a shelf of 6 across both APIs: 3 move, 3 refused',
        passed:
          numbers.size === 3 &&
          moves.filter((response) => response.status === 409).length === 3 &&
          from.on_hand === 0 &&
          from.ledger === 0 &&
          to.on_hand === homeBefore + 6 &&
          to.ledger === to.on_hand,
        detail: `statuses ${moves.map((r) => r.status).join(',')}, ${numbers.size} number(s), source ${from.on_hand} (ledger ${from.ledger}), target ${homeBefore} -> ${to.on_hand} (ledger ${to.ledger})`,
      });

      // 7. Six retries of one transfer: one document, the stock moved once.
      await restore();
      const retried = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          post(
            index % 2 ? apis.NEST : apis.DJANGO,
            '/api/v1/stock-transfers/',
            {
              source_branch: shelf.branch_id,
              target_branch: home.branch_id,
              lines: [{ variant: shelf.variant_id, quantity: 1 }],
            },
            'parity-race-transfer',
          ),
        ),
      );
      const answers = new Set(
        retried.map((response) =>
          response.status === 201 ? (JSON.parse(response.body) as { id: string }).id : null,
        ),
      );
      const documents = Number(
        (
          await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM inventory_stocktransfer WHERE idempotency_key = 'parity-race-transfer'`,
          )
        ).rows[0]?.n,
      );
      const after = await state(shelf.id);
      checks.push({
        name: 'transfers: 6 simultaneous retries of one transfer across both APIs make one document and move one unit',
        passed:
          retried.every((response) => response.status === 201) &&
          answers.size === 1 &&
          documents === 1 &&
          after.on_hand === 5 &&
          after.ledger === 5,
        detail: `statuses ${retried.map((r) => r.status).join(',')}, ${answers.size} answer(s), ${documents} document(s), shelf ${after.on_hand}, ledger ${after.ledger}`,
      });
    }

    // 8. An apply that meets a cancellation mid-flight: the harness holds the
    //    count's row, an apply queues on it, the harness cancels the count
    //    and commits. The apply must see the cancellation and refuse.
    //    Without the lock it read "counting" first and adjusted the stock.
    const sheet = (
      await db.query<{ id: string }>(
        `SELECT id FROM inventory_stockcount WHERE notes = 'Parity counting'`,
      )
    ).rows[0]?.id;
    if (sheet) {
      const adjustments = async () =>
        Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*) AS n FROM inventory_inventorytransaction
                WHERE reference_type = 'stock_count' AND reference_id = $1`,
              [sheet],
            )
          ).rows[0]?.n,
        );
      for (const [side, api] of SIDES(apis)) {
        await restore();
        const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await holder.connect();
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM inventory_stockcount WHERE id = $1 FOR UPDATE`, [sheet]);
        const pending = post(api, `/api/v1/stock-counts/${sheet}/apply/`, {});
        let waited = false;
        for (let attempt = 0; attempt < 100 && !waited; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const found = await db.query<{ count: string }>(
            `SELECT count(*) AS count FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND state = 'active'
                AND query ILIKE '%inventory_stockcount%FOR UPDATE%' AND query NOT ILIKE '%pg_stat_activity%'`,
          );
          waited = Number(found.rows[0]?.count ?? 0) > 0;
        }
        await holder.query(`UPDATE inventory_stockcount SET status = 'CANCELLED' WHERE id = $1`, [
          sheet,
        ]);
        await holder.query('COMMIT');
        await holder.end();
        const response = await pending;
        const written = await adjustments();
        checks.push({
          name: `counts: an apply (${side}) that meets a cancellation mid-flight refuses -- the lock holds`,
          passed: waited && response.status === 409 && written === 0,
          detail: `${response.status} ${response.body.slice(0, 70)}, ${waited ? 'waited on the lock' : 'never waited'}, ${written} adjustment(s)`,
        });
      }

      // 9. Two applies of one count at once, one per API: one applies, the
      //    other is refused, and the adjustments are written once.
      await restore();
      const both = await Promise.all([
        post(apis.DJANGO, `/api/v1/stock-counts/${sheet}/apply/`, {}),
        post(apis.NEST, `/api/v1/stock-counts/${sheet}/apply/`, {}),
      ]);
      const written = await adjustments();
      checks.push({
        name: 'counts: two simultaneous applies of one count, one per API: one applies, once',
        passed:
          both.filter((response) => response.status === 200).length === 1 &&
          both.filter((response) => response.status === 409).length === 1 &&
          written === 2,
        detail: `statuses ${both.map((r) => r.status).join(',')}, ${written} adjustment(s)`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
