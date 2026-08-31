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

**The decision is made at receipt**, not when the return is raised: that is the first moment anybody
has the item in their hands. Whatever was chosen when the return was requested stands as the default
for any line not decided at receipt, and the receipt event records the decision per SKU. Applying a
decision happens before stock moves, so a line marked `DAMAGED` on inspection never touches sellable
stock even if it was raised as `RESTOCK`.

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
- **Both usage limits are re-checked inside `promotions.services.redeem()`**, under the coupon row's
  `select_for_update` lock — not only in `validate_coupon`. Validation runs while the cart is priced,
  which is before that lock exists, so two concurrent checkouts can both pass it. The lock serialises
  them and the re-read is what actually enforces the limit. `usage_limit_per_customer` defaults to 1,
  so the common configuration is the one a race would give away twice.
- A **free-shipping** coupon carries **no amount**: its `value` is always `0.00`, and the discount is
  the shipping line being zeroed in `checkout.price_cart`. Every other discount type must have a
  `value` above 0 — a coupon giving away nothing is a coupon that silently does nothing. The database
  constraint exempts `FREE_SHIPPING` from the "above zero" rule for exactly this reason.
- A coupon's rules are validated against the **resulting** coupon on edit, not just the submitted
  fields: a PATCH sending only `ends_at` is still checked against the stored `starts_at`, and one
  sending only `value` against the stored `discount_type`. Editing a coupon never changes orders
  already placed — they keep the discount they were given.

### 3.4 Tax

VAT is **set in the admin** at `/admin/settings`, not in an environment variable, because it is a
decision the owner makes and has to be able to see. Two settings, both on `Organization`:

- **`tax_mode`** — `EXCLUSIVE` (tax added on top of the shown price) or `INCLUSIVE` (the shown price
  already contains it). Default `EXCLUSIVE`.
- **`default_tax_rate`** — a fraction, `0.1500` for 15%. Default `0.0000`. A category may override it
  (`Category.tax_rate`); a mixed-rate basket takes the **highest** rate present.

```text
taxable_base = subtotal - discount_total

EXCLUSIVE   tax   = round(taxable_base * rate, 2)
            total = taxable_base + tax + shipping

INCLUSIVE   tax   = round(taxable_base * rate / (1 + rate), 2)
            total = taxable_base + shipping
```

**Shipping is never taxed** under either treatment — the carriage line is quoted as it is charged.

**Margin under inclusive pricing.** When the tax sits inside `subtotal`, every profit figure has to
take it back out again, or margin is overstated by exactly the VAT. That is what `Order.net_revenue`
is for, and `gross_profit` is built on it rather than on `subtotal` directly.

**History never moves.** Every order freezes the `tax_mode`, `tax_rate` and `tax_total` it was priced
under, so changing the setting cannot rewrite a total that has already been charged. What it *does*
change is that a report spanning the change mixes two treatments — so once orders exist the API
refuses an unconfirmed change (`409 TAX_CHANGE_NEEDS_CONFIRMATION`, carrying the order count) and the
screen asks before proceeding. Every change is written to the audit log with before and after, and
stamped with who settled it and when.

Writes go through `PATCH /organization/tax/` (permission `settings.manage`) and
`accounts.services.update_tax_settings()`. The VAT fields are deliberately **read-only** on the
generic `PATCH /organization/`, so a change cannot slip through without the guard or the audit entry.

*`DECISION REQUIRED` — the default is still exclusive at 0%, which is a placeholder, not an answer.
Bangladeshi retail commonly quotes VAT-inclusive prices. Settle it before the first real sale: the
arithmetic is now implemented for both treatments, but orders taken under the wrong one keep the
totals they were given.*

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

Returned items credit COGS back at the same frozen `unit_cost` — but **only when the goods went back
on the shelf**. `RESTOCK` recovers the cost; `DAMAGED` is a write-off and `QUARANTINE` is not sellable
yet, so both keep the cost as a cost until that changes.

### 4.1 Net profit (the business summary)

`reports.services.business_summary(date_range, branch)` is the whole statement, and
`GET /api/v1/reports/business-summary/` serves it (permission `reports.financial`):

