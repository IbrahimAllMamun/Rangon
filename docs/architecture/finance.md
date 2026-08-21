# Finance — accounts and the cash book

> Phase 35 (F1) of the money layer. Foundation for expenses (36), the party ledger (37), net profit
> (38) and the cheque register (39).
>
> Rules: [CLAUDE.md](../../CLAUDE.md) §3.3 · Decisions: [ADR-0011](decisions/0011-append-only-cash-book.md)
> · Business rules: [business-rules.md §6b.1](../business-rules.md)

---

## 1. The problem this solves

Before this app, Rangon recorded that a customer paid **by cash** and lost the fact that the money
went **into the counter drawer**. `Payment.method` was the whole story. That meant:

- no cash position — nobody could ask "how much is in the shop right now?"
- no bank balance, so card settlements were invisible
- no place for expenses to come out of (phase 36)
- no way to compute net profit (phase 38), only gross margin

A payment *method* is a fact about the customer. An *account* is a fact about the business.

## 2. Shape

Deliberately the same shape as the inventory engine. If you have read
[inventory.md](inventory.md), you already know this design.

| Inventory | Finance |
|---|---|
| `Inventory.on_hand` (cached) | `Account.balance` (cached) |
| `InventoryTransaction` (append-only, signed `quantity`) | `AccountTransaction` (append-only, signed `amount`) |
| `inventory.services` is the only writer | `finance.services` is the only writer |
| `verify_inventory` replays the ledger | `verify_accounts` replays the cash book |
| `InsufficientStock` (409) | `InsufficientFunds` (409) |
| `SELECT … FOR UPDATE` on the `Inventory` row | `SELECT … FOR UPDATE` on the `Account` row |
| Lock ordering by pk to avoid deadlock | Lock ordering by pk to avoid deadlock |

```text
finance/
  models.py      Account · AccountTransaction · AccountTransfer
  services.py    create_account · record_movement · record_for_reference ·
                 transfer · balance_at · verify_integrity · repair_drift
  selectors.py   active_accounts · cash_position · ledger · movement_totals
  api/           AccountViewSet · AccountTransactionViewSet · AccountTransferViewSet
  management/    verify_accounts
```

### 2.1 There is no opening-balance column

An account opened with ৳20,000 gets an `OPENING` transaction for ৳20,000. It does **not** get an
`opening_balance` field.

This matters more than it looks. With a column, the invariant would be
`balance == opening_balance + SUM(transactions)`, and every reconciliation would need to special-case
the opening figure. Without it the invariant is simply:

```text
Account.balance == SUM(AccountTransaction.amount)
```

which `verify_integrity()` checks with one `GROUP BY`, and which cannot drift for a reason anybody
has to reason about.

### 2.2 `amount` is signed

Positive is money in, negative is money out. `TRANSACTION_SIGN` maps each type to `+1` or `-1` and
applies it to the absolute figure the caller supplies — except `ADJUSTMENT`, which is `0` because
the caller states the delta itself. This is exactly `inventory.models.TRANSACTION_SIGN`.

## 3. Movement types

| Type | Sign | Written by |
|---|---|---|
| `OPENING` | + | `create_account()` |
| `SALE_PAYMENT` | + | `orders.services.payments` on capture |
| `REFUND` | − | `orders.services.payments.refund_order()` |
| `SUPPLIER_PAYMENT` | − | `purchasing.services.record_supplier_payment()` |
| `EXPENSE` | − | phase 36 |
| `TRANSFER_IN` / `TRANSFER_OUT` | + / − | `finance.services.transfer()` |
| `DEPOSIT` / `WITHDRAWAL` | + / − | the admin cash-book form |
| `ADJUSTMENT` | signed | the admin form, and `repair_drift()` |

`SALE_PAYMENT`, `REFUND`, `SUPPLIER_PAYMENT` and `EXPENSE` **cannot be entered by hand** through
`/accounts/record-movement/`. Each is posted by the service that causes it, and typing one in would
double-count money that is already in the account.

## 4. Wiring into the existing money events

`finance` never imports `orders` or `purchasing`. The dependency runs one way: those apps call
`finance.services.record_for_reference()`, which takes plain arguments (branch, amount, method,
reference) rather than an `Order` or a `Payment`.

```text
orders.services.payments.record_payment(status=CAPTURED) ─┐
orders.services.payments.capture_payment()                ├─→ SALE_PAYMENT
orders.services.payments.refund_order()                   ──→ REFUND
purchasing.services.record_supplier_payment()             ──→ SUPPLIER_PAYMENT
```

Each posts **inside the caller's existing `transaction.atomic()` block**, so a rolled-back sale
cannot leave money in a drawer, and a supplier payment that the drawer cannot cover rolls back the
`SupplierPayment` row with it.

### 4.1 Money moves on capture, never on record

