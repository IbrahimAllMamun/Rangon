# ADR-0023 — Django is gone: the NestJS API alone, without the month and without the rehearsal

**Status:** Accepted · 2026-10-14 · completes [the removal plan](../django-removal-plan.md) (steps 6.4, 7 and 8); amends [ADR-0020](0020-django-is-removed-in-steps.md)

## Context

[ADR-0020](0020-django-is-removed-in-steps.md) removed Django in steps, and put the point of no
return -- the first schema change Django does not know, step 6.4 -- behind three things: a month of
the real shop on the NestJS API without the rollback file being used, step 7's rehearsal on a restored
backup of the shop, and the owner's word at the time. Steps 1 to 6.3 were built by 2026-10-14
(PR #100 and PR #105). On that day the shop on the owner's machine was still served by Django, on
`264103f`, so the month had not begun.

The owner then asked for the rest at once: "no need to rehearse. do everything so that it works
fine". Asked how far, the answer was all the way, Django deleted; asked how the shop reaches it, the
owner upgrades the shop to the last release that has Django first.

## Decision

1. **The month and the rehearsal are waived.** The owner's word is given; ADR-0020's decision 1 and
   its condition on step 7 no longer hold. The rehearsal of the cutover upgrade on the shop's own
   backup (roadmap, 2026-10-14) is the nearest thing to step 7 that was done.
2. **A rule changes in the NestJS API**, from this ADR. ADR-0020's decision 5 and ADR-0017's fourth
   decision are reversed.
3. **The schema is the API's** ([migrations.md](../../database/migrations.md)). The first migration
   written in Drizzle, `0001`, is step 6.4 and step 8's contract migration in one: it drops the tables
   only Django's framework used -- content types, its permissions and groups with the user's links to
   them, the admin's log, sessions, and Celery beat's schedule. `django_migrations` stays as the
   history of how the schema came to be; `token_blacklist_*` stays because the API uses it.
4. **Background jobs are pg-boss's alone.** The Celery transport (ADR-0014), `RANGON_JOBS_BACKEND` and
   `CELERY_BROKER_URL` are removed; Redis is cache and rate limits.
5. **The proof is the recording, committed.** The recorded answers and the database they were given
   from (`apps/api-nest/parity/recorded/`) were taken by CI from the last run in which Django and the
   NestJS API were compared and agreed, and are committed, as decided on 2026-10-14. A replay restores
   the recording's snapshot and migrates it to the build first. A deliberate change to an answer is a
   replay with `PARITY_ACCEPT` naming the cases, committed with the change.
6. **The demo snapshot is committed too** (`infrastructure/snapshots/demo/`), made by Django in that
   same run. It carries the README's password; `node dist/cli.js set-password`, new here, is how a
   stack another machine can reach gives its accounts their own.
7. **The way through for a database Django built** is the last release that has Django: it is
   brought to that release's migrations there, and this release's `migrate` adopts it. A database
   behind that is refused, with the reason.

## Consequences

- **No way back.** `docker-compose.django.yml` and the Django image are gone. A release that goes
  wrong is rolled back to the previous image and, if its migration ran, the pre-deploy backup -- as
  for any release ([deployment.md](../../operations/deployment.md)). A Django image built from
  `c5f4e81` or earlier cannot serve a database `0001` has run on: its admin, sessions and content
  types are gone.
- **The comparison is gone with what it found.** It found every defect from D1xx to D241 that the
  port found. The recording finds regressions, not original mistakes: a wrong rule that the code and
  its recorded answer agree on is simply the rule.
- **The copied defects are ordinary bugs** (ADR-0020, "The copied defects"), each fixed with its
  recorded answer changed in the same commit.
- **The `S3` comparison has no recorded counterpart** (recorded-proof.md, open question 5). Uploads to
  a bucket are proven by unit tests of the signing and by the comparisons that ran until today.
- **Django's names stay**: the tables, the `DJANGO_*` settings, the job names (ADR-0020, decision 4).
- **The month's protection is not had.** One month-end -- the reports, the VAT return, the cash book
  closing -- was to be seen on the new API with Django still able to take over. It will be seen with
  no Django to take over.

## Alternatives considered

- **Wait the month, as ADR-0020 decided.** Safer; the owner chose not to.
- **Keep Django's code in the repository after 6.4**, as a reference. It could not serve the migrated
  database, and code nobody runs is code nobody checks still works.
