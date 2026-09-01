"""Read queries over the inventory tables that more than one caller needs.

Kept out of `services.py` deliberately: everything in there writes, and mixing
the two makes it easy to reach for a service when a query would do.
"""

from __future__ import annotations

from typing import Any

from django.db.models import OuterRef, QuerySet, Subquery

from inventory.models import Inventory, StockException, StockExceptionStatus


def stock_exceptions(*, status: str | None = None) -> QuerySet[StockException]:
    """Oversell exceptions, newest first, ready to render.

    Annotates the *current* balance alongside the frozen one. Triage needs
    both: `on_hand_after` says how bad it was, `on_hand_now` says whether it
    still is — a hole that a delivery has already covered needs a different
    answer from one that is still open on the shelf.
    """
    queryset = StockException.objects.select_related(
        "branch", "variant", "variant__product", "resolved_by", "transaction"
    ).annotate(
        on_hand_now=Subquery(
            Inventory.objects.filter(
                branch_id=OuterRef("branch_id"), variant_id=OuterRef("variant_id")
            ).values("on_hand")[:1]
        )
    )
    if status:
        queryset = queryset.filter(status=status)
    return queryset.order_by("-created_at")


def open_exception_count(*, branch: Any = None) -> int:
    """How many holes nobody has looked at yet.

    Offline POS is only allowed to run while this is a number somebody is
    watching (docs/architecture/offline-pos.md), so it is surfaced rather than
    left to be counted on the page.
    """
    queryset = StockException.objects.filter(status=StockExceptionStatus.OPEN)
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    return queryset.count()


def in_transit(*, branch: Any = None, direction: str = "in") -> QuerySet[Any]:
    """Transfers that have left one shelf and not yet reached another.

    This is the stock the ledger deliberately cannot see: `TRANSFER_OUT` has
    been written, `TRANSFER_IN` has not. Nobody's `on_hand` includes it, which
    is correct — it is in a van — but somebody has to be able to look at it, or
    it is just missing.

    `direction` is from the given branch's point of view: `"in"` is what is
    coming, `"out"` is what has left and not landed.
    """
    from inventory.models import StockTransfer, TransferStatus

    queryset = StockTransfer.objects.filter(status=TransferStatus.IN_TRANSIT).select_related(
        "source_branch", "target_branch"
    )
    if branch is not None:
        field = "target_branch" if direction == "in" else "source_branch"
        queryset = queryset.filter(**{field: branch})
    return queryset.prefetch_related("items__variant__product").order_by("dispatched_at")


def in_transit_units(*, branch: Any) -> dict[str, int]:
    """variant id → units currently heading to `branch`.

    Used to answer "it is not on the shelf, but is it on its way?" on the
    inventory screen, without pretending the stock is available.
    """
    from django.db.models import Sum

    from inventory.models import StockTransferItem, TransferStatus

    rows = (
        StockTransferItem.objects.filter(
            transfer__status=TransferStatus.IN_TRANSIT, transfer__target_branch=branch
        )
        .values("variant_id")
        .annotate(units=Sum("quantity"))
    )
    return {str(row["variant_id"]): row["units"] for row in rows}
