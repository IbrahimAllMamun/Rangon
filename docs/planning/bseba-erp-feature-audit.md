# Bseba ERP — feature audit and Rangon implementation plan

Source: `https://erp.bseba.com`, tenant **Dostishop**, walked signed-in on 2026-08-21.
Read-only: every screen below was opened and its fields recorded; nothing was created or changed.

Related: [dostishop-feature-review.md](dostishop-feature-review.md) reviewed Dostishop's *custom
storefront dashboard*. This document covers the *ERP they run the business on*, which is a different
system with a different shape.

---

## 1. What Bseba is, and why that matters before copying anything

Bseba is an **accounting-first single-shop ERP**. Its centre of gravity is a party ledger: every
customer and supplier carries a running balance, every sale and purchase can be part-paid, and the
system's headline output is a **Business Report ending in Net Profit**.

Rangon is an **omnichannel retail platform**. Its centre of gravity is the inventory ledger and the
order: one catalog with variants, one stock ledger across branches, three surfaces (storefront,
admin, POS) on one backend.

Neither is a superset of the other:

| | Bseba | Rangon |
|---|---|---|
| Product model | one product = one stock row. No variants | Product → Variant → per-branch Inventory |
| Stock | a `Stock QTY` number typed on the product form | append-only `InventoryTransaction` ledger; a column is never written directly |
| Branches | single business | `Organization → Branch → Inventory` throughout |
| Money owed | party ledger, receivable/payable, cash book | order `payment_status`; **no accounts, no party balance** |
| Online store | none (a "Marketplace" you list into) | full storefront, cart, checkout, SEO |
| Expenses / payroll / cheques / EMI | yes | none |

**So the plan is not "clone Bseba".** It is: take the financial layer Rangon genuinely lacks, adapt
it to Rangon's rules, and consciously decline the parts that are a different product.

---

## 2. Complete feature inventory

56 routes, exactly as the sidebar lists them.

### 2.1 Dashboard (`/Dashboard`)

- Period selector: Custom · Today · Last 30 Days · This Week · Last Week · This Month · Last Month ·
  This Year · Last Year
- Three headline cards, each with paid/due split and a percentage:
  **Sales** (total, paid, due, "% collected") · **Purchase** (total, paid, due, "% paid") ·
  **Cash Flow** (received, paid out)
- Subscription and messaging strip: SMS credit balance, licence countdown (`6d : 02h : 04m : 10s`),
  account balance, expense total, "7 days left"
- Quick counters: Sale Invoice · Purchase Invoice · Cash Flow · Expense · Service Paid
- **Financial Distribution** — Sales vs Purchases vs Expenses
- **Last 30 Days Trend** — line chart with Total Sales / Purchases / Expenses and Avg. Sales
- **Latest Invoice** table: Customer · Date · Amount · Paid · Due · Action

### 2.2 Header / global

Language toggle **English ⇄ বাংলা** · support phone · quick "Sale" and "POS Sale" buttons ·
"Add New" quick-create menu (New Sale, New Purchase, Product List, Customer, Supplier, Sales List,
Purchase List) · profile · logout · Buy SMS · subscription/payment page

### 2.3 Catalogue

| Route | What it does |
|---|---|
| `/NewProduct` | name, "Suggestion Enabled", brand, category, sub-category, **unit**, "Decimal" toggle, **Manage Stock** toggle, **Stock QTY**, unit cost, **alert quantity**, sale price, **dealer price**, barcode, image. Inline `+ Brand` `+ Category` `+ Unit` |
| `/ProductList` | search, filter, paginate |
| `/Brand` `/Category` `/SubCategory` `/Unit` | reference data CRUD |

### 2.4 Purchase

| Route | What it does |
|---|---|
| `/CreatePurchase` | supplier, date, product picker + **barcode search**, note. Lines: `NO · PRODUCT NAME · QTY · PURCHASE PRICE · SALE PRICE · MARGIN · DP/RP · DP MARGIN · TOTAL`. Totals: Total, Discount %, Discount Amount, Cost, Grand Total. **Payment By** (account) + amount. Inline `New Supplier` / `New Product` |
| `/PurchaseList` `/PurchaseReturnList` | with returns |

Note: the purchase screen **sets the sale price and shows the margin** as goods are received.

### 2.5 Sale

