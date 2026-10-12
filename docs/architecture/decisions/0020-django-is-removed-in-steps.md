# ADR-0020 — Django is removed in steps; the rule changes hands at the first Drizzle migration

**Status:** Accepted · 2026-10-08 · step 0 of [the removal plan](../django-removal-plan.md); sets the date on which decision 4 of [ADR-0017](0017-nest-api-serves-production.md) is reversed

## Context

Since the cutover (ADR-0017) the NestJS API serves every request, the uploads and the
background jobs, and Django starts only on demand. Django still owns nine things, measured in
the plan: the schema and its 54 migrations, the roles and permissions, four operator commands,
the demo seed, the parity fixtures, the proof itself (the harness compares against a *running*
Django), 1,514 rule tests, the Django admin with the API docs, and the way back
(`docker-compose.django.yml`).

ADR-0017's fourth decision kept Django the place a rule changes first, "to be looked at again
once the NestJS API has run in production for a while". The plan is that second look. It has
eight steps, of which the first five remove nothing, and four questions that are the owner's.
They were put to the owner on 2026-10-08.

## Decision

1. **When: one month.** The NestJS API runs the real shop for one month without the rollback
   file being used before the point of no return -- step 6.4, the first schema change made by
   a Drizzle migration. The month is counted **from the day the shop on the owner's machine is
   upgraded** by step 6-once of
   [upgrading-local-production.md](../../operations/upgrading-local-production.md), not from
   the merge of PR #91: until that upgrade the shop is still served by Django. A use of the
   rollback file starts the month again. One month covers one month-end: the reports, the VAT
   return and the cash book closing on the new API.
2. **The Django admin and the API docs are dropped** at step 5, not replaced. The admin
   registers none of this project's models; the OpenAPI schema is generated from Django's
   serializers and has no counterpart.
3. **The demo seed is replaced by a database snapshot**, not ported. One seeded,
   fixture-loaded database, dumped, made by Django while Django exists and brought forward by
   migrations afterwards. It serves the test stacks and a demo shop.
4. **The names stay.** The `DJANGO_*` settings and `DJANGO_SETTINGS_MODULE=config.settings.prod`
   keep their names, and the service stays `api-nest`. Every deployed `.env` uses the first;
   nginx, the compose files and every operations page use the second.

And one thing the plan said two ways, settled here:

5. **A rule changes in Django first until step 6.4, and in the NestJS API from then.** The
   plan's step 0 read as though the rule changed hands when this ADR was written; its first
   decision said "from then", meaning step 6.4. It is step 6.4, for two reasons. Step 1 runs
   the recorded proof and the comparison with Django side by side until step 6, and that holds
   only while the two APIs agree. And until 6.4 Django is the way back: a rule changed in the
   NestJS API alone would be undone by using the rollback file. So **CLAUDE.md §2 and
   `nest-port-instructions.md` §1 stand as written** until the owner gives the word for 6.4.

## What this authorises, and what it does not

- **Steps 1 to 5 may be built now**, in any order the plan allows. Each leaves Django running
  and the rollback file working, and can be abandoned.
- **Step 6.4 is not authorised by this ADR.** It needs the month of decision 1 to have passed,
  step 7's rehearsal on a restored backup of the real shop to have passed, and the owner's
  word at that time.
- Nothing here changes what production runs.

## The copied defects

The port copied Django's defects so that the two APIs would agree
([nest-port.md](../nest-port.md), "Django defects that are copied": some 120 D-numbers). The
recorded proof of step 1 holds them as they are. While Django is still compared with (until
step 6), a fix made in both and recorded again keeps both proofs green, so the triage decides
only what must be done **before Django stops being compared with**:

| Class | Rule | Which |
|---|---|---|
| **Fix in both, before step 6** | A defect that loses money or stock, or lets someone do what their role does not allow. Django is the way back for at least a month more, and a rollback must not bring the defect back | D166, D167, D149, D233, D158, D204, and the missing lock of D221 |
| **Fix in both, before step 6, for the proof's own sake** | An answer that depends on the order rows lie in. Found by step 1 on 2026-10-09: while a list can tie, a recording holds its rows and not their order ([recorded-proof.md](../recorded-proof.md), "Tied rows") | D243, D244, D245, D161 -- *fixed in Django on 2026-10-12; the port is owed* |
| **The owner's rule first, then as above** | The fix states a business rule that is still `DECISION REQUIRED` | D221 (may an administrator manage owners, §7.1), D164 (a return before the order has shipped) |
| **Fix in the NestJS API after step 6** | Everything else: a 500 for a malformed body, a lost update between two staff edits (D207, D222 and their shape: D184, D200, D203, D215), an unordered list. The recorded answer changes with the fix, in the same commit | the rest of the list |
| **Django only** | Nothing to port. Fixed in Django if it is cheap and the rollback is worth more with it, otherwise moot at step 8 | D241 (no Sentry on Django: one requirement), and the Django image's failing scan (the 5.1 line's CVE) |
| **Configuration** | Not a rule; fixed in both whenever a deployment needs it | D238 (`S3_PUBLIC_ENDPOINT`) |

None of them is fixed by this ADR or by step 1. The first row is the order the owner was
already asked to look at them in (`nest-port-instructions.md` §11).

## Consequences

- **The two-codebase cost continues for at least a month**, and in practice until steps 1 to 5
  and step 7 are done: every rule change is still made twice and compared.
- **The proof changes meaning at step 6**, from "answers as Django just did" to "answers as
  recorded". A recording finds a regression; it does not find a rule that was wrong when it was
  recorded. The plan names this as the real cost. The first row of the table above is what
  can be done about it while there is still a second implementation to ask.
- **The snapshot becomes a thing to look after.** Once Django cannot regenerate it, a fixture
  that needs new rows adds them in SQL or through the API, and the snapshot is brought forward
  by every migration.
- **Names that describe history stay in every `.env`.** `DJANGO_SECRET_KEY` on a stack with no
  Django in it is a cost in explanation, paid once in the operations pages, against a rename
  that would touch every deployment.
- **To settle at step 6, not now:** the plan's step 6.2 stops building and scanning the Django
  image, while step 7.4 keeps "the last Django-capable image" as the way back until step 8.
  An image nobody builds is one nobody has checked still starts. Whether CI keeps building it
  between 6.2 and 8 is a question for that step.

## Alternatives considered

- **Keep Django as the specification indefinitely.** The safest proof and the dearest: two
  implementations of every rule for as long as the shop runs.
- **Reverse the rule now, at this ADR.** Changes would be made once from today. But the
  comparison with Django would go red at the first of them, and the rollback file would restore
  older rules, during exactly the month in which it is most likely to be needed.
- **Port the demo seed** (decision 3's other answer). A demo shop that can always be built from
  code, for 1,525 lines of ORM code ported and kept. The snapshot is needed by the test stacks
  either way.
- **Rename the settings and the service** (decision 4's other answer). Cleaner names, for a
  release in which both are accepted and an edit to every deployed `.env`.
