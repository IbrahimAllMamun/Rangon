import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/** `drizzle/`, beside `src/` in a checkout and beside `dist/` in the image. */
export const MIGRATIONS = join(__dirname, '..', '..', 'drizzle');

/** A refusal with a reason an operator can act on: printed without a stack. */
export class Refusal extends Error {}

/** What stands between a database Django built and the baseline: nothing, or these. */
export function againstTheBaseline(
  head: readonly (readonly [app: string, name: string])[],
  applied: readonly (readonly [app: string, name: string])[],
): { missing: string[]; unknown: string[] } {
  const key = ([app, name]: readonly [string, string]) => `${app}.${name}`;
  const wanted = new Set(head.map(key));
  const have = new Set(applied.map(key));
  return {
    missing: [...wanted].filter((migration) => !have.has(migration)).sort(),
    unknown: [...have].filter((migration) => !wanted.has(migration)).sort(),
  };
}

/**
 * `migrate`: bring a database's schema to what this build expects.
 *
 * Three databases can be handed to it:
 *
 * - **An empty one.** The baseline runs: the schema Django's migrations
 *   build, and the rows they leave (drizzle/0000_baseline.sql).
 * - **One Django built**, which is every database there is today. The
 *   baseline is recorded as applied and is not run: the tables are there.
 *   That is allowed only where Django's own record says the database is at
 *   the migrations the baseline was cut from -- no fewer, or the schema is
 *   older than this build; no more, or the baseline is.
 * - **One this command has migrated before.** Whatever is newer than its
 *   record runs; nothing, for as long as the baseline is all there is.
 *
 * Anything else -- tables, and nobody's record of how they came -- is refused.
 *
 * A release step of its own, never run as the API starts
 * (docs/architecture/django-removal-plan.md, step 3). Until that plan's step
 * 6.4 Django migrates production and this is exercised in CI alone.
 */
export async function migrate(databaseUrl: string, log: (line: string) => void): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const exists = async (name: string) =>
      (
        await client.query<{ found: string | null }>(`SELECT to_regclass($1)::text AS found`, [
          name,
        ])
      ).rows[0]?.found !== null;
    const count = async (sql: string) =>
      Number((await client.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
    const recorded = async () =>
      (await exists('drizzle.__drizzle_migrations'))
        ? count(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)
        : 0;

    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS });
    const baseline = migrations[0];
    if (!baseline) throw new Refusal(`No migrations in ${MIGRATIONS}.`);
    const before = await recorded();

    if (before === 0 && (await exists('public.django_migrations'))) {
      const head = JSON.parse(
        readFileSync(join(MIGRATIONS, 'meta', 'django-head.json'), 'utf8'),
      ) as [string, string][];
      const applied = (
        await client.query<{ app: string; name: string }>(
          `SELECT app, name FROM public.django_migrations`,
        )
      ).rows.map((row) => [row.app, row.name] as const);
      const { missing, unknown } = againstTheBaseline(head, applied);
      if (missing.length) {
        throw new Refusal(
          `This database is behind the baseline: Django has not applied ${missing.join(', ')}. ` +
            `Run Django's migrate first; nothing was changed.`,
        );
      }
      if (unknown.length) {
        throw new Refusal(
          `This database is ahead of the baseline: it has ${unknown.join(', ')}, which the ` +
            `baseline was not cut from (scripts/nest-baseline.sh cut). Nothing was changed.`,
        );
      }
      // The table as Drizzle's migrator makes it, and the row it would have written.
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations
           (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      );
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [baseline.hash, baseline.folderMillis],
      );
      await client.query('COMMIT');
      log(
        `adopted: Django built this database (${applied.length} of its migrations, the ` +
          `baseline's own); the baseline is recorded as applied and was not run`,
      );
    } else if (before === 0) {
      const tables = await count(
        `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      if (tables > 0) {
        throw new Refusal(
          `This database has ${tables} tables and no record of a migration, Django's or this ` +
            `command's. The baseline is for an empty database; nothing was changed.`,
        );
      }
    }

    const known = await recorded();
    await applyMigrations(drizzle(client), { migrationsFolder: MIGRATIONS });
    const applied = (await recorded()) - known;
    log(
      applied
        ? `applied ${applied} migration${applied === 1 ? '' : 's'}: the schema is this build's`
        : `nothing to apply: the schema is this build's (${migrations.length} migration${migrations.length === 1 ? '' : 's'} on record)`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
