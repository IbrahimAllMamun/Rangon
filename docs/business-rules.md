# Business Rules

This document is the **authoritative statement of business behaviour**. Code must match it. If code and
this document disagree, that is a bug in one of them — fix both in the same change.

Rules marked `DECISION REQUIRED` were not specified in the source plan. A sensible default has been
implemented so the system is usable, and the assumption is stated explicitly. The store owner should
confirm or change each one.

---

## 1. Stock

### 1.1 How stock is calculated

Stock is held per **branch × variant** in `inventory.Inventory`:

```text
available = on_hand - reserved
```

`on_hand` and `reserved` are **derived caches maintained transactionally** alongside the ledger
(`inventory.InventoryTransaction`). The ledger is the source of truth; the cached columns exist so that
listing 10 000 variants does not require summing millions of ledger rows.

`inventory.services.verify_integrity()` recomputes both columns from the ledger and reports drift.
It runs nightly (Celery beat) and in the test suite.

Signed ledger effects:

| Transaction type | `on_hand` | `reserved` |
|---|---|---|
| `PURCHASE` | + | – |
| `SALE` | − | – |
| `RETURN` | + | – |
| `DAMAGE`, `LOSS` | − | – |
| `ADJUSTMENT` | ± | – |
| `TRANSFER_IN` | + | – |
| `TRANSFER_OUT` | − | – |
| `RESERVATION` | 0 | + |
| `RESERVATION_RELEASE` | 0 | − |

### 1.2 When stock is reserved

- **Online order:** at order creation, before payment. `RESERVATION` rows are written.
- **POS sale:** never reserved. A POS sale is instantaneous; stock is deducted directly.
- **Cart:** never reserved. Adding to cart reserves nothing — carts are checked against `available`
  at read time and re-checked authoritatively at checkout.

### 1.3 When stock is deducted

- **POS sale:** immediately, `SALE`, at sale time.
- **Online order:** when the order moves to `PACKED` (the goods physically leave the shelf). At that
  point the reservation is released and an equal `SALE` is written, atomically.
  *`DECISION REQUIRED` — alternative is to deduct at `CONFIRMED`. Deducting at `PACKED` keeps shelf
  stock accurate for the shop floor while the reservation still prevents overselling.*
- Deduction never happens twice for the same order line; `orders.services.fulfilment` is idempotent on
  `(order, line, stage)`.

### 1.4 Overselling

Overselling is refused (`INSUFFICIENT_STOCK`) unless `RANGON_ALLOW_OVERSELL=1`, which is a deliberate
organisation-level configuration. `available` may never go negative while that flag is off. Enforced by
a database `CheckConstraint` plus a service-level guard under `SELECT … FOR UPDATE`.

### 1.5 Expired reservations

An online order that is `PENDING` (awaiting prepayment) for longer than `RANGON_RESERVATION_MINUTES`
(default 60) has its reservations released by the `release_expired_reservations` Celery task and the
order is `CANCELLED` with reason `PAYMENT_TIMEOUT`. COD orders skip this: they are `CONFIRMED`
immediately and are not time-limited.
*`DECISION REQUIRED` — 60 minutes assumed.*

### 1.6 Stock transfers

A transfer writes `TRANSFER_OUT` at the source and `TRANSFER_IN` at the destination in one atomic
transaction. In-transit stock is modelled as: it leaves the source immediately and arrives when the
transfer is marked received. A pending transfer therefore shows as reduced at the source and not yet
present at the destination.
*`DECISION REQUIRED` — a formal in-transit holding location was not requested; with one branch in V1
this is adequate.*

---

## 2. Returns and refunds

### 2.1 Flow

```text
Order → ReturnRequest(REQUESTED) → APPROVED → RECEIVED → per-item restock decision → Refund
```

`REJECTED` is terminal. The original order and its payments are **never deleted or edited**; the return
is a separate record that references them.

### 2.2 Return windows

Returns are accepted within **14 days** of delivery (online) or sale (POS), for items that are not
marked `is_final_sale`. Beyond the window a return needs `sales.refund_override` permission and a
reason, which is recorded in the audit log.
*`DECISION REQUIRED` — 14 days assumed.*