```text
  revenue from goods            net of VAT, never the gross line total
− refunds                       completed returns, by completed_at
= net revenue
− cost of goods sold            frozen unit_cost × quantity
+ cost recovered from returns   RESTOCK lines only
= gross profit
− operating expenses            finance.selectors.expense_totals, voids excluded
= net profit
```

Three rules decide which period a figure lands in, and each matches what the money did: sales by
`placed_at`, returns by `completed_at`, expenses by `spent_at`. A refund in August of a July sale
reduces August.

**VAT is reported but never counted as revenue or profit.** It is money held for the government. Under
inclusive pricing it sits inside the line total, so it is removed per line — the order's own frozen
`tax_mode` decides, not today's setting.

### 4.2 Receivable and payable (the party ledger)

`finance.selectors.party_ledger(branch)` and `GET /api/v1/party-ledger/` (permission
`reports.financial`). Both sides are **derived on read**:

- **Receivable** — every order where `grand_total > paid_total`. The common case is COD: goods
  delivered, cash not yet collected. `PENDING` baskets, `CANCELLED` and `REFUNDED` orders are not
  debts. Aged from `placed_at`.
- **Payable** — every purchase order where `grand_total > paid_total`, excluding `DRAFT` (nothing
  committed to the supplier yet) and `CANCELLED`. Aged from the **due date**:
  `completed_at or ordered_at` plus `Supplier.payment_terms_days`, so a supplier on 30-day terms is
  not overdue on day one.

Ageing buckets are current (0–30), 31–60, 61–90 and 90+ days.

**There is deliberately no balance column on `Customer` or `Supplier`.** A stored balance is a second
source of truth that drifts from the documents it claims to summarise — the same mistake
`CLAUDE.md` §3.2 forbids for stock. Every figure is recomputed from the orders and purchase orders
behind it, and the screen can expand any party to show exactly which documents make up the number.

This answers **decision D-A** ("does the business sell on credit?") without needing the decision: a
credit sale is already an order with a balance, so if the answer turns out to be yes, nothing here
changes.

Gated on `reports.financial` rather than `finance.view`. A cashier holds `finance.view` so they can
pick which account a sale's money lands in — a deliberately narrow grant that must not also hand them
every customer's debt and every supplier's balance.

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
- Phone-first identity is enforced on **create and on edit**: a customer must always keep at least one
  of phone or email. An edit that would clear both is refused, because it produces exactly the
  unfindable record the rule exists to prevent. Swapping one for the other is allowed.

### 6.1 Addresses

- A customer has **at most one default address, and never zero while any address exists.**
  `CustomerAddress` is ordered `("-is_default", "-created_at")` and checkout pre-fills from the first
  row, so a second default would make the pre-filled delivery address arbitrary.
- The rule is held by `customers.services`, not by callers, and applies to both surfaces (the admin
  screens and the storefront account page):
  - the first address a customer gets becomes the default whatever the caller asked for;
  - setting a new default demotes the previous one in the same transaction;
  - deleting the default promotes the next address (newest first);
  - un-setting the default on the **only** address is refused — add another and promote that instead.
- Addresses and notes are deletable. They are contact details and staff commentary, not financial
  records: an order stores its own frozen `as_snapshot()` copy at checkout, so editing or deleting an
  address never rewrites history (CLAUDE.md §3.3).
- The owning customer is never read from the request body. It comes from the URL (admin) or the
  session (storefront), so an address cannot be written onto another customer's record.

### 6.2 Who may edit a customer

`customers.view` grants **read only**. Writing an address or a note requires `customers.update` — the
same permission as editing the customer. This matters for the `ACCOUNTANT` role, which deliberately
holds `customers.view` without create or update.

---

## 6a. Reviews

A review is a **claim about a purchase**, so the API treats it as one rather than as free-form
comment. `POST /shop/products/{slug}/reviews/` accepts a review only when all of these hold:

- the caller is signed in **as a customer** (`IsAuthenticated` + `IsCustomer`);
- that customer has an order containing the product in status `DELIVERED`, `RETURNED` or `REFUNDED`
  — you may only review something you actually received;
- they have not already reviewed **that purchase**. A second, later order of the same product earns a
  second review — the API resolves the most recent eligible order the customer has **not** yet
  reviewed, so a repeat buyer gets one review per purchase rather than one review ever.

