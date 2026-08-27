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

Cost travels with the goods: each line carries the source's weighted average cost at the moment of
the move (ADR-0006), so neither branch's margin is distorted by relocating stock. Cost is therefore
never an input to a transfer — a box for it would let someone change what stock is worth by moving
it between shelves.

### 1.7 Write-offs

Stock that is damaged or lost leaves through `write_off()` as a `DAMAGE` or `LOSS` ledger row, never
as an adjustment. The distinction is kept because the two are different figures to a business:
damage is a cost of doing business, loss is shrinkage.

**A reason is mandatory** and free text. An unexplained write-off is indistinguishable from theft by
whoever recorded it, so the service refuses one without a reason and the row is audit-logged with
actor, quantity and reason. Correcting a mistaken write-off means receiving the stock back in — the
ledger keeps both movements rather than erasing either.

### 1.8 Stock counts

A count sheet snapshots what the ledger believes (`expected_quantity`) at the moment it is opened.
That snapshot is what makes the variance meaningful, so **it is never editable**: the only figure a
person may write back is `counted_quantity`.

**Counting and applying are separate.** Counting a shop takes hours and more than one person, so
figures are saved as they are gathered and nothing touches stock until the sheet is applied.
Applying writes `ADJUSTMENT` rows through the ledger — it never sets `on_hand` directly (§1.1).

**An uncounted line is left alone**, never treated as a count of zero: a line nobody reached is not
evidence that the shelf is empty. A sheet where nothing has been counted cannot be applied at all,
because marking it applied having adjusted nothing would record a stock take that never happened.

A count that should not proceed is **cancelled**, which touches no stock. An applied count is
history: it can be neither re-counted nor cancelled, and correcting it means a new count or an
adjustment with its own reason.

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

## 6a. Reviews

A review is a **claim about a purchase**, so the API treats it as one rather than as free-form
comment. `POST /shop/products/{slug}/reviews/` accepts a review only when all of these hold:

- the caller is signed in **as a customer** (`IsAuthenticated` + `IsCustomer`);
- that customer has an order containing the product in status `DELIVERED`, `RETURNED` or `REFUNDED`
  — you may only review something you actually received;
- they have not already reviewed **that purchase**. A second, later order of the same product earns a
  second review.

Every accepted review is stored `verified_purchase = True` and `status = PENDING`. **Nothing appears
on the storefront until a human approves it** through `POST /reviews/{id}/approve/`, which needs
`content.review_moderate`. Rejection takes the same shape and both record the moderator, the time and
an optional note.

Ratings are whole numbers 1–5. The aggregate shown on a product page (and in its JSON-LD
`AggregateRating`) counts approved reviews only, so a pending or rejected review can never move the
score.

The storefront form lives on the product page (`components/commerce/review-form.tsx`). It does not
try to predict eligibility — it submits and shows what the API says — because the purchase test is a
business rule and belongs on the server.

---

## 6b. Money accounts and credit

**§6b.1 and §6b.1a are built** (phases 35 and 36, `finance` app — see
[architecture/finance.md](architecture/finance.md) and [ADR-0011](architecture/decisions/0011-append-only-cash-book.md)).
§6b.2 and §6b.3 are not: they state the rules phases 37 and 38 must implement, so the decisions are
settled before the schema is. See [roadmap.md](roadmap.md) and
[planning/bseba-erp-feature-audit.md](planning/bseba-erp-feature-audit.md).

### 6b.1 Where money is held

Every payment, refund and supplier payment names the **account** it moved through — a cash drawer, a
bank account or an MFS wallet — not merely a *method*.

An account's balance is a **transactional cache over an append-only transaction table**, reconciled
by replaying the ledger, exactly as `Inventory.on_hand` sits over `InventoryTransaction`
(§1.1). No code writes a balance column directly.

*`DECISION REQUIRED` — a flat list of cash/bank/MFS accounts is assumed, not a chart of accounts. A
flat list is sufficient for a retailer; a chart of accounts is an accounting product and changes the
schema materially. Roadmap decision D-B. **Built on this default.***

**Money moves on capture, never on record.** A payment that is `PENDING` or `AUTHORIZED` has put
money nowhere: an authorised card payment has not settled, and a COD order's cash arrives when the
courier remits. `capture_payment()` is what posts to the cash book.

**Which account, when the caller does not say.** The branch's default account for the *kind* the
method implies: cash and COD → `CASH`, card, bank transfer and gateway → `BANK`, MFS → `MFS`,
store credit and anything else → `OTHER`. If the branch has no active account of that kind, the
service posts **nothing** and returns `None` rather than guessing — card takings dropped into the
cash drawer would make the drawer impossible to reconcile.

