"""Barcode labels: which variants a branch has finished labelling.

The label screen shows every variant of a product beside the stock it has at
the branch, which is the hint for how many stickers each one needs, and lets
the person printing tick off the variants that are done. This module reads that
state and writes the ticks.

Nothing here moves stock. ``LabelPrint`` sits beside the ledger, not in it, and
is append-only for the same reason the ledger is: an un-mark is a new row, never
an edit, so a mark is never lost.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.db.models import Q, Sum

from accounts.models import Branch, User
from catalog.models import Product, ProductVariant
from core.exceptions import ValidationError
from inventory.models import Inventory, InventoryTransaction, LabelPrint, TransactionType

#: The most stickers one mark may claim -- the label screen's own ceiling per
#: variant, so a typo of 5000 is refused rather than recorded.
MAX_LABELS = 500

#: Movements that bring units in **without** one of this shop's labels.
#:
#: A purchase is new stock off a supplier's van. A transfer is deliberately not
#: here: it moves stock this shop has already labelled -- same barcode, same
#: shop name -- from one branch to another. Customer returns come back with the
#: sticker they left with, and a counted surplus was already on the rail.
UNLABELLED_INBOUND = (TransactionType.PURCHASE,)


@dataclass(frozen=True)
class LabelMark:
    """One variant's tick, as the caller states it."""

    variant_id: Any
    printed: bool
    quantity: int = 0


def latest_marks(*, branch: Branch, variant_ids: Sequence[Any]) -> dict[str, LabelPrint]:
    """The newest mark per variant at ``branch``: the state the screen shows.

    A variant nobody has ever marked has no entry. One query, whatever the
    number of variants or of marks behind them: PostgreSQL's ``DISTINCT ON``
    keeps the first row of each variant in the stated order, which is the
    newest, and the ``(branch, variant, -created_at)`` index serves it.
    """
    if not variant_ids:
        return {}
    rows = (
        LabelPrint.objects.filter(branch=branch, variant_id__in=list(variant_ids))
        .select_related("created_by")
        .order_by("variant_id", "-created_at")
        .distinct("variant_id")
    )
    return {str(row.variant_id): row for row in rows}


def received_since(*, branch: Branch, marks: dict[str, LabelPrint]) -> dict[str, int]:
    """Units purchased into ``branch`` after each variant's labels were printed.

    This is what tells a "done" variant that it is not done any more: twelve
    labelled, then a delivery of twenty, and those twenty have no stickers.
    Read from the ledger rather than from ``on_hand``, which sales pull down
    and so cannot tell a delivery from a quiet week.

    One query for the whole product, each variant measured from its own mark.
    """
    printed = {variant_id: mark for variant_id, mark in marks.items() if mark.printed}
    if not printed:
        return {}
    after_mark = Q()
    for variant_id, mark in printed.items():
        after_mark |= Q(variant_id=variant_id, created_at__gt=mark.created_at)
    rows = (
        InventoryTransaction.objects.filter(branch=branch, transaction_type__in=UNLABELLED_INBOUND)
        .filter(after_mark)
        .values("variant_id")
        .annotate(total=Sum("quantity"))
    )
    return {str(row["variant_id"]): int(row["total"] or 0) for row in rows}


def suggested_labels(*, on_hand: int, mark: LabelPrint | None, received: int) -> int:
    """How many stickers the screen offers to print for a variant.

    Never marked, or un-marked: one per unit on hand. Marked printed: one per
    unit delivered since, but never more than are on hand -- what sold in the
    meantime has left the shop and needs no sticker. Negative stock (an
    oversell) needs none at all.
    """
    stock = max(on_hand, 0)
    if mark is None or not mark.printed:
        return min(stock, MAX_LABELS)
    return min(received, stock, MAX_LABELS)


def mark_labels(
    *,
    branch: Branch,
    product: Product,
    marks: Sequence[LabelMark],
    actor: User | None = None,
) -> list[LabelPrint]:
    """Record that labels for some of ``product``'s variants are, or are not, done.

    Every variant must belong to ``product``: the screen marks one product's
    variants at a time, and a stray id is a client fault, not a mark to keep.
    All or nothing, so a bulk "mark the sheet as printed" never half-applies.

    ``on_hand`` is taken from the branch's stock row here, not from the
    request. No lock: nothing is protected by it. Two people marking the same
    variant at once both get a row, and the newer is the state -- exactly what
    either of them would see if they had marked one after the other.
    """
    if not marks:
        raise ValidationError("Choose at least one variant to mark.")

    wanted = [str(mark.variant_id) for mark in marks]
    if len(set(wanted)) != len(wanted):
        raise ValidationError("Each variant may be marked once per request.")
    for mark in marks:
        if mark.quantity < 0 or mark.quantity > MAX_LABELS:
            raise ValidationError(
                f"Labels printed must be between 0 and {MAX_LABELS}.",
                details={"variant": str(mark.variant_id)},
            )

    owned = {
        str(pk)
        for pk in ProductVariant.objects.filter(product=product, pk__in=wanted).values_list(
            "pk", flat=True
        )
    }
    stray = [variant_id for variant_id in wanted if variant_id not in owned]
    if stray:
        raise ValidationError(
            "Some of those variants are not part of this product.",
            details={"variants": stray},
        )

    stock = dict(
        Inventory.objects.filter(branch=branch, variant_id__in=wanted).values_list(
            "variant_id", "on_hand"
        )
    )
    on_hand = {str(variant_id): value for variant_id, value in stock.items()}

    with transaction.atomic():
        return [
            LabelPrint.objects.create(
                branch=branch,
                variant_id=mark.variant_id,
                printed=mark.printed,
                # An un-mark printed nothing; keeping a count on it would read
                # as a print run that never happened.
                quantity=mark.quantity if mark.printed else 0,
                on_hand=on_hand.get(str(mark.variant_id), 0),
                created_by=actor,
            )
            for mark in marks
        ]
