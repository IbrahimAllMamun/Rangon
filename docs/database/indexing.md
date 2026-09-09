# Indexing & Constraints

Every index below exists to serve a named query. Do not add an index without recording its query here.

## Extensions

`pg_trgm` (fuzzy product/SKU search), `citext` (case-insensitive email), `btree_gin`.
Created by the `core` migration `0002_extensions`.

## Unique constraints (business identity)

| Table | Constraint | Why |
|---|---|---|
| `accounts_user` | `email` unique (citext) | login identity |
| `accounts_branch` | `(organization, code)` | branch code printed on receipts |
| `catalog_category` | `slug` unique | SEO URL |
| `catalog_product` | `slug` unique | SEO URL |
| `catalog_productvariant` | `sku` unique, `barcode` unique (nullable) | scan/lookup identity |
| `catalog_variantattributevalue` | `(variant, attribute)` | one value per attribute per variant |
| `inventory_inventory` | `(branch, variant)` | one stock row per branch × variant |
| `orders_order` | `number` unique; `idempotency_key` unique (nullable) | duplicate-order protection |
| `orders_payment` | `(provider, provider_reference)` unique when both set | duplicate capture protection |
| `orders_paymentevent` | `(provider, provider_event_id)` | webhook replay protection |
| `promotions_coupon` | `code` unique (upper) | coupon identity |
| `promotions_couponredemption` | `(coupon, order)` | one redemption per order |
| `customers_customer` | `phone` unique (nullable), `email` unique (nullable) | phone-first identity |
| `engagement_review` | `(product, customer, order)` | one review per purchase |
| `core_numbersequence` | `key` | sequence identity |

## Check constraints (invariants in the database, not only in Python)

```sql
inventory_inventory:      reserved >= 0
-- NOTE: on_hand has no >= 0 constraint on purpose.  Negative stock is a real
-- business state when RANGON_ALLOW_OVERSELL is on, and for the V2 offline POS
-- where a sale physically happened offline.  Overselling is prevented by the
-- service guard under SELECT … FOR UPDATE and detected by verify_integrity().
orders_order:             grand_total >= 0 AND paid_total >= 0 AND refunded_total >= 0
orders_orderitem:         quantity > 0 AND unit_price >= 0 AND unit_cost >= 0
orders_payment:           amount > 0
orders_refund:            amount > 0
purchasing_poi:           quantity_ordered > 0 AND quantity_received >= 0
                          AND quantity_received <= quantity_ordered
promotions_coupon:        (value > 0) AND (discount_type <> 'PERCENTAGE' OR value <= 100)
engagement_review:        rating BETWEEN 1 AND 5
```

## Indexes by query

| Index | Query it serves |
|---|---|
| `catalog_product (status, published, category)` | storefront category listing |
| `catalog_product (featured, published)` partial | homepage featured rail |
| `catalog_product` GIN trgm on `name` | storefront + admin product search |
| `catalog_productvariant (product)` | product detail variant fetch |
| `catalog_productvariant` GIN trgm on `sku` | admin SKU search |
| `catalog_productvariant (barcode)` | **POS scan** — the hottest read in the system |
| `catalog_variantattributevalue (attribute_value, variant)` | facet filtering |
| `inventory_inventory (branch, variant)` unique | availability lookup |
| `inventory_inventory (branch)` partial `on_hand <= reorder_point` | low-stock report |
| `inventory_inventorytransaction (branch, variant, created_at DESC)` | stock card / movement report |
| `inventory_inventorytransaction (reference_type, reference_id)` | "what did this order do to stock" |
| `orders_order (branch, created_at DESC)` | admin order list, dashboard |
| `orders_order (channel, status, created_at DESC)` | channel reports, pending-online-orders KPI |
| `orders_order (customer, created_at DESC)` | customer order history |
| `orders_order (status)` partial pending/processing | fulfilment queue |
| `orders_orderitem (variant)` | product performance report |
| `orders_orderitem (order)` | order detail |
| `orders_payment (order)`, `(method, captured_at)` | payment-method report |
| `purchasing_purchaseorder (supplier, created_at DESC)`, `(status)` | purchase report |
| `customers_customer (phone)`, GIN trgm on `name` | POS customer attach |
| `core_auditlog (entity_type, entity_id, created_at DESC)`, `(actor, created_at DESC)` | audit views |
| `notifications_notification (user, read_at, created_at DESC)` | notification bell |

## Reporting strategy

Dashboard and reports aggregate **in the database** (`annotate`/`aggregate`/`TruncDate`), never in
Python over fetched rows. Date-range queries always hit `(branch, created_at)` or
`(channel, status, created_at)`.

If a report grows beyond an acceptable latency budget, the next step is a materialised daily rollup
table refreshed by Celery beat — not an in-memory cache of raw rows.

## Query budgets (enforced in tests)