### 2.3 How returns affect stock

Restock decision is per returned line:

| Decision | Ledger effect | Meaning |
|---|---|---|
| `RESTOCK` | `RETURN` (+) | Sellable again, back on the shelf |
| `DAMAGED` | none | Written off; recorded on the return line, not added to stock |
| `QUARANTINE` | none | Held pending inspection; not sellable, not written off |

`DAMAGED` and `QUARANTINE` lines never increase `available`. A quarantined item that is later cleared
is brought back with an explicit `ADJUSTMENT` carrying the return reference as its reason.

### 2.4 Refunds

- A refund never exceeds the amount actually paid against the order (`SUM(payments.captured)` −
  `SUM(refunds)`), enforced in `orders.services.returns`.
- Refund method defaults to the original payment method. Cash sales refund cash from the register;
  gateway payments refund through the provider; COD orders refund by cash or mobile transfer recorded
  manually.
- Shipping is **not** refunded when the customer changed their mind; it **is** refunded when the item
  was defective, wrong, or damaged in transit.
  *`DECISION REQUIRED` — assumed.*
- Restocking fee: none.
  *`DECISION REQUIRED` — assumed 0%.*

---

## 3. Pricing, discounts, tax

### 3.1 Price authority

The browser never sets a price. At every cart read and at checkout the server re-prices every line from
`ProductVariant.price`, re-validates stock, and recomputes all totals. A client-supplied total is
ignored; if it disagrees the API returns the server total and the UI must show the change before the
customer can continue.

### 3.2 Order maths

```text
line_subtotal   = unit_price × quantity − line_discount
subtotal        = Σ line_subtotal
order_discount  = coupon discount + manual discount
taxable_base    = subtotal − order_discount
tax             = round(taxable_base × tax_rate, 2)
total           = taxable_base + tax + shipping_amount
```

Rounding: half-up to 2 decimal places, applied once per order-level figure (never on intermediate
sums). Money is `Decimal`; `float` is forbidden.

### 3.3 Discounts

- **Line discount** (POS): amount or percentage on a line. Requires `sales.discount` permission.
  A discount above 20% additionally requires `sales.discount_override` and is audit-logged with reason.
  *`DECISION REQUIRED` — 20% threshold assumed.*
- **Order discount** (POS): same permission rules.
- **Coupon** (online): validated and computed server-side only. Rules: active window, minimum order
  value, maximum discount cap, total usage limit, per-customer limit, product/category scope. A coupon
  applies to the sum of eligible lines only.
- Coupons do not stack. One coupon per order.
  *`DECISION REQUIRED` — assumed.*
- Coupon usage is counted when the order is **created**, and released if the order is cancelled before
  fulfilment.

### 3.4 Tax

VAT is configurable per organisation (`RANGON_DEFAULT_TAX_RATE`, default `0.00`) and can be overridden
per category. Prices are stored and displayed **tax-exclusive**, with tax shown as a separate order
line.
*`DECISION REQUIRED` — Bangladesh retail commonly quotes VAT-inclusive prices. Confirm with the
owner/accountant before go-live; switching to inclusive pricing changes `taxable_base` and every
historical report, so it must be decided before real sales are recorded.*

---

## 4. Costing and profit

Inventory costing is **weighted average cost (WAC)** per branch × variant.

On receiving a purchase of quantity `q` at unit cost `c`:

```text
new_average_cost = ((on_hand × average_cost) + (q × c)) / (on_hand + q)
```

`average_cost` is only ever changed by receiving stock, by an explicit revaluation adjustment, or by a
purchase return. Sales never change it.

At sale time the current `average_cost` is **copied onto the order line** as `unit_cost`. Therefore:

```text
line_cogs    = unit_cost × quantity          (frozen at sale time)
gross_profit = revenue − Σ line_cogs
```

Profit is never computed as "selling price − current product cost". Reports read the frozen
`unit_cost`, so historical profit does not move when prices or costs change later.

Returned items credit COGS back at the same frozen `unit_cost`.

