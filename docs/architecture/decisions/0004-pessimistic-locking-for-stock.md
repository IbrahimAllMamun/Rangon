# ADR-0004 — Pessimistic row locks for stock, cached columns beside an append-only ledger

**Status:** Accepted · 2026-08-17

## Context

Two invariants must never break: stock cannot go negative, and money cannot be captured twice. Options
considered: (a) recompute stock from the ledger on every read, (b) optimistic version columns with
retry, (c) `SELECT … FOR UPDATE` on a cached row.

## Decision

(c). `Inventory` holds `on_hand`/`reserved` as transactionally-maintained caches next to an append-only
`InventoryTransaction` ledger. Every mutation locks the affected `Inventory` rows ordered by `id`,
checks the invariant, appends ledger rows, and updates the cache in the same transaction.

## Consequences

- Reads are cheap: a 10 000-variant product list does not aggregate millions of ledger rows.
- Writes serialise per variant — exactly the granularity we want. Two cashiers selling different
  products never block each other; two selling the last unit of the same SKU do.
- Lock ordering by `id` prevents the classic two-transaction deadlock on multi-line sales.
- The cache can theoretically drift (a bug, or an out-of-band `UPDATE`). Mitigated by
  `on_hand_after`/`reserved_after` snapshots on every ledger row, `verify_integrity()`, a nightly Celery
  check, and tests that assert cache == ledger sum after every scenario.
- Rejected optimistic locking: retry storms at a POS counter are worse UX than a 5 ms lock wait, and the
  failure mode is harder to explain to a cashier.
