# Endpoints

Authoritative machine-readable version: `/api/schema/` (drf-spectacular). This is the human map.
`P:` = required permission code.

## Auth — `/api/v1/auth/`

| Method | Path | Notes |
|---|---|---|
| POST | `login/` | email + password → access/refresh + user payload |
| POST | `refresh/` | rotating refresh |
| POST | `logout/` | blacklists the refresh token |
| GET | `me/` | current user, role, branch, permission codes |
| POST | `password/change/` | requires current password |
| POST | `register/` | **customer** self-registration only |

## Organisation — `/api/v1/`

| Method | Path | Perm |
|---|---|---|
| GET/PATCH | `organization/` | `settings.view` / `settings.manage` |
| GET/POST/PATCH | `branches/` | `settings.view` / `settings.manage` |
| GET/POST/PATCH | `users/` | `users.view` / `users.manage` |
| GET | `roles/`, `permissions/` | `users.view` |
| GET | `audit-logs/` | `audit.view` |

## Catalog — `/api/v1/`

`categories/` `brands/` `attributes/` `attribute-values/` `products/` `products/{id}/variants/`
`variants/` `products/{id}/images/` — full CRUD, `P: products.*`.

Extras:

| Method | Path | Purpose |
|---|---|---|
| POST | `products/{id}/generate-variants/` | cartesian product of chosen attribute values |
| POST | `products/{id}/publish/` · `unpublish/` | storefront visibility |
| GET | `variants/lookup/?code=<barcode\|sku>` | exact-first lookup (POS + admin) |
| POST | `variants/{id}/barcode/` | generate a barcode if missing |
| POST | `products/import/` · GET `products/export/` | CSV bulk (`products.create`) |

`DELETE` on a product or a variant **archives rather than deletes** when it has stock, ledger rows or
sales: `OrderItem`, `Inventory` and `InventoryTransaction` all reference `ProductVariant` with
`on_delete=PROTECT`, so financial history keeps resolving. Either way the response is `204`; check
`status` if you need to know which happened. A clean row with no history is deleted outright.

## Inventory — `/api/v1/inventory/`

| Method | Path | Perm |
|---|---|---|
| GET | `` | `inventory.view` — per branch × variant, filters: low stock, out of stock, category |
| GET | `transactions/` | `inventory.view` — the ledger, filterable by type/variant/date |
| POST | `adjust/` | `inventory.adjust` — `{variant, branch, new_on_hand, reason}` |
| POST | `write-off/` | `inventory.adjust` — `DAMAGE`/`LOSS` + reason |
| POST | `transfers/` · POST `transfers/{id}/receive/` | `inventory.transfer` |
| GET/POST | `counts/` · POST `counts/{id}/apply/` | `inventory.count` — stock take → adjustments |
| GET | `low-stock/` · `valuation/` | `inventory.view` / `reports.financial` |
| POST | `verify-integrity/` | `settings.manage` — ledger vs cache drift report |

## Purchasing — `/api/v1/`

`suppliers/` CRUD (`purchases.view`/`create`), `purchase-orders/` CRUD, plus:

| Method | Path | Perm |
|---|---|---|
| POST | `purchase-orders/{id}/send/` · `cancel/` | `purchases.create` |
| POST | `purchase-orders/{id}/receive/` | `purchases.receive` — lines received → `PURCHASE` ledger + WAC |
| GET | `purchase-orders/{id}/receipts/` | `purchases.view` |
| POST | `supplier-payments/` | `purchases.pay` |

## Customers — `/api/v1/customers/`

CRUD (`customers.*`), `{id}/orders/`, `{id}/addresses/`, `{id}/notes/`,
`lookup/?phone=…` (POS fast customer attach).

## POS — `/api/v1/pos/`

