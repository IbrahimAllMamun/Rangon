/**
 * Race checks for notifications (phase 7 part 2), run by run.ts after the
 * comparison cases. Each puts the notices back.
 *
 * Marking read takes no lock in either API: it is one `UPDATE` of the
 * reader's unread notices, and PostgreSQL looks at a row again once it has
 * waited for it. These checks show that is enough: no notice is counted, or
 * stamped, twice.
 */
import pg from 'pg';

import {
  AUDITOR,
  notificationsFixture,
  readerHeaders,
  resetNotifications,
} from './notifications-cases.ts';
import { behind, type Check, statuses } from './races.ts';
import { send } from './run.ts';

export async function notificationsConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const reader = (
      await one<{ id: string }>(`SELECT id FROM accounts_user WHERE email = $1`, [AUDITOR])
    )?.id;
    const held = (
      await one<{ id: string }>(
        `SELECT id FROM notifications_notification WHERE title = 'Parity notice one'`,
      )
    )?.id;
    if (!reader || !held) {
      // There when the cases were built and gone now: another suite deleted them.
      return notificationsFixture.seen
        ? [
            {
              name: "notifications: the fixture's notices are still there after the cases",
              passed: false,
              detail: 'Parity notice one is gone: another suite deleted it mid-run',
            },
          ]
        : [];
    }
    const headers = (await readerHeaders(db))[AUDITOR] as Record<string, string>;
    const markAll = (api: URL) =>
      send(api, {
        name: 'mark read',
        method: 'POST',
        path: '/api/v1/notifications/mark-read/',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
    const updated = (body: string) => (JSON.parse(body) as { updated?: number }).updated ?? -1;
    const unread = async () =>
      Number(
        (
          await one<{ count: string }>(
            `SELECT count(*) AS count FROM notifications_notification
              WHERE user_id = $1 AND read_at IS NULL`,
            [reader],
          )
        )?.count,
      );

    // 1. Six requests to mark everything read, at once.
    await resetNotifications(db);
    const before = await unread();
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, index) => markAll(index % 2 ? apis.NEST : apis.DJANGO)),
    );
    const counted = burst.map((response) => updated(response.body));
    const total = counted.reduce((sum, count) => sum + count, 0);
    checks.push({
      name: 'notifications: 6 requests to mark everything read at once, across both APIs -- six 200s; each notice is counted by one of them, and none is left unread',
      passed:
        before > 0 &&
        statuses(burst).join() === '200,200,200,200,200,200' &&
        total === before &&
        (await unread()) === 0,
      detail: `statuses ${statuses(burst).join(',')}, ${before} unread before, counted ${counted.join('+')} = ${total}, ${await unread()} left`,
    });

    // 2. A notice read by someone else's request while a mark-all waits on its row.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await resetNotifications(db);
      const there = await unread();
      const waited = await behind(
        db,
        [`SELECT id FROM notifications_notification WHERE id = $1 FOR UPDATE`, [held]],
        '%UPDATE%notifications_notification%',
        [() => markAll(api)],
        async (holder) => {
          await holder.query(
            `UPDATE notifications_notification SET read_at = '2025-04-05 00:00:00+06' WHERE id = $1`,
            [held],
          );
        },
      );
      const answer = waited.responses[0];
      const kept = await one<{ kept: boolean }>(
        `SELECT read_at = '2025-04-05 00:00:00+06' AS kept FROM notifications_notification WHERE id = $1`,
        [held],
      );
      checks.push({
        name: `notifications: a notice read while a request to mark everything (${side}) waits on its row -- the request leaves it as it was read and counts the others (no lock is involved: the UPDATE looks again)`,
        passed:
          waited.queued === 1 &&
          answer?.status === 200 &&
          updated(answer.body) === there - 1 &&
          kept?.kept === true &&
          (await unread()) === 0,
        detail: `${answer?.status} ${answer?.body}, ${waited.queued ? 'its UPDATE waited' : 'never waited'}, ${there} unread before, the held notice ${kept?.kept ? 'kept its moment' : 'was stamped again'}`,
      });
    }
    await resetNotifications(db);
  } finally {
    await db.end();
  }
  return checks;
}