A `PENDING` or `AUTHORIZED` payment has put money nowhere. An authorised card payment has not
settled. A COD order's cash arrives when the courier remits, which may be a week after the order.
Posting at record time would put money in the drawer that is not in the drawer.

So `record_payment()` posts only when it is called with `status=CAPTURED`; otherwise the chosen
account is stored on the row and `capture_payment()` posts later.

### 4.2 Double-posting is checked against the cash book

Not against a flag on the payment row — against the existence of an `AccountTransaction` with that
`(reference_type, reference_id)`. The cash book is the thing that must not be double-counted, so it
is the thing that is checked. A gateway that replays its capture webhook four times credits the
account once (`tests/test_concurrency.py`).

### 4.3 Account resolution, and the honest gap

`resolve_account(branch, method)` maps the method to a *kind* and returns that branch's default
active account of that kind, falling back to any active account of that kind.

If there is none, it returns `None` and **nothing is posted**. It does not fall back across kinds:
posting card takings into the cash drawer would make the drawer impossible to reconcile, and a
plausible lie in a cash book is worse than a visible gap.

The causing event still succeeds — a shop that has not opened its accounts yet must still be able to
sell. `verify_accounts` counts every captured payment, completed refund and supplier payment that
carries no account, so the gap is reported (illustrative output, not a measurement):

```text
$ python manage.py verify_accounts
Accounts are consistent with the cash book.

41 money event(s) posted nothing to any account
(no account existed for that method at the time):
      38  captured payments
       3  supplier payments
  These cannot be repaired by replaying the ledger — the money's destination was
  never recorded. Open the accounts you need so that future events post, and
  treat the figures above as a known gap.
```

Those rows cannot be backfilled. `Payment.account` is nullable and stays nullable, because inventing
a destination for money that was received before the app existed would be exactly the kind of
retroactive fiction CLAUDE.md §3.3 forbids.

## 5. Concurrency

Every mutation locks the affected `Account` rows `FOR UPDATE`, **ordered by primary key**, before
reading the balance it is about to change. Without that, `balance = balance + amount` is a
read-modify-write and simultaneous sales lose increments.

Four threaded tests in `apps/api/tests/test_concurrency.py` cover it:

| Test | What it proves |
|---|---|
| `test_simultaneous_sales_all_land_in_one_drawer` | Six concurrent sales sum exactly — no lost update |
| `test_concurrent_withdrawals_cannot_overdraw_a_drawer` | Five withdrawals against a drawer covering three succeed exactly three times |
| `test_transfers_in_opposite_directions_do_not_deadlock` | pk-ordered locking holds under crossed transfers |
| `test_a_replayed_capture_webhook_banks_the_money_once` | Idempotent posting under a race |

## 6. Overdraft

`Account.allow_overdraft` is `False` by default. A cash drawer cannot pay out notes it does not
hold, and the service refuses with `INSUFFICIENT_FUNDS` (409) rather than letting the balance go
quietly negative.

A bank account with an overdraft line legitimately goes negative, so it opts in. This is the money
analogue of `RANGON_ALLOW_OVERSELL` — the difference being that overdraft is a per-account fact
rather than a global setting, because two accounts at the same branch genuinely differ.

## 7. Drift and repair

`verify_integrity()` replays the cash book and reports any account whose cached balance disagrees.
Drift means something wrote `Account.balance` without appending a transaction — a bug, or an
out-of-band `UPDATE`.

`repair_drift()` follows `inventory.repair_drift()` exactly: the cached figure is the one people
have been looking at, so the repair **appends a row explaining the difference** rather than silently
rewriting the cache. The ledger itself is never edited. A reason is mandatory.

```bash
python manage.py verify_accounts
python manage.py verify_accounts --branch DHK1
python manage.py verify_accounts --fix --reason "DR-2026-08-22 reconciliation"
```

## 8. Screens

| Route | What it does |
|---|---|
| `/admin/finance` | Cash position tiles, accounts table, recent movements, and every write action |
| `/admin/finance/[id]` | One account's cash book, filterable by movement type |
| `/admin` | Cash position tiles, linking through |
| `/pos` | Per-tender account, so a split of cash + card does not dump both in the till |
| `/admin/orders/[id]` | Which account a COD remittance lands in, and which a refund comes out of |

The POS shows the destination as plain text when the branch has one account of that kind, and only
becomes a `<select>` when there are two or more. The register is the one screen where a needless
interaction costs real money in queue time.

## 9. What this does not do

- **No chart of accounts.** A flat list per branch (decision D-B). A chart of accounts is an
  accounting product, not a retail feature.
- **No double-entry.** One row per movement, per account. A transfer writes two rows because two
  accounts change, not because of debits and credits.
- **No receivable or payable.** That is phase 37, and only if the business sells on credit
  (decision D-A, currently assumed *no*).
- **No expenses.** Phase 36.
- **No net profit.** Phase 38, and blocked on the VAT decision (D-C).
- **No multi-currency.** The organisation has one currency (`RANGON_CURRENCY`).
