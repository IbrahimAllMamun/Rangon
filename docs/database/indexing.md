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
| `GET /shop/home/` | 45 | **yes** | 27 · 0.26 s | **511 · 2.42 s** |
| `GET /shop/products/` | 25 | **yes** | 11 · 0.10 s | **363 · 1.29 s** |
| `GET /shop/products/{slug}/` | 10 | no | 13 · 0.05 s | 15 |
| `GET /pos/lookup/` | 4 | no | — | — |
| `POST /pos/sales/` (3 lines) | 30 | no | — | — |
| `GET /orders/` (25 orders) | 10 | no | — | — |
| `GET /reports/dashboard/` | 15 | no | — | — |

Only the first two rows are asserted, in `apps/api/tests/test_performance.py`. The rest are intentions,
not guarantees — do not cite them as evidence. Note that product detail measures **13** against a
documented budget of 10: the budget was never measured, and nothing enforces it yet. Either raise it
deliberately or bring the endpoint down, but do not leave the doc claiming a number the code misses.

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

The remaining rows are the obvious next tests. Each one written is one fewer place a regression can
hide behind documentation.
