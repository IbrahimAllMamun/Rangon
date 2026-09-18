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
- **A refund carries the VAT the customer paid.** Under the `EXCLUSIVE` treatment the tax sits on
  top of `OrderItem.line_total` in its own `tax_amount` column, so the refund is
  `line_total + tax_amount`; under `INCLUSIVE` the tax is already inside `line_total` and is not
  added again. The **order's own** frozen `tax_mode` decides (§3.4), so an order refunds under the
  treatment it was priced with even after the setting changes. A partial quantity refunds its share
  of both.
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

**A memo that charged no VAT says nothing about VAT.** The customer's memo — the POS receipt and the
A4 invoice — carries a VAT block in two parts: the shop's registration number in the header and the
tax line above the total. They are one fact, so they appear together or not at all, decided by
`lib/commerce/memo.ts`. The amount lines were always conditional; the registration number was not, so
at the shipped rate of 0% every memo announced a VAT registration and then showed no tax, which reads
like tax was collected and withheld. The test is the **order's own** `tax_total`, not today's
setting, so reprinting an old memo shows what that sale actually charged. A packing slip carries no
prices and never showed the number.

*For a VAT-registered shop selling zero-rated or exempt goods, those memos will not carry the BIN
either, because the rule looks at what was charged rather than at whether the shop is registered.
Move it to the organisation's registration if that shop exists.*

**The VAT return.** `GET /reports/vat/` (permission `reports.financial`, screen
`/admin/reports/vat`) is the filing, and it is one subtraction:

```text
output VAT      charged on sales placed in the period
less credits    the VAT element of returns completed in the period
less input VAT  on purchases raised in the period
= net payable   negative means the government owes the business
```

- **Every figure reads a frozen value.** Output VAT sums `OrderItem.tax_amount`, the same column
  `business_summary` reports as `vat_collected`, so the two reports cannot disagree about a month.
  The taxable base is net of VAT under both treatments, and delivery is never in it.
- **A return credits its share of the tax, not its share of the refund.** The credit is the line's
  frozen `tax_amount` prorated by the quantity that came back — exact under both treatments.
  Backing it out of the refund would not be, because a shop-fault return also refunds shipping and
  shipping is never taxed.
- **Each event lands in the period it happened** — sales by `placed_at`, returns by `completed_at`,
  purchases by `created_at`.
- **Draft and cancelled purchases are not purchases**, so they carry no reclaimable input VAT.
- **Goods sent back to a supplier take their input VAT with them.** A purchase return credits the
  *cost* — `PurchaseReturnItem.unit_cost` is what the goods came in at — so the tax is reclaimed
  back here, dated by `returned_at`. Without it a shop that returned a delivery would keep claiming
  tax on goods it no longer holds. The report shows the gross input VAT and the give-back as
  separate lines, so the subtraction can be read rather than inferred.
- Output is split **by rate**, because a category override means one period can hold several and a
  return is filed per rate. The rate shown is the order's own.
- The range picker is for convenience; the filing is monthly, so the report always breaks the range
  into calendar months and the CSV exports those.

*Two known limits. An operator who overrides the refund amount at `returns.complete()` moves the
money without moving the credit, which is computed from the returned lines. And a purchase is dated
by when it was raised, because `PurchaseOrder` carries an `invoice_number` but no invoice date —
`DECISION REQUIRED` if the two must differ for filing.*

**A storefront price says which treatment it was quoted under.** Under `EXCLUSIVE` the catalogue
price is not what the shopper pays — the tax goes on at checkout — so a bare `৳ 1,290` promises a
total that never arrives. Every shop price (product page, listing card, quick view) carries a short
note: `+ 15% VAT` under `EXCLUSIVE`, `incl. 15% VAT` under `INCLUSIVE`, and **nothing at all at a
zero rate**, which is the same rule the memo follows. The rate is resolved **per product** by the
API (`shop_views._tax_payload`) rather than read from the organisation in the browser, because a
category override replaces the organisation rate and the note has to be true of the price it sits
beside — `+ 15% VAT` on a zero-rated line would quote a checkout total that never arrives either.

