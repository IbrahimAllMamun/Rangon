# ADR-0011 — An append-only cash book, mirroring the inventory ledger

**Status:** Accepted · 2026-08-22

## Context

Phase 35 adds the financial layer the platform had none of: a payment recorded a *method* and never
which account the money landed in. Three shapes were available.

1. **A `balance` column on an `Account` table, written directly.** What most small retail ERPs do,
   including the Bseba ERP this phase was scoped from
   ([audit](../../planning/bseba-erp-feature-audit.md)).
2. **Double-entry bookkeeping** with a chart of accounts, debits and credits.
3. **A cached balance over an append-only transaction table** — the shape
   `Inventory.on_hand`/`InventoryTransaction` already uses in this codebase (ADR-0004).

The decision also had to settle whether an opening balance is a column or an entry, and what happens
when a branch has no account able to hold a given payment method's money.

## Decision

**Shape 3.** `Account.balance` is a transactional cache over `AccountTransaction`, and
`finance.services` is the only code allowed to write it.

- Every movement is one append-only row with a **signed** `amount`, a `balance_after`, a
  `reference_type`/`reference_id`, an actor and (for adjustments and withdrawals) a mandatory reason.
- **An opening balance is an `OPENING` row, not a column**, so the invariant is exactly
  `balance == SUM(amount)` with no special case.
- `verify_accounts` replays the cash book and reports drift; `--fix` **appends a row explaining the
  difference** rather than rewriting the cache, exactly as `verify_inventory --fix` does.
- Mutations lock the `Account` rows `SELECT … FOR UPDATE` ordered by primary key.
- A flat list of `CASH`/`BANK`/`MFS`/`OTHER` accounts per branch. **No chart of accounts, no
  double-entry** (decision D-B).
- Money posts on **capture**, never on record.
- When no account of the right kind exists, the service posts **nothing** and returns `None`. It
  does not fall back to an account of another kind, and it does not block the sale.
- `Payment.account`, `Refund.account` and `SupplierPayment.account` are nullable, permanently.

## Consequences

- **The invariant is provable, not merely believed.** Any drift between the balance and the ledger
  is detectable by one `GROUP BY`, and the nightly check is the same operational habit staff already
  have for stock.
- **The concurrency story is already proven.** The lost-update bug that a directly-written balance
  column invites is prevented by the same row-locking discipline as oversell, and the concurrency
  tests were written by analogy with the inventory ones.
- **Corrections cannot destroy history.** A miscount is a new `ADJUSTMENT` row with a reason, never
  an edit — which is what CLAUDE.md §3.3 requires of every financial record.
- **An accountant will not recognise this as bookkeeping.** There are no debits, no credits and no
  trial balance. That is deliberate: the business needs to know where its money is, not to produce
  statutory accounts. If double-entry is ever required, this table is a faithful source to derive it
  from — every movement already carries its counterparty reference.
- **A transfer writes two rows**, because two accounts change. That is not double-entry; it is the
  same thing `inventory.transfer()` does with `TRANSFER_OUT`/`TRANSFER_IN`.
- **Some money will have no account, forever.** Every payment taken before this app existed, and any
  taken afterwards under a method the branch has no account for, carries `account = NULL`. This is
  the deliberate cost of refusing to guess: `verify_accounts` states the number rather than hiding
  it. A backfill would be fiction, and the alternative — refusing the sale — would make the register
  unusable on day one.
- **Posting card takings into the cash drawer is impossible**, which is the failure mode that makes
  a drawer permanently unreconcilable and is the single most common defect in the ERPs surveyed.
- Overdraft is a per-account flag rather than a global setting (contrast `RANGON_ALLOW_OVERSELL`),
  because a bank account and a cash drawer at the same branch genuinely differ.
