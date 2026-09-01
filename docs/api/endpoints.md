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

`?search=` works on `suppliers/` (name, code, phone) and `variants/` (SKU, barcode, product name).
`SearchFilter` is **not** one of the global `DEFAULT_FILTER_BACKENDS`, so it is named explicitly on
those two viewsets; declaring `search_fields` alone does nothing.

`POST /suppliers/` derives `code` from `name` when it is omitted
(`purchasing.services.unique_supplier_code`), so no caller has to invent one. An explicit `code` is
kept as given, and editing a supplier never regenerates it.

## Inventory — `/api/v1/inventory/`

| Method | Path | Perm |
|---|---|---|
| GET | `` | `inventory.view` — per branch × variant, filters: low stock, out of stock, category |
| GET | `transactions/` | `inventory.view` — the ledger, filterable by type/variant/date |
| POST | `adjust/` | `inventory.adjust` — `{variant, branch, new_on_hand, reason}` |
| POST | `write-off/` | `inventory.adjust` — `DAMAGE`/`LOSS` + reason (both mandatory) |
| GET | `low-stock/` · `valuation/` | `inventory.view` / `reports.financial` |
| POST | `verify-integrity/` | `settings.manage` — ledger vs cache drift report |

Stock transfers and counts are **top-level** resources, not nested under
`inventory/` — they are documents in their own right, with their own numbers:

| Method | Path | Perm |
|---|---|---|
| GET/POST | `/stock-transfers/` | `inventory.view` / `inventory.transfer` — writes `TRANSFER_OUT` + `TRANSFER_IN` in one transaction; cost travels with the goods (ADR-0006) |
| GET/POST | `/stock-counts/` | `inventory.view` / `inventory.count` — creating one snapshots the branch's current on-hand as `expected_quantity` |
| POST | `/stock-counts/{id}/record/` | `inventory.count` — `{lines: [{variant, counted_quantity, notes}]}` |
| POST | `/stock-counts/{id}/apply/` | `inventory.count` — counted figures → `ADJUSTMENT` ledger rows |
| POST | `/stock-counts/{id}/cancel/` | `inventory.count` — abandon without touching stock |
| GET | `/stock-exceptions/` | `inventory.view` — oversell report: movements that left `on_hand < 0`. Filter `?status=OPEN\|RESOLVED`. Read-only; rows are written only by `inventory.services` and can never be created or deleted through the API |
| GET | `/stock-exceptions/summary/` | `inventory.view` — `{open, resolved}` counts for the badge, without pulling the list |
| POST | `/stock-exceptions/{id}/resolve/` | `inventory.adjust` — `{resolution, note}`; the note is mandatory and a resolved row returns `409` rather than being overwritten. Moves no stock (see business-rules §1.4a) |

`record/` is the only way `counted_quantity` can be written: `items` on the count serializer is
read-only, because `expected_quantity` is the ledger's snapshot and editing it would make the
variance — the one figure a count exists to produce — meaningless. It refuses a variant that is not
on the sheet, and the same variant twice in one request.

`apply/` refuses a count that is not `COUNTING`, and refuses one where nothing has been counted
rather than marking it applied having adjusted nothing. An uncounted line is left alone; it is never
treated as a count of zero.

## Purchasing — `/api/v1/`

`suppliers/` CRUD (`purchases.view`/`create`), `purchase-orders/` CRUD, plus:

| Method | Path | Perm |
|---|---|---|
| POST | `purchase-orders/{id}/send/` · `cancel/` | `purchases.create` |
| POST | `purchase-orders/{id}/receive/` | `purchases.receive` — lines received → `PURCHASE` ledger + WAC |
| GET | `purchase-orders/{id}/receipts/` | `purchases.view` |
| POST | `supplier-payments/` | `purchases.pay` |

## Finance — `/api/v1/`

Accounts and the append-only cash book (phase 35). See
[architecture/finance.md](../architecture/finance.md) and
[ADR-0011](../architecture/decisions/0011-append-only-cash-book.md).

