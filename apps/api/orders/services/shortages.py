"""Online orders left short when the counter sells their reserved stock (§1.4, D115).

With the organisation's `counter_sells_reserved` on, a counter sale may take
units an online order has reserved: the customer in the shop is served, and the
shelf can no longer cover every reservation (`available` goes negative). The
orders that lost their units are flagged here, inside the sale's transaction --
an entry on their timeline that staff see and the customer does not, and a
notice to everyone who handles orders at the branch -- so someone restocks or
calls the customer before the order is packed. The reservation itself stays:
the order still has its claim, and stock received later covers it.

Which orders: the oldest keep first claim on the shelf, so the newest are
short first. Only the units this sale took are flagged; a shortfall that was
already there was flagged by the sale that caused it.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from django.db.models import Sum

from accounts.models import Branch
from inventory.models import Inventory, InventoryTransaction, TransactionType
from notifications import services as notification_services
from notifications.models import NotificationLevel, NotificationType
from orders.models import Order, OrderEventType
from orders.services.lifecycle import log_event


def _held_by_order(branch: Branch, variant_id: Any) -> dict[str, int]:
    """Each order's net reservation of the variant at the branch, from the ledger."""
    rows = (
        InventoryTransaction.objects.filter(
            branch=branch,
            variant_id=variant_id,
            reference_type="order",
            transaction_type__in=[
                TransactionType.RESERVATION,
                TransactionType.RESERVATION_RELEASE,
            ],
        )
        .values("reference_id")
        .annotate(held=Sum("quantity"))
        .filter(held__gt=0)
    )
    return {row["reference_id"]: int(row["held"]) for row in rows}


def flag_short_orders(
    *,
    branch: Branch,
    lines: Iterable[tuple[Any, int]],
    sale: Order,
    actor: Any = None,
) -> list[Order]:
    """Flag the online orders a counter sale left short. Call after `sell`, in its transaction."""
    sold: dict[str, int] = {}
    for variant_id, quantity in lines:
        sold[str(variant_id)] = sold.get(str(variant_id), 0) + int(quantity)
    inventories = Inventory.objects.select_related("variant").filter(
        branch=branch, variant_id__in=list(sold)
    )
    flagged: list[Order] = []
    for inventory in inventories:
        short_after = max(0, -inventory.available)
        short_before = max(0, -(inventory.available + sold[str(inventory.variant_id)]))
        if short_after <= short_before:
            continue
        held = _held_by_order(branch, inventory.variant_id)
        orders = Order.objects.filter(pk__in=list(held)).order_by("-placed_at", "-created_at")
        # Walk newest first: the first `short_before` units were already short.
        covered = 0
        for order in orders:
            if covered >= short_after:
                break
            units = held[str(order.pk)]
            start, end = covered, covered + units
            covered = end
            lost = min(end, short_after) - max(start, short_before)
            if lost <= 0:
                continue
            sku = inventory.variant.sku
            log_event(
                order,
                OrderEventType.STOCK_SHORT,
                f"{lost} × {sku} reserved for this order was sold at the counter "
                f"({sale.number}). Restock or contact the customer before packing.",
                data={"sku": sku, "short": lost, "counter_sale": sale.number},
                actor=actor,
                customer_visible=False,
            )
            notification_services.notify_staff(
                notification_type=NotificationType.ORDER_STOCK_SHORT,
                title=f"Order {order.number} is short {lost} × {sku}",
                body=(
                    f"The counter sold units reserved for this order ({sale.number}) at "
                    f"{branch.code}. Restock or contact the customer before packing."
                ),
                permission_code="orders.view",
                branch=branch,
                link=f"/admin/orders/{order.pk}",
                level=NotificationLevel.WARNING,
                data={"order": order.number, "sku": sku, "short": lost},
            )
            flagged.append(order)
    return flagged
