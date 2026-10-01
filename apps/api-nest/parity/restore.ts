/**
 * Whole-table resets for the admin write cases.
 *
 * The first call copies each table into a temporary table on the harness's
 * own connection (which lives for the whole run); every later call puts the
 * table back exactly: rows a request created are deleted, rows it deleted
 * are re-inserted, and every surviving row gets its snapshot's values back,
 * timestamps included. Rows are told apart by primary key, never by time.
 *
 * One transaction per reset: Django creates its foreign keys
 * `DEFERRABLE INITIALLY DEFERRED`, so the order of the three steps across
 * tables does not matter until the commit.
 */
import type pg from 'pg';

const columnsCache = new Map<string, string[]>();

async function columnsOf(client: pg.Client, table: string): Promise<string[]> {
  const cached = columnsCache.get(table);
  if (cached) return cached;
  const rows = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  const columns = rows.rows.map((row) => row.column_name);
  columnsCache.set(table, columns);
  return columns;
}

export async function restoreTables(client: pg.Client, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS "snap_${table}" AS SELECT * FROM "${table}"`,
    );
  }
  await client.query('BEGIN');
  try {
    for (const table of tables) {
      await client.query(
        `DELETE FROM "${table}" WHERE "id" NOT IN (SELECT "id" FROM "snap_${table}")`,
      );
    }
    for (const table of tables) {
      await client.query(
        `INSERT INTO "${table}" SELECT * FROM "snap_${table}" s
          WHERE s."id" NOT IN (SELECT "id" FROM "${table}")`,
      );
      const columns = (await columnsOf(client, table)).filter((column) => column !== 'id');
      const list = columns.map((column) => `"${column}"`).join(', ');
      const values = columns.map((column) => `s."${column}"`).join(', ');
      await client.query(
        `UPDATE "${table}" t SET (${list}) = ROW(${values}) FROM "snap_${table}" s
          WHERE t."id" = s."id" AND ROW(${columns.map((c) => `t."${c}"`).join(', ')})
                IS DISTINCT FROM ROW(${values})`,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** `core_numbersequence` (keyed by `key`): new sequences removed, the rest put back. */
export async function restoreSequences(client: pg.Client): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS "snap_core_numbersequence" AS SELECT * FROM core_numbersequence`,
  );
  await client.query(
    `DELETE FROM core_numbersequence WHERE key NOT IN (SELECT key FROM "snap_core_numbersequence")`,
  );
  await client.query(
    `UPDATE core_numbersequence n SET last_value = s.last_value, prefix = s.prefix,
            padding = s.padding, updated_at = s.updated_at
       FROM "snap_core_numbersequence" s
      WHERE s.key = n.key AND (n.last_value, n.updated_at) IS DISTINCT FROM (s.last_value, s.updated_at)`,
  );
}
