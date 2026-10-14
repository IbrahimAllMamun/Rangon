# System Architecture

## 1. Shape of the system

A **modular monolith** API (NestJS, `apps/api-nest/`) with a single Next.js frontend that hosts three
route groups. One database, one inventory ledger, one order table.

```text
                    ┌──────────────────────────────────────────┐
                    │           Next.js 15 (apps/web)          │
                    │  (storefront)   (admin)   (pos)          │
                    └───────┬───────────┬───────────┬──────────┘
                            │  server components fetch server-side
                            │  client components fetch via TanStack Query
                            ▼
                    ┌──────────────────────────────────────────┐
                    │      NestJS on Fastify  (apps/api-nest)  │
                    │  /api/v1/{auth,catalog,inventory,        │
                    │   purchasing,orders,pos,shop,reports}    │
                    │                                          │
                    │  controllers → services → database       │
                    │  + the job worker and its schedule       │
                    └───────┬──────────────────┬───────────────┘
                            │                  │
                  ┌─────────▼───────┐   ┌──────▼──────┐
                  │   PostgreSQL 16 │   │   Redis 7   │
                  │ source of truth │   │ cache and   │
                  │ + the job queue │   │ rate limits │
                  └─────────────────┘   └─────────────┘
```

The API was a Django project until 2026-10-14. The NestJS port answered the same endpoints over the
same PostgreSQL, served production from 2026-10-08, and Django was then removed
([ADR-0013](decisions/0013-nestjs-api-alongside-django.md),
[ADR-0016](decisions/0016-nest-jobs-on-pg-boss.md),
[ADR-0017](decisions/0017-nest-api-serves-production.md),
[ADR-0023](decisions/0023-django-is-gone.md)). The domains below are still Django's apps, by name and
by table: `orders_order`, `inventory_inventorytransaction`.

## 2. Backend module map

| Domain (`src/<domain>/`, tables `<domain>_*`) | Owns | Depends on |
|---|---|---|
| `common`, `http`, `health`, `media` (Django's `core`) | money, errors, sequences, audit log, health, storage | — |
| `accounts` | organization, branch, user, role, permission, JWT auth | core |
| `catalog` | category, brand, product, variant, attribute, image | core, accounts |
| `inventory` | inventory record, ledger, reservations, transfers, costing | core, catalog, accounts |
| `purchasing` | supplier, purchase order, receipt, supplier payment | inventory, catalog |
| `customers` | customer, address, note | core, accounts |
| `orders` | order, line, payment, refund, return, POS + checkout + lifecycle services | inventory, customers, catalog, promotions, shipping |
| `shipping` | zone, method, shipment, tracking event | orders |
| `promotions` | coupon, usage | catalog, customers |
| `engagement` | wishlist, review | catalog, customers, orders |
| `reports` | dashboard + report aggregation (no models) | everything (read-only) |
| `notifications`, `jobs` | notifications; the background jobs on pg-boss (mail, SMS, the sweeps and digests) | core, accounts |
| `content` | the storefront's navbar overrides, banners, footer (settings, social links, link columns) and site pages; HTML sanitising for page bodies; cache revalidation pings to the web app — [navigation.md](navigation.md), [ADR-0012](decisions/0012-storefront-footer-and-site-pages.md) | core, catalog (categories drive the navbar and the footer's "Top categories"), accounts (the organisation's contact details are the footer's fallback) |

Dependency direction is one-way: `orders` may import from `inventory`; `inventory` must never import
from `orders`. Cross-domain coupling that would create a cycle goes through a service argument
instead.

## 3. Request lifecycle

```text
Nginx → Fastify → the request id → JWT authentication (auth/authentication.ts)
      → the route's permission check (auth/permissions.ts: role permission codes + branch scope)
      → controller: the body parsed and validated (shape + type + basic rules)
      → service: one transaction, SELECT … FOR UPDATE on the protected rows, the invariants
      → row writes + ledger writes + audit entry + order event + jobs queued, in that transaction
      → the serialised answer → JSON
```

Failures throw a `BusinessError` (`common/errors.ts`), which the envelope filter renders as
`{"error": {"code", "message", "details"}}` with an appropriate status code.

## 4. Concurrency strategy

The invariants that must never break are "stock does not go negative" and "money is not captured
twice". Both are protected pessimistically:

- `SELECT … FOR UPDATE` on the `Inventory` rows involved, ordered by primary key to avoid deadlocks.
- Database `CheckConstraint`s as a second line of defence (`on_hand >= 0`, `reserved >= 0`,
  `reserved <= on_hand` when overselling is disabled).
- `UniqueConstraint` on `(provider, provider_event_id)` for payment events and on idempotency keys.
- Number sequences allocated under a row lock.

Optimistic locking is deliberately **not** used for stock: retry loops under contention are harder to
reason about at a POS counter than a short row lock. See
[ADR-0004](decisions/0004-pessimistic-locking-for-stock.md).

## 5. Frontend architecture

- **Server components** render catalog, order and report pages: SEO-friendly, no client secrets.
- **Client components** handle cart, POS, filters and forms; server state through TanStack Query,
  ephemeral UI state through Zustand (POS cart draft, drawer state) — nothing authoritative.
- Auth tokens live in **httpOnly cookies** set by Next.js route handlers under `/api/auth/*`, never in
  `localStorage`. Server components read the cookie and call the API directly over the private network.
- One design-token layer (`src/styles/tokens.css`) feeds Tailwind and every component; the three
  surfaces differ by density and surface colour, not by visual language.

## 6. Deviations from the source plan

| Plan | Implemented | Why |
|---|---|---|
| `apps/web/{storefront,admin,pos}` as three apps | one Next.js app with `(storefront)`, `(admin)`, `(pos)` route groups | Shares the design system, one build, one deploy, one auth cookie domain. Splitting later is a directory move — [ADR-0002](decisions/0002-single-next-app-with-route-groups.md) |
| `packages/{ui,types,config,validation}` | `apps/web/src/{components,lib,types}` | A single frontend app makes a workspace package boundary pure overhead. Revisit when a second frontend app (e.g. Tauri POS) appears |
| Separate `Purchase` and `PurchaseOrder` models | one `PurchaseOrder` with a `status` machine + `PurchaseReceipt` for goods actually received | Avoids two near-identical tables; receiving is the event that touches inventory |
| Elasticsearch/Meilisearch | PostgreSQL `pg_trgm` + indexed facets | The plan says only introduce a search engine if real requirements justify it |
| Nginx in front in production | included, but documented as optional if the host provides a managed proxy | Plan §32A |

Every deviation is recorded as an ADR under `decisions/`.
