# Requirements

Distilled from [rangon_fashion_build_plan.md](../rangon_fashion_build_plan.md). `MVP` = launch scope,
`V1.1`/`V2` = later. Anything marked ❓ needs the owner's decision (see
[business-rules.md](business-rules.md)).

## Functional

### Physical store (POS)
- MVP: barcode scan, SKU/name search, category browse, cart, quantity edit, line/order discount,
  customer attach or walk-in, cash/card/MFS payment, split payment, change calculation, receipt print,
  hold & resume sale, void with permission, in-store return + refund, keyboard-first operation.
- V2: offline mode, multi-register cash drawer reconciliation, shift open/close reports.

### Online store
- MVP: catalog browse, category pages, product detail with variant selection, search with typo
  tolerance, facet filters (category, brand, price, size, colour, availability), sort, cart, checkout,
  COD, guest checkout, customer accounts, order tracking, address book, return request, policy pages,
  responsive mobile-first UI, SEO (metadata, sitemap, structured data).
- V1.1: online payment gateway, coupons ✅(built), wishlist ✅, reviews ✅, email notifications.
- V2: loyalty, recommendations, marketplace integrations.

### Back office
- MVP: products/variants/attributes/images, categories, brands, inventory with ledger view,
  adjustments, stock counts, suppliers, purchase orders + receiving, customers, orders across channels,
  status management, packing slip + invoice, returns/refunds, users/roles, audit log, dashboard,
  sales/inventory/product/purchase/returns reports with CSV export, settings.
- V1.1: notifications centre, advanced reports, XLSX export.
- V2: branch transfers at scale, customer segmentation, purchasing suggestions.

### Cross-cutting
- One catalog, one inventory ledger, one customer database, one order table across all channels.
- Multi-branch capable from day one, single branch at launch.
- Every order carries a channel; every stock movement carries a reason and reference.

## Non-functional

| Area | Requirement |
|---|---|
| Correctness | Stock and money invariants hold under concurrency; proven by tests |
| Performance | Product list p95 < 400 ms; POS barcode lookup p95 < 150 ms; checkout p95 < 800 ms; dashboard < 1.5 s |
| Availability | Shop-hours availability is what matters; degraded Redis must not stop sales |
| Security | See [operations/security.md](operations/security.md) |
| Accessibility | WCAG 2.2 AA |
| Localisation | BDT `৳` by default, configurable; Bengali/Unicode text renders correctly everywhere |
| Auditability | Every sensitive action attributable to a user with before/after values |
| Recoverability | RPO ≤ 24 h (≤ 5 min with PITR), RTO ≤ 60 min |
| Maintainability | Modular monolith, documented decisions, tests for business-critical paths |

## Open decisions ❓

1. **VAT** — inclusive or exclusive pricing, and the rate. Must be settled **before** real sales are
   recorded; it changes every historical total and report.
2. Return window (assumed 14 days) and restocking fee (assumed none).
3. Discount threshold requiring manager approval (assumed 20%).
4. Reservation expiry for unpaid online orders (assumed 60 minutes).
5. Whether shipping is refunded on a change-of-mind return (assumed no).
6. Which payment gateway(s) to integrate: SSLCOMMERZ, bKash, Nagad, card acquirer.
7. Courier(s) for delivery and whether an API integration is needed at launch.
8. Delivery zones and charges (Dhaka inside/outside, nationwide).
9. Whether the shop needs a thermal ESC/POS driver or the browser print dialog suffices.
10. Loyalty programme design (schema is loyalty-ready; behaviour is unspecified).
