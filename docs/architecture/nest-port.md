# The NestJS API port

The NestJS API (`apps/api-nest/`) is being built beside the Django API (`apps/api/`) on the same
PostgreSQL database, module by module, each module proven to answer exactly as Django does before
anything is routed to it. Why and how it was decided: [ADR-0013](decisions/0013-nestjs-api-alongside-django.md).

**Django remains the source of truth.** It owns the schema and every migration, and every path the
storefront, admin and POS use today is still served by it. Nothing routes to the Nest API yet.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation; storefront catalogue, content and feeds; rate limits | **Done** 2026-09-30, parity 202/202 |
| 2 | Accounts: login, refresh, logout, me, password change; customer orders and addresses; guest order tracking; review submission | Next |
| 3 | Cart, coupons, shipping options, checkout, payment webhook -- the first stock and money writes | |
| 4 | Catalogue, inventory and content admin (ledger, transfers, counts, image uploads) | |
| 5 | POS: sales, held sales, registers, discounts; returns and refunds | |
| 6 | Purchasing, finance, customers admin, promotions, shipping admin | |
| 7 | Reports, audit log, notifications, background jobs (BullMQ for Celery); cutover | |

Phase 1 endpoints, all compared by the parity harness:

| Endpoint | Notes |
|---|---|
| `GET /api/health/`, `/api/ready/` | not throttled, as plain Django views are not |
| `GET /api/v1/shop/products/` | search, filters, sorts and pagination exactly as `search_products`; logs search terms |
| `GET /api/v1/shop/products/<slug>/` | specs, size chart, reviews, bought-together |
| `GET /api/v1/shop/categories/[<slug>/]`, `brands/[<slug>/]` | |
| `GET /api/v1/shop/facets/`, `search/suggest/` | |
| `GET /api/v1/shop/home/`, `navigation/`, `site/`, `pages/[<slug>/]` | `site/` creates the settings row on first read |
| `GET /api/v1/shop/feed.xml`, `feed.csv` | cached 15 minutes; 503 without `RANGON_PUBLIC_URL` |

## Running it

```bash
scripts/nest-parity.sh reset
```

Starts both APIs on one fresh database (project `rangon-nest`, ports 8610 Django and 8620 Nest,
loopback only), seeds the demo data and applies the parity fixtures. Then:

```bash
scripts/nest-parity.sh run
```

Every case to both APIs; exits non-zero on any difference not listed below. `PARITY_ONLY=feed`
runs the cases whose name contains `feed`. The rate limits, which the parity stack turns off, are
compared on their own:

```bash
docker compose -p rangon-nest -f docker-compose.nest.yml --profile throttle run --rm throttle-check
```

**Always pass `-p rangon-nest`** when calling compose directly: `.env` sets
`COMPOSE_PROJECT_NAME=rangon`, and without `-p` these containers join the development project.

Inside `apps/api-nest/` (Node is not needed on the host; run these in `node:22-bookworm-slim`):

```bash
npm run typecheck      # the API and the harness
npm run lint
npm test               # unit tests: Python/DRF compatibility, JWT, pagination, throttling
npm run db:pull        # re-introspect after a Django migration (DATABASE_URL to a migrated DB)
```

## How a module is ported

1. **Capture Django's SQL** for every endpoint in the module, in the parity stack, with
   `CaptureQueriesContext`. Where the response order depends on the plan -- a GROUP BY (Django drops
   `Meta.ordering` there), a sort on a column with ties, an unordered prefetch -- send the same
   statement, aliases and join order included. `catalog/product-search.ts` shows how the ORM's
   alias rules are reproduced.
2. **Read the serializer, not the model.** Key names, `None` versus `""`, which datetime format
   (`common/datetime.ts`: DRF's `Z` for a raw datetime, the local zone through a serializer field,
   `+00:00` where the view calls `isoformat()`), which Decimal becomes a JSON number (a bare Decimal
   in a dict) and which a string (a serializer field).
3. **Use the Python helpers** in `common/python.ts` wherever Python parses or formats something a
   client sees.
4. **Add parity cases and fixtures** for every branch: missing, inactive, unpublished, empty, a tie,
   a malformed parameter. A module is done when its cases pass and a spot check shows they exercise
   what they claim to.
5. **Writes** additionally need the service's transaction boundary, its `SELECT ... FOR UPDATE`, its
   idempotency handling and concurrency tests against the shared database, before any parity run.

## Deliberate differences

Each is also listed in `apps/api-nest/parity/known-differences.ts` where the harness sees it.

| Where | Django | Nest | Why |
|---|---|---|---|
| 401 message | the Python `repr` of SimpleJWT's error dict | the words inside it | Status and code match; a repr is not a message |
| Rate-limit budgets | its own buckets | its own buckets | Route each path to one API and a client sees one budget |
| Cached feeds | its own cache keys | its own cache keys | Both expire on the same schedule |
| Session cookies | `SessionAuthentication` accepts a Django admin session | not read | No ported endpoint's answer depends on the user; revisit with phase 2 |
| `OPTIONS` without CORS headers | DRF's view metadata | 405 | Nothing calls it |
| `USE_S3=1` | S3 URLs | refuses to start | django-storages' URL building is not ported; a wrong image URL is worse than a refusal |

One Django quirk is *not* copied because the harness cannot see it: gunicorn writes a body on
`HEAD` responses. The Nest API sends none, as HTTP requires.

## Performance, measured 2026-09-30

Same machine, same database, one API at a time, 400 requests per endpoint with 8 concurrent
clients (`parity/bench.ts`); Django as production runs it, 2 gunicorn workers x 4 threads.

| Endpoint | Django req/s | Nest req/s | Django p95 ms | Nest p95 ms |
|---|---|---|---|---|
| `/api/health/` | 362 | 2113 | 34.7 | 7.3 |
| `/shop/categories/` | 64 | 517 | 247.4 | 29.0 |
| `/shop/products/` | 23 | 103 | 468.0 | 119.2 |
| `/shop/products/?q=shirt` | 35 | 140 | 388.9 | 67.7 |
| `/shop/products/<slug>/` | 17 | 95 | 904.9 | 99.8 |
| `/shop/home/` | 5 | 40 | 1739.1 | 258.9 |
| `/shop/navigation/` | 68 | 249 | 184.6 | 39.2 |

Memory after the run: Django 248 MB (master 28, two workers 110 each), Nest 114 MB (one process).
The machine was swapping; absolute numbers are this machine's, the ratios are the finding. Part of
the gap on `categories/` is that Django issues 8 queries there (an N+1) where the port issues 2.
