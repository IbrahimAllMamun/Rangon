# Roadmap & Status

Phase order follows §85 of the build plan. **Do not reorder casually** — the storefront must not be
built before the product/variant/inventory/order architecture is stable.

Legend: ✅ done and verified · 🟡 partial (gap stated) · ⬜ not started

**Verified** means it was actually executed: migrations applied from an empty database, `seed_demo`
run, 155 backend tests passing, `ruff` clean, frontend typecheck passing.

| # | Phase | Backend | Frontend | Notes |
|---|---|---|---|---|
| 00 | Project constitution | ✅ | — | `CLAUDE.md`, `docs/`, 8 ADRs, CI workflow |
| 01 | Brand + design system | — | ✅ | Tokens, primitives, three shells. Official logo vectors wired |
| 02 | Architecture | ✅ | — | `docs/architecture/*`, ERD, domain model |
| 03 | Database | ✅ | — | 12 apps, UUID PKs, Decimal money, constraints, migrations apply clean |
| 04 | Auth + RBAC | ✅ | ✅ | JWT in httpOnly cookies, 7 roles, branch scoping, audit log, sign-in page |
| 05 | Product catalog | ✅ | 🟡 | Full CRUD API. Admin has a **read-only** product list; no create/edit form yet |
| 06 | Inventory engine | ✅ | 🟡 | Ledger, reservations, transfers, WAC, `verify_inventory`. Admin list is read-only; no adjust/count UI |
| 07 | Suppliers + purchasing | ✅ | ⬜ | PO → receive → ledger → cost recalculation all work via API; no admin screens |
| 08 | POS | ✅ | ✅ | Barcode-first register, split payment, hold/resume, receipt, F2/F4/F8 shortcuts |
| 09 | Payments | ✅ | ✅ | Generic model + provider registry; `manual` provider (cash/card/MFS/COD) shipped |
| 10 | Returns | ✅ | ⬜ | Full request→approve→receive→restock→refund service + API; POS one-step return API. No admin UI |
| 11 | Customers | ✅ | ⬜ | Phone-first identity, addresses, notes, history via API; no admin screens |
| 12 | Online store | ✅ | ✅ | Home, shop, product, cart, checkout, order tracking, account, policies |
| 13 | Search + filters | ✅ | ✅ | Postgres trigram + indexed facets; facet UI with colour swatches |
| 14 | Cart | ✅ | ✅ | Server-authoritative, re-priced on every read, drawer + full page |
| 15 | Checkout | ✅ | ✅ | Idempotency keys, reservation, COD, server-side totals, error summary |
| 16 | Online payments | 🟡 | 🟡 | Abstraction + COD complete. **No live gateway** — the card option is disabled in the UI |
| 17 | Orders | ✅ | 🟡 | Status machine, timeline, invoice/packing-slip payloads. Admin list built; **no order detail page** |
| 18 | Shipping | ✅ | 🟡 | Zones, methods, shipments, courier-ready interface. Checkout picks a method; no admin screens |
| 19 | Coupons | ✅ | 🟡 | Full engine + API; cart can apply/remove. No admin coupon screens |
| 20 | Wishlist + reviews | ✅ | 🟡 | API complete, reviews render on the product page. No wishlist page, no moderation UI |
| 21 | Dashboard | ✅ | ✅ | Server-aggregated KPIs, sales chart with a table alternative |
| 22 | Reports | ✅ | ⬜ | 8 report endpoints + CSV export work; no reports UI (dashboard covers the headline numbers) |
| 23 | Offline POS | ⬜ | ⬜ | Deliberately V2 (plan §29). Design recorded in `architecture/offline-pos.md` |
| 24 | Barcode + printing | 🟡 | 🟡 | Keyboard-wedge scanning + barcode generation work; print CSS for 80 mm receipt and A4. No ESC/POS driver |
| 25 | Notifications | 🟡 | ⬜ | Model, in-app feed API, Celery email tasks. No SMS provider, no bell UI |
| 26 | SEO | ✅ | ✅ | Metadata, OG, sitemap, robots, canonicals, JSON-LD product + breadcrumbs |
| 27 | Security | 🟡 | 🟡 | Controls implemented and documented; **no independent penetration test** |
| 28 | Performance | 🟡 | 🟡 | Indexes + DB-side aggregation. Query budgets are documented but **not yet asserted in tests**; no load test |
| 29 | E2E testing | 🟡 | 🟡 | Playwright specs written for the four critical flows; **not yet executed** |
| 30 | Deployment | 🟡 | 🟡 | Compose prod stack, CI with build + Trivy scan; **no live environment** |
| 31 | Backup/recovery | 🟡 | — | Scripts + runbook written; **restore never rehearsed** |
| 32 | Production launch | ⬜ | ⬜ | Blocked on `docs/operations/go-live-checklist.md` |

## What was actually executed

```text
migrations from empty database ........ OK (all 12 apps)
seed_demo --reset ..................... 12 products, 72 variants, 2 POs, 40 orders
ledger integrity after seeding ........ 0 drift
pytest ................................ 155 passed (148 unit/service/API + 7 concurrency)
ruff check + ruff format .............. clean
frontend typecheck (tsc --noEmit) ..... clean
```

## Gaps to close before go-live

1. **Payment gateway.** Implement a real provider against
   `orders.payments.providers.base.PaymentProvider`, with signature verification and webhook replay
   tests. COD works today; the card option is visibly disabled rather than pretending to work.
2. **Admin CRUD screens** for products, purchasing, customers, returns, coupons and reports. The APIs
   are complete and tested — this is frontend work, not backend work.
3. **Admin order detail page** (status changes, refunds, invoice/packing slip printing). The endpoints
   exist; `/admin/orders/[id]` does not.
4. **Run the E2E suite** against a seeded stack and wire it into CI.
5. **Restore rehearsal.** A backup that has never been restored is not a backup.
6. **Load test** product listing, checkout and POS search at expected peak; add the
   `assertNumQueries` budgets from `docs/database/indexing.md` as real tests.
7. **Independent security review.**
8. **SMS provider** for order notifications.
9. **Favicon raster + OG image** from the official symbol (the SVG favicon is wired).

## Suggested next task

Build `/admin/orders/[id]`. It is the screen the shop will use every single day, every endpoint it
needs is already built and tested, and it closes the loop between the storefront and the back office.