| Endpoint | Budget | Enforced? | Measured | Was |
|---|---|---|---|---|
| `GET /shop/home/` | 45 | **yes** | 29 · 0.16 s | **511 · 2.42 s** |
| `GET /shop/products/` | 25 | **yes** | 13 · 0.09 s | **363 · 1.29 s** |
| `GET /purchase-orders/` | — | **yes** (growth only) | 15 · 0.10 s | **156 · 0.58 s** |
| `GET /shop/products/{slug}/` | 18 | **yes** (+ growth) | 13 | 15 |
| `GET /pos/products/` | 12 | **yes** (+ growth) | 5 | **81 for 8 products** |
| `GET /pos/lookup/` | 12 | **yes** | 9 | — |
| `GET /products/` (admin) | 25 | **yes** (+ growth) | 6 | 21 · 0.42 s |
| `GET /orders/` (25 orders) | 12 | **yes** (+ growth) | 3 | 6 · 0.07 s |
| `GET /reports/dashboard/` | 20 | **yes** | 11 | 14 · 0.07 s |
| `POST /pos/sales/` (2 lines) | 75, and 13 per extra line | **yes** (+ per-line) | 63; 53 for one line, +10 a line | — |
| `GET /shop/feed.csv` (whole catalogue) | 12 | **yes** (+ growth) | 9 for 9 products / 27 variants | — |

All eleven are asserted in `apps/api/tests/test_performance.py`. That was not true
until 2026-09-09: the heading said "enforced in tests" while only the first two
were, and the paragraph underneath admitted it. Writing the missing seven found
that one of them was not merely unenforced but wrong.

### `GET /pos/products/` was issuing 81 queries — the same trap, twice in a loop

The counter's grid search cost **nine queries per matching row**: 21 for a
search of two products, 75 for eight. A cashier who taps rather than scans hits
this on every sale, and a shop with twenty matches for "shirt" was paying 180
queries for one keystroke's worth of search.

Both causes are named in the section below, and neither reads like a query at
the call site:

- `variant.label` joins the variant's attribute values. The view prefetched
  `product__images` and never `attribute_values__attribute_value`.
- `Product.primary_image` was `self.images.filter(is_primary=True).first()`.
  **`.filter()` on a related manager ignores `prefetch_related` entirely** and
  issues a fresh query per product, so the prefetch that was there did nothing.
  It now reads `images.all()` and picks in Python, which uses the cache and
  chooses the same row (both paths share `Meta.ordering`).

Fixed 2026-09-09: **81 → 5 queries, flat as the catalogue grows.**

Two figures were documented and wrong rather than merely unmeasured. Product
detail was budgeted at 10 against a measured 13, and is flat whatever the
variant count, so the cost is fixed and the budget was raised to 18 deliberately
rather than the endpoint being changed. `POST /pos/sales/` was budgeted at 30
and had never been measured; it costs 53 for one line and 10 for each line
after, which is what a ledger-driven sale with a row lock per line should cost.

Every other list endpoint was swept on 2026-08-18 and sits at 4–7 queries: suppliers, coupons, reviews,
shipments, shipping methods and zones, stock transfers and counts, audit logs, categories, brands,
attributes, branches, notifications, inventory, inventory transactions, customers, returns.

### The trap that produced all three N+1s

`ProductVariant.label` is a *property* that joins the variant's attribute values:

```python
values = [str(v.attribute_value.display) for v in self.attribute_values.all()]
```

Nothing about `serializers.CharField(source="variant.label")` hints that rendering it costs a query
per row. Any queryset feeding a serialiser that renders a variant label — storefront payload, purchase
order line, inventory row — must prefetch `attribute_values__attribute_value` or it degrades silently
as the data grows. That is why these are guarded by *growth* tests rather than constants: the failure
is invisible at seed scale and only appears in production.

Every row above is now asserted. Where a budget was documented and the code missed it, the number was
settled rather than left standing: raised deliberately where the cost is real and fixed, and the
endpoint brought down where the cost was an N+1. A budget nothing enforces is a claim, not a
guarantee — that is how `/pos/products/` sat at 81 queries under a table that read "enforced in
tests".

All three storefront read paths serialise through `_product_payload`, so they share one failure mode.
`orders/api/shop_views._payload_queryset` is now the single place that declares the relations that
serialiser needs; every product queryset feeding it goes through that helper. The N+1s above existed
because four call sites each prefetched their own guess at the right depth — the home page stopped one
hop short (`variants__attribute_values`, but not its `attribute` and `attribute_value`), and the listing
prefetched nothing at all.

That distinction is not academic. This table previously claimed the listing was capped at 8 queries and
that the whole set was `assertNumQueries`-enforced. Neither was true: the test file did not exist, and
the listing was in fact issuing **363 queries per page** (1.3 s) because the list path never prefetched
the variant attribute relations its serialiser reads — while the *detail* path, using the same
serialiser, always had. The budget above is the measured figure plus headroom, and the test that guards
it asserts something stronger than a constant: that the count **does not grow with catalogue size**. A
budget can be quietly raised; a growth check cannot be satisfied by an N+1 at all.

### The feed is the one with no page size

Added 2026-09-09 with `GET /shop/feed.xml` / `.csv`. Every other row above serves
one page, so an N+1 there costs a page's worth of queries and somebody notices a
slow screen. The feed serialises **every published variant in the shop**, and
nobody watches a feed fetch: the same mistake costs the whole catalogue's worth
of queries, Meta times the request out, and the adverts quietly keep running at
last month's prices. Sabotaging the prefetch takes it from 9 queries to 309 on a
13-product catalogue, which is what the growth test was checked against.

Its guard needs one thing the others do not. The view is wrapped in
`cache_page`, so a second fetch answers from the cache in **zero** queries — the
first version of this test measured exactly that and would have passed with any
N+1 at all. `_fetch()` clears the cache before measuring, which is what makes it
a measurement rather than a formality.

The remaining rows are the obvious next tests. Each one written is one fewer place a regression can
hide behind documentation.
