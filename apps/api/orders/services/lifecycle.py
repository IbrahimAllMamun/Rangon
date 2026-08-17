"""Order status machine and its stock side effects.

Every transition goes through transition(); nothing sets Order.status directly.
docs/architecture/orders.md §5.1
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone

from core import audit
from core.exceptions import Conflict, InvalidStatusTransition
from inventory import services as inventory_services
from orders.models import Order, OrderEvent, OrderEventType, OrderStatus

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    OrderStatus.PENDING: {OrderStatus.CONFIRMED, OrderStatus.CANCELLED},
    OrderStatus.CONFIRMED: {OrderStatus.PROCESSING, OrderStatus.CANCELLED},
    OrderStatus.PROCESSING: {OrderStatus.PACKED, OrderStatus.CANCELLED},
    OrderStatus.PACKED: {OrderStatus.SHIPPED, OrderStatus.DELIVERED},
    OrderStatus.SHIPPED: {OrderStatus.DELIVERED, OrderStatus.RETURN_REQUESTED},
    OrderStatus.DELIVERED: {OrderStatus.RETURN_REQUESTED},
    OrderStatus.RETURN_REQUESTED: {OrderStatus.RETURNED, OrderStatus.DELIVERED},
    OrderStatus.RETURNED: {OrderStatus.REFUNDED},
    OrderStatus.REFUNDED: set(),
    OrderStatus.CANCELLED: set(),
}

TIMESTAMP_FIELDS = {
    OrderStatus.CONFIRMED: "confirmed_at",
    OrderStatus.PACKED: "packed_at",
    OrderStatus.SHIPPED: "shipped_at",
    OrderStatus.DELIVERED: "delivered_at",
    OrderStatus.CANCELLED: "cancelled_at",
}


def can_transition(from_status: str, to_status: str) -> bool:
    return to_status in ALLOWED_TRANSITIONS.get(from_status, set())


def log_event(
    order: Order,
    event_type: str,
    message: str = "",
    *,
    data: dict[str, Any] | None = None,
    actor: Any = None,
    customer_visible: bool = True,
) -> OrderEvent:
    return OrderEvent.objects.create(
        order=order,
        event_type=event_type,
        message=message[:255],
        data=data or {},
        actor=actor,
        is_customer_visible=customer_visible,
    )


def _order_lines(order: Order) -> list[tuple[Any, int]]:
    return [(item.variant_id, item.quantity) for item in order.items.all()]


@transaction.atomic
def transition(
    *,
    order: Order,
    to_status: str,
    actor: Any = None,
    reason: str = "",
    notify: bool = True,
) -> Order:
    """Move an order to `to_status`, applying that edge's stock side effect."""
    order = Order.objects.select_for_update().get(pk=order.pk)
    from_status = order.status

    if from_status == to_status:
        return order
    if not can_transition(from_status, to_status):
        raise InvalidStatusTransition(
            f"An order cannot go from {from_status} to {to_status}.",
            details={"from": from_status, "to": to_status},
        )

    # --- stock side effects ------------------------------------------------
    if to_status == OrderStatus.PACKED and not order.stock_committed:
        # The goods physically leave the shelf now: reservation becomes a sale.
        inventory_services.consume_reservation(
            branch=order.branch,
            lines=_order_lines(order),
            actor=actor,
            reference_type="order",
            reference_id=order.pk,
        )
        order.stock_committed = True
        log_event(
            order,
            OrderEventType.STOCK_COMMITTED,
            "Stock deducted for dispatch",
            actor=actor,
            customer_visible=False,
        )

    if to_status == OrderStatus.CANCELLED:
        if order.stock_committed:
            raise Conflict(
                "Stock has already left the shelf for this order; process a return instead of "
                "cancelling."
            )
        inventory_services.release_reservation(
            branch=order.branch,
            lines=_order_lines(order),
            actor=actor,
            reference_type="order",
            reference_id=order.pk,
            reason=reason or "Order cancelled",
        )
        log_event(
            order,
            OrderEventType.STOCK_RELEASED,
            "Reserved stock released",
            actor=actor,
            customer_visible=False,
        )
        from promotions import services as promotion_services

        promotion_services.release(order=order, reason=reason or "Order cancelled")
        order.cancel_reason = reason[:255]

    # --- apply -------------------------------------------------------------
    order.status = to_status
    update_fields = ["status", "stock_committed", "cancel_reason", "updated_at"]
    stamp = TIMESTAMP_FIELDS.get(to_status)
    if stamp:
        setattr(order, stamp, timezone.now())
        update_fields.append(stamp)
    order.save(update_fields=update_fields)

    log_event(
        order,
        OrderEventType.CANCELLED
        if to_status == OrderStatus.CANCELLED
        else OrderEventType.STATUS_CHANGED,
        f"{from_status} → {to_status}",
        data={"from": from_status, "to": to_status, "reason": reason},
        actor=actor,
    )
    audit.record(
        action=(
            audit.AuditAction.ORDER_CANCELLED
            if to_status == OrderStatus.CANCELLED
            else audit.AuditAction.ORDER_STATUS_CHANGED
        ),
        entity=order,
        actor=actor,
        old_values={"status": from_status},
        new_values={"status": to_status},
        reason=reason,
        branch=order.branch,
    )

    if notify:
        _notify_status(order, to_status)
    return order


def _notify_status(order: Order, to_status: str) -> None:
    from notifications import services as notification_services

    mapping = {
        OrderStatus.SHIPPED: ("ORDER_SHIPPED", "Your order is on the way"),
        OrderStatus.DELIVERED: ("ORDER_DELIVERED", "Your order has been delivered"),
    }
    if to_status not in mapping:
        return
    notification_type, title = mapping[to_status]

    def _send() -> None:
        notification_services.notify_customer(
            order=order, notification_type=notification_type, title=title
        )

    transaction.on_commit(_send)


@transaction.atomic
def cancel_order(*, order: Order, actor: Any = None, reason: str = "") -> Order:
    """Cancel and, if money was taken, refund it.  Never deletes the order."""
    from orders.services import payments as payment_services

    if not order.is_cancellable:
        raise Conflict(f"An order in status {order.status} cannot be cancelled.")

    order = transition(order=order, to_status=OrderStatus.CANCELLED, actor=actor, reason=reason)

    if order.paid_total > 0:
        payment_services.refund_order(
            order=order,
            amount=order.paid_total - order.refunded_total,
            actor=actor,
            reason=reason or "Order cancelled",
        )
    return order
