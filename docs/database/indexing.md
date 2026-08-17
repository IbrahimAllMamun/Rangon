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

| Endpoint | Max queries |
|---|---|
| `GET /shop/products/` (25 items) | 8 |
| `GET /shop/products/{slug}/` | 10 |
| `GET /pos/lookup/` | 4 |
| `POST /pos/sales/` (3 lines) | 30 |
| `GET /orders/` (25 orders) | 10 |
| `GET /reports/dashboard/` | 15 |

`apps/api/tests/test_performance.py` asserts these with `assertNumQueries`, so an accidental N+1 fails
CI instead of surfacing in production.