---

## 5. Orders

### 5.1 Statuses

```text
PENDING → CONFIRMED → PROCESSING → PACKED → SHIPPED → DELIVERED
                                                    ↘ RETURN_REQUESTED → RETURNED → REFUNDED
      ↘ CANCELLED (from PENDING/CONFIRMED/PROCESSING only)
```

POS sales are created directly as `DELIVERED` + `PAID` — the customer walks out with the goods.

Transitions are enforced by `orders.services.lifecycle.transition()`; illegal transitions raise
`INVALID_STATUS_TRANSITION`. Every transition writes an `OrderEvent` (the timeline) and an audit entry.

### 5.2 Cancellation

- Allowed up to `PROCESSING` by staff with `sales.cancel`; a customer may cancel their own order while
  it is `PENDING` or `CONFIRMED`.
- Cancellation releases reservations, releases coupon usage, and — if money was captured — creates a
  refund. It never deletes the order.
- After `PACKED`, the path is a **return**, not a cancellation.

### 5.3 COD orders

Created as `CONFIRMED` with a `Payment` row of method `COD`, status `PENDING`, amount = order total.
Stock is reserved at creation. The payment is marked `CAPTURED` when the courier remits, which is
recorded manually by staff with `sales.payment_record` permission. A COD order that is refused on
delivery becomes `CANCELLED` (or `RETURNED` if it had already been dispatched and comes back), the
payment is marked `FAILED`, and stock is released/restocked.

### 5.4 Payment failure

A failed gateway payment leaves the order `PENDING` with the reservation intact until the reservation
window expires (§1.5). The customer may retry; each attempt is a separate `Payment` row. An order is
never marked paid on a client-side callback alone — only a verified server-side webhook or a provider
verification call may capture a payment.

### 5.5 Duplicate protection

- Checkout requires an `Idempotency-Key`; a repeat with the same key returns the original order rather
  than creating a second one.
- Payment webhooks are deduplicated on `(provider, provider_event_id)` in `PaymentEvent`, so a replayed
  webhook is recorded and ignored.
- Returns are idempotent on `(order, stage)`.

---

## 6. Customers

- Identity is **phone-first**: `phone` is unique per organisation when present; `email` is optional and
  unique when present. Many walk-in customers have no email.
- Every branch has one `WALK_IN` customer record used for anonymous POS sales, so that every order has
  a customer FK.
- A guest online order creates (or matches, by phone) a customer record without a login. If that person
  later registers with the same phone, the records are linked rather than duplicated.
- Customers are never hard-deleted while they have orders; they are deactivated. A data-deletion request
  is handled by anonymising personal fields and keeping the financial rows.

---

## 7. Permissions

Roles: `OWNER`, `ADMIN`, `MANAGER`, `CASHIER`, `INVENTORY_MANAGER`, `ACCOUNTANT`, `CUSTOMER`.
Permission codes and the default role → permission matrix live in
[`architecture/permissions.md`](architecture/permissions.md) and are seeded by
`accounts.services.sync_permissions()`.

Rules:
- `OWNER` implicitly holds every permission.
- Staff are scoped to their branch; only `OWNER`/`ADMIN` may act across branches.
- A cashier can create a sale, but a refund needs `sales.refund`; the POS asks for a manager login when
  the cashier lacks it (elevation is audit-logged).
- `CUSTOMER` accounts can only ever reach `/api/v1/shop/*` and their own resources.

---

## 8. Audit

Recorded for: authentication events, permission elevation, price/discount overrides, stock adjustments
and transfers, purchase receipt, order status changes, cancellations, refunds, user/role changes and
settings changes.

Each entry stores actor, action, entity type/id, `old_values`, `new_values`, reason, IP, user agent,
request id, timestamp. Passwords, tokens and full card data are never logged.

---

## 9. Currency and formatting

Default currency **BDT**, symbol `৳`, 2 decimal places, `1,290.00` grouping, symbol before the amount.
Currency is configuration (`RANGON_CURRENCY`), not a literal in business logic. Financial tables use
tabular numerals.
