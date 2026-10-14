# Testing Strategy

Testing is mandatory (plan §34). A failing test is never deleted or skipped to go green.

## Layers

| Layer | Tool | Location | What it proves |
|---|---|---|---|
| Unit | Jest | `apps/api-nest/test/unit/` | pricing maths, rounding, coupon rules, costing, parsers, permissions, the job settings |
| API, with its effects | the recorded proof (`scripts/nest-parity.sh replay`) | `apps/api-nest/parity/*-cases.ts` | status, body and headers of some 12,000 requests; every row each wrote and every job it queued; error envelope; permissions by role |
| Concurrency | the race checks, across two API processes | `apps/api-nest/parity/*-concurrency.ts` | oversell, double submit, duplicate webhooks, drawer movements; each proven by removing its lock |
| Migrations | `node dist/cli.js migrate`, in CI | `.github/workflows/ci.yml` | a new database and one Django built reach the same schema |
| Component | Vitest + Testing Library | `apps/web/src/**/*.test.tsx` | non-trivial component logic, form validation |
| E2E | Playwright | `apps/web/e2e/` | the four critical flows below |

The recorded proof needs real PostgreSQL and runs in containers (`docker-compose.recorded.yml`),
as CI does. Until 2026-10-14 the API layer was also Django's own suite -- 1,514 pytest tests, the
concurrency ones in `tests/test_concurrency.py` -- and a comparison of every case with Django. The
tests a case did not already cover were ported as cases before Django went
([djangos-tests-sorted.md](../architecture/djangos-tests-sorted.md)). What is lost is the
comparison: a recording finds a regression, not a rule that was already wrong when it was recorded
([ADR-0023](../architecture/decisions/0023-django-is-gone.md)).

Each write case asserts both the API outcome **and** every row it wrote, the ledger's included.

## The browser suite

From the cutover ([ADR-0017](../architecture/decisions/0017-nest-api-serves-production.md)) to
2026-10-14 the E2E job in CI was a matrix of two: the web app on the NestJS API and on Django. The
first run on the NestJS API found a difference in speed the suite was leaning on: eleven sign-ins
inside a minute against a limit of ten. **It is one job now**, on the API, whose database is the
committed demo snapshot, restored and migrated.

`scripts/e2e-local.sh run` is that job in containers, for a machine with Docker and nothing else:
a fresh database restored from the snapshot each time, the storefront's production build,
Playwright in its own image. 50 of 50, 2026-10-08; 50 of 50 on the native development stack,
2026-10-14.

## Commands

```bash
docker compose exec api-nest npm test               # the API's unit tests
scripts/nest-parity.sh replay                       # every case against its recorded answer, and the races
scripts/nest-parity.sh replay-empty                 # the shop on its first day
docker compose exec web npm run test                # Vitest
docker compose exec web npm run test:e2e            # Playwright — DOES NOT WORK, see above
scripts/e2e-local.sh run                            # Playwright, as CI runs it
```

## Test data

The recorded proof's database is its own snapshot (`apps/api-nest/parity/recorded/snapshot.dump`):
the demo shop with the parity fixtures on top, as they stood when it was recorded. A case that
needs rows nobody made arranges them in its `setup` and takes them away in its `teardown`. The
browser suite starts from the demo snapshot (`infrastructure/snapshots/demo/`).
