# ADR-0022 — The NestJS API's baseline is Django's schema as `pg_dump` wrote it, applied by Drizzle's migrator

**Status:** Accepted · 2026-10-14 · step 3 of [the removal plan](../django-removal-plan.md); authorised by [ADR-0020](0020-django-is-removed-in-steps.md), which leaves the point of no return (step 6.4) to the owner

## Context

Django owns the schema: 54 migrations of this project's and its framework's own, 96 tables. The
NestJS API reads a description of it (`src/database/schema.ts`) that `drizzle-kit pull` wrote
from a database Django had migrated, and has never created a table.

Step 3 of the plan asks for the NestJS API to be *able* to: a baseline migration that builds
today's schema from nothing, a rule for the databases that already have it, a command in the
image, and the roles and permissions that Django's `post_migrate` hook creates. It sets the
proof: a database built by the baseline and one built by Django's migrations have identical
`pg_dump --schema-only` output.

Drizzle's own answer to "baseline" is the migration `drizzle-kit pull` writes. That one cannot
pass the proof. Django declares every foreign key `DEFERRABLE INITIALLY DEFERRED` -- 174 of
them -- and Drizzle's schema language has no way to say so; the harness's whole-table resets
and several of the port's own transactions depend on it.

## Decision

1. **The baseline is the dump.** `drizzle/0000_baseline.sql` is `pg_dump --schema-only` of a
   database Django has just migrated, less the three lines only `psql` can run, followed by
   the rows Django's migrations leave in a new database: its own bookkeeping
   (`django_migrations`, content types, model permissions) and what data migrations seed (the
   site settings, the system pages, the menu, the social links, the expense categories). It is
   **cut by a script** (`scripts/nest-baseline.sh cut`) and never edited.
2. **Drizzle's migrator applies it**, from `node dist/cli.js migrate`: the journal and the
   `drizzle.__drizzle_migrations` table are Drizzle's own, so the first migration written after
   step 6.4 is an ordinary `drizzle-kit generate`.
3. **A database Django built is adopted, not rebuilt.** Where `django_migrations` exists and
   Drizzle has no record, `migrate` writes the baseline's record and runs nothing -- but only if
   Django's record names exactly the migrations the baseline was cut from
   (`drizzle/meta/django-head.json`). Fewer, and the database is older than the build; more,
   and the baseline is. Either is refused with the names. Tables and nobody's record is refused
   too.
4. **Django's record goes into a new database with the rest.** The baseline writes
   `django_migrations` as Django would have. Until step 8 Django is the way back, and it must
   be able to take over a database this command built: `manage.py migrate --check` on one says
   there is nothing to do, and that is checked.
5. **The roles and permissions are a command of their own**, `sync-permissions`, with the
   catalogue a constant in the NestJS API (`auth/permission-catalogue.ts`), generated from
   Django's. They are left out of the baseline for the reason Django leaves them out of its
   migrations: they change without the schema changing.
6. **Two copies of the schema for Drizzle.** `drizzle/schema.ts` is the whole of it, foreign
   keys included, which is what migrations are a difference from; it is not compiled, because
   its tables refer to each other in cycles TypeScript cannot type. `src/database/schema.ts`
   stays the copy without them, for the API. Both are written by the cut.
7. **Until step 6.4 nothing here touches a real database.** Django migrates production. A
   schema change is a Django migration, then a new cut; `scripts/nest-baseline.sh compare`, in
   CI, is what fails when the second is forgotten.

## Proven by

`scripts/nest-baseline.sh compare`, on 2026-10-14 and in CI's parity job since:

```text
a new database: migrate, sync-permissions ...... the baseline applied; 43 permissions, 7 roles, 166 grants written
pg_dump --schema-only, both databases .......... identical: 96 tables, 7,770 lines
the rows, by what they say ..................... the same 909 facts
Django, on the database this built ............. nothing to migrate
the same commands again ........................ nothing applied, nothing written
a database Django built ........................ adopted; schema and rows unchanged
```

## Consequences

- **A third thing to keep in step, until 6.4**: a Django migration now wants a cut as well as a
  port. The comparison catches a forgotten one; it costs about two minutes of CI.
- **The repository carries the schema three times**: Django's migrations, the dump (349 KB),
  and Drizzle's snapshot of it (512 KB). Two of them go at step 8.
- **The first Drizzle-written migration will not make deferrable foreign keys** unless it is
  edited to. That is a thing to decide at step 6.4, with the first real migration in hand:
  hand-finish each migration's constraints, or stop relying on deferral.
- **No column has a default**, in either database: Django supplies them in Python and the
  NestJS API writes every column. The plan's suggested check for that (an insert naming fewer
  columns fails) was not added; the identical dumps say the same thing about the schema, and
  the 12,283 compared cases about the writes.
- **`drizzle-kit` is used for something new** -- its journal and snapshot -- though it was
  already a development dependency, and `drizzle-orm`'s migrator, already a dependency, now
  runs in the image. No new package.

## Alternatives considered

- **Drizzle's pulled migration as the baseline.** Standard, and not Django's schema: no
  deferrable constraints, and nothing to prove it against but itself.
- **A migrator of our own**, a table and a loop. Less code than it sounds, and one more thing
  that is ours to maintain where the tool the next migration will be written with has one.
- **The roles in the baseline.** One command fewer on a new database, and a catalogue change
  would then want a migration where Django wants none.
