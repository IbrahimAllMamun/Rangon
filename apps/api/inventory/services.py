"""Inventory engine — the only code allowed to move stock.

Every mutation:
  1. opens a transaction,
  2. locks the affected Inventory rows FOR UPDATE, ordered by pk (deadlock
     avoidance when a sale touches several variants),
  3. checks the invariant for the resulting state,
  4. appends ledger rows,
  5. updates the cached columns,
  6. schedules side effects (low-stock notification) for after commit.

docs/architecture/inventory.md · ADR-0004 · ADR-0006
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from accounts.models import Branch, User
from catalog.models import ProductVariant
from core import audit
from core.exceptions import Conflict, InsufficientStock, ValidationError
from core.money import quantize
from inventory.models import (
    REASON_REQUIRED,
    RESERVATION_AFFECTING,
    STOCK_AFFECTING,
    TRANSACTION_SIGN,
    Inventory,
    InventoryTransaction,
    StockException,
    StockExceptionResolution,
    StockExceptionStatus,
    TransactionType,
)

Line = tuple[Any, int]  # (variant or variant_id, quantity)


@dataclass(frozen=True)
class AvailabilitySnapshot:
    variant_id: str
    on_hand: int
    reserved: int
    available: int
    average_cost: Decimal

    @property
    def in_stock(self) -> bool:
        return self.available > 0


@dataclass(frozen=True)
class IntegrityIssue:
    inventory_id: str
    branch_code: str
    sku: str
    cached_on_hand: int
    ledger_on_hand: int
    cached_reserved: int
    ledger_reserved: int

    @property
    def on_hand_drift(self) -> int:
        return self.cached_on_hand - self.ledger_on_hand

    @property
    def reserved_drift(self) -> int:
        return self.cached_reserved - self.ledger_reserved


def _allow_oversell() -> bool:
    return bool(settings.RANGON["ALLOW_OVERSELL"])


def _variant_id(variant: Any) -> Any:
    return getattr(variant, "pk", variant)


def get_or_create_inventory(branch: Branch, variant: Any) -> Inventory:
    inventory, _ = Inventory.objects.get_or_create(
        branch=branch,
        variant_id=_variant_id(variant),
        defaults={"reorder_point": settings.RANGON["LOW_STOCK_THRESHOLD"]},
    )
    return inventory


def _lock_inventories(branch: Branch, variant_ids: Sequence[Any]) -> dict[Any, Inventory]:
    """Lock (creating if needed) one Inventory row per variant, ordered by pk.

    Consistent lock ordering is what stops two multi-line sales deadlocking on
    each other's rows.
    """
    unique_ids = list(dict.fromkeys(str(v) for v in variant_ids))
    for variant_id in unique_ids:
        Inventory.objects.get_or_create(
            branch=branch,
            variant_id=variant_id,
            defaults={"reorder_point": settings.RANGON["LOW_STOCK_THRESHOLD"]},
        )
    locked = (
        Inventory.objects.select_for_update()
        .filter(branch=branch, variant_id__in=unique_ids)
        .order_by("pk")
    )
    return {str(inv.variant_id): inv for inv in locked}


def _write_ledger(
    *,
    inventory: Inventory,
    transaction_type: str,
    delta: int,
    actor: User | None,
    reference_type: str,
    reference_id: Any,
    reason: str,
    notes: str,
    unit_cost: Decimal | None,
) -> InventoryTransaction:
    """Apply `delta` to the locked row and append the matching ledger entry."""
    if transaction_type in RESERVATION_AFFECTING:
        inventory.reserved += delta
    else:
        inventory.on_hand += delta

    inventory.save(update_fields=["on_hand", "reserved", "average_cost", "updated_at"])

    entry = InventoryTransaction.objects.create(
        branch=inventory.branch,
        variant_id=inventory.variant_id,
        transaction_type=transaction_type,
        quantity=delta,
        unit_cost=unit_cost,
        on_hand_after=inventory.on_hand,
        reserved_after=inventory.reserved,
        reference_type=reference_type or "manual",
        reference_id=str(reference_id) if reference_id else "",
        reason=reason,
        notes=notes,
        created_by=actor,
    )
    _raise_stock_exception(inventory=inventory, entry=entry, delta=delta)
    return entry


def _raise_stock_exception(
    *, inventory: Inventory, entry: InventoryTransaction, delta: int
) -> None:
    """Record a movement that left `on_hand` below zero.

    Every stock movement in the system funnels through `_write_ledger`, so this
    is the one place that can promise the guarantee offline POS depends on:
    stock cannot go negative without somebody being told
    (docs/architecture/offline-pos.md).

    Only *reductions* raise one. A receipt landing on an already-negative
    balance is the stock arriving to cover the hole, not a second hole, and
    flagging it would bury the original under noise.
    """
    if delta >= 0 or entry.transaction_type not in STOCK_AFFECTING:
        return
    if inventory.on_hand >= 0:
        return

    StockException.objects.create(
        branch=inventory.branch,
        variant_id=inventory.variant_id,
        transaction=entry,
        shortfall=abs(inventory.on_hand),
        on_hand_after=inventory.on_hand,
        reference_type=entry.reference_type,
        reference_id=entry.reference_id,
    )


def _check_can_reduce(inventory: Inventory, delta: int, *, allow_negative: bool) -> None:
    """Guard the two invariants before the row is written."""
    if delta >= 0:
        return
    if inventory.on_hand + delta < 0 and not (allow_negative or _allow_oversell()):
        raise InsufficientStock(
            f"Only {inventory.on_hand} unit(s) of {inventory.variant.sku} are in stock at "
            f"{inventory.branch.code}.",
            details={
                "variant_id": str(inventory.variant_id),
                "sku": inventory.variant.sku,
                "branch": inventory.branch.code,
                "requested": abs(delta),
                "on_hand": inventory.on_hand,
                "available": inventory.available,
            },
        )


def _check_can_reserve(inventory: Inventory, quantity: int, *, allow_negative: bool) -> None:
    if quantity <= 0:
        return
    if inventory.available < quantity and not (allow_negative or _allow_oversell()):
        raise InsufficientStock(
            f"Only {inventory.available} unit(s) of {inventory.variant.sku} are available at "
            f"{inventory.branch.code}.",
            details={
                "variant_id": str(inventory.variant_id),
                "sku": inventory.variant.sku,
                "branch": inventory.branch.code,
                "requested": quantity,
                "available": inventory.available,
            },
        )


def _schedule_low_stock_check(inventory: Inventory) -> None:
    """Notify after commit only — a rolled-back sale must not raise an alert."""
    if not inventory.is_low_stock:
        return
    inventory_id = str(inventory.pk)

    def _notify() -> None:
        from inventory.tasks import notify_low_stock

        notify_low_stock.delay(inventory_id)

    transaction.on_commit(_notify)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@transaction.atomic
def apply_transaction(
    *,
    branch: Branch,
    variant: Any,
    transaction_type: str,
    quantity: int,
    actor: User | None = None,
    reference_type: str = "manual",
    reference_id: Any = None,
    reason: str = "",
    notes: str = "",
    unit_cost: Decimal | None = None,
    allow_negative: bool = False,
) -> InventoryTransaction:
    """Apply a single stock movement.

    `quantity` is an absolute count for typed movements (the sign comes from
    the transaction type); for ADJUSTMENT it is the signed delta.
    """
    if transaction_type not in TransactionType.values:
        raise ValidationError(f"Unknown transaction type {transaction_type!r}.")
    if transaction_type in REASON_REQUIRED and not reason.strip():
        raise ValidationError(
            f"A reason is required for {transaction_type}.", details={"reason": ["Required."]}
        )

    sign = TRANSACTION_SIGN[transaction_type]
    if sign == 0:  # ADJUSTMENT: caller supplies the signed delta
        delta = int(quantity)
        if delta == 0:
            raise ValidationError("An adjustment of zero has no effect.")
    else:
        if quantity <= 0:
            raise ValidationError(f"Quantity must be positive for {transaction_type}.")
        delta = sign * int(quantity)

    inventories = _lock_inventories(branch, [_variant_id(variant)])
    inventory = inventories[str(_variant_id(variant))]

    if transaction_type in RESERVATION_AFFECTING:
        if delta > 0:
            _check_can_reserve(inventory, delta, allow_negative=allow_negative)
        elif inventory.reserved + delta < 0:
            # Releasing more than is reserved would corrupt the cache; clamp and
            # record what actually happened.
            delta = -inventory.reserved
            if delta == 0:
                return InventoryTransaction.objects.create(
                    branch=branch,
                    variant_id=_variant_id(variant),
                    transaction_type=transaction_type,
                    quantity=0,
                    on_hand_after=inventory.on_hand,
                    reserved_after=inventory.reserved,
                    reference_type=reference_type,
                    reference_id=str(reference_id) if reference_id else "",
                    reason=reason or "No reservation outstanding",
                    created_by=actor,
                )
    elif transaction_type in STOCK_AFFECTING:
        _check_can_reduce(inventory, delta, allow_negative=allow_negative)

    entry = _write_ledger(
        inventory=inventory,
        transaction_type=transaction_type,
        delta=delta,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        notes=notes,
        unit_cost=unit_cost,
    )
    _schedule_low_stock_check(inventory)
    return entry


@transaction.atomic
def reserve(
    *,
    branch: Branch,
    lines: Iterable[Line],
    actor: User | None = None,
    reference_type: str = "order",
    reference_id: Any = None,
) -> list[InventoryTransaction]:
    """Hold stock for an online order.  All-or-nothing."""
    return _bulk(
        branch=branch,
        lines=lines,
        transaction_type=TransactionType.RESERVATION,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
    )


@transaction.atomic
def release_reservation(
    *,
    branch: Branch,
    lines: Iterable[Line],
    actor: User | None = None,
    reference_type: str = "order",
    reference_id: Any = None,
    reason: str = "",
) -> list[InventoryTransaction]:
    return _bulk(
        branch=branch,
        lines=lines,
        transaction_type=TransactionType.RESERVATION_RELEASE,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
    )


@transaction.atomic
def consume_reservation(
    *,
    branch: Branch,
    lines: Iterable[Line],
    actor: User | None = None,
    reference_type: str = "order",
    reference_id: Any = None,
) -> list[InventoryTransaction]:
    """Turn a reservation into a sale: release then deduct, atomically.

    Idempotent per (reference, variant): if a SALE already exists for this
    reference the line is skipped, so a retried fulfilment cannot double-deduct.
    """
    entries: list[InventoryTransaction] = []
    materialised = [(_variant_id(v), int(q)) for v, q in lines if int(q) > 0]
    if not materialised:
        return entries

    already_sold = {
        str(variant_id)
        for variant_id in InventoryTransaction.objects.filter(
            reference_type=reference_type,
            reference_id=str(reference_id),
            transaction_type=TransactionType.SALE,
        ).values_list("variant_id", flat=True)
    }
    pending = [(v, q) for v, q in materialised if str(v) not in already_sold]
    if not pending:
        return entries

    inventories = _lock_inventories(branch, [v for v, _ in pending])

    for variant_id, quantity in pending:
        inventory = inventories[str(variant_id)]
        release_qty = min(quantity, inventory.reserved)
        if release_qty:
            entries.append(
                _write_ledger(
                    inventory=inventory,
                    transaction_type=TransactionType.RESERVATION_RELEASE,
                    delta=-release_qty,
                    actor=actor,
                    reference_type=reference_type,
                    reference_id=reference_id,
                    reason="Reservation consumed by fulfilment",
                    notes="",
                    unit_cost=None,
                )
            )
        _check_can_reduce(inventory, -quantity, allow_negative=False)
        entries.append(
            _write_ledger(
                inventory=inventory,
                transaction_type=TransactionType.SALE,
                delta=-quantity,
                actor=actor,
                reference_type=reference_type,
                reference_id=reference_id,
                reason="",
                notes="",
                unit_cost=inventory.average_cost,
            )
        )
        _schedule_low_stock_check(inventory)

    return entries


@transaction.atomic
def sell(
    *,
    branch: Branch,
    lines: Iterable[Line],
    actor: User | None = None,
    reference_type: str = "order",
    reference_id: Any = None,
) -> list[InventoryTransaction]:
    """Deduct stock immediately (POS: goods leave the shop at once)."""
    return _bulk(
        branch=branch,
        lines=lines,
        transaction_type=TransactionType.SALE,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        cost_from_average=True,
    )


@transaction.atomic
def restock_return(
    *,
    branch: Branch,
    lines: Iterable[Line],
    actor: User | None = None,
    reference_type: str = "return",
    reference_id: Any = None,
    reason: str = "Customer return restocked",
) -> list[InventoryTransaction]:
    return _bulk(
        branch=branch,
        lines=lines,
        transaction_type=TransactionType.RETURN,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        cost_from_average=True,
    )


def _bulk(
    *,
    branch: Branch,
    lines: Iterable[Line],
    transaction_type: str,
    actor: User | None,
    reference_type: str,
    reference_id: Any,
    reason: str = "",
    cost_from_average: bool = False,
) -> list[InventoryTransaction]:
    materialised = [(_variant_id(v), int(q)) for v, q in lines if int(q) != 0]
    if not materialised:
        return []

    inventories = _lock_inventories(branch, [v for v, _ in materialised])
    sign = TRANSACTION_SIGN[transaction_type]
    entries: list[InventoryTransaction] = []

    # Validate every line before writing any, so a partial batch is impossible.
    for variant_id, quantity in materialised:
        inventory = inventories[str(variant_id)]
        if transaction_type in RESERVATION_AFFECTING:
            if sign > 0:
                _check_can_reserve(inventory, quantity, allow_negative=False)
        else:
            _check_can_reduce(inventory, sign * quantity, allow_negative=False)

    for variant_id, quantity in materialised:
        inventory = inventories[str(variant_id)]
        delta = sign * quantity
        if transaction_type == TransactionType.RESERVATION_RELEASE:
            delta = -min(quantity, inventory.reserved)
            if delta == 0:
                continue
        entries.append(
            _write_ledger(
                inventory=inventory,
                transaction_type=transaction_type,
                delta=delta,
                actor=actor,
                reference_type=reference_type,
                reference_id=reference_id,
                reason=reason,
                notes="",
                unit_cost=inventory.average_cost if cost_from_average else None,
            )
        )
        _schedule_low_stock_check(inventory)

    return entries


@transaction.atomic
def receive_stock(
    *,
    branch: Branch,
    variant: Any,
    quantity: int,
    unit_cost: Decimal,
    actor: User | None = None,
    reference_type: str = "purchase_receipt",
    reference_id: Any = None,
    notes: str = "",
) -> InventoryTransaction:
    """Receive purchased stock and recalculate the weighted average cost.

    new_avg = ((on_hand * avg) + (qty * unit_cost)) / (on_hand + qty)
    """
    if quantity <= 0:
        raise ValidationError("Received quantity must be positive.")
    unit_cost = quantize(unit_cost)
    if unit_cost < 0:
        raise ValidationError("Unit cost cannot be negative.")

    variant_id = _variant_id(variant)
    inventory = _lock_inventories(branch, [variant_id])[str(variant_id)]

    previous_on_hand = max(inventory.on_hand, 0)
    total_units = previous_on_hand + quantity
    if total_units > 0:
        inventory.average_cost = quantize(
            ((Decimal(previous_on_hand) * inventory.average_cost) + (Decimal(quantity) * unit_cost))
            / Decimal(total_units)
        )
    else:  # pragma: no cover - defensive
        inventory.average_cost = unit_cost

    entry = _write_ledger(
        inventory=inventory,
        transaction_type=TransactionType.PURCHASE,
        delta=quantity,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason="",
        notes=notes,
        unit_cost=unit_cost,
    )

    # Keep the variant's "latest cost" in step for admin display; valuation and
    # profit always use Inventory.average_cost / OrderItem.unit_cost.
    ProductVariant.objects.filter(pk=variant_id).update(cost=unit_cost)
    return entry


@transaction.atomic
def adjust(
    *,
    branch: Branch,
    variant: Any,
    new_on_hand: int,
    reason: str,
    actor: User | None = None,
    reference_type: str = "manual",
    reference_id: Any = None,
) -> InventoryTransaction | None:
    """Correct stock to a counted figure by writing the difference."""
    if not reason.strip():
        raise ValidationError("A reason is required for an adjustment.")
    if new_on_hand < 0:
        raise ValidationError("Counted stock cannot be negative.")

    variant_id = _variant_id(variant)
    inventory = _lock_inventories(branch, [variant_id])[str(variant_id)]
    delta = new_on_hand - inventory.on_hand
    if delta == 0:
        return None

    before = {"on_hand": inventory.on_hand, "reserved": inventory.reserved}
    entry = _write_ledger(
        inventory=inventory,
        transaction_type=TransactionType.ADJUSTMENT,
        delta=delta,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        notes="",
        unit_cost=inventory.average_cost,
    )
    audit.record(
        action=audit.AuditAction.STOCK_ADJUSTMENT,
        entity=inventory,
        actor=actor,
        old_values=before,
        new_values={"on_hand": inventory.on_hand, "reserved": inventory.reserved},
        reason=reason,
        branch=branch,
    )
    _schedule_low_stock_check(inventory)
    return entry


@transaction.atomic
def write_off(
    *,
    branch: Branch,
    variant: Any,
    quantity: int,
    transaction_type: str,
    reason: str,
    actor: User | None = None,
    notes: str = "",
) -> InventoryTransaction:
    """Damage or loss.  Requires a reason and is audit-logged."""
    if transaction_type not in {TransactionType.DAMAGE, TransactionType.LOSS}:
        raise ValidationError("Write-off must be DAMAGE or LOSS.")
    entry = apply_transaction(
        branch=branch,
        variant=variant,
        transaction_type=transaction_type,
        quantity=quantity,
        actor=actor,
        reference_type="manual",
        reason=reason,
        notes=notes,
    )
    audit.record(
        action=audit.AuditAction.STOCK_ADJUSTMENT,
        entity_type="Inventory",
        entity_id=str(entry.variant_id),
        entity_label=f"{entry.variant.sku} @ {branch.code}",
        actor=actor,
        new_values={"type": transaction_type, "quantity": -quantity},
        reason=reason,
        branch=branch,
    )
    return entry


@transaction.atomic
def transfer(
    *,
    source_branch: Branch,
    target_branch: Branch,
    lines: Iterable[Line],
    actor: User | None = None,
    notes: str = "",
) -> Any:
    """Move stock between branches: TRANSFER_OUT + TRANSFER_IN in one transaction.

    Cost travels with the goods (ADR-0006), so each branch's margin stays honest.
    """
    from core.services import next_number
    from inventory.models import StockTransfer, StockTransferItem, TransferStatus

    if source_branch.pk == target_branch.pk:
        raise ValidationError("Source and destination branches must differ.")

    materialised = [(_variant_id(v), int(q)) for v, q in lines if int(q) > 0]
    if not materialised:
        raise ValidationError("A transfer needs at least one line.")

    stock_transfer = StockTransfer.objects.create(
        number=next_number("stock_transfer", prefix="TRF"),
        source_branch=source_branch,
        target_branch=target_branch,
        status=TransferStatus.RECEIVED,
        notes=notes,
        created_by=actor,
    )

    source_locks = _lock_inventories(source_branch, [v for v, _ in materialised])
    for variant_id, quantity in materialised:
        _check_can_reduce(source_locks[str(variant_id)], -quantity, allow_negative=False)

    for variant_id, quantity in materialised:
        source_inventory = source_locks[str(variant_id)]
        unit_cost = source_inventory.average_cost

        StockTransferItem.objects.create(
            transfer=stock_transfer,
            variant_id=variant_id,
            quantity=quantity,
            unit_cost=unit_cost,
        )
        _write_ledger(
            inventory=source_inventory,
            transaction_type=TransactionType.TRANSFER_OUT,
            delta=-quantity,
            actor=actor,
            reference_type="stock_transfer",
            reference_id=stock_transfer.pk,
            reason="",
            notes=notes,
            unit_cost=unit_cost,
        )
        _schedule_low_stock_check(source_inventory)

        # Receiving side: weighted average at the destination.
        receive_stock(
            branch=target_branch,
            variant=variant_id,
            quantity=quantity,
            unit_cost=unit_cost,
            actor=actor,
            reference_type="stock_transfer",
            reference_id=stock_transfer.pk,
            notes=notes,
        )
        InventoryTransaction.objects.filter(
            reference_type="stock_transfer",
            reference_id=str(stock_transfer.pk),
            variant_id=variant_id,
            transaction_type=TransactionType.PURCHASE,
        ).update(transaction_type=TransactionType.TRANSFER_IN)

    audit.record(
        action=audit.AuditAction.STOCK_TRANSFER,
        entity=stock_transfer,
        actor=actor,
        new_values={
            "from": source_branch.code,
            "to": target_branch.code,
            "lines": len(materialised),
        },
        reason=notes,
        branch=source_branch,
    )
    return stock_transfer


def availability(*, branch: Branch, variants: Sequence[Any]) -> dict[str, AvailabilitySnapshot]:
    """Read-only stock snapshot for a set of variants (no locking)."""
    variant_ids = [str(_variant_id(v)) for v in variants]
    rows = Inventory.objects.filter(branch=branch, variant_id__in=variant_ids)
    snapshots = {
        str(row.variant_id): AvailabilitySnapshot(
            variant_id=str(row.variant_id),
            on_hand=row.on_hand,
            reserved=row.reserved,
            available=row.available,
            average_cost=row.average_cost,
        )
        for row in rows
    }
    for variant_id in variant_ids:  # variants never stocked read as zero
        snapshots.setdefault(
            variant_id,
            AvailabilitySnapshot(variant_id, 0, 0, 0, Decimal("0.00")),
        )
    return snapshots


def check_availability(*, branch: Branch, lines: Iterable[Line]) -> None:
    """Fail fast before doing expensive work.  Not a substitute for the lock."""
    materialised = [(str(_variant_id(v)), int(q)) for v, q in lines]
    snapshots = availability(branch=branch, variants=[v for v, _ in materialised])
    if _allow_oversell():
        return
    for variant_id, quantity in materialised:
        snapshot = snapshots[variant_id]
        if snapshot.available < quantity:
            variant = ProductVariant.objects.filter(pk=variant_id).first()
            raise InsufficientStock(
                f"Only {snapshot.available} unit(s) of "
                f"{variant.sku if variant else variant_id} are available.",
                details={
                    "variant_id": variant_id,
                    "sku": variant.sku if variant else "",
                    "requested": quantity,
                    "available": snapshot.available,
                },
            )


def verify_integrity(*, branch: Branch | None = None) -> list[IntegrityIssue]:
    """Replay the ledger and report any drift from the cached columns.

    Runs nightly (inventory.tasks.verify_inventory_integrity) and in the test
    suite after every scenario.
    """
    inventories = Inventory.objects.select_related("branch", "variant")
    ledger_qs = InventoryTransaction.objects.all()
    if branch is not None:
        inventories = inventories.filter(branch=branch)
        ledger_qs = ledger_qs.filter(branch=branch)

    ledger = ledger_qs.values("branch_id", "variant_id").annotate(
        on_hand=Sum("quantity", filter=~Q(transaction_type__in=RESERVATION_AFFECTING)),
        reserved=Sum("quantity", filter=Q(transaction_type__in=RESERVATION_AFFECTING)),
    )
    totals = {
        (str(row["branch_id"]), str(row["variant_id"])): (
            row["on_hand"] or 0,
            row["reserved"] or 0,
        )
        for row in ledger
    }

    issues: list[IntegrityIssue] = []
    for inventory in inventories:
        key = (str(inventory.branch_id), str(inventory.variant_id))
        ledger_on_hand, ledger_reserved = totals.get(key, (0, 0))
        if inventory.on_hand != ledger_on_hand or inventory.reserved != ledger_reserved:
            issues.append(
                IntegrityIssue(
                    inventory_id=str(inventory.pk),
                    branch_code=inventory.branch.code,
                    sku=inventory.variant.sku,
                    cached_on_hand=inventory.on_hand,
                    ledger_on_hand=ledger_on_hand,
                    cached_reserved=inventory.reserved,
                    ledger_reserved=ledger_reserved,
                )
            )
    return issues


@transaction.atomic
def repair_drift(*, issue: IntegrityIssue, actor: User | None = None, reason: str) -> None:
    """Reconcile a drifted cache with the ledger.

    Drift means something wrote the cached column without a ledger row — a bug,
    or an out-of-band UPDATE.  The *physical* count is assumed to match the
    cache (that is what staff have been looking at), so the repair appends
    ledger rows that explain the difference rather than silently rewriting the
    cache.  The ledger itself is never edited.
    """
    inventory = Inventory.objects.select_for_update().get(pk=issue.inventory_id)

    unexplained_on_hand = inventory.on_hand - issue.ledger_on_hand
    if unexplained_on_hand:
        InventoryTransaction.objects.create(
            branch=inventory.branch,
            variant_id=inventory.variant_id,
            transaction_type=TransactionType.ADJUSTMENT,
            quantity=unexplained_on_hand,
            unit_cost=inventory.average_cost,
            on_hand_after=inventory.on_hand,  # cache is unchanged by this row
            reserved_after=inventory.reserved,
            reference_type="integrity_repair",
            reference_id=str(inventory.pk),
            reason=reason,
            notes="Ledger reconciliation: stock present but never recorded as a movement.",
            created_by=actor,
        )

    unexplained_reserved = inventory.reserved - issue.ledger_reserved
    if unexplained_reserved:
        InventoryTransaction.objects.create(
            branch=inventory.branch,
            variant_id=inventory.variant_id,
            transaction_type=(
                TransactionType.RESERVATION
                if unexplained_reserved > 0
                else TransactionType.RESERVATION_RELEASE
            ),
            quantity=unexplained_reserved,
            on_hand_after=inventory.on_hand,
            reserved_after=inventory.reserved,
            reference_type="integrity_repair",
            reference_id=str(inventory.pk),
            reason=reason,
            notes="Ledger reconciliation: reservation cache did not match the ledger.",
            created_by=actor,
        )

    audit.record(
        action=audit.AuditAction.STOCK_ADJUSTMENT,
        entity=inventory,
        actor=actor,
        old_values={
            "ledger_on_hand": issue.ledger_on_hand,
            "ledger_reserved": issue.ledger_reserved,
        },
        new_values={"on_hand": inventory.on_hand, "reserved": inventory.reserved},
        reason=reason,
        branch=inventory.branch,
    )


# ---------------------------------------------------------------------------
# Stock exceptions
# ---------------------------------------------------------------------------


@transaction.atomic
def resolve_stock_exception(
    *,
    exception: StockException,
    resolution: str,
    note: str,
    actor: User | None = None,
) -> StockException:
    """Close an oversell exception, with a reason that is not optional.

    Resolving does not touch stock. If the shortfall needs correcting, that is
    a receipt, a write-off or a stock count -- each of which writes its own
    ledger row. This only records that a human looked at the hole and said what
    it was, which is the whole guarantee offline POS is allowed to rely on.
    """
    locked = StockException.objects.select_for_update().get(pk=exception.pk)
    if locked.status == StockExceptionStatus.RESOLVED:
        raise Conflict("That exception has already been resolved.")
    if resolution not in StockExceptionResolution.values:
        raise ValidationError(
            f"Unknown resolution {resolution!r}.",
            details={
                "resolution": [f"Choose one of {', '.join(StockExceptionResolution.values)}."]
            },
        )
    if not note.strip():
        raise ValidationError(
            "Say what was done about it.",
            details={"note": ["Required — an unexplained resolution explains nothing."]},
        )

    locked.status = StockExceptionStatus.RESOLVED
    locked.resolution = resolution
    locked.resolution_note = note.strip()
    locked.resolved_at = timezone.now()
    locked.resolved_by = actor if actor is not None and actor.is_authenticated else None
    locked.save(
        update_fields=[
            "status",
            "resolution",
            "resolution_note",
            "resolved_at",
            "resolved_by",
            "updated_at",
        ]
    )

    audit.record(
        action=audit.AuditAction.STOCK_ADJUSTMENT,
        entity=locked,
        actor=actor,
        old_values={"status": StockExceptionStatus.OPEN},
        new_values={"status": locked.status, "resolution": resolution},
        reason=locked.resolution_note,
        branch=locked.branch,
    )
    return locked