| Route | What it does |
|---|---|
| `/NewSale` | customer, **Bill To**, date, toggles to reveal **Purchase Price** and **Profit** live, **Send SMS**, product + barcode search, note, **SR** (sales rep). Lines: `NO · PRODUCT NAME · STOCKS · QTY · SALE PRICE · DP · TOTAL`. Totals: Discount %, Discount Amount, **Other Cost** (name + amount), Grand Total, Payment By + amount |
| `/SaleWithVat` | a VAT-bearing variant of the same document |
| `/PosSale` | counter register |
| `/SaleList` `/SaleReturnList` | with returns |

### 2.6 Quotation

`/CreateQuotation` — Bill To, product picker, optional purchase-price reveal. Lines carry
`PRODUCT · WARRANTY · QTY · PRICE · TOTAL`. `/QuotationList`.

### 2.7 Damage

`/AddDamage` — date, product + barcode, note. Lines: `PRODUCT NAME · STOCKS · **SERIALS** · QTY ·
PURCHASE PRICE · TOTAL PURCHASE`. `/DamageList`.

### 2.8 Expense

`/Expense` — expense type, **payment account**, date, note, amount; plus an Expense List and a
**Category Wise Total**, printable. `/ExpenseType` (CRUD), `/ExpenseByType` (grouped report).

### 2.9 Barcode

`/Barcode` multi-product label sheet · `/Barcode2` single label.

### 2.10 Bank accounts / cash book

| Route | What it does |
|---|---|
| `/BankAccount` | accounts with name, number, branch, **running balance** |
| `/BalanceTransfer` | move money between accounts |
| `/Cheque` | cheque register: contact, account, cheque no, amount, issue date, cheque date, type, **status: Pending → Deposited → Cleared / Bounce** |
| `/Transactions` | the cash book itself |

### 2.11 Investment

`/InvestorList` — investors and their invested balance, surfaced on the Business Report.

### 2.12 EMI / কিস্তি

`/CreateEMI` — pick a **sale**, customer auto-fills, grand total, **advance/down payment**,
**EMI No** (number of instalments), type, first EMI date. `/EMI` list, `/InstallmentReport`.

### 2.13 HRM

| Route | What it does |
|---|---|
| `/NewMember` | team member: name, mobile, salary, salary date, Active, **Manage Business**, **Is SR?** |
| `/srList` | sales reps |
| `/Attendance` | one schedule per business: off days, check-in/out time, late-after minutes, absent-after minutes |
| `/Role` | role management |

### 2.14 Reports (15)

Business Report · Sale Report · Top Customer · Customer Report · Receivable Report · Payable Report ·
Low Stock Product List · Alert Product List · Sale Product Report · Account Payment Report ·
Expense Report · Transaction Report · Daily Report · Stock Report · StockList

**`/BusinessReport` is the system's thesis.** Cards: Receivable (contacts + amount), Payable,
Investment (investors + balance), Stock (products + stock value), Business Asset (account balance +
asset). Then a period-filtered summary of **27 figures**:

```
Total Sales · Total Paid Sales · Total Due Sales · Sales Profit · Others Sales Earned · Total Vat
Total Purchases · Total Paid Purchases · Total Due Purchases · Purchase Others Cost
Total Damage · Expense · Salary · Warranty Cost · Warranty Earned
Total Sale Return · Sale Return Loss · Service · Service Paid · Service Refunded
Discount Payment · Discount Received · Total Received · Total Paid
Total Customers · Total Suppliers · >>> NET PROFIT <<<
```

### 2.15 Marketplace

`/Marketplace` dashboard (pending → approved → shipped → delivered / cancelled, approved product
count, revenue paid/due, pending queue) · `/ActiveMarketplace`. A B2B channel the shop lists into.

### 2.16 Admin & settings

`/Admin` — administrators by **mobile number**, add/remove.
`/BusinessSetting` — business name, contact, address, currency, **VAT percentage**, TIN, tag line,
email, website, invoice footer, logo upload, **POS printer size**, **default invoice no**, and
**Backup Download**.

### 2.17 Contacts

`/Customer` and `/Supplier` — name, mobile, email, address, contact person, **contact type**,
**opening balance** ("আমি পাবো" — what I am owed). List shows `BALANCE · TRANSACTION · DATE ·
EDIT · REPORT · LEDGER`.

---

## 3. Gap analysis against Rangon

