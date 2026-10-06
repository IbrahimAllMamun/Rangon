/**
 * Race checks for review moderation (phase 6 part 9), run by run.ts after the
 * comparison cases. Each puts the reviews back.
 *
 * A decision takes no lock in either API: it reads the review, then writes
 * the status, the moderator, the time and the note it read or was given.
 * These checks show what that leaves, the same in both.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { behind, type Check, statuses } from './races.ts';
import { resetReviews, reviewsFixture } from './reviews-cases.ts';
import { send } from './run.ts';

export async function reviewsConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const id = (
      await one<{ id: string }>(`SELECT id FROM engagement_review WHERE title = 'Parity mod five'`)
    )?.id;
    if (!id) {
      // There when the cases were built and gone now: an earlier suite deleted the
      // fixture's reviews, and every case about them matched as a 404.
      return reviewsFixture.seen
        ? [
            {
              name: "reviews: the fixture's reviews are still there after the cases",
              passed: false,
              detail: 'Parity mod five is gone: another suite deleted it mid-run',
            },
          ]
        : [];
    }
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetReviews(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const decide = (api: URL, decision: 'approve' | 'reject', body: Record<string, unknown>) =>
      send(api, {
        name: 'review',
        method: 'POST',
        path: `/api/v1/reviews/${id}/${decision}/`,
        headers: { ...auth('manager'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const state = async () =>
      (await one<{ status: string; note: string; entries: string; last: string }>(
        `SELECT r.status, r.moderation_note AS note,
                (SELECT count(*)::text FROM core_auditlog a
                  WHERE a.entity_id = r.id::text AND a.created_at >= $2) AS entries,
                COALESCE((SELECT a.new_values->>'status' FROM core_auditlog a
                           WHERE a.entity_id = r.id::text AND a.created_at >= $2
                           ORDER BY a.created_at DESC LIMIT 1), '') AS last
           FROM engagement_review r WHERE r.id = $1`,
        [id, since],
      )) as { status: string; note: string; entries: string; last: string };

    // 1. Six decisions at once, three each way.
    await restore();
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        decide(index % 2 ? apis.NEST : apis.DJANGO, index < 3 ? 'approve' : 'reject', {
          note: `Decision ${index}`,
        }),
      ),
    );
    let end = await state();
    checks.push({
      name: 'reviews: 6 decisions on one review at once, three each way, across both APIs -- six 200s and six audit entries; the review is left as one of them decided',
      passed:
        statuses(burst).join() === '200,200,200,200,200,200' &&
        end.entries === '6' &&
        (end.status === 'APPROVED' || end.status === 'REJECTED') &&
        /^Decision [0-5]$/.test(end.note),
      detail: `statuses ${statuses(burst).join(',')}, ${end.entries} audit entries, left ${end.status} with "${end.note}"`,
    });

    // 2. A review rejected with a reason while an approval with no note waits to write.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM engagement_review WHERE id = $1 FOR UPDATE`, [id]],
        '%UPDATE%engagement_review%',
        [() => decide(api, 'approve', {})],
        async (holder) => {
          await holder.query(
            `UPDATE engagement_review SET status = 'REJECTED', moderation_note = 'Spam, by the harness'
              WHERE id = $1`,
            [id],
          );
        },
      );
      end = await state();
      const answer = held.responses[0];
      checks.push({
        name: `reviews: a review rejected with a reason while an approval of it with no note (${side}) waits to write -- the approval stands and the reason is gone: it writes back the note it read (copied: no lock)`,
        passed:
          held.queued === 1 &&
          answer?.status === 200 &&
          end.status === 'APPROVED' &&
          end.note === '',
        detail: `${answer?.status}, ${held.queued ? 'its write waited' : 'never waited'}, left ${end.status} with "${end.note}"`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
