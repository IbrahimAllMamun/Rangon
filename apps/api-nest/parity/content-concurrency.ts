/**
 * Race checks for the content admin's writes (phase 4 part 5), run by run.ts
 * after the comparison cases. Each puts the tables back and removes its audit
 * entries.
 *
 * `update_site_settings` and `update_social_link` lock their row before they
 * read it, and both then save every field they track from what they read --
 * the settings with a full `save()`. A write that read the row before
 * another committed would put that other write back. The harness makes the
 * conflict on purpose: it holds the row, starts one request, waits until the
 * request is queued on the lock, changes a field the request does not touch,
 * and commits. Both changes must survive. A move locks the whole run, and
 * one that meets a reorder mid-flight shows D132.
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

const TABLES = ['content_sitesettings', 'content_sociallink'];

export async function contentConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const links = new Map(
      (
        await db.query<{ platform: string; id: string }>(
          `SELECT platform, id FROM content_sociallink`,
        )
      ).rows.map((row) => [row.platform, row.id]),
    );
    if (!links.has('FACEBOOK')) return [];
    const auth = await staffHeaders(db);
    const since = (await db.query<{ now: string }>(`SELECT clock_timestamp() AS now`)).rows[0]
      ?.now as string;
    const restore = async () => {
      await restoreTables(db, TABLES);
      await db.query(
        `DELETE FROM core_auditlog WHERE created_at >= $1 AND action = 'SETTINGS_CHANGED'`,
        [since],
      );
    };
    await restore();
    const sides = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;

    /** Hold `lock`, start `request`, wait for it to queue on `waitsOn`, run `change`, commit. */
    const midFlight = async (
      lock: string,
      lockValues: unknown[],
      waitsOn: string,
      request: () => Promise<{ status: number; body: string }>,
      change: (holder: pg.Client) => Promise<void>,
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(lock, lockValues);
      const pending = request();
      let waited = false;
      for (let attempt = 0; attempt < 100 && !waited; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const found = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query ILIKE $1 AND query NOT ILIKE '%pg_stat_activity%'`,
          [`%${waitsOn}%FOR UPDATE%`],
        );
        waited = Number(found.rows[0]?.count ?? 0) > 0;
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { waited, response: await pending };
    };
    const call = (api: URL, method: string, path: string, body: unknown) =>
      send(api, {
        name: 'content write',
        method,
        path,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 1. The settings: the request changes the tagline while the harness
    //    changes the address. Without the lock, the full save writes the
    //    address back as it was read.
    for (const [side, api] of sides) {
      await restore();
      const { waited, response } = await midFlight(
        `SELECT id FROM content_sitesettings WHERE key = 'default' FOR UPDATE`,
        [],
        'content_sitesettings',
        () => call(api, 'PATCH', '/api/v1/site-settings/', { tagline: 'From the request' }),
        async (holder) => {
          await holder.query(
            `UPDATE content_sitesettings SET address = 'From the harness' WHERE key = 'default'`,
          );
        },
      );
      const row = (
        await db.query<{ tagline: string; address: string }>(
          `SELECT tagline, address FROM content_sitesettings WHERE key = 'default'`,
        )
      ).rows[0];
      checks.push({
        name: `content: a settings edit (${side}) that meets another mid-flight keeps both -- the lock holds`,
        passed:
          waited &&
          response.status === 200 &&
          row?.tagline === 'From the request' &&
          row.address === 'From the harness',
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, tagline ${JSON.stringify(row?.tagline)}, address ${JSON.stringify(row?.address)}`,
      });
    }

    // 2. A social link: the request changes the address while the harness
    //    hides the link. Without the lock, the request writes the stale
    //    visibility back with its address.
    for (const [side, api] of sides) {
      await restore();
      const { waited, response } = await midFlight(
        `SELECT id FROM content_sociallink WHERE id = $1 FOR UPDATE`,
        [links.get('FACEBOOK')],
        'content_sociallink',
        () =>
          call(api, 'PATCH', `/api/v1/social-links/${links.get('FACEBOOK')}/`, {
            url: 'facebook.com/raced',
          }),
        async (holder) => {
          await holder.query(`UPDATE content_sociallink SET is_visible = false WHERE id = $1`, [
            links.get('FACEBOOK'),
          ]);
        },
      );
      const row = (
        await db.query<{ url: string; is_visible: boolean }>(
          `SELECT url, is_visible FROM content_sociallink WHERE id = $1`,
          [links.get('FACEBOOK')],
        )
      ).rows[0];
      checks.push({
        name: `content: a social link edit (${side}) that meets a change mid-flight keeps both -- the lock holds`,
        passed:
          waited &&
          response.status === 200 &&
          row?.url === 'https://facebook.com/raced' &&
          row.is_visible === false,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, url ${row?.url}, visible ${row?.is_visible}`,
      });
    }

    // 3. D132, copied: a move renumbers the run in the order PostgreSQL
    //    sorted it before the move waited on the lock. Instagram's move down
    //    waits while the harness sends Facebook and YouTube to the end and
    //    commits; the move swaps Instagram with the row after it in the old
    //    order and renumbers 0..n, undoing the harness's reorder. Without the
    //    lock the outcome is the same -- only the wait tells the two apart.
    const order = async () =>
      (
        await db.query<{ platforms: string }>(
          `SELECT string_agg(platform || position, ' ' ORDER BY position, platform) AS platforms
             FROM content_sociallink`,
        )
      ).rows[0]?.platforms ?? '';
    await restore();
    const before = (
      await db.query<{ platform: string }>(
        `SELECT platform FROM content_sociallink ORDER BY position, platform`,
      )
    ).rows.map((row) => row.platform);
    const at = before.indexOf('INSTAGRAM');
    [before[at], before[at + 1]] = [before[at + 1] as string, before[at] as string];
    const expected = before.map((platform, offset) => `${platform}${offset}`).join(' ');
    for (const [side, api] of sides) {
      await restore();
      const { waited, response } = await midFlight(
        `SELECT id FROM content_sociallink ORDER BY position, platform FOR UPDATE`,
        [],
        'content_sociallink',
        () =>
          call(api, 'POST', `/api/v1/social-links/${links.get('INSTAGRAM')}/move/`, {
            direction: 'down',
          }),
        async (holder) => {
          await holder.query(
            `UPDATE content_sociallink SET position = position + 20
              WHERE platform IN ('FACEBOOK', 'YOUTUBE')`,
          );
        },
      );
      const left = await order();
      checks.push({
        name: `content: a social link move (${side}) that meets a reorder mid-flight renumbers the order it sorted before the wait (D132, copied)`,
        passed: waited && response.status === 200 && left === expected,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, left ${left}${left === expected ? '' : ` (expected ${expected})`}`,
      });
    }

    // 4. D132 again: two moves of Instagram down queue together behind the
    //    harness's lock, one per API. Both sorted the run before they waited,
    //    so the second swaps the same pair from the same stale order: the
    //    link moves one place, not two.
    await restore();
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM content_sociallink ORDER BY position, platform FOR UPDATE`);
    const moves = sides.map(([, api]) =>
      call(api, 'POST', `/api/v1/social-links/${links.get('INSTAGRAM')}/move/`, {
        direction: 'down',
      }),
    );
    let queued = 0;
    for (let attempt = 0; attempt < 100 && queued < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const found = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active'
            AND query ILIKE '%content_sociallink%FOR UPDATE%'
            AND query NOT ILIKE '%pg_stat_activity%'`,
      );
      queued = Number(found.rows[0]?.count ?? 0);
    }
    await holder.query('COMMIT');
    await holder.end();
    const statuses = (await Promise.all(moves)).map((response) => response.status);
    const left = await order();
    checks.push({
      name: 'content: two social link moves down that queue together, one per API, move it one place (D132, copied)',
      passed: queued === 2 && statuses.every((status) => status === 200) && left === expected,
      detail: `statuses ${statuses.join(',')}, ${queued} queued on the lock, left ${left}${left === expected ? '' : ` (expected ${expected})`}`,
    });
    await restore();
    checks.push(...(await pageChecks(db, sides, call, midFlight, since)));
  } finally {
    await db.end();
  }
  return checks;
}