### Already in Rangon, equal or better — do nothing

| Bseba | Rangon today |
|---|---|
| Product/brand/category CRUD | ✅ plus **variants**, a variant matrix, colour-linked media, SEO fields |
| Purchase → stock | ✅ PO → send → receive → ledger → weighted-average cost (ADR-0006) |
| Sale, POS Sale, Sale returns | ✅ POS register, split payment, hold/resume, returns state machine |
| Stock / low-stock / alert lists | ✅ ledger-backed, plus `verify_inventory` integrity replay |
| Roles | ✅ 7 roles, permission codes, branch scoping, audit log |
| Business settings, invoice footer, logo | ✅ `/admin/settings`, editable |
| Customer records | ✅ phone-first identity, addresses, notes, order history |
| Reports | ✅ 8 endpoints + CSV export |
| Barcode generation + scanning | ✅ EAN-13 with check digit, keyboard-wedge POS |
| — | ✅ **plus a whole storefront** Bseba has no equivalent of |

### Absent from Rangon and genuinely worth having

| # | Feature | Why it matters here |
|---|---|---|
| G1 | **Financial accounts + cash book** | Rangon records a payment *method* but never *which account* the money landed in. There is no cash position, no bank balance, no transfer. |
| G2 | **Party ledger — receivable / payable** | A retailer selling on credit ("বাকি") cannot see who owes what. Rangon has `payment_status` per order and nothing that aggregates it per customer. |
| G3 | **Expenses** | Rent, salary, utilities, transport. Without them, "profit" is gross margin, not profit. |
| G4 | **Business Report / Net Profit** | The single figure the owner actually manages by. Rangon's profit report stops at gross margin. |
| G5 | **Damage / write-off screen** | `inventory.services.write_off` exists and is tested; there is no UI. |
| G6 | **Quotation** | Quote → convert to sale. Nothing in Rangon. |
| G7 | **Cheque register** | Common in BD wholesale. Rangon has `CHEQUE` as a supplier payment *method* with no lifecycle. |
| G8 | **Barcode label sheets** | Rangon generates barcodes but cannot print a sheet of labels. |
| G9 | **Bengali UI toggle** | CLAUDE.md §11 already requires Bengali text to render; the UI is English-only. |
| G10 | **SMS** | Already on the roadmap as gap #8. Bseba sells SMS credit and fires it on sale. |
| G11 | **Sales-rep (SR) attribution** | Commission and per-rep reporting. |
| G12 | **Backup download from the UI** | Rangon's restore has never been rehearsed (roadmap "Still unproven"). |

### Absent, and deliberately declined — with reasons

| Bseba feature | Why not |
|---|---|
| **Marketplace** | A different product (multi-vendor B2B). `Branch` + the storefront cover the real need. Revisit only if the owner actually sells wholesale through a network. |
| **EMI / instalments** | Real in BD electronics retail, rare in fashion. Cheap to add *after* G1–G4 exist, meaningless before. |
| **Investor list** | A capital-account feature for a business whose owner tracks investors. Ask before building. |
| **Attendance / payroll** | HR, not retail. A salary *expense* (G3) captures the money without building an HR module. |
| **`Stock QTY` on the product form** | Directly violates CLAUDE.md §3.2. Rangon opens stock through `inventory.services` with a reason. Already done correctly in the product form. |
| **Setting sale price inside the purchase screen** | Tempting and dangerous: it edits the catalog from a goods-receipt document with no audit trail of *why* the price moved. If wanted, do it as an explicit "reprice from this receipt" action that writes `AuditLog` rows. |
| **Single-product-no-variants model** | Rangon's variant model is the reason it can sell fashion at all. Never regress it. |
| **Admin identified by mobile number only** | Rangon uses Argon2 + JWT + role permissions (ADR-0005). |

---

## 4. Decisions the owner owes before the plan starts

These change the shape of the code, not just the schedule. Each is added to
[business-rules.md](../business-rules.md) as a `DECISION REQUIRED` when the phase begins.

1. **Does the business sell on credit?** If yes, G2 (party ledger) is the top priority and changes
   the order model's relationship to payment. If no, G1 + G3 alone deliver most of the value.
2. **Chart of accounts, or a flat list of cash/bank/MFS accounts?** Bseba uses a flat list. A flat
   list is honest and sufficient; a real chart of accounts is an accounting product.
