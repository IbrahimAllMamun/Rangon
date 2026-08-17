# Inventory Engine

The highest-risk module in the platform. Everything that changes stock goes through
`apps/api/inventory/services.py`. Nothing else may write `Inventory.on_hand` or `Inventory.reserved`.

## Data model

```text
Inventory              (branch, variant) unique
  on_hand              int   ≥ 0
  reserved             int   ≥ 0
  average_cost         Decimal(14,2)      weighted average cost at this branch
  reorder_point        int                low-stock threshold
  updated_at

InventoryTransaction   append-only ledger
  branch, variant
  transaction_type     PURCHASE | SALE | RETURN | DAMAGE | LOSS | ADJUSTMENT
                       TRANSFER_IN | TRANSFER_OUT | RESERVATION | RESERVATION_RELEASE
  quantity             signed int (the delta this row applies)
  unit_cost            Decimal(14,2) nullable  (cost at the time, for PURCHASE/RETURN)
  on_hand_after        int      snapshot for audit and drift detection
  reserved_after       int
  reference_type       str  ("order", "purchase_receipt", "return", "transfer", "manual")
  reference_id         uuid nullable
  reason               str  (required for ADJUSTMENT / DAMAGE / LOSS)
  created_by, created_at, notes
```

`on_hand_after` / `reserved_after` make the ledger self-verifying: any row whose snapshot disagrees with
the replayed sum indicates a bug or an out-of-band write.

## Public API of the service layer

```python
apply_transaction(*, branch, variant, transaction_type, quantity, actor,
                  reference_type="manual", reference_id=None, reason="",
                  unit_cost=None, notes="", allow_negative=False) -> InventoryTransaction

reserve(*, branch, lines, actor, reference_type, reference_id)            # lines: [(variant, qty)]
release_reservation(*, branch, lines, actor, reference_type, reference_id)
consume_reservation(*, branch, lines, actor, reference_type, reference_id)  # release + SALE, atomic
sell(*, branch, lines, actor, reference_type, reference_id)                 # direct SALE (POS)
receive_purchase(*, receipt, actor)                                         # PURCHASE + WAC update
restock_return(*, branch, lines, actor, reference_id)
adjust(*, branch, variant, new_on_hand, reason, actor)                      # stock count correction
write_off(*, branch, variant, quantity, transaction_type, reason, actor)    # DAMAGE / LOSS
transfer(*, source_branch, target_branch, lines, actor, notes="")
availability(*, branch, variants) -> dict[variant_id, AvailabilitySnapshot]
verify_integrity(*, branch=None) -> list[IntegrityIssue]
```

Every mutating function:

1. opens `transaction.atomic()`,
2. `select_for_update()`s the affected `Inventory` rows **ordered by `id`** (deadlock avoidance),
3. checks the invariant for the new state,
4. writes the ledger row(s),
5. updates the cached columns from the ledger delta,
6. emits low-stock notifications after commit (`transaction.on_commit`).

## Invariants

| Invariant | Enforced by |
|---|---|
| `on_hand ≥ 0` | service guard + `CheckConstraint inventory_inventory_on_hand_gte_0` |
| `reserved ≥ 0` | service guard + `CheckConstraint` |
| `reserved ≤ on_hand` unless overselling enabled | service guard (org config) |
| cached columns == ledger sum | `verify_integrity()`, nightly task, test suite |
| a reservation is consumed at most once | `consume_reservation` is keyed on `(reference_type, reference_id, variant)` and refuses a second pass |
| ledger rows are never updated or deleted | no service does it; `AppendOnlyModel` blocks `save()` on an existing row and `delete()` |

## Concurrency

The canonical race — two customers buying the last unit — is prevented by the row lock plus the guard:

```python
with transaction.atomic():
    inv = Inventory.objects.select_for_update().get(branch=b, variant=v)   # second txn blocks here
    if inv.available < qty and not allow_oversell:
        raise InsufficientStock(...)
    ...
```

`apps/api/tests/test_concurrency.py` proves this with real threads against PostgreSQL for:
oversell (POS vs POS, POS vs online), double-click checkout, duplicate webhook, reservation-expiry race,
and a return processed twice.

## Costing

Weighted average cost per branch × variant, updated **only** on receipt:

```text
new_average_cost = ((on_hand × average_cost) + (received_qty × unit_cost)) / (on_hand + received_qty)
```

Sale lines copy `average_cost` into `OrderItem.unit_cost` so historical COGS is frozen. See
[business-rules.md §4](../business-rules.md).

## Low stock

`Inventory.reorder_point` (default `RANGON_LOW_STOCK_THRESHOLD`) drives the admin low-stock list and a
`LOW_STOCK` notification emitted after any transaction that crosses the threshold downwards. Emission
happens in `on_commit`, so a rolled-back sale never notifies.

## What deliberately does not exist yet

- **Lot/serial tracking.** Cosmetics carry batch/expiry on the variant, which covers expiry reporting
  but not multi-lot cost layers. FIFO/lot costing would replace WAC — a schema change, so it is an
  explicit V2 decision, not an accident.
- **In-transit branch stock.** See business-rules §1.6.
- **Negative-stock reconciliation workflows.** Overselling is off by default; if it is turned on, a
  back-order/oversell report must be built before use.
