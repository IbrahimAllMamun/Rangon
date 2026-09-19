"""Read queries over purchasing that more than one caller needs."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, TypedDict

from purchasing.models import PurchaseReceiptItem, Supplier

#: How many of a supplier's products the order form is offered. A supplier's
#: range is a few dozen lines in practice; the cap keeps a long-standing one
#: from turning a dropdown into a catalogue.
SUPPLIER_PRODUCTS_LIMIT = 50


class LastDelivery(TypedDict):
    variant_id: Any
    last_cost: Decimal
    last_received_at: datetime


def supplier_products(
    *, supplier: Supplier, limit: int = SUPPLIER_PRODUCTS_LIMIT
) -> list[LastDelivery]:
    """What this supplier has delivered before, most recent first, and what it cost.

    Derived from receipts rather than kept on a link table. A remembered price
    is a second copy of a fact the receipts already hold, and the copy drifts:
    it is the reason there is no balance column on `Supplier` either
    (business-rules §4.2). A receipt line carries the cost *actually paid* --
    the figure the receive dialog lets a buyer correct -- so it is the right
    starting point for the next order, where `ProductVariant.cost` is only the
    last price paid to anyone.
    """
    latest = (
        PurchaseReceiptItem.objects.filter(purchase_order_item__purchase_order__supplier=supplier)
        # DISTINCT ON keeps the first row per variant, so the ordering after
        # the variant is what decides which delivery counts as the last one.
        .order_by("purchase_order_item__variant_id", "-receipt__received_at", "-created_at")
        .distinct("purchase_order_item__variant_id")
        .values_list("purchase_order_item__variant_id", "unit_cost", "receipt__received_at")
    )
    rows = sorted(latest, key=lambda row: row[2], reverse=True)[:limit]
    return [
        {"variant_id": variant_id, "last_cost": cost, "last_received_at": received_at}
        for variant_id, cost, received_at in rows
    ]