type Call = (
  api: URL,
  method: string,
  path: string,
  body: unknown,
) => Promise<{ status: number; body: string }>;
type MidFlight = (
  lock: string,
  lockValues: unknown[],
  waitsOn: string,
  request: () => Promise<{ status: number; body: string }>,
  change: (holder: pg.Client) => Promise<void>,
) => Promise<{ waited: boolean; response: { status: number; body: string } }>;

/**
 * The site pages (part 5b). A create relies on the slug's unique index, in a
 * transaction of its own: of six at once, one is created and the rest are
 * told the address is taken. An edit and a delete lock the page by slug
 * before they read it; the harness proves each lock by changing the page
 * while the request waits on it.
 */
async function pageChecks(
  db: pg.Client,
  sides: readonly (readonly [string, URL])[],
  call: Call,
  midFlight: MidFlight,
  since: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const restore = async () => {
    await restoreTables(db, ['content_sitepage', 'content_navigationitem']);
    await db.query(
      `DELETE FROM core_auditlog WHERE created_at >= $1 AND action = 'SETTINGS_CHANGED'`,
      [since],
    );
  };
  const audits = async (label: string) =>
    Number(
      (
        await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM core_auditlog
            WHERE created_at >= $1 AND entity_type = 'SitePage' AND entity_label = $2`,
          [since, label],
        )
      ).rows[0]?.count ?? 0,
    );

  // 1. Six creates of one address at once, three per API.
  await restore();
  const creates = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      call((sides[i % 2] as readonly [string, URL])[1], 'POST', '/api/v1/site-pages/', {
        title: 'Raced page',
        slug: 'raced-page',
      }),
    ),
  );
  const statuses = creates.map((response) => response.status);
  const rows = Number(
    (
      await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM content_sitepage WHERE slug = 'raced-page'`,
      )
    ).rows[0]?.count ?? 0,
  );
  const created = await audits('Raced page');
  checks.push({
    name: 'pages: 6 simultaneous creates of one address across both APIs make one page',
    passed:
      rows === 1 &&
      created === 1 &&
      statuses.filter((status) => status === 201).length === 1 &&
      statuses.filter((status) => status === 409).length === 5,
    detail: `statuses ${statuses.join(',')}, ${rows} page(s), ${created} audit row(s)`,
  });

  // 2. An edit that meets the same edit mid-flight: the request sets the title
  //    the harness has just committed, so it finds nothing to change -- no
  //    save, no audit row. Without the lock it reads the old title, saves and
  //    audits a change that has already been made.
  for (const [side, api] of sides) {
    await restore();
    const { waited, response } = await midFlight(
      `SELECT id FROM content_sitepage WHERE slug = 'parity-faq' FOR UPDATE`,
      [],
      'content_sitepage',
      () => call(api, 'PATCH', '/api/v1/site-pages/parity-faq/', { title: 'Raced title' }),
      async (holder) => {
        await holder.query(
          `UPDATE content_sitepage SET title = 'Raced title' WHERE slug = 'parity-faq'`,
        );
      },
    );
    const page = (
      await db.query<{ updated_by_id: string | null }>(
        `SELECT updated_by_id FROM content_sitepage WHERE slug = 'parity-faq'`,
      )
    ).rows[0];
    const audited = await audits('Raced title');
    checks.push({
      name: `pages: an edit (${side}) that meets the same edit mid-flight changes nothing -- the lock holds`,
      passed: waited && response.status === 200 && audited === 0 && page?.updated_by_id === null,
      detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, ${audited} audit row(s), updated by ${page?.updated_by_id ?? 'nobody'}`,
    });
  }

  // 3. A delete that meets the page made one of the standard pages
  //    mid-flight is refused and leaves it. Without the lock it reads the
  //    page as it was and deletes it.
  for (const [side, api] of sides) {
    await restore();
    const { waited, response } = await midFlight(
      `SELECT id FROM content_sitepage WHERE slug = 'parity-faq' FOR UPDATE`,
      [],
      'content_sitepage',
      () => call(api, 'DELETE', '/api/v1/site-pages/parity-faq/', undefined),
      async (holder) => {
        await holder.query(
          `UPDATE content_sitepage SET is_system = true WHERE slug = 'parity-faq'`,
        );
      },
    );
    const left = Number(
      (
        await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM content_sitepage WHERE slug = 'parity-faq'`,
        )
      ).rows[0]?.count ?? 0,
    );
    checks.push({
      name: `pages: a delete (${side}) that meets the page made standard mid-flight is refused -- the lock holds`,
      passed: waited && response.status === 400 && left === 1 && (await audits('FAQ')) === 0,
      detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, ${left} page(s) left`,
    });
  }
  await restore();
  return checks;
}