**Input VAT is entered on the purchase order.** `PurchaseOrderItem.tax_rate` has existed since the
first migration and `recalculate_totals` has always read it, but nothing could set it: the
`PurchaseLine` dataclass had no such field, so every purchase order ever raised carried
`tax_total 0.00`. The buyer now enters **one VAT percentage per order** — a supplier invoice quotes
one figure at the bottom — and it is stored on every line, which is where the column lives, so a
mixed-rate order needs no migration later. The tax is quantised per line and summed, exactly as the
server computes it; delivery is not taxed.

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

**The channel never changes COGS.** A POS sale and an online sale of the same variant in the same
minute freeze the same figure. Both resolve it through `orders.services.pricing.resolve_unit_cost`,
which is the single place the rule below is applied — online checkout used to skip it and read
`ProductVariant.cost` instead ([D73](roadmap.md#known-defects)).

**A variant nothing has been received against has no weighted average.** Its `average_cost` is
`0.00` by column default, not by measurement, and freezing a zero would report the entire selling
price as profit. In that one case the sale line falls back to `ProductVariant.cost` — the last price
paid, or the buyer's estimate:

```text
unit_cost = average_cost   if the variant has been received at this branch
          = variant.cost   otherwise
```

The two cost fields are not duplicates and are not interchangeable:

| Field | Meaning | Written by |
|---|---|---|
| `Inventory.average_cost` | Authoritative WAC, per branch × variant | `inventory.services.receive_stock` only |
| `ProductVariant.cost` | Latest or expected cost — display, PO defaulting, the fallback above | receiving, and the product form |

Returned items credit COGS back at the same frozen `unit_cost` — but **only when the goods went back
on the shelf**. `RESTOCK` recovers the cost; `DAMAGED` is a write-off and `QUARANTINE` is not sellable
yet, so both keep the cost as a cost until that changes.

### 4.0a Opening stock

**Stock only ever enters through a purchase receipt or the CSV import.** Both call
`inventory.services.receive_stock` with the cost actually paid, so the units and the money that
bought them arrive together.

There is deliberately **no "opening stock" field on the product form**. It used to have one, which
posted an `ADJUSTMENT` through `/inventory/adjust/`; an adjustment writes units in at the existing
`average_cost`, which is `0.00` for a variant nothing has been received against, so that stock was
valued at nothing and sold at 100% margin ([D72](roadmap.md#known-defects)).

`ADJUSTMENT` remains what it says: a correction to a counted figure — a stock count, breakage found,
drift repaired. It is not a way to bring goods in, because it carries no cost with it.

To put existing stock on the shelf when the business first goes live, use the CSV import
(`/admin/products/import`), which carries a `cost` column per row. To bring in goods afterwards,
raise and receive a purchase order.

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

**Days are calendar days in the shop's timezone** (`finance.selectors._ageing_days`), counted from the
local date the document was raised — or fell due — to today's local date, not a floored elapsed
interval. So the number ticks at local midnight rather than at each document's time of day, the same
report run twice in one afternoon gives the same answer both times, and a clock that steps backwards
by a millisecond cannot make an invoice a day younger. Roadmap D46 has the measurements.

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

### 6.0 One number, one spelling

Phone-first identity only works if a subscriber has exactly one spelling, so **every customer phone
number is stored canonically as `8801XXXXXXXXX`** — country code, no `+`, no separators, no national
trunk `0`. `01712345678`, `+8801712345678`, `8801712345678` and `+880 1712-345678` are one person and
one row.

- The rule lives in `core.phone` and is applied in three places: the serializers, so a customer sees a
  field error against the field they typed in; `Customer.save()`, so a management command or a shell
  cannot go round them; and a data migration, which canonicalised what was already stored.
- A **Bangladeshi mobile** is ten digits beginning `1`, with an operator digit of 3-9 (013/017
  Grameenphone, 014/019 Banglalink, 015 Teletalk, 016 Airtel, 018 Robi). 011 was Citycell and is
  withdrawn; 010 and 012 were never issued. Anything else is refused rather than stored, because
  storing a number nobody can read is how one person becomes two records.
- **On screen** the country code is a fixed `+880` beside the box and never typed into it, so the box
  holds the ten digits that vary. Whatever is pasted in — the local form, the international form,
  brackets, dashes — is reduced to those ten as it is typed.
- **Searching** is on the subscriber digits, so a cashier may type the whole number, the local
  `0`-prefixed form, or only the last few digits the customer reads out. A query of `880` alone
  matches nobody rather than everybody.
- The same rule applies to a **delivery address contact number**, which is what the courier rings and
  what a returning guest is matched on at checkout.
- It does **not** apply to a branch, supplier, courier or organization number. Those are contact
  details rather than identities, and may legitimately be a landline or a short hotline
  (`+8809610003030`). A mobile there is still canonicalised so it matches everywhere else; anything
  else is kept as typed.
- Order address snapshots are **not** rewritten. An order already placed keeps the spelling it was
  given (CLAUDE.md §3).

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

## 5a. Product attributes: axes and specifications

Every attribute in the catalogue is one of exactly two things, and
`Attribute.is_variant_defining` is the switch that says which.

**A variant axis** (`is_variant_defining = True`) builds SKUs. Size, Colour, Shade, Volume and
Capacity are axes: the matrix on the product form takes the ticked values and generates one
`ProductVariant` per combination, each with its own price, barcode and stock. A shopper choosing one
is choosing *which item to buy*.

**A specification** (`is_variant_defining = False`) is a fact about the product, stated once.
Material, Gender, Fit, Sole, Dimensions and Skin type are specifications: they are stored as
`ProductAttributeValue` rows against the product, rendered as the Details list on the product page
and as `additionalProperty` in its JSON-LD. A shopper reading one is *learning about* the item they
have already chosen. Ticking three specifications adds three facts; it does not add eight SKUs.

Three rules follow, and the API enforces all three rather than trusting the form:

1. **An attribute cannot be both.** A value whose attribute is variant-defining is refused as a
   specification — two places claiming the same fact, only one of them sellable. The refusal names
   the attribute and lives in `catalog.services.set_product_specs`, so a shell or a management
   command meets it too.
2. **An attribute cannot change sides underneath a product.** It may stop defining variants only
   while no variant relies on it, and may start defining variants only while no product states it as
   a specification. Either move would otherwise strand rows the app can read but could never have
   written.
3. **The category decides what is offered.** `CategoryAttribute` links an attribute to a category and
   `GET /categories/{id}/attributes/` answers with that list, inherited down the tree — so a handbag
   is never asked for a shoe size. Where a category and an ancestor both declare the same attribute,
   the **nearer** one wins the `is_required` flag: a specific category may tighten a general rule,
   never the reverse. `is_required` is advisory today — the form marks it, the API does not refuse a
   product without it, because refusing would make every existing product unsaveable the moment
   somebody ticks the box.

   This scopes **both** halves of the product form, the variant axes as well as the specifications,
   under two rules that keep the scoping from becoming a trap. A category that declares nothing
   offers everything, because the alternative is a category whose products can never be given a
   variant. And an axis a product's saved variants are already built on is always offered, declared
   or not — those rows exist, may hold stock, and are referenced by the inventory ledger and by
   order history, so hiding the control over them would leave them visible and un-editable.
   Scoping is a convenience; it never removes the only way to manage an existing SKU.

A product's specifications are **replaced, not merged**: `spec_values` on the product write endpoint
is the set as it now stands. Omitting the key leaves them alone; sending `[]` clears them. A caller
that had to diff before saving would eventually forget to, and the failure mode — a spec list that
only ever grows — is invisible until a shopper reads it.

`Product.material` and `Product.care_instructions` remain as free text and predate this. `material`
is now also a real attribute, so the product page shows the free-text column only when no Material
attribute is stated; nothing prints the term twice. `care_instructions` has no attribute and stays
prose, because care advice is a sentence, not a value from a list.

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

### 6b.1b Paying a supplier

Money paid to a supplier is recorded by `record_supplier_payment()`, which writes the
`SupplierPayment` document, posts a `SUPPLIER_PAYMENT` movement through §6b.1's engine and advances
the purchase order's `paid_total` — all inside one `transaction.atomic()` block, for the same reason
an expense is never just a row.

**A payment may not exceed what is outstanding.** Paying more than `grand_total - paid_total` raises
`PAYMENT_EXCEEDS_OUTSTANDING` (422), the exact mirror of `REFUND_EXCEEDS_CAPTURED` on the customer
side (§2.4). Without it `outstanding` goes negative, and because the payables selector (§4.2) matches
on `grand_total > paid_total`, an overpaid order silently disappears from the payable list rather
than showing as a problem.

*`DECISION REQUIRED` — assumed **no**. The counter-case is real: suppliers in this market are often
paid an advance against future deliveries. That is a different instrument, not an overpayment of a
specific order, and it is covered below.*

**The purchase order and the supplier must agree.** Both reach the service as separate arguments, so
a payment naming supplier A against supplier B's order would credit A's ledger while reducing B's
outstanding — two wrong balances from one row. Refused as a validation error.

**A `DRAFT` or `CANCELLED` purchase order cannot be paid**, and the refusal is a `CONFLICT` (409).
§4.2 already excludes both from payables, so paying one writes cash out against a liability the
ledger says does not exist. A draft has not been sent to the supplier at all.

*`DECISION REQUIRED` — assumed **no** for both.*

**A payment is idempotent on the caller's `Idempotency-Key`.** A retried or double-clicked submission
returns the payment already recorded rather than paying the supplier twice, exactly as a refund does
(§5.5). Required by CLAUDE.md §7 for any endpoint where a retry could double-spend.

**A supplier advance with no purchase order is out of scope for now.** The service accepts
`purchase_order=None` with an explicit branch, and the cash book records it correctly, but nothing
allocates that credit against a later delivery.

*`DECISION REQUIRED` — assumed **not offered from the purchase-order screen**. Building it needs an
allocation rule (which order a later delivery draws the advance down against), and inventing that
silently is what CLAUDE.md §13 forbids.*

**A recorded payment is never edited or deleted.** It reached the ledger, so §3.3 of CLAUDE.md
applies. There is deliberately no undo in this release; correcting one needs a compensating
instrument (a reversal row or a supplier credit note) that has not been designed yet, so the screen
says so rather than implying a delete exists.

*Recording a payment needs `purchases.pay`; reading the history needs `purchases.view`.*

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

### 7.1 Staff accounts

Only `OWNER` holds `users.manage`; `MANAGER` holds `users.view` and can see the list without changing
it. Every edit goes through `accounts.services.update_staff_user()`, never onto the model from a
serializer, because two guards and one audit entry hang off it:

- **Nobody may lock themselves out.** Deactivating or demoting *your own* account is refused, on the
  `deactivate` action and on a plain `PATCH` alike. Guarding only the action left the PATCH as a way
  around it.
- **The last active owner may not be deactivated or demoted.** Nothing but `OWNER` holds
  `users.manage` or `settings.manage`, so an organisation with no active owner cannot grant them to
  anybody again — there is no recovery path short of a shell on the server. Promote a second owner
  first.
- **Every change is audited.** A role change decides who may refund, discount and adjust stock; a
  password reset hands somebody an account. Both write an `AuditLog` entry with before and after.
  The password itself is never written to it — only `password_reset: true`.

Staff are **deactivated, never deleted**: `DELETE /users/<id>/` deactivates, because the audit trail
has to keep pointing at a real row. Customers never appear in the staff list.

### 7.2 Categories, brands and attributes

- A category may not be its own parent, or be moved underneath its own descendant. `Category.path`,
  `ancestors()` and the serializer's `children` all walk `parent` without a depth guard, so a cycle
  recurses until the stack gives out — on the navigation menu that renders on every storefront page.
- `Category.tax_rate` must be between 0 and 1, enforced in the serializer *and* by a database
  constraint. It overrides the organisation default and a mixed basket takes the **highest** rate
  present, so one impossible value silently overcharges every order containing that category.
- **A slug is generated on create only.** Renaming a category or brand keeps its slug: the slug is a
  URL, and regenerating it on every rename breaks every link and every indexed page pointing at the
  old one. Changing a slug is a separate, deliberate edit.
- A category or brand that still holds products cannot be deleted (`PROTECT`); retire it with
  `is_active` instead.

---

## 7a. Supplier pricing

`SupplierProduct` is one supplier's offer for one variant: `unique(supplier, variant)`.

Before it existed nothing joined a supplier to a product. `PurchaseOrderItem` points at a variant and
`PurchaseOrder` points at a supplier, and no row connected the two — so "who sells us this", "what did
*they* last charge" and "which of them should we buy from" had no answer, and the purchase order form
defaulted every line to `ProductVariant.cost`, the last price paid to **anyone**.

### 7a.1 Three cost fields, three different facts

| Field | Means | Written by |
|---|---|---|
| `Inventory.average_cost` | Weighted average per branch — values stock, prices COGS (§4) | `inventory.services.receive_stock` only |
| `ProductVariant.cost` | The last price paid to anybody — display, and the fallback in §4 | receiving, and the product form |
| `SupplierProduct.last_cost` | What **this** supplier last charged | receiving, and a buyer recording a quote |

They are not interchangeable. A purchase order quotes `SupplierProduct.last_cost` back at the
supplier it is addressed to; a sale books `Inventory.average_cost`.

### 7a.2 The list builds itself

Receiving a delivery upserts the offer for the supplier it came from, inside the same transaction as
the ledger write. A delivery can never be half-recorded — stock in, but nothing remembered about who
supplied it or for how much.

A buyer may also create one by hand to record a quote before ordering. Such a row has a `last_cost`
and no `last_purchased_at`, which is how the screen tells "quoted" from "bought".

Receiving from a supplier whose offer was marked discontinued reinstates it: a delivery is the
strongest available evidence that they still supply it.

### 7a.3 The preferred supplier

At most one per variant, enforced by `purchasing_supplierproduct_one_preferred` — a partial unique
index, so the many non-preferred offers do not collide.

**The first supplier a variant is ever received from becomes the preferred one.** That is a default,
not a judgement: with one supplier it is simply true, and it gives the purchase order form something
to suggest from the very first reorder. After that it only changes by an explicit act, so a second
delivery never silently moves it.

Promoting a supplier demotes the incumbent in the same transaction, through
`purchasing.services.set_preferred_supplier` (`POST /supplier-products/{id}/set-preferred/`). It is
refused for a supplier that does not supply the variant, and for an offer marked discontinued.
`is_preferred` is read-only on the serializer: writable, a PATCH would hit the index and surface as a
500 on an ordinary business action.

### 7a.4 Minimum order quantity

`minimum_order_quantity` is **advisory**. The purchase order form warns when a line is below it and
the order is still accepted.

> **DECISION REQUIRED** — advisory is a documented default, not a stated rule. Suppliers in practice
> flex on their own minimums, and refusing the order outright would be a rule nobody asked for. If
> the business wants it enforced, it belongs in `purchasing.services.create_purchase_order` as a
> `BusinessError`, not in the form.

### 7a.6 Creating a product from a purchase order

A buyer ordering something the catalogue has never carried creates it on the order itself. The
product is created **`DRAFT` and unpublished**, and its variants are added to the order as lines.

Two things it does not collect:

* **Stock.** Goods arrive by receiving the order being raised, which is what carries the cost paid
  into the ledger (§ 4.0a). A figure typed at order time would be the zero-cost door that closed.
* **A retail price, necessarily.** At the moment of ordering, a buyer knows what they are paying and
  frequently not yet what they will charge. Demanding a retail price here produces a made-up one.
  Blank is recorded as `0.00`, which is safe because of the rule below.

**A product with nothing priced above zero cannot be published.** `catalog.services.publish_product`
refuses it: zero is a legitimate price in the database — a sample, a gift line, something bundled —
and deliberately allowed by `catalog_variant_price_gte_0`, but nothing downstream refuses it.
`orders.services.pricing` computes `unit_price × quantity`, so a checkout for `0.00` is a valid
order and the goods leave for nothing ([D75](roadmap.md#known-defects)). The gate is per product,
not per variant: a free sample alongside a priced row is a real arrangement, and what is refused is
a product with *nothing* a shopper can pay for.

> **DECISION REQUIRED** — a product with one SKU and no variant axes cannot be created this way,
> because `generate_variants` requires at least one attribute value and `POST /variants/` requires a
> SKU the client would have to invent. The documented default is to send the buyer to the full
> product form for that case. If single-SKU products are common enough to matter — cosmetics are the
> likely ones — the fix is for the variant serializer to derive a SKU the way
> `unique_supplier_code` derives a supplier code.

### 7a.6a After receiving: what arrived that nobody can buy

Once a delivery is posted, the purchase order lists every product on it a shopper still cannot see —
`GET /purchase-orders/{id}/`, field `unpublished_products`.

Everything unpublished on the order is listed, not only what was created from it: a product someone
took offline last month is equally invisible, and its stock has equally just landed.

`can_publish` on each row mirrors `publish_product` exactly, so the screen never offers a button the
API would refuse, and never hides one it would allow. A product with nothing priced above zero shows
why instead of a button, and links to where the price is set.

The field is on the **detail** serializer only. It costs one query per order, which is nothing on one
order and an N+1 on the list — measured at 15 queries for four orders against 12 for one, and
enforced by `TestPurchaseOrderDetailQueryBudget`.

### 7a.6b Where a product stands, in one badge

`status` and `published` are independent, and the two surfaces read them differently:

| `status` | `published` | Storefront | POS | Badge |
|---|---|---|---|---|
| `DRAFT` | either | no | no | Draft |
| `ACTIVE` | `false` | no | **yes** | Counter only |
| `ACTIVE` | `true` | yes | yes | Published |
| `ARCHIVED` | either | no | no | Archived |

The storefront requires both (`catalog/search.py`); the POS grid filters on `status` alone
(`orders/api/pos_views.py`). An active, unpublished product is therefore **not hidden** — it sells at
the counter and not online, which is a real arrangement and is why the admin list names it rather
than calling everything unpublished "Hidden".

### 7a.5 Not a financial record

A supplier price list is reference data: it may be edited and deleted, and both foreign keys cascade.
That is the opposite of §3's rule for orders, payments, receipts and inventory transactions, which
record what was actually agreed and paid and are never hard-deleted. Deleting an offer loses a price
list entry; it cannot lose history, because the purchase orders and receipts hold that.

Offers are not branch-scoped. A supplier's price is an agreement with the business, not with one
shop; branch scoping lives on the purchase orders that spend against it.

## 7b. Returning goods to a supplier

`TransactionType.PURCHASE_RETURN` existed from the first migration — scored in the sign table,
accepted by the ledger — with **no service and no caller**. Faulty goods could not go back at all,
while § 4 claimed all along that a purchase return moves the weighted average cost. Both halves now
exist.

### 7b.1 What a return is

`PurchaseReturn` is to `PurchaseReceipt` what a customer return is to a sale: the mirror of the event
that moved the stock, never an edit of it. It is posted in one transaction — there is no draft state,
because a return that has taken stock off the shelf without recording the credit is exactly the
half-written record the ledger exists to prevent.

Three things happen together or not at all:

1. the ledger loses the units (`PURCHASE_RETURN`, through `inventory.services`, never a column write);
2. the order gains the credit;
3. the line remembers how many went back.

### 7b.2 Only what arrived, and only once

`quantity_returnable` is received minus already returned. More than that is refused in a sentence,
and `purchasing_poi_returned_lte_received` is the database saying the same thing when two returns
race. Nothing can be returned against a `DRAFT` or `CANCELLED` order — nothing arrived.

Stock that is not on the shelf cannot be put in a box. This is deliberately **stricter** than the
generic reducer: `ALLOW_OVERSELL` lets a *sale* go negative because the goods are in transit and will
follow, and there is no equivalent for a physical return. Driving stock negative here would claim a
box was sent back containing units that never existed.

The endpoint honours `Idempotency-Key`, because a replay would take the stock off the shelf twice and
credit the order twice (CLAUDE.md §7).

### 7b.3 The money is a credit, not a refund

A supplier is rarely paid back in cash; the value is set against what is owed.

```text
outstanding = grand_total − paid_total − credited_total
```

`grand_total` is what was agreed and never moves, exactly as `paid_total` never rewrites it. The
credit accumulates alongside in `credited_total` (CLAUDE.md §3.3). `finance.selectors.payables`
subtracts it, and `record_supplier_payment` caps payments at the same figure — without that, goods
could be sent back and the original total still paid, handing the supplier money for stock now
sitting in their own warehouse.

The credit is valued at **what the supplier charged** — the cost on the order line, not today's price
and not the branch's blended average. The client never names it; sending a `unit_cost` in the request
is ignored (CLAUDE.md §13).

### 7b.4 What the payment badge means

A credit is not a payment, and a partial one must not read as though money changed hands:

| Paid | Credited | Badge |
|---|---|---|
| nothing | part of the total | **Unpaid** — no money has been paid |
| part | — | Partially paid |
| any | enough that together they cover the total | **Paid** — nothing further is owed |

### 7b.5 Effect on cost

Returning removes units at what they cost, leaving the remainder valued at what *it* cost:

```text
new_average_cost = ((on_hand × average_cost) − (qty × unit_cost)) / (on_hand − qty)
```

Sending back the dear half of a blended shelf therefore **lowers** the average — the cheap stock is
what is left. An emptied shelf keeps its last average (nothing to value, and the next receipt sets
it). A return priced above the blended average is clamped at zero rather than valuing stock below
nothing: that means the figures disagree, not that the goods are worth less than free.

> **DECISION REQUIRED** — a return after the order was paid makes `outstanding` negative: the supplier
> owes the business. `payables` drops those rather than showing a negative liability, so the credit is
> visible on the order and nowhere else. Carrying supplier credit balances as an asset, drawable
> against the next order, is a larger piece of work and is not built. The documented default is that
> such a credit is settled with the supplier off-system.

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

**Which orders may be shipped.** `CONFIRMED`, `PROCESSING`, `PACKED` and
`SHIPPED` — the last because a split delivery is real, and the first parcel has
already moved the order on. Everything else is refused: `PENDING` has not been
confirmed, and `CANCELLED` / `REFUNDED` / `RETURNED` / `RETURN_REQUESTED` are
orders that must not leave the shop. Recording a shipment against one of those
is the kind of mistake that ends with goods gone and no money owed for them.

**A parcel always starts `PENDING`.** Its status is the tail of its event log
and nothing else; `status`, `dispatched_at` and `delivered_at` are read-only on
the API and move only through a `ShipmentEvent`. Allowing them to be set at
creation produced a parcel marked delivered with no event behind it and the
order still sitting at `PACKED` — a delivery nobody recorded, which no later
correction can unpick.

**A finished parcel takes no more events.** Once a shipment is `DELIVERED` or
`RETURNED` its history is closed. `FAILED` is deliberately not final: a failed
delivery attempt is normally retried the next day, and that retry is another
event on the same parcel.

**A tracking number needs the courier that issued it**, and one courier cannot
give one number to two parcels (`shipping_shipment_courier_tracking_uniq`,
conditional on a non-blank number because the number usually arrives after the
booking does). Without a courier the number identifies nothing, can be looked up
nowhere, and cannot be turned into a link — `Courier.tracking_url_template` is
what makes it one. The uniqueness rule is also what stops a double-clicked
fulfilment form booking the same parcel twice.

**Shipments are branch-scoped**, like orders, inventory, purchases and money. A
manager confined to one branch cannot list, read or create a shipment against
another branch's order.

**What the customer sees.** `GET /shop/orders/{number}/` returns the order's
parcels with courier, tracking number, tracking link, status and the visible
events — but **not `cost` and not `notes`**. What we pay the courier is our
margin, and the notes are written for the packing bench; the customer has
already paid the shipping line on their own order.

---

## 9. Currency and formatting

Default currency **BDT**, symbol `৳`, 2 decimal places, `1,290.00` grouping, symbol before the amount.
Currency is configuration (`RANGON_CURRENCY`), not a literal in business logic. Financial tables use
tabular numerals.
