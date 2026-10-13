# Removing Django: a plan

**Status: accepted 2026-10-08 ([ADR-0020](decisions/0020-django-is-removed-in-steps.md)). Step 0's
decisions are made; its wait has not begun. Step 1 is built as far as
[recorded-proof.md](recorded-proof.md) says, which is not all of it: Django's own tests are
not yet sorted and ported, and three defects it found (D243 to D245) stand between a recording
and the order of a list. Nothing of Django's has been removed.** It follows
from the cutover ([ADR-0017](decisions/0017-nest-api-serves-production.md)), which left Django out
of serving requests and in charge of four other things.

## Where things stand

The NestJS API serves every request, uploads and the background jobs. Django no longer runs day
to day. What it still does, measured on 2026-10-08:

| Django still owns | Size | Used by |
|---|---|---|
| **The schema.** 54 migrations over 96 tables; the Nest API's `schema.ts` is introspected from a Django-migrated database and never migrated | 15 of the 96 tables are Django's own framework tables | every deploy (`manage.py migrate`) |
| **Roles and permissions.** A `post_migrate` hook creates the seven roles and every permission code | `accounts/permissions.py`, `accounts.services.sync_permissions` | every deploy; a blank database |
| **Operator commands.** `createsuperuser`, `scripts/bootstrap-store.py`, `verify_inventory [--fix]`, `verify_accounts` | 3 commands, 1 script | a new shop; a release's verify step; disaster recovery |
| **The demo seed.** `seed_demo` | 1,525 lines of ORM code | the browser suite, the parity stack, a local production stack |
| **The parity fixtures.** 28 Python scripts run through `manage.py shell` | 4,120 lines of ORM code | the parity stack |
| **The proof.** The harness compares 12,243 requests against a *running* Django; the race checks drive both APIs at once; the throttle check compares live | 38 case files, 211 race checks | CI, every part of the port |
| **The rule tests.** Django's own suite | 87 files, 1,514 tests, 884 lines of concurrency tests | CI; CLAUDE.md §9 |
| **The Django admin and the API docs** | `/django-admin/`, `/api/docs/`, `/api/schema/` | on demand |
| **The way back.** `docker-compose.django.yml` | one file | an emergency |