| Method | Path | Perm |
|---|---|---|
| GET | `session/` | `sales.create` — register, branch, cashier, open holds |
| GET | `lookup/?code=` | `sales.create` — barcode/SKU → variant + price + availability |
| GET | `products/?q=&category=` | `sales.create` — fast search grid |
| POST | `sales/` | `sales.create` — full sale command; `Idempotency-Key` required |
| POST | `sales/{id}/void/` | `sales.cancel` |
| GET/POST | `holds/` · POST `holds/{id}/resume/` · DELETE `holds/{id}/` | `sales.create` |
| POST | `returns/` | `sales.refund` — in-store return + refund in one step |
| POST | `elevate/` | manager credential check → short-lived permission grant |
| GET | `sales/{id}/receipt/` | `sales.view` — receipt payload |

## Orders (staff) — `/api/v1/orders/`

| Method | Path | Perm |
|---|---|---|
| GET | `` · `{id}/` | `orders.view` — filters: channel, status, payment status, branch, date, customer |
| POST | `{id}/status/` | `orders.update_status` — `{to_status, reason}` |
| POST | `{id}/cancel/` | `sales.cancel` |
| POST | `{id}/payments/` | `sales.payment_record` — record cash/COD/bank capture |
| POST | `{id}/refunds/` | `sales.refund` — `Idempotency-Key` |
| GET | `{id}/timeline/` | `orders.view` |
| GET | `{id}/invoice/` · `packing-slip/` | `orders.view` — print payloads |
| GET/POST | `returns/` · POST `returns/{id}/{approve,reject,receive,complete}/` | `sales.refund` |
| GET/POST | `shipments/` · POST `shipments/{id}/events/` | `orders.fulfil` |

## Shipping & promotions — `/api/v1/`

`shipping-zones/`, `shipping-methods/`, `couriers/` (`settings.manage`);
`coupons/` CRUD + `coupons/{id}/redemptions/` (`content.coupons_manage`);
`reviews/` moderation queue + `{id}/{approve,reject}/` (`content.review_moderate`).

## Storefront (public) — `/api/v1/shop/`

| Method | Path | Notes |
|---|---|---|
| GET | `home/` | hero, featured categories, new arrivals, best sellers, promos |
| GET | `products/` | search + facet filters + sort; only published, in-stock-aware |
| GET | `products/{slug}/` | detail incl. variants, attributes, images, related, reviews |
| GET | `categories/` · `categories/{slug}/` | tree + landing data |
| GET | `facets/?category=` | available filter values with counts |
| GET/POST/PATCH/DELETE | `cart/` · `cart/items/` · `cart/items/{id}/` | server-priced; guest via `X-Cart-Token` |
| POST | `cart/coupon/` · DELETE `cart/coupon/` | server-computed discount |
| GET | `shipping-options/` | zone-matched methods + prices for the cart |
| POST | `checkout/` | **`Idempotency-Key` required** → order (+ payment intent) |
| GET | `orders/{number}/?token=` | guest order tracking |
| GET | `account/orders/` · `account/orders/{number}/` | authenticated customer |
| GET/POST/PATCH/DELETE | `account/addresses/` | authenticated customer |
| GET/POST/DELETE | `wishlist/` | authenticated customer |
| POST | `products/{slug}/reviews/` | verified purchase required, enters moderation |
| POST | `payments/{provider}/webhook/` | signature-verified, deduplicated, no auth |

## Reports — `/api/v1/reports/`

| Path | Perm |
|---|---|
| `dashboard/?range=today\|7d\|30d\|custom` | `reports.view` |
| `sales/`, `sales/by-channel/`, `sales/by-payment/` | `reports.view` |
| `products/performance/` | `reports.view` |
| `inventory/valuation/`, `inventory/movement/` | `reports.financial` |
| `purchases/`, `returns/`, `profit/` | `reports.financial` |
| any of the above + `&format=csv` | `reports.export` |

## Infra

`GET /api/health/` → `{"status":"ok"}` (liveness, no dependency check).
`GET /api/ready/` → database + Redis check, `503` when not ready. Neither leaks version or config.
