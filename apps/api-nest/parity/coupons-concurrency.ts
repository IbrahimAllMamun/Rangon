/**
 * Race checks for the back office's coupons (phase 6 part 7), run by run.ts
 * after the comparison cases. Each puts the coupon tables back.
 *
 * A redemption takes the coupon's row lock (phase 3). The back office's edit
 * takes none: it writes every column back as it read them.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetCoupons } from './coupons-cases.ts';
import { behind, type Check, statuses } from './races.ts';
import { send } from './run.ts';

export async function couponsConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const big = (
      await one<{ id: string }>(`SELECT id FROM promotions_coupon WHERE code = 'PARITY-BIG'`)
    )?.id;
    if (!big) return [];
    const auth = await staffHeaders(db);
    const call = (api: URL, method: string, path: string, body: unknown) =>
      send(api, {
        name: 'coupons',
        method,
        path,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);

    // 1. Six coupons of one code at once.
    await resetCoupons(db);
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call(either(index), 'POST', '/api/v1/coupons/', {
          code: 'PARITY-RACED',
          discount_type: 'FIXED',
          value: '10',
        }),
      ),
    );
    const raced = await one<{ count: string }>(
      `SELECT count(*)::text AS count FROM promotions_coupon WHERE code = 'PARITY-RACED'`,
    );
    checks.push({
      name: 'coupons: 6 coupons of one code at once, across both APIs -- one is made; the rest are told the code is taken (400) or meet the unique index (409)',
      passed:
        made.filter((response) => response.status === 201).length === 1 &&
        statuses(made).every((status) => [201, 400, 409].includes(status)) &&
        raced?.count === '1',
      detail: `statuses ${statuses(made).join(',')}, ${raced?.count} coupon of the code`,
    });

    // 2. A coupon redeemed while an edit of it waits at its UPDATE.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await resetCoupons(db);
      const held = await behind(
        db,
        [`SELECT id FROM promotions_coupon WHERE id = $1 FOR UPDATE`, [big]],
        '%promotions_coupon%',
        [() => call(api, 'PATCH', `/api/v1/coupons/${big}/`, { description: 'Edited mid-flight' })],
        async (holder) => {
          await holder.query(
            `UPDATE promotions_coupon SET used_count = used_count + 1 WHERE id = $1`,
            [big],
          );
        },
      );
      const end = await one<{ used_count: number; description: string }>(
        `SELECT used_count, description FROM promotions_coupon WHERE id = $1`,
        [big],
      );
      checks.push({
        name: `coupons: a coupon redeemed while an edit of it (${side}) waits at its UPDATE has its use forgotten: the edit writes back the count it read (D203, copied) -- no lock is involved`,
        passed:
          held.queued === 1 &&
          held.responses[0]?.status === 200 &&
          end?.used_count === 0 &&
          end.description === 'Edited mid-flight',
        detail: `${held.responses[0]?.status}, ${held.queued ? 'waited at its UPDATE' : 'never waited'}, used ${end?.used_count} time(s)`,
      });
    }
    await resetCoupons(db);
  } finally {
    await db.end();
  }
  return checks;
}