Also Django-shaped, though the Nest API already owns the behaviour: the names of its settings
(`DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, and `DJANGO_SETTINGS_MODULE=config.settings.prod`
choosing the production profile), two of the framework tables it reads and writes
(`token_blacklist_*`), and the development stack, which is Django's.

## The shape of the plan

Eight steps. Each ends in something that works and can be merged on its own. **Steps 1 to 5
remove nothing**: after each of them Django still runs, the rollback file still works, and the
step can be abandoned. Step 6 contains the point of no return, and says where.

```text
0  Decide, and wait                     nothing is built
1  A proof that does not need Django    Django still the oracle, in parallel
2  A seed that does not need Django     the test stacks start without it
3  The Nest API can migrate the schema  Django still migrates production
4  The operator commands, in Nest       both sets exist
5  The admin and the docs: replace or drop
   ------------------------------------ everything above is reversible
6  Development and CI run on Nest alone; the first schema change Django does not know
7  Rehearse on the real shop's data, then upgrade it
8  Delete
```

---

## 0. Decide, and wait

**Nothing is built in this step.**

- PR #91 merged, and the shop on the owner's machine upgraded to the NestJS API by the one-time
  step in `operations/upgrading-local-production.md`.
- **The NestJS API has run the real shop for a period the owner names** without the rollback
  file being used. A month is a suggestion, not a measurement.
- The four decisions in [§ Decisions](#decisions-the-owner-has-to-make) are made and recorded in
  an ADR (0020), which sets the date on which the fourth decision of ADR-0017 is reversed: from
  step 6.4, a rule changes in the Nest API. Until then it changes in Django first, as now.
- The copied defects are triaged ([§ The copied defects](#the-copied-defects)). While Django is
  the oracle, fixing one in the Nest API alone breaks the comparison; after step 1 it is an
  ordinary change with a changed expectation.

**Done when:** the ADR exists, and the month it names has passed.

*2026-10-08: the ADR exists. PR #91 is merged. The month starts when the shop on the owner's
machine is upgraded, and must have passed before step 6.4, not before steps 1 to 5.*

## 1. A proof that does not need Django

Today "the Nest API is right" means "it answered as Django just did". This step turns that into
"it answered as recorded", so the proof survives Django.

1. **Measure first.** Reset twice, a day apart, and compare the Nest API's answers *with
   themselves* across the two runs. Whatever differs is what a recording cannot hold as it is:
   ids the seed mints, times relative to now (the reports' windows, the reservation sweep,
   expiring stock), random file suffixes. This number decides how much of the rest is work. It is
   not known today.
2. **Make the state repeatable.** A database snapshot (step 2) in place of a fresh seed gives
   stable ids. For time, either the cases that depend on the clock arrange their own rows
   relative to it -- many already do -- or the stack runs with a pinned clock. Decide from the
   measurement. *(Measured 2026-10-09: 475 cases answer differently a day later. The clock is
   set: [ADR-0021](decisions/0021-the-recorded-proof-replays-on-a-set-clock.md).)*
3. **Record.** A harness mode that runs each case against the Nest API alone and compares with a
   stored answer: status, headers, body, effects, queued jobs, stored objects -- what `compare`
   already compares. The recording is taken from a run in which Django and Nest agree, so every
   stored answer has been Django's too.
4. **The race checks.** Many drive "both APIs at once" to prove the lock holds across them.
   Rewrite each to drive two Nest processes: the invariant is the same, and the mutation test
   (remove the lock, the check fails) still applies.
5. **The throttle check** and **the job cases**: recorded the same way.
6. **The rule tests.** Go through Django's 87 test files and sort each test into: already
   covered by a parity case (most API tests); a service-level invariant with no case (port it,
   as a Nest test against a real database); Django-only (migrations, the seed's guard, the
   admin: drop with the thing it tests). `tests/test_concurrency.py` is ported whole: CLAUDE.md §9
   makes those tests mandatory.
   *Sorted on 2026-10-13 and 14, by coverage: [djangos-tests-sorted.md](djangos-tests-sorted.md).
   What a request can reach and no case did came to 28 functions; 25 have cases now, and both
   APIs agreed on all 40 of them. Three are reached only in a shop with nothing in it, and are
   compared on a database of their own (`scripts/nest-parity.sh empty`, 174 answers, all
   agreeing). None wanted a Nest test against a database: every one was a parity case.
   **Done**, but for recording the empty shop's answers before step 6.*
7. **Run both proofs in CI, side by side**, until step 6. While they agree, the recording is
   known to be faithful.

**Proven by:** the recorded suite passes with the Django container stopped; with a deliberate
change to a ported rule, the same cases fail that fail against Django.
**Size:** large. The biggest step, and the one that is useful even if the plan stops here: it
makes the Nest API testable in minutes, on its own.
**Reversible:** entirely. Nothing of Django's is touched.

## 2. A seed that does not need Django

`seed_demo` and the 28 fixtures are ORM code. The stacks that depend on them -- parity, the
browser suite, a local production stack -- cannot start without Django.

1. **A snapshot for the test stacks.** One seeded, fixture-loaded database, dumped
   (`pg_dump`), stored as a build artefact with the commit it was made at, and restored in
   seconds. It is made *by Django* while Django exists, and regenerated by a script.
2. **A demo seed in Nest**, if the owner wants a demo shop after Django
   ([decision 3](#decisions-the-owner-has-to-make)): `seed_demo` ported so that stock arrives
   through the ledger and money through the services, as CLAUDE.md §3 requires. Or the snapshot
   serves as the demo too, and this is skipped.
3. After step 3, the snapshot is brought forward by migrations, not regenerated: a fixture that
   needs new rows adds them in SQL or through the API.

**Proven by:** the parity stack and the browser suite start from the snapshot and pass, with no
Django container.
**Size:** medium with the snapshot alone; large with the ported seed.

## 3. The Nest API can migrate the schema

Drizzle is already the Nest API's view of the schema; it becomes the owner.

1. **A complete `schema.ts`.** Today's is introspected with its foreign keys stripped, because
   they only matter to migrations. Introspect again with them: constraints, indexes and their
   names included.
2. **A baseline migration** that creates today's schema from nothing, and a rule for a database
   that already has it: recorded as applied, not run.
   **Proven by:** a database built by the baseline and one built by Django's 54 migrations have
   identical `pg_dump --schema-only` output.
3. **A migration command** in the image (`node dist/cli.js migrate`), with the same discipline
   as today: a separate release step, never at container start, expand/contract for anything
   destructive.
4. **Roles and permissions.** `sync_permissions` ported as an idempotent command the release
   runs after `migrate`, with the permission codes as a constant in the Nest API. Proven by
   comparing the two tables after each.
5. **The framework tables.** `token_blacklist_*` stay: the Nest API uses them. `django_migrations`
   stays as history. The rest (`django_session`, `django_admin_log`, `django_content_type`,
   `auth_group*`, `auth_permission`, `django_celery_beat_*`) are dropped in a later *contract*
   migration, in step 8, not here.
6. Things Django did that a schema does not say: it supplies defaults in Python, so columns have
   no database defaults. The Nest API already writes every column; a check for it (an insert
   that names fewer columns fails in the test database) is worth adding.

**In this step Django still migrates production.** The Drizzle baseline is built, compared and
exercised in CI only.
**Size:** medium.

## 4. The operator commands, in Nest

One entry point (`node dist/cli.js <command>`), each command with a test and compared with
Django's on the same database:

| Command | Replaces | Note |
|---|---|---|
| `migrate`, `sync-permissions` | `manage.py migrate` and its hook | step 3 |
| `create-owner` | `createsuperuser` | the same password rules, the Owner role |
| `bootstrap-store` | `scripts/bootstrap-store.py` | organization, first branch, cash drawer |
| `verify-inventory [--fix]` | `verify_inventory` | the check exists as an endpoint; `--fix` writes `ADJUSTMENT` rows through the ledger |
| `verify-accounts` | `verify_accounts` | likewise |
| `seed-demo` | `seed_demo` | only if step 2.2 is done; refuses in production without the opt-in, as now |

Then every operations page that says `run --rm api python manage.py ...` gets its Nest
equivalent beside it: `new-store-from-scratch.md`, `upgrading-local-production.md`,
`deployment.md`, `disaster-recovery.md`, `local-production.md`.

**Size:** medium.

## 5. The Django admin and the API docs

[Decision 2](#decisions-the-owner-has-to-make). The admin registers no models of this project's
(`admin.site.register` appears nowhere), so it shows what Django's own packages register --
groups, the token blacklist, the beat schedule -- and nothing of the shop; the Next.js admin is the product's. The OpenAPI schema is generated by
drf-spectacular from Django's serializers and has no counterpart.

- **Drop both** (recommended for the admin): the nginx locations go, and the 503 page with them.
- **Or generate the API docs from the Nest API.** That is a new dependency and annotations on
  some 300 routes: a project of its own, worth it only if someone reads the docs.

**Size:** small to drop; large to replace the docs.

---

**Everything above leaves Django in place.** From here on it does not.

## 6. Development and CI on Nest alone

1. **The development stack** runs the Nest API in watch mode in place of Django;
   `docker-compose.dev.yml`, the README and CLAUDE.md §14 change with it. Celery's worker and
   beat leave the development stack.
2. **CI**: the Django backend job and the two "parity with Django" jobs go; the recorded suite
   (step 1) and the ported tests take their place. The browser suite has one leg. The Django
   image is no longer built or scanned.
3. **Scripts**: `rebuild-local-prod.sh`, `e2e-local.sh` and `nest-parity.sh` use the snapshot
   and the Nest commands.
4. **The first schema change made by a Drizzle migration.**

> **The point of no return is step 6.4**, not the deletion in step 8. Until a migration exists
> that Django's models do not describe, `docker-compose.django.yml` still works. After it,
> Django cannot serve this database without being taught the change -- which is exactly the
> double work this plan ends. Make that migration deliberately, with the owner's word, after
> step 7's rehearsal has passed.

**Size:** medium.

## 7. Rehearse on the real shop's data, then upgrade it

1. Restore a backup of the real shop into a scratch stack.
2. Apply the release: the Drizzle baseline is recorded as applied (nothing runs), permissions are
   synced, both verify commands pass, the browser walk passes, an order is placed and its email
   arrives.
3. Write the upgrade step for the real stack as `upgrading-local-production.md` has one for the
   cutover, and rehearse that from the old compose files.
4. Upgrade the shop. Keep its last Django-capable image and its pre-upgrade backup until step 8.

**Size:** small, and not skippable: the cutover's own rehearsal found an order of operations
that would otherwise have fired every scheduled job twice.

## 8. Delete

Only after the shop has run a release from step 7 for a while.

- `apps/api`, the `worker` and `beat` services, `docker-compose.django.yml`, the Django
  Dockerfiles and requirements, the parity gateway's Django half, the Python fixtures.
- Redis keeps its cache and rate limits; the Celery broker and result databases are no longer
  configured.
- **The settings' names.** `DJANGO_*` and `DJANGO_SETTINGS_MODULE=config.settings.prod` are read
  by the Nest API today. Rename them with a release in which both names are accepted, or keep
  them: every deployed `.env` uses them ([decision 4](#decisions-the-owner-has-to-make)).
- **The service's name.** `api-nest` could become `api`. It touches nginx, the compose files and
  every operations page; worth doing once, here, or not at all.
- The contract migration that drops the unused framework tables.
- CLAUDE.md, the README, `architecture.md` and the ADR index say what is true: one backend, in
  TypeScript; migrations in Drizzle; the port's documents kept as history, not as instructions.
- Comments in the Nest API that say "as Django does" stay. They are why the code is the way it
  is.

**Size:** small in work, large in consequence.

---

## What is lost, and what replaces it

| Lost | Replaced by |
|---|---|
| A second implementation to fall back on | the previous image and the pre-deploy backup, as for any release |
| A second implementation to compare with -- which found every defect D1xx to D241 that the port found | the recorded suite and the ported tests, which find regressions but not original mistakes |
| 1,514 tests | fewer: those a parity case already covers are not ported twice |
| The Django admin | nothing, or a small tool for the one thing it was used for |

The second row is the real cost. A wrong rule that both the code and its recorded answer agree
on is simply the rule.

## Decisions the owner has to make

Made on 2026-10-08, and recorded with their reasons in
[ADR-0020](decisions/0020-django-is-removed-in-steps.md):

1. **When.** How long the NestJS API runs the real shop before step 6.4, and that ADR-0017's
   "a rule changes in Django first" is reversed from then. -- **One month, from the day the
   shop is upgraded.**
2. **The Django admin and the API docs:** dropped, or replaced (and with what). -- **Dropped.**
3. **The demo seed:** ported to Nest, or replaced by a database snapshot. -- **A snapshot.**
   Step 2.2 is skipped, and step 4 has no `seed-demo` command.
4. **Names:** whether `DJANGO_*` settings and the `api-nest` service are renamed or kept. --
   **Kept.**

## The copied defects

The port copied Django's defects so that the two APIs would agree. Without Django there is
nothing left to agree with, and each becomes an ordinary bug in the only API there is. Before
step 1's recording is frozen, sort them into: fix now in both (the comparison stays green); fix
in Nest after the recording (the expectation changes with the fix); leave. The ones worth the
owner's attention first, from `nest-port-instructions.md` §11: D221, D233, D166, D149, D158,
D164, D167, D204, D207, D222 -- and D238 and D241, which are about configuration rather than
rules. The sorting is in ADR-0020, "The copied defects"; its first row -- D166, D167, D149, D233,
D158, D204 and D221's lock -- was fixed in both APIs on 2026-10-13.

## Order, and what can be skipped

Steps 1, 2 and 3 do not depend on each other and can be done in any order or in parallel; 4
needs 3; 6 needs 1 to 5; 7 needs 6.1 to 6.3 and comes before 6.4; 8 needs 7.

Stopping after step 1 is a sensible place to stop for a long time: Django stays as the rollback
and the schema's owner, and the Nest API has a fast proof of its own. Stopping after step 5
leaves two complete ways to operate the shop, which is the most expensive place to stay.