3. **VAT** — still open from the existing roadmap, and **it blocks G4**: Net Profit cannot be
   computed until VAT is settled, because changing it rewrites every historical total.
4. **EMI, investors, marketplace, attendance** — build any of these at all? Default answer in this
   plan: **no**.

---

## 5. The plan

Five phases. Each follows CLAUDE.md §12's definition of done — migration, service, endpoint,
frontend, validation, authorization, states, tests, docs, audit, accessibility, security.

The ordering rule: **money-in/money-out first**, because that is what Rangon is missing as a
*business system*, and every later feature (cheques, EMI, commission) hangs off it.

---

### Phase F1 — Financial accounts and the cash book  *(G1)*

The foundation. Nothing else in the money layer can be built first.

**New Django app: `finance`.**

```text
finance/
  models.py      Account, AccountTransaction, AccountTransfer
  services.py    record_movement(), transfer(), balance_at()
  selectors.py   account_balances(), cash_position()
  api/           viewsets, serializers
```

- `Account` — name, kind (`CASH` / `BANK` / `MFS` / `OTHER`), account number, branch, `is_active`,
  opening balance. **No `balance` column that is written directly.**
- `AccountTransaction` — append-only, exactly like `InventoryTransaction`: signed `amount`,
  `transaction_type`, `reference_type` + `reference_id`, actor, `occurred_at`, reason. The balance
  is a transactional cache reconciled by a `verify_accounts` command that replays the ledger, mirroring
  `verify_inventory`.
- Every existing money event grows an optional `account` FK and posts a movement **inside the
  service's existing `transaction.atomic()` block**: `orders.services.payments`, `SupplierPayment`,
  refunds.

**Why append-only rather than a balance column:** CLAUDE.md §3.3 makes financial records immutable,
and the inventory engine already proves the pattern works under concurrency. Reusing it means the
concurrency tests can be written by analogy.

- API: `/api/v1/accounts/`, `/accounts/{id}/transactions/`, `/account-transfers/`
- Admin: `/admin/finance/accounts` (list + balances), transfer form, transaction ledger with filters
- POS and the payment capture dialog gain an **account** selector, defaulting to the branch's cash
  account
- Tests: invariant (replaying the ledger equals the cached balance), failure path (transfer from an
  account with insufficient balance if overdraft is disallowed), concurrency (two simultaneous
  payments into one account), permission

*Depends on:* nothing. *Blocks:* F2, F3, F4, F5.

---

### Phase F2 — Expenses  *(G3)*

Small, self-contained, immediately useful, and it exercises F1.

- `ExpenseCategory` (name, code, active) and `Expense` (category, account, amount, `spent_at`,
  note, attachment, branch, `created_by`)
- Posting an expense writes an `AccountTransaction` through `finance.services` — never a bare row
- API: `/api/v1/expense-categories/`, `/api/v1/expenses/`, plus `/reports/expenses/` grouped by
  category and period
- Admin: `/admin/expenses` — create form, list with period filter, category-wise totals, CSV export
- Tests: an expense moves the account balance by exactly its amount; a deleted category with expenses
  is refused (PROTECT); permission `expenses.create`

*Depends on:* F1.

---

### Phase F3 — Party ledger: receivable and payable  *(G2)*

Only if decision 5.1 says the business sells on credit.

- **Do not add a `balance` column to `Customer`.** Derive it: a customer's balance is
  `Σ unpaid order totals − Σ payments`, from rows that already exist. Add a `CustomerLedgerEntry`
  *view/selector* first; only materialise a cached balance if measurement shows the query is too slow,
  and then reconcile it the same way inventory does.
- Opening balances need one new row type: an `OPENING` entry, so a shop migrating from paper can
  state what a customer already owed.
- API: `/api/v1/customers/{id}/ledger/`, `/reports/receivable/`, `/reports/payable/`
- Admin: a Ledger tab on the customer and supplier detail screens; Receivable and Payable reports
  with ageing buckets (0–30 / 31–60 / 61–90 / 90+)
- Storefront: nothing. Credit is a counter relationship.
- Tests: ledger sums to the same figure as the aggregate report; a part-paid order appears in both
  the order timeline and the ledger exactly once

*Depends on:* F1. *Decision:* 5.1.

---

### Phase F4 — Business Report and Net Profit  *(G4)*

The payoff. Everything it needs now exists.

