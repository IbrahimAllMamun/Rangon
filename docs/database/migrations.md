# Migrations

The schema belongs to the API (`apps/api-nest/`) since Django was removed
([ADR-0023](../architecture/decisions/0023-django-is-gone.md)). It changes by a Drizzle migration and
in no other way.

## What is there

```text
apps/api-nest/drizzle/
  0000_baseline.sql          Django's schema as pg_dump wrote it, and the rows its migrations left
                             (ADR-0022). Never edited but for the line at its end that hands the
                             session its search path back.
  0001_drop_django_framework_tables.sql
                             the first migration written here: the tables only Django's framework used
  schema.ts, relations.ts    the whole schema, foreign keys included: what a migration is a difference from
  meta/                      drizzle-kit's journal and its snapshot of each migration
  django-head.json           the Django migrations a database Django built must be at to be adopted
apps/api-nest/src/database/schema.ts, relations.ts
                             the API's copy, without the foreign-key blocks (`npm run db:copy`)
```

## Making one

From `apps/api-nest/`:

1. Change `drizzle/schema.ts` (and `drizzle/relations.ts` for a join the ORM should know).
2. `npm run db:generate -- --name <what-it-does>` writes `drizzle/NNNN_<what-it-does>.sql` and its
   snapshot. It needs no database.
3. **Read the SQL**, and finish it by hand where `drizzle-kit` gets it wrong:
   - It writes `ALTER ... SET MAXVALUE 9223372036854776000` for bigint identities: a number rounded
     past bigint's range, which PostgreSQL refuses. Delete those lines.
   - It writes `DISABLE ROW LEVEL SECURITY` for a dropped table. Harmless; delete it.
   - A new foreign key is not deferrable. Every existing one is `DEFERRABLE INITIALLY DEFERRED`, as
     Django made them, and the replay's whole-table resets and several transactions depend on it: add
     it.
   - A column it adds may have a database default. The API writes every column; none has one.
4. `npm run db:copy` updates the API's copy, then build and type-check.
5. `node dist/cli.js migrate` on a database, and the replay (`scripts/nest-parity.sh replay`), which
   restores the recording's snapshot and migrates it first.

On a new database the migrations run in one transaction with the baseline. A migration that drops a
table the baseline wrote rows into needs `SET CONSTRAINTS ALL IMMEDIATE;` first, as `0001` has: a
table with deferred checks still owed cannot be dropped.

## Applying them

`node dist/cli.js migrate` is a release step of its own, before the new API starts and never as it
starts ([deployment.md](../operations/deployment.md)). It takes three databases:

- **An empty one**: every migration, the baseline first. Then `sync-permissions`.
- **One Django built**, at exactly the migrations in `django-head.json`: the baseline is recorded as
  applied and not run, then everything newer runs. A database at fewer Django migrations is refused:
  it needs the last release that had Django first
  ([upgrading-local-production.md](../operations/upgrading-local-production.md)).
- **One it migrated before**: what is newer than its record.

Anything else -- tables and nobody's record of them -- is refused. Destructive changes are made in two
releases, expand then contract, so that the release before can still run on the database while the
new one is rolled out.
