# Endpoints

Authoritative machine-readable version: `/api/schema/` (drf-spectacular). This is the human map.
`P:` = required permission code.

## Auth — `/api/v1/auth/`

| Method | Path | Notes |
|---|---|---|
| POST | `login/` | email + password → access/refresh + user payload |
| POST | `refresh/` | rotating refresh: both tokens are minted afresh. Refuses a deactivated account and a token issued under a password that has since changed; a token with no password claim (issued before 2026-09-19) is honoured |
| POST | `logout/` | blacklists the refresh token |
| GET | `me/` | current user, role, branch, permission codes |
| POST | `password/change/` | `{current_password, new_password}`. The new one must pass the validators and differ from the current one. **Ends every session the account has** and answers `200` with a fresh `{access, refresh}` for the caller — the web app's `/api/auth/password` stores them in the cookies. 10/min per account (`auth` scope); a wrong current password is audited as `LOGIN_FAILED` ([business-rules §7.1a](../business-rules.md#71a-your-own-password-and-your-sessions)) |
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
| POST | `products/{id}/generate-variants/` | cartesian product of chosen attribute values. Refuses a specification attribute, and any value the attribute does not have — the whole request or none of it (D84) |
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
| GET | `supplier-payments/?purchase_order={id}` | `purchases.view` — payment history |
| POST | `supplier-payments/` | `purchases.pay` — `Idempotency-Key` honoured |

`POST supplier-payments/` refuses more than is owed with **422 `PAYMENT_EXCEEDS_OUTSTANDING`**
(`details` carries `requested`, `outstanding`, `grand_total`, `paid_total`), a `DRAFT` or `CANCELLED`
order with **409 `CONFLICT`**, and a `supplier` that is not the purchase order's with
**400 `VALIDATION_ERROR`**. `paid_at` is optional and defaults to now. Retrying with the same
`Idempotency-Key` returns the payment already recorded rather than paying twice
([business-rules.md §6b.1b](../business-rules.md)).

`POST purchase-orders/` refuses as **400 `VALIDATION_ERROR`**, with a field in `details`: negative
`shipping_total`, a line discount above its line, a negative cost, the same variant on two lines, and
an unknown `supplier` (D82). `receive/` refuses one order line named twice in a delivery (D83).
`cancel/` answers **409 `CONFLICT`** for an order that is not `DRAFT`/`SENT`, has a receipt, or has
**any money paid against it** (D80); `send/` and `cancel/` decide under the order's row lock (D81).
See [business-rules.md §7c](../business-rules.md#7c-raising-and-cancelling-a-purchase-order).

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
| GET/POST | `shipments/` · POST `shipments/{id}/events/` | `orders.fulfil` (`orders.view` to read). Branch-scoped on `order__branch`. A parcel always starts `PENDING` — `status`, `dispatched_at` and `delivered_at` are read-only and move only through `events/`. See [business-rules §8a.3](../business-rules.md#8a3-shipments-and-tracking) |

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
| GET | `account/orders/` · `account/orders/{number}/` | authenticated customer. **No caller** — see below |
| GET/POST/PATCH/DELETE | `account/addresses/` | authenticated customer. **No caller** — see below |
| POST | `products/{slug}/reviews/` | verified purchase required, enters moderation. **No caller** since the storefront's account surface was withdrawn — see below |
| POST | `payments/{provider}/webhook/` | signature-verified, deduplicated, no auth |
| GET | `feed.xml` · `feed.csv` | product feed for Meta / Google. Public, cached 15 min, one row per sellable variant. 503 if `RANGON_PUBLIC_URL` is unset — see [marketing-feeds.md](../operations/marketing-feeds.md) |

### The customer-account endpoints have no caller, deliberately

`wishlist/` was **removed** on 2026-09-15; the three rows above marked *No caller*
were **kept**. The difference is the owner's instruction and it is worth writing
down, because the next audit will otherwise read them as rot.

A shopper cannot create an account. `auth/register/` has never had a screen in
front of it, so the only accounts that exist are staff ones made in `/admin`.
Everything gated on a signed-in *customer* was therefore unreachable: the
wishlist heart on every product card toggled optimistically and rolled back on
the 401, and the review form could only ever render "Sign in to review".

The wishlist went entirely — model rows aside, there is no view, no route and no
UI. The account order history, address book and review submission stayed,
because they are the parts a customer account would need on the day one exists;
they are simply not advertised anywhere in the storefront. Checkout is
guest-token based and does not touch them, so nothing is blocked.

## Reports — `/api/v1/reports/`

| Path | Perm |
|---|---|
| `dashboard/?range=<preset>` — see [§ Date ranges](#date-ranges) | `reports.view` |
| `sales/`, `sales/by-channel/`, `sales/by-payment/` | `reports.view` |
| `products/performance/` | `reports.view` |
| `inventory/valuation/`, `inventory/movement/` | `reports.financial` |
| `purchases/`, `returns/`, `profit/` | `reports.financial` |
| `expenses/` — spend by category, with each category's share | `reports.financial` |
| any of the above + `&format=csv` | `reports.export` |

### Date ranges

Every dated report takes the same window. Either a preset:

`today` · `yesterday` · `7d` · `30d` · `90d` · `month` · `last_month` · `year`

or an explicit `date_from` / `date_to` pair (`YYYY-MM-DD`, both inclusive), which
wins over `range` when present. An unrecognised preset falls back to `30d`, and
the response's `range.label` says `30d` rather than echoing what was asked for.

Two things about the boundaries, because they are easy to get wrong and both
have been:

- **Days are the shop's days, not UTC days.** A window opens at midnight in
  `TIME_ZONE` (`Asia/Dhaka`). Deriving them from a UTC clock put the start of
  "today" at 06:00 local, and before dawn it reached back into the previous day.
- **`7d`/`30d`/`90d` are that many whole calendar days *including today*,** not a
  rolling N×24 hours, so `sales_over_time` returns exactly N buckets instead of
  N+1 with a part-day at each end.

`month` is this calendar month to date; `last_month` is the whole of the previous
one, and is a different question from `30d`.

`sales_over_time` carries one row per day in the window, zero-filled where
nothing sold, so a quiet day is flat on a chart rather than missing from its
axis. Windows wider than 370 days are not filled.

## Infra

`GET /api/health/` → `{"status":"ok"}` (liveness, no dependency check).
`GET /api/ready/` → database + Redis check, `503` when not ready. Neither leaks version or config.