Ratings are whole numbers. A fractional or non-numeric rating is refused rather than coerced: `4.7`
is not silently stored as `4`.

Every accepted review is stored `verified_purchase = True` and `status = PENDING`. **Nothing appears
on the storefront until a human approves it** through `POST /reviews/{id}/approve/`, which needs
`content.review_moderate`. Rejection takes the same shape and both record the moderator, the time and
an optional note.

A decision is **reversible and audit-logged**. The review row carries only the latest moderator, note
and time, so a reversal would otherwise erase the previous decision; each one writes an `AuditLog`
entry instead, and the sequence of a contested review survives. Omitting a note on re-moderation
means "no new note" and keeps the existing one — re-approving a rejected review must not erase why it
was rejected.

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

## 8a. Shipping

Shipping had no section here until 2026-08-28. That absence is why four rules
below were enforceable nowhere: an area nobody wrote down is an area nobody
checks. What follows was reconstructed from `shipping/` and is now asserted in
`tests/api/test_shipping_admin.py`.

### 8a.1 Zones

- A delivery address is matched to a **zone** by city name, comparing lower-cased
  on both sides. Zones are tried in `position` order and the first match wins.
- A zone whose city list is empty matches nothing — **unless** it is the
  `is_default` zone, which is the fallback for any city no other zone claims.
- **With no default zone, a shopper in an unlisted city is offered no delivery
  options and cannot check out.** This is a configuration hazard rather than a
  bug, so the admin screen warns about it rather than the API refusing it: a shop
  that genuinely only delivers to listed cities is entitled to that setup.
- `cities` must be a **list of names**. It is a `JSONField`, so a bare string
  passes type-checking and then breaks matching silently: `matches()` iterates
  the value, and iterating `"Dhaka"` yields characters, making the zone match
  the city `"d"` and never `"Dhaka"`. The serializer refuses anything but a list
  and stores the names stripped and lower-cased.

### 8a.2 Methods and rates

- A **method** belongs to one zone; `code` is unique per zone. Checkout offers
  the active methods of the matched zone in `position`, then `price` order.
- `price` is what the shopper pays, **computed server-side** by
  `ShippingMethod.price_for(subtotal)`. The browser never sends a shipping cost.
- `free_over` is the subtotal at or above which shipping is free. **Blank means
  shipping is never free** — not 0, which would make it always free. A negative
  threshold is refused by both the serializer and a database constraint, because
  `subtotal >= free_over` would then hold for every order and silently give the
  shipping revenue away.
- `min_days`/`max_days` are the delivery estimate and must read forwards;
  `max_days < min_days` renders to a shopper as "5–2 days" and is refused.
- A free-shipping **coupon** (§3.3) zeroes the shipping line independently of
  `free_over`.

### 8a.3 Shipments and tracking

- A `Shipment` records what physically left: courier, tracking number, cost.
  `ShipmentEvent` is **append-only** — a tracking update is never edited or
  deleted, only followed by another.
- An event's status drives the order: `DISPATCHED` moves a `PACKED` order to
  `SHIPPED`, and `DELIVERED` moves a `SHIPPED` or `PACKED` order to `DELIVERED`.
  Because of that, an event carrying a status outside `ShipmentStatus` is refused
  rather than stored: it would be permanent, and it would stop the order
  progressing.
- Payment is **not** affected by delivery. A COD order's payment is captured when
  the courier remits (§5.3), which is a separate act from marking it delivered.
- Configuring zones, methods and couriers needs `settings.manage`. Recording a
  shipment or a tracking update needs `orders.fulfil` — it is fulfilment work,
  not configuration, so a manager can do it without being able to change rates.
- `Courier.integration` selects the code that talks to a courier's API. There is
  one implementation, `manual`, meaning tracking numbers are typed in. It is not
  editable from the admin screen, because naming a provider that does not exist
  would produce shipments nothing can dispatch.

---

## 9. Currency and formatting

Default currency **BDT**, symbol `৳`, 2 decimal places, `1,290.00` grouping, symbol before the amount.
Currency is configuration (`RANGON_CURRENCY`), not a literal in business logic. Financial tables use
tabular numerals.
