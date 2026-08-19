# Rangon Fashion — Retail & E-commerce Platform

Omnichannel retail platform for Rangon Fashion: **one backend** serving a public storefront, an
in-store POS, and a back-office admin panel, over a single shared catalog, inventory ledger, customer
database and order system.

```text
   Storefront (Next.js)        POS (Next.js)        Admin (Next.js)
            \                      |                     /
             ------------  Django REST API  -------------
                                  |
                    PostgreSQL  +  Redis  +  Celery
```

- Product spec: [rangon_fashion_build_plan.md](rangon_fashion_build_plan.md)
- Engineering constitution: [CLAUDE.md](CLAUDE.md)
- Roadmap & status: [docs/roadmap.md](docs/roadmap.md)
- Business rules: [docs/business-rules.md](docs/business-rules.md)
- Architecture: [docs/architecture/architecture.md](docs/architecture/architecture.md)

## Status

Not production-ready; not deployed anywhere. As of **2026-08-18** (commit `423cdf4`):

|                  |                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI               | Green on all four jobs — backend lint/format/migrations/tests, frontend lint/typecheck/**build**, dependency audits, image build + Trivy scan              |
| Backend tests    | 167 passing, including 7 threaded concurrency tests against real PostgreSQL                                                                                       |
| Frontend tests   | Vitest 17 passing —**not run by CI**. Playwright specs exist but [cannot run in the dev image](docs/roadmap.md#known-defects)                               |
| Verified by hand | Migrations from empty, seeded demo data, ledger integrity, a POS sale, and a full browser purchase (add to cart → COD checkout → confirmed order)               |
| Type checking    | `tsc` clean; `mypy` reports 98 errors and is deliberately non-blocking in CI                                                                                  |
| Biggest gaps     | No payment gateway, no live environment, most admin**write** screens are still API-only, and the wishlist/reviews/notifications features have no working UI |

Phase-by-phase status, the full verification log, and the known defects (D1–D9) are in
[docs/roadmap.md](docs/roadmap.md). Read it before claiming any part of this works.

## Repository layout

```text
Rangon/
├── apps/
│   ├── api/                     Django + DRF modular monolith
│   │   ├── config/              settings (base/dev/test/prod), urls, celery
│   │   ├── core/                base models, money, errors, audit, sequences
│   │   ├── accounts/            organization, branch, user, role, permission
│   │   ├── catalog/             category, brand, product, variant, attributes, images
│   │   ├── inventory/           inventory records + ledger engine
│   │   ├── purchasing/          suppliers, purchase orders, receiving
│   │   ├── customers/           customers, addresses, notes
│   │   ├── orders/              orders, payments, refunds, returns, POS + checkout services
│   │   ├── shipping/            zones, methods, shipments, tracking events
│   │   ├── promotions/          coupons
│   │   ├── engagement/          wishlist, reviews
│   │   ├── reports/            dashboard + reporting endpoints
│   │   └── notifications/       in-app/email notification infrastructure
│   └── web/                     Next.js app: (storefront) (admin) (pos) route groups
├── infrastructure/docker/       nginx config, entrypoint scripts
├── docs/                        architecture, database, api, testing, operations
├── scripts/                     developer helper scripts
└── docker-compose*.yml
```

## Prerequisites

Only Git, Docker Desktop and an editor. Everything else runs in containers.

## Quick start

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Then, in a second terminal:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py seed_demo --reset
```

| Service                | URL                                                                |
| ---------------------- | ------------------------------------------------------------------ |
| Storefront             | http://localhost:3000 (`WEB_PORT` — see the Windows note below) |
| Admin                  | http://localhost:3000/admin                                        |
| POS                    | http://localhost:3000/pos                                          |
| API                    | http://localhost:8000/api/v1/                                      |
| API schema (Swagger)   | http://localhost:8000/api/docs/                                    |
| Django admin           | http://localhost:8000/django-admin/                                |
| Mailpit (dev email)    | http://localhost:8025                                              |
| MinIO console (dev S3) | http://localhost:9001                                              |

> **Windows: if port 3000 will not bind**, `docker compose up` fails with
> `bind: An attempt was made to access a socket in a way forbidden by its access permissions`.
> Windows reserves wide TCP ranges for Hyper-V/WinNAT — frequently the whole
> 2900–3500 block, so 3000, 3001 and 3100 all fail. List the reserved ranges:
>
> ```bash
> netsh interface ipv4 show excludedportrange protocol=tcp
> ```
>
> Then pick a free port and set it in `.env`, keeping the origin consistent:
> `WEB_PORT`, `NEXT_PUBLIC_SITE_URL`, `DJANGO_CORS_ALLOWED_ORIGINS` and
> `DJANGO_CSRF_TRUSTED_ORIGINS`. Recreate with:
>
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate web api
> ```
>
> Reclaiming 3000 instead needs an elevated `net stop winnat && net start winnat`,
> which drops every other Docker port mapping while it restarts.

Demo logins created by `seed_demo` (development only):

| Role              | Email                | Password    |
| ----------------- | -------------------- | ----------- |
| OWNER             | owner@rangon.test    | rangon12345 |
| MANAGER           | manager@rangon.test  | rangon12345 |
| CASHIER           | cashier@rangon.test  | rangon12345 |
| INVENTORY_MANAGER | stock@rangon.test    | rangon12345 |
| ACCOUNTANT        | accounts@rangon.test | rangon12345 |
| CUSTOMER          | customer@rangon.test | rangon12345 |

## Everyday commands

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up          # start
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d       # start detached
docker compose logs -f api                                                 # tail api logs
docker compose down                                                        # stop
docker compose down -v                                                     # stop + wipe volumes
```

Backend:

```bash
docker compose exec api python manage.py makemigrations
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
docker compose exec api python manage.py seed_demo --reset
docker compose exec api pytest                        # full suite
docker compose exec api pytest -m "not slow"          # fast suite
docker compose exec api ruff check .                  # lint
docker compose exec api ruff format .                 # format
docker compose exec api mypy .                        # type check
```

Frontend:

```bash
docker compose exec web npm run dev
docker compose exec web npm run lint
docker compose exec web npm run typecheck
docker compose exec web npm run test                  # Vitest unit/component (17 tests, ~25 s)
docker compose exec web npm run build
docker compose exec web npm run test:e2e              # Playwright — see the warning below
```

> **`npm run test:e2e` does not work in the dev container.** `apps/web/Dockerfile.dev` is
> `node:22-alpine`, and Playwright publishes no musl browser builds, so `npx playwright install`
> has nothing to install. Run the specs from a glibc image (`mcr.microsoft.com/playwright`) or from
> the host against a seeded stack, pointing `E2E_BASE_URL` at the storefront origin. Until that is
> set up, the four critical flows are only covered by hand.

> **CI runs neither frontend test suite.** The frontend job is `npm ci` → lint → typecheck → build.
> Vitest and Playwright are not wired in; adding Vitest is a two-line change and it already passes.

### The dev server is not the app. Do not judge speed by it.

`next dev` compiles each route on first request and serves an unminified React development build. It
is **many times slower than production, by design**. Measured on this project, same machine, same API,
same seeded data:

| Page | Production | Dev |
|---|---|---|
| `/` | **0.03 s** | 4.87 s |
| `/shop` | **0.29 s** | 1.44 s |
| `/checkout` | **0.012 s** | 0.93 s |
| `/product/[slug]` | **0.11 s** | 1.36 s |

Production boots in ~0.35 s and serves pages in 11–320 ms. If you want a real number, measure the real
thing:

```bash
docker compose build web
docker run -d --name rangon-web-prod --network rangon_frontend \
  -e API_INTERNAL_URL=http://api:8000/api/v1 -p 4100:3000 rangon-web:latest
```

Then compare `http://localhost:4100` against `http://localhost:4000`. Remove it with
`docker rm -f rangon-web-prod` afterwards, and rebuild the dev image, because both share one tag.

The dev script uses **Turbopack** (`next dev --turbopack`), which cut per-route compilation from
~5–16 s to ~2 s. It pays a one-off graph build (~30 s) on the first request after start. `npm run build`
still uses webpack — the production path is unchanged.

**When a page really is slow, it is almost never the bundler.** Time the endpoint directly and count
its queries before touching the frontend — that is how three N+1s and a per-keystroke request storm
were found here. See [docs/database/indexing.md](docs/database/indexing.md).

`apps/web/package-lock.json` is committed and CI installs with `npm ci`, so every environment gets
byte-identical dependencies. Never delete it or install with `npm install` in CI.

> On Windows, `npm run build` through the bind-mounted dev container is very slow. Building the
> production image (`docker compose build web`) copies the source in instead and is the faster path —
> it is also exactly what CI does.
>
> **Both web images share the tag `rangon-web:latest`.** Neither compose file sets `image:`, so
> `docker compose build web` (production `Dockerfile`) overwrites the tag the dev overlay
> (`Dockerfile.dev`) produced, and vice versa. The production runtime deliberately removes npm, so a
> later `up -d` *without* `--build` can start the production image with the dev command `npm run dev`
> and fail. After building the production image, rebuild the dev one before bringing the stack up:
>
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.dev.yml build web
> ```

Tests in a throwaway containerised environment (what CI runs):

```bash
docker compose -f docker-compose.test.yml run --rm api-test
```

## Local run without Docker (fallback)

Docker is the supported path. If you must run on the host you still need PostgreSQL 16 and Redis 7
available, then:

```bash
cd apps/api
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install -r requirements/dev.txt
set DJANGO_SETTINGS_MODULE=config.settings.dev
python manage.py migrate && python manage.py seed_demo --reset && python manage.py runserver

cd ../web
npm install && npm run dev
```

## Deployment

Staging/production procedures, migration strategy, rollback and backups are documented in:

- [docs/operations/deployment.md](docs/operations/deployment.md)
- [docs/operations/backups.md](docs/operations/backups.md)
- [docs/operations/disaster-recovery.md](docs/operations/disaster-recovery.md)

CI builds both images on every push and tags them with the git SHA (`rangon-api:<sha>`,
`rangon-web:<sha>`), then scans them with Trivy for HIGH/CRITICAL vulnerabilities. `latest` is never
the only production reference. Note that CI **builds and scans but does not push** — no registry is
configured yet, and nothing has ever been deployed.

## Brand assets

The official logo vectors live in `apps/web/public/brand/logo/` and are rendered only by
`src/components/brand/logo.tsx`. Which variant goes where, the geometry, and the brand colour
(`#FD3807`, read from the vector itself) are documented in
[apps/web/public/brand/BRAND-ASSETS.md](apps/web/public/brand/BRAND-ASSETS.md). A raster favicon and
an OG share image still need to be produced from the symbol.

## Licence

Proprietary — © Rangon Fashion.