- `reports/services.py` gains `business_summary(period, branch)` returning the figures Rangon can
  honestly produce: sales (total/paid/due), gross margin from the frozen `unit_cost` on order lines
  (ADR-0006), purchases, damage/write-off value, expenses, returns and return loss, discounts given
  and received, received/paid totals, VAT, and **net profit**
- Deliberately omitted until the corresponding feature exists: Salary, Warranty, Service, Investment.
  A figure that is always zero is worse than an absent one — it reads as "we have that".
- `/admin/reports/business` with the period selector and a CSV export
- The admin dashboard gains a Cash position tile and an Expenses tile
- Tests: net profit equals the sum of its parts on a seeded month; changing the VAT setting changes
  the figure (which is exactly why decision 5.3 must come first)

*Depends on:* F1, F2, F3 (whichever exist). *Decision:* 5.3 (VAT).

---

### Phase F5 — Trade documents and operations

Independent of the money layer; can run in parallel with F2–F4 if there is capacity.

| Task | Notes |
|---|---|
| **Damage / write-off screen** (G5) | `inventory.services.write_off` is built and tested. This is form work: product picker, quantity, DAMAGE/LOSS, required reason. |
| **Stock count and transfer screens** | Same story — services exist, screens do not. |
| **Quotation** (G6) | New `quotations` app: `Quotation` + `QuotationLine`, statuses `DRAFT → SENT → ACCEPTED → EXPIRED / CONVERTED`, printable A4, and one service `convert_to_order()` that reuses the existing checkout path so pricing and stock rules cannot diverge. |
| **Purchase order create → receive UI** | Already the roadmap's next task; unchanged by this audit. |
| **Cheque register** (G7) | `Cheque` model with the Bseba lifecycle (Pending → Deposited → Cleared / Bounce). A cleared cheque posts to F1; a bounced one reverses. Only worth building after F1. |
| **Barcode label sheets** (G8) | Print CSS + a selection screen; reuses the existing barcode generator. |
| **SR attribution** (G11) | An optional `sales_rep` FK on `Order`, a filter on the sales report. Do **not** build attendance or payroll. |
| **Bengali toggle** (G9) | `next-intl`, message catalogues, `৳` and Bengali numerals already handled in `lib/format.ts`. Sizeable — treat as its own phase. |
| **Backup download** (G12) | Fix D14 first (the API image ships `pg_dump` 15 against a PostgreSQL 16 server), then expose an owner-only download. **Rehearse a restore before calling it done.** |
| **SMS provider** (G10) | Already roadmap gap #8. |

---

## 6. Sequencing

```text
F1 Accounts + cash book      ████████            foundation, blocks everything
F2 Expenses                      ████            small, high value
F3 Party ledger                  ██████          only if credit sales — decision 5.1
F4 Business report                   ████        needs VAT settled — decision 5.3
F5 Damage / count / transfer ████                parallel, services already exist
   Quotation                     ██████          parallel
   Cheques                            ████       after F1
   Barcode sheets               ██               parallel, small
   Bengali                          ████████     own phase, whole-UI sweep
```

Relative sizes only — no hour estimates, because the repo has no measured velocity to base them on.

**Do F5's damage/count/transfer screens first if you want a quick win**: the services are built,
tested and unused, so it is pure form work with no new business rules, exactly like the product form
that just shipped.

---

## 7. Rules that apply to every phase

Repeating these because Bseba breaks all of them and the temptation to copy its screens is real.

1. **Money is `Decimal`, never `float`** (CLAUDE.md §6).
2. **No balance column is ever written directly.** Append a transaction and let the cache reconcile,
   the way `Inventory.on_hand` does over `InventoryTransaction`.
3. **The service owns the transaction boundary**, not the view (§4).
4. **Every money movement is audit-logged** with actor, before, after, reason and reference (§3.5).
5. **Financial rows are never hard-deleted** — reverse, refund, or compensate (§3.3).
6. **The backend refuses, the frontend merely hides.** A missing permission must fail server-side (§3.4).
7. **Every service that moves money needs an invariant test and a failure-path test** (§9), and
   anything with a concurrency window gets a threaded test in `tests/test_concurrency.py`.
8. **`DECISION REQUIRED`** goes in `business-rules.md` for anything the owner has not settled — pick a
   documented default and say so, never invent a rule silently (§13).
