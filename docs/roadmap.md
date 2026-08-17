# Roadmap & Status

Phase order follows §85 of the build plan. **Do not reorder casually** — the storefront must not be
built before the product/variant/inventory/order architecture is stable.

Legend: ✅ done · 🟡 partial (gaps listed) · ⬜ not started

| # | Phase | Status | Notes |
|---|---|---|---|
| 00 | Project constitution | ✅ | `CLAUDE.md`, `docs/` tree, ADRs, CI skeleton |
| 01 | Brand + design system | ✅ | Tokens, components, shells. Logo assets are **placeholders** |
| 02 | Architecture | ✅ | `docs/architecture/*`, ERD, domain model, ADR 0001–0008 |
| 03 | Database | ✅ | 11 Django apps, UUID PKs, Decimal money, constraints, migrations |
| 04 | Auth + RBAC | ✅ | JWT, 7 roles, permission codes, branch scoping, audit log |
| 05 | Product catalog | ✅ | Categories, brands, products, variants, dynamic attributes, images |
| 06 | Inventory engine | ✅ | Ledger, reservations, transfers, adjustments, weighted-average cost |
| 07 | Suppliers + purchasing | ✅ | PO → receive → `PURCHASE` ledger rows → cost recalculation |
| 08 | POS | ✅ | Barcode-first UI, cart, split payment, hold/resume, receipt, refund |
| 09 | Payments | ✅ | Generic payment model + provider registry (`manual` provider shipped) |
| 10 | Returns | ✅ | Request → approve → receive → restock decision → refund |
| 11 | Customers | ✅ | Customers, addresses, notes, phone-first identity, history |
| 12 | Online store | ✅ | Home, shop, category, product, cart, checkout, order, account |
| 13 | Search + filters | ✅ | Postgres trigram + indexed facet filtering (no external search engine) |
| 14 | Cart | ✅ | Server-authoritative cart, re-priced on every read |
| 15 | Checkout | ✅ | Idempotency keys, stock reservation, COD, server-side totals |
| 16 | Online payments | 🟡 | Provider abstraction + manual/COD complete; no live gateway credentials |
| 17 | Orders | ✅ | Status machine, timeline, packing slip, invoice, cancel, fulfil |
| 18 | Shipping | ✅ | Zones, methods, shipments, manual tracking, courier-ready interface |
| 19 | Coupons | ✅ | Percentage/fixed, min order, max discount, windows, usage limits, scope |
| 20 | Wishlist + reviews | ✅ | Wishlist; verified-purchase reviews with moderation |
| 21 | Dashboard | ✅ | Server-side aggregated KPIs + charts |
| 22 | Reports | ✅ | Sales, product performance, inventory, purchases, returns + CSV export |
| 23 | Offline POS | ⬜ | Deliberately deferred to V2 (see plan §29). Design notes in `architecture/offline-pos.md` |
| 24 | Barcode + printing | 🟡 | Keyboard-wedge scanning, barcode generation, print CSS for receipt/A4/labels. No ESC/POS driver |
| 25 | Notifications | 🟡 | Model + in-app feed + Celery email tasks. No SMS provider wired |
| 26 | SEO | ✅ | Metadata, OG, sitemap, robots, canonicals, JSON-LD product + breadcrumbs |
| 27 | Security audit | 🟡 | Controls implemented and documented; independent pen-test not performed |
| 28 | Performance | 🟡 | Indexes + aggregation + query budgets in tests; no load test yet |
| 29 | E2E testing | 🟡 | Playwright specs for the 4 critical flows; require a running stack |
| 30 | Deployment | 🟡 | Compose prod stack + CI build/scan/push documented; no live environment |
| 31 | Backup/recovery | 🟡 | Scripts + runbook written; **restore has not been rehearsed on real data** |
| 32 | Production launch | ⬜ | Blocked on the checklist in `docs/operations/go-live-checklist.md` |

## Known gaps to close before go-live

1. **Real brand assets.** Replace placeholder logo/favicon/OG files (`apps/web/public/brand/`).
2. **Payment gateway.** Implement a real provider (SSLCOMMERZ / bKash) against
   `orders.payments.providers.base.PaymentProvider`; add webhook signature verification and replay
   tests. COD works today.
3. **SMS provider** for order notifications.
4. **Restore rehearsal.** A backup that has never been restored is not a backup.
5. **Load testing** of product listing, checkout and POS search at expected peak.
6. **Independent security review** (the internal pass is documented, not externally validated).
7. **Thermal printer driver** if the store uses ESC/POS rather than the browser print dialog.
8. **Offline POS** (V2) once the online POS has been used in production for a while.

## Suggested next task

Wire one real payment gateway end to end (provider class → checkout → webhook → `Payment` row →
order status), with webhook replay and duplicate-payment tests. It is the largest remaining functional
gap and it unblocks online prepaid orders.
