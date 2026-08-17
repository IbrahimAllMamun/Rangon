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

| Service | URL |
|---|---|
| Storefront | http://localhost:3000 |
| Admin | http://localhost:3000/admin |
| POS | http://localhost:3000/pos |
| API | http://localhost:8000/api/v1/ |
| API schema (Swagger) | http://localhost:8000/api/docs/ |
| Django admin | http://localhost:8000/django-admin/ |
| Mailpit (dev email) | http://localhost:8025 |
| MinIO console (dev S3) | http://localhost:9001 |

Demo logins created by `seed_demo` (development only):

| Role | Email | Password |
|---|---|---|
| OWNER | owner@rangon.test | rangon12345 |
| MANAGER | manager@rangon.test | rangon12345 |
| CASHIER | cashier@rangon.test | rangon12345 |
| INVENTORY_MANAGER | stock@rangon.test | rangon12345 |
| ACCOUNTANT | accounts@rangon.test | rangon12345 |
| CUSTOMER | customer@rangon.test | rangon12345 |

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
docker compose exec web npm run build
docker compose exec web npm run test:e2e              # Playwright
```

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

Images are built by CI and tagged with the git SHA (`rangon/api:<sha>`, `rangon/web:<sha>`).
`latest` is never the only production reference.

## Brand assets

Logo, favicon and social assets live in `apps/web/public/brand/`. The files currently committed are
**placeholders** — see [apps/web/public/brand/BRAND-ASSETS.md](apps/web/public/brand/BRAND-ASSETS.md)
before shipping anything customer-facing.

## Licence

Proprietary — © Rangon Fashion.
