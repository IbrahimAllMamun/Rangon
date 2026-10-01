/**
 * Race checks for the merchandising admin (phase 4 part 5c), run by run.ts
 * after the comparison cases. Each puts the three tables back and removes
 * its audit entries.
 *
 * `add_carousel_product` locks the carousel's run before it counts it and
 * looks for the product; `remove_carousel_product` locks the item (and, through
 * the join, its product); a move of a carousel item or a navigation item
 * locks its run. The harness proves each lock by holding it, starting one
 * request, waiting until the request is queued on it, and committing a change
 * the request must then see. Where PostgreSQL's snapshot keeps a request from
 * seeing a row inserted meanwhile, the outcome is Django's defect (D135,
 * D136) and the wait is the proof of the lock.
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

const TABLES = ['content_navigationitem', 'content_storefrontbanner', 'content_homecarouselitem'];

export async function merchandisingConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const exists = await db.query(`SELECT 1 FROM catalog_product WHERE slug = 'parity-rack-1'`);
    if (!exists.rowCount) return [];
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
    const call = (api: URL, method: string, path: string, body?: unknown) =>
      send(api, {
        name: 'merchandising write',
        method,
        path,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const count = async (sql: string, values: unknown[] = []) =>
      Number((await db.query<{ count: string }>(sql, values)).rows[0]?.count ?? 0);
    const product = async (slug: string) =>
      (await db.query<{ id: string }>(`SELECT id FROM catalog_product WHERE slug = $1`, [slug]))
        .rows[0]?.id as string;

    /**
     * Hold `lock`, start `request`, wait for it to queue on a lock -- a
     * statement naming `table`, `FOR UPDATE` (or `waitsOn`, where Django's
     * statement is longer than the 1024 bytes `pg_stat_activity` keeps) --
     * run `change`, commit.
     */
    const midFlight = async (
      lock: string,
      table: string,
      request: () => Promise<{ status: number; body: string }>,
      change: (holder: pg.Client) => Promise<void>,
      waitsOn = `%${table}%FOR UPDATE%`,
    ) => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(lock);
      const pending = request();
      let waited = false;
      for (let attempt = 0; attempt < 100 && !waited; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        waited =
          (await count(
            `SELECT count(*) AS count FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND state = 'active'
                AND query ILIKE $1 AND query NOT ILIKE '%pg_stat_activity%'`,
            [waitsOn],
          )) > 0;
      }
      await change(holder);
      await holder.query('COMMIT');
      await holder.end();
      return { waited, response: await pending };
    };

    /** The carousel filled to `size` with racks and other products not in it. */
    const fillCarousel = async (client: pg.Client, size: number) => {
      await client.query(
        `INSERT INTO content_homecarouselitem (id, created_at, updated_at, product_id, position)
         SELECT gen_random_uuid(), clock_timestamp(), clock_timestamp(), p.id,
                100 + row_number() OVER (ORDER BY p.slug)
           FROM catalog_product p
          WHERE p.status <> 'ARCHIVED' AND p.slug NOT IN ('parity-rack-6', 'parity-rack-7')
            AND p.id NOT IN (SELECT product_id FROM content_homecarouselitem)
          ORDER BY p.slug
          LIMIT ($1 - (SELECT count(*) FROM content_homecarouselitem))`,
        [size],
      );
    };
    const carouselSize = () => count(`SELECT count(*) AS count FROM content_homecarouselitem`);

    // 1. Six adds of one product at once, three per API: the product's unique
    //    index lets one in; the others are told it is already there.
    await restore();
    const rack = await product('parity-rack-1');
    const adds = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call((sides[i % 2] as readonly [string, URL])[1], 'POST', '/api/v1/home-carousel/', {
          product: rack,
        }),
      ),
    );
    const statuses = adds.map((response) => response.status);
    const rows = await count(
      `SELECT count(*) AS count FROM content_homecarouselitem WHERE product_id = $1`,
      [rack],
    );
    checks.push({
      name: 'carousel: 6 simultaneous adds of one product across both APIs add it once',
      passed:
        rows === 1 &&
        statuses.filter((status) => status === 201).length === 1 &&
        statuses.filter((status) => status === 409).length === 5,
      detail: `statuses ${statuses.join(',')}, ${rows} row(s)`,
    });

    // 2. D135, copied: an add that waited on the run's lock while another add
    //    committed counts the run as it was before it waited -- PostgreSQL's
    //    locking SELECT reads the statement's snapshot, so the new row is not
    //    in it -- and the carousel passes its 24. The wait proves the lock.
    for (const [side, api] of sides) {
      await restore();
      await fillCarousel(db, 23);
      const extra = await product('parity-rack-6');
      const added = await product('parity-rack-7');
      const { waited, response } = await midFlight(
        `SELECT id FROM content_homecarouselitem ORDER BY position, created_at FOR UPDATE`,
        'content_homecarouselitem',
        () => call(api, 'POST', '/api/v1/home-carousel/', { product: added }),
        async (holder) => {
          await holder.query(
            `INSERT INTO content_homecarouselitem (id, created_at, updated_at, product_id, position)
             VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, 500)`,
            [extra],
          );
        },
      );
      const size = await carouselSize();
      checks.push({
        name: `carousel: an add (${side}) that waited while another committed counts the run as it was, and passes 24 (D135, copied)`,
        passed: waited && response.status === 201 && size === 25,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, ${size} in the carousel`,
      });
    }

    // 3. A remove that meets the item deleted mid-flight finds nothing to
    //    remove: 404, and no audit entry. Without the lock it audits and
    //    "removes" a row already gone.
    for (const [side, api] of sides) {
      await restore();
      const item = (
        await db.query<{ id: string }>(
          `SELECT id FROM content_homecarouselitem ORDER BY position, created_at LIMIT 1`,
        )
      ).rows[0]?.id as string;
      const { waited, response } = await midFlight(
        `SELECT id FROM content_homecarouselitem WHERE id = '${item}' FOR UPDATE`,
        'content_homecarouselitem',
        () => call(api, 'DELETE', `/api/v1/home-carousel/${item}/`),
        async (holder) => {
          await holder.query(`DELETE FROM content_homecarouselitem WHERE id = $1`, [item]);
        },
        '%content_homecarouselitem%INNER JOIN%catalog_product%',
      );
      const audits = await count(
        `SELECT count(*) AS count FROM core_auditlog
          WHERE created_at >= $1 AND entity_type = 'HomeCarouselItem'`,
        [since],
      );
      checks.push({
        name: `carousel: a remove (${side}) that meets the item removed mid-flight finds nothing -- the lock holds`,
        passed: waited && response.status === 404 && audits === 0,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, ${audits} audit row(s)`,
      });
    }

    // 4. D132, copied, in the carousel: a move that waited on the run's lock
    //    renumbers the order it read before the wait, undoing a reorder
    //    committed meanwhile.
    const carouselOrder = async () =>
      (
        await db.query<{ ids: string }>(
          `SELECT string_agg(id::text, ' ' ORDER BY position, created_at) AS ids
             FROM content_homecarouselitem`,
        )
      ).rows[0]?.ids ?? '';
    await restore();
    const before = (await carouselOrder()).split(' ');
    const moving = before[1] as string;
    [before[1], before[2]] = [before[2] as string, before[1] as string];
    const expected = before.join(' ');
    for (const [side, api] of sides) {
      await restore();
      const { waited, response } = await midFlight(
        `SELECT id FROM content_homecarouselitem ORDER BY position, created_at FOR UPDATE`,
        'content_homecarouselitem',
        () => call(api, 'POST', `/api/v1/home-carousel/${moving}/move/`, { direction: 'down' }),
        async (holder) => {
          await holder.query(
            `UPDATE content_homecarouselitem SET position = position + 50 WHERE id = $1`,
            [before[0]],
          );
        },
      );
      const left = await carouselOrder();
      checks.push({
        name: `carousel: a move (${side}) that meets a reorder mid-flight renumbers the order it read before the wait (D132, copied)`,
        passed: waited && response.status === 200 && left === expected,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, ${left === expected ? 'as expected' : `left ${left}`}`,
      });
    }

    // 5. D132 in the navigation: a header item's move waits on its siblings'
    //    lock and renumbers the order it read before the wait.
    const sale = (
      await db.query<{ id: string }>(
        `SELECT id FROM content_navigationitem WHERE placement = 'HEADER' AND label = 'Sale'`,
      )
    ).rows[0]?.id as string;
    const headerOrder = async () =>
      (
        await db.query<{ ids: string }>(
          `SELECT string_agg(id::text, ' ' ORDER BY position, label) AS ids
             FROM content_navigationitem WHERE placement = 'HEADER' AND parent_id IS NULL`,
        )
      ).rows[0]?.ids ?? '';
    await restore();
    const header = (await headerOrder()).split(' ');
    const at = header.indexOf(sale);
    [header[at], header[at - 1]] = [header[at - 1] as string, header[at] as string];
    const headerExpected = header.join(' ');
    for (const [side, api] of sides) {
      await restore();
      const { waited, response } = await midFlight(
        `SELECT id FROM content_navigationitem WHERE parent_id IS NULL AND placement = 'HEADER'
          ORDER BY position, label FOR UPDATE`,
        'content_navigationitem',
        () => call(api, 'POST', `/api/v1/navigation-items/${sale}/move/`, { direction: 'up' }),
        async (holder) => {
          await holder.query(
            `UPDATE content_navigationitem SET position = position + 50
              WHERE placement = 'HEADER' AND parent_id IS NULL AND id <> $1`,
            [sale],
          );
        },
      );
      const left = await headerOrder();
      checks.push({
        name: `navigation: a move (${side}) that meets a reorder mid-flight renumbers the order it read before the wait (D132, copied)`,
        passed: waited && response.status === 200 && left === headerExpected,
        detail: `${response.status}, ${waited ? 'waited on the lock' : 'never waited'}, ${left === headerExpected ? 'as expected' : 'another order'}`,
      });
    }

    // 6. D136, copied: the footer's limit of four columns is a count no lock
    //    guards. A new column added while another's insert is not yet
    //    committed counts three and goes in: five columns.
    for (const [side, api] of sides) {
      await restore();
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO content_navigationitem (id, created_at, updated_at, placement, type, label, url,
           badge, image, description, layout, position, is_active)
         VALUES (gen_random_uuid(), now(), now(), 'FOOTER', 'GROUP', 'Fourth', '', '', '', '', 'AUTO', 8, true)`,
      );
      const response = await call(api, 'POST', '/api/v1/navigation-items/', {
        placement: 'FOOTER',
        type: 'GROUP',
        label: 'Raced',
      });
      await holder.query('COMMIT');
      await holder.end();
      const columns = await count(
        `SELECT count(*) AS count FROM content_navigationitem WHERE placement = 'FOOTER' AND type = 'GROUP'`,
      );
      checks.push({
        name: `navigation: a footer column (${side}) added while a fourth is being added goes in too, making five (D136, copied)`,
        passed: response.status === 201 && columns === 5,
        detail: `${response.status}, ${columns} column(s)`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
