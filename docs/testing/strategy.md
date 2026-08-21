# Testing Strategy

Testing is mandatory (plan §34). A failing test is never deleted or skipped to go green.

## Layers

| Layer | Tool | Location | What it proves |
|---|---|---|---|
| Unit | pytest | `apps/api/tests/unit/` | pricing maths, rounding, coupon rules, costing, status machine |
| Model | pytest-django | `apps/api/tests/` | constraints, append-only behaviour, invariants |
| Service | pytest-django | `apps/api/tests/` | inventory ledger, POS sale, checkout, returns, payments |
| API | DRF `APIClient` | `apps/api/tests/api/` | status codes, error envelope, permissions, serialisation |
| Permission | pytest | `apps/api/tests/test_permissions.py` | every role × endpoint matrix |
| Concurrency | pytest + threads | `apps/api/tests/test_concurrency.py` | oversell, double submit, replay |
| Performance | `assertNumQueries` | `apps/api/tests/test_performance.py` | query budgets from `docs/database/indexing.md` |
| Component | Vitest + Testing Library | `apps/web/src/**/*.test.tsx` | non-trivial component logic, form validation |
| E2E | Playwright | `apps/web/e2e/` | the four critical flows below |

Concurrency and performance tests need real PostgreSQL — they never run against SQLite. The whole suite
runs against the containerised database (`docker-compose.test.yml`), which is what CI uses.

### What of that table actually exists (2026-08-18)

The backend rows are real: **167 tests pass**, concurrency included. Three rows are aspirational and
should not be read as coverage that exists:

| Row | Reality |
|---|---|
| Performance | `apps/api/tests/test_performance.py` now exists and asserts the storefront listing's query budget. It was written after that listing was found issuing **363 queries** for one page. Other endpoints in `docs/database/indexing.md` still have no assertions, and there is no load test |
| Component | Frontend tests are all pure-logic: `lib/format`, `lib/api/server`, `lib/use-debounced-callback` and `lib/commerce/variant-matrix` — 39 tests. Still no component or form-validation tests; the product form's rendering is covered only by the browser walk |
| E2E | The committed specs still have **never been executed**; they cannot run in the dev image (`node:22-alpine` has no Playwright browsers). What does work here is `apps/web/e2e/browser-walk.mjs`, a scripted browser walk run from `mcr.microsoft.com/playwright` joined to the compose network — see the command in its header. Set `E2E_BASE_URL` for the committed specs; the config default is port 3000, which is not where the storefront runs on Windows |

CI runs the backend suite on every push. It runs **neither** frontend suite — the frontend job stops
at `npm ci` → lint → typecheck → build.

## Coverage expectations

Not a percentage target — a list. These **must** have tests:

`inventory/services.py`, `orders/services/*`, `promotions/services.py` (coupon maths),
`purchasing/services.py`, `accounts/permissions.py`, `core/money.py`, `core/services.py` (sequences).

## Critical E2E flows

```text
POS      login → scan barcode → add to cart → cash payment → sale completed
         → receipt renders → inventory decreased by exactly the sold quantity

Online   browse → product → select variant → add to cart → checkout (COD)
         → order created → stock reserved → order PACKED → stock deducted

Return   delivered order → request return → approve → receive (RESTOCK)
         → refund issued → stock increased → order REFUNDED

Purchase draft PO → send → receive partially → inventory increased
         → average cost recalculated → receive remainder → PO RECEIVED
```

## Concurrency scenarios (all implemented)

| Scenario | Expected |
|---|---|
| stock = 1, two simultaneous online checkouts | exactly one order, one `INSUFFICIENT_STOCK` |
| stock = 1, POS sale and online checkout at once | exactly one succeeds |
| double-clicked checkout with the same `Idempotency-Key` | one order, second call returns the first |
| duplicate payment webhook | one capture, second event recorded and ignored |
| reservation expiring while checkout completes | no double release, ledger stays consistent |
| return processed twice | one refund, one restock |
| concurrent receipt of the same purchase receipt | stock added once |

Each asserts both the API outcome **and** ledger integrity via `verify_integrity()`.

## Commands

```bash
docker compose exec api pytest                      # everything
docker compose exec api pytest -m "not slow"        # skips concurrency/perf
docker compose exec api pytest --cov=. --cov-report=term-missing
docker compose exec web npm run test                # Vitest (17 tests, ~25 s)
docker compose exec web npm run test:e2e            # Playwright — DOES NOT WORK, see above
docker compose -f docker-compose.test.yml run --rm api-test    # what CI runs
```

## Test data

`tests/factories.py` (factory-boy) builds organisations, branches, users per role, categories,
attributes, products with variants, inventory positions, suppliers and orders. Tests never depend on
`seed_demo`, which is for humans, not assertions.
