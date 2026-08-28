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

To run the **production** build on your own machine instead, see
[Run the production build locally](#run-the-production-build-locally).

Backend:

```bash
docker compose exec api python manage.py makemigrations
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
docker compose exec api python manage.py seed_demo --reset
docker compose exec api python manage.py verify_inventory   # stock cache vs ledger
docker compose exec api python manage.py verify_accounts    # balances vs cash book
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

| Page                | Production        | Dev    |
| ------------------- | ----------------- | ------ |
| `/`               | **0.03 s**  | 4.87 s |
| `/shop`           | **0.29 s**  | 1.44 s |
| `/checkout`       | **0.012 s** | 0.93 s |
| `/product/[slug]` | **0.11 s**  | 1.36 s |

Production boots in ~0.35 s and serves pages in 11–320 ms. If you want a real number, measure the real
thing — see [Run the production build locally](#run-the-production-build-locally) below, then compare
`http://localhost:4100` against `http://localhost:4000`.

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

## Run the production build locally

`docker-compose.prodlocal.yml` runs the **production** images on your own machine — gunicorn, the
production Next build, Celery and one Nginx origin — over plain HTTP. Use it to see what the app
actually feels like, to reproduce something that only happens in a production build (a CSP failure, a
server/client boundary error), or to rehearse a deploy. It is *not* a deployment; for that see
[docs/operations/](docs/operations/deployment.md).

It runs as a **separate compose project** (`-p rangon-prod`) with its own volumes and network, so it
cannot collide with the dev stack or share a Postgres data directory with it. Two servers on one data
directory is how you lose a database.

**1. Create `.env.prod.local`** (gitignored). `config/settings/prod.py` refuses to boot without these:

```bash
DJANGO_SECRET_KEY=<a real secret — not one starting with dev-, test-, build- or insecure>
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,api,web,nginx   # must not be empty, must not contain "*"
POSTGRES_PASSWORD=<any local password>
```

**2. Name the stack once**, because every command needs the same four flags and getting one wrong
silently targets the dev stack instead:

```bash
alias prodlocal='docker compose -p rangon-prod --env-file .env.prod.local -f docker-compose.yml -f docker-compose.prodlocal.yml'
```

**3. Build and start:**

```bash
prodlocal up -d --build
```

**4. Migrate and seed** (its database is empty and separate from the dev one):

```bash
prodlocal exec api python manage.py migrate
prodlocal exec api python manage.py seed_demo --reset
```

|                               |                                                               |
| ----------------------------- | ------------------------------------------------------------- |
| Storefront / admin / POS      | [http://localhost:4100](http://localhost:4100)                 |
| API (direct, bypassing Nginx) | [http://localhost:8100/api/v1/](http://localhost:8100/api/v1/) |
| Mailpit                       | [http://localhost:8125](http://localhost:8125)                 |

Everything goes through Nginx on **4100** as a single origin, which is what the deployed topology
looks like and what `smoke-test.sh` assumes:

```bash
./scripts/smoke-test.sh http://localhost:4100
```

**Logs and stop**, leaving the dev stack untouched:

```bash
prodlocal logs -f api
prodlocal down            # add -v to drop this stack's database too
```

Without the alias, spell the four flags out every time:

```bash
docker compose -p rangon-prod --env-file .env.prod.local \
  -f docker-compose.yml -f docker-compose.prodlocal.yml <command>

docker build -t rangon-web:prod -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://rangonfashion.com/api/v1 --build-arg NEXT_PUBLIC_SITE_URL=https://rangonfashion.com apps/web
```

What this deliberately is *not*: no TLS (so `DJANGO_SECURE_SSL_REDIRECT` is forced off per service —
leave it off, or nothing loads over `http://localhost`), images built locally rather than pulled by
immutable tag, and none of the container hardening from `docker-compose.prod.yml`, which changes
nothing about what you see in the browser. For a real deployment, and for exposing this on a domain,
read [docs/operations/self-hosting-with-a-domain.md](docs/operations/self-hosting-with-a-domain.md).

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
- [docs/operations/webuzo-deployment.md](docs/operations/webuzo-deployment.md) — single-server Webuzo VPS
- [docs/operations/self-hosting-with-a-domain.md](docs/operations/self-hosting-with-a-domain.md) — your own machine + your own domain
- [docs/operations/cloudflare-local-setup.md](docs/operations/cloudflare-local-setup.md) — Cloudflare Tunnel runbook for the local stack
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