| Method | Path | Perm |
|---|---|---|
| GET | `accounts/` | `finance.view` — filters: `branch`, `kind`, `is_active`, `search` |
| POST | `accounts/` | `finance.manage` — `opening_balance` posts an `OPENING` entry |
| PATCH | `accounts/{id}/` | `finance.manage` — descriptive fields only; `balance` is read-only |
| GET | `accounts/{id}/transactions/` | `finance.view` — that account's cash book |
| GET | `accounts/cash-position/` | `finance.view` — totals by kind + money in/out |
| POST | `accounts/record-movement/` | `finance.adjust` — `DEPOSIT`/`WITHDRAWAL`/`ADJUSTMENT` only |
| POST | `accounts/verify-integrity/` | `settings.manage` — cache vs cash-book drift report |
| GET | `account-transactions/` | `finance.view` — every movement, filterable by account/type/date |
| GET/POST | `account-transfers/` | `finance.view` / `finance.transfer` |

There is deliberately **no `DELETE /accounts/{id}/`**: an account with movements is financial
history. Close it with `PATCH {"is_active": false}`.

`SALE_PAYMENT`, `REFUND`, `SUPPLIER_PAYMENT` and `EXPENSE` are rejected by `record-movement/` — those
are posted by the services that cause them, and entering one by hand would double-count the money.

### Expenses (phase 36)

| Method | Path | Perm |
|---|---|---|
| GET | `expense-categories/` | `finance.view` — filters: `is_active`, `search`; carries `expense_count` |
| POST | `expense-categories/` | `finance.manage` — `code` derived from the name when omitted |
| PATCH | `expense-categories/{id}/` | `finance.manage` — name/description/`is_active`; **`code` is immutable** |
| GET | `expenses/` | `finance.view` — filters: `branch`, `category`, `account`, `status`, `date_from`, `date_to`, `include_void` |
| POST | `expenses/` | `finance.expense` — JSON, or `multipart` when attaching a receipt |
| POST | `expenses/{id}/void/` | `finance.expense` — `reason` required |
| GET | `expenses/summary/` | `finance.view` — period total plus a per-category split and share |

`POST expenses/` writes the document **and** its `EXPENSE` cash-book movement in one transaction.
If the account cannot cover it the whole thing rolls back with `409 INSUFFICIENT_FUNDS` — no orphan
document is left behind. An expense dated in the future is refused (`400`).

There is deliberately **no `PATCH`/`DELETE` on `expenses/`**: the amount, account and date reached
the ledger. Correct one with `void/`, which posts a compensating `ADJUSTMENT` rather than erasing
anything. `date_from`/`date_to` accept either `YYYY-MM-DD` (widened to cover the whole day) or a
full timestamp; anything else is a `400`, never a silently ignored filter.

Money in every finance response is a **string** (`"12000.00"`), never a JSON number — including the
computed figures in `accounts/cash-position/` and `expenses/summary/`.

Overdrawing an account that does not allow overdraft returns **409 `INSUFFICIENT_FUNDS`**.

Three existing endpoints now accept an optional `account` (omit it and the branch default for the
method's kind is used): `POST orders/{id}/payments/`, `POST orders/{id}/refunds/` and
`POST supplier-payments/`. `POST pos/sales/` accepts one per tender line.

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
| GET/POST | `returns/` | `orders.view` / `sales.refund` |
| POST | `returns/{id}/approve/` · `reject/` | `sales.refund` — `{comment}`, recorded either way |
| POST | `returns/{id}/receive/` | `sales.refund` — `{items: [{id, restock_decision, condition_note}]}` |
| POST | `returns/{id}/complete/` | `sales.refund` — `{refund_amount, refund_method, account}`, idempotent |

`receive/` takes the per-line restock decision, because that is the first moment anyone has the goods
in hand (business-rules §2.1). A line left out keeps whatever it was raised with. Decisions are
applied *before* stock moves, so `DAMAGED` on inspection never reaches sellable stock.

`complete/` accepts an `account`, so a refund can name the drawer the cash leaves from rather than
falling back to the branch default for the method. It is idempotent on `Idempotency-Key` (and on the
return itself), so a retried request cannot pay a customer twice.
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
| `expenses/` — spend by category, with each category's share | `reports.financial` |
| any of the above + `&format=csv` | `reports.export` |

## Infra

`GET /api/health/` → `{"status":"ok"}` (liveness, no dependency check).
`GET /api/ready/` → database + Redis check, `503` when not ready. Neither leaks version or config.