**A missing account never blocks a sale.** A shop that has not set its accounts up must still be
able to trade. The sale, refund or supplier payment completes; `manage.py verify_accounts` reports
how many money events posted nowhere, so the gap is stated rather than hidden.

**Historical rows keep no account.** `Payment.account`, `Refund.account` and
`SupplierPayment.account` are nullable and stay that way: every payment taken before the `finance`
app existed has no honest answer, and §3.3 of CLAUDE.md forbids inventing one after the fact.

**An account cannot pay out money it does not hold.** A withdrawal, transfer or supplier payment
that would take a balance below zero raises `INSUFFICIENT_FUNDS` (409) under `SELECT … FOR UPDATE`,
unless the account is explicitly marked `allow_overdraft` — a bank account with an overdraft line
legitimately goes negative; a cash drawer never does.

**An opening balance is an entry, not a column.** Opening an account with a starting figure writes
an `OPENING` transaction, so `balance == SUM(transactions.amount)` holds from the first row and
`verify_accounts` can prove the cache honest with no special case.

**Reasons are mandatory** for `WITHDRAWAL` and `ADJUSTMENT`, as they are for stock adjustments and
write-offs (§1.1). An unexplained movement of money is a red flag.

**Transfers are not income or spending.** Moving money between two of the business's own accounts
(banking the takings, floating the drawer) is excluded from money-in and money-out totals; counting
it would inflate both sides by the same amount.

**Accounts are never deleted.** An account with movements against it is financial history. Closing
one sets `is_active = false`; the balance and the cash book stay readable, and no new movement may
pass through it.

### 6b.1a Expenses

Money that leaves the business for something other than stock or a refund — rent, salary, utilities,
transport — is an **expense**, and it is recorded as a document *and* a movement written in one
transaction (phase 36).

**An expense is never just a row.** `record_expense()` creates the `Expense` and posts an `EXPENSE`
movement through §6b.1's engine inside the same `transaction.atomic()` block. An expense with no
cash-book row would claim money moved when it did not; a movement with no document would be an
unexplained withdrawal. Neither can exist.

**An expense larger than the account holds is refused**, under the same `INSUFFICIENT_FUNDS` rule as
any other outgoing, and the refusal rolls the document back with it — a rejected expense leaves
nothing behind.

**An expense is paid from its own branch's account.** Spending recorded at one branch cannot be
drawn from another branch's drawer; the money would leave a balance nobody there authorised.

**Posted figures are frozen.** `amount`, `account` and `spent_at` reach the ledger, so they are never
edited afterwards. The category may be corrected (it re-labels, it does not re-post). Everything else
is corrected by **voiding**: `void_expense()` posts a compensating `ADJUSTMENT` that puts the money
back and marks the document `VOID`, with a mandatory reason. Nothing is deleted, and the cash book
still reads as what happened — it went out, then it came back.

**A voided expense is excluded from every total** but stays on the list, so the correction is visible
rather than silent.

**Categories are organisation-wide, and their `code` is permanent.** A category may be renamed or
retired (`is_active = false`), never re-keyed and never deleted: the code is the key past expenses
were filed under, and rewriting it would re-label history. Nine heads are seeded on install so the
screen is usable on day one.

**Future-dating is refused.** An expense dated ahead of now is money that has not left yet; posting
it would put the cash book ahead of reality. Back-dating is allowed, because a receipt often arrives
after the payment.

*Recording and voiding need `finance.expense`, held by the owner, an admin, a manager and the
accountant — deliberately not by a cashier. Opening or retiring a **category** needs
`finance.manage`, because categories shape every report.*

### 6b.2 Selling on credit

*`DECISION REQUIRED` — assumed **no**: every sale is paid in full at the point of sale or is a COD
order that settles on delivery. If the business does sell on credit ("বাকি"), phase 37 builds a party
ledger and this section grows the rules for credit limits, ageing and dunning. Roadmap decision D-A.*

If credit is enabled, a customer's balance is **derived** from orders and payments that already
exist — no balance column on `Customer` — and an `OPENING` entry states what a customer owed before
the system was adopted.

### 6b.3 Net profit

Net profit is only reported from figures the system can compute honestly: sales, gross margin from
the `unit_cost` frozen onto the order line at sale time (§4, ADR-0006), purchases, damage, expenses,
returns, discounts and VAT. Figures for features that do not exist — salary, warranty, service — are
**omitted rather than reported as zero**, because a permanent zero reads as a working feature.

Net profit cannot be reported at all until the VAT decision in §3.4 is settled, since VAT changes
every historical total.

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
