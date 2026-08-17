"""Returns and refunds.

    REQUESTED -> APPROVED -> RECEIVED -> COMPLETED
              -> REJECTED

The original order and its payments are never edited or deleted; a return is a
separate record referencing them (docs/business-rules.md §2).
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import audit
from core.exceptions import Conflict, PermissionDenied, ValidationError
from core.money import ZERO, quantize
from core.services import next_number
from inventory import services as inventory_services
from orders.models import (
    Order,
    OrderEventType,
    OrderItem,
    OrderStatus,
    RestockDecision,
    ReturnItem,
    ReturnRequest,
    ReturnStatus,
)
from orders.services import payments as payment_services
from orders.services.lifecycle import log_event, transition

#: Reasons where the shop, not the customer, is at fault — shipping is refunded.
SHOP_FAULT_REASONS = {"DEFECTIVE", "WRONG_PRODUCT", "DAMAGED"}


def _within_return_window(order: Order) -> bool:
    reference = order.delivered_at or order.placed_at
    window = timedelta(days=int(settings.RANGON["RETURN_WINDOW_DAYS"]))
    return timezone.now() <= reference + window


@transaction.atomic
def request_return(
    *,
    order: Order,
    lines: list[tuple[Any, int]],
    reason: str,
    actor: Any = None,
    customer_comment: str = "",
    restock_decisions: dict[str, str] | None = None,
) -> ReturnRequest:
    """Open a return request for specific order lines."""
    order = Order.objects.select_for_update().get(pk=order.pk)

    if order.status in {OrderStatus.CANCELLED, OrderStatus.REFUNDED}:
        raise Conflict(f"An order in status {order.status} cannot be returned.")
    if not order.stock_committed and order.channel != "POS":
        raise Conflict("The goods have not been dispatched yet — cancel the order instead.")
    if not lines:
        raise ValidationError("Select at least one item to return.")

    if not _within_return_window(order):
        approver = actor
        if approver is None or not approver.has_perm_code("sales.refund_override"):
            raise PermissionDenied(
                f"The {settings.RANGON['RETURN_WINDOW_DAYS']}-day return window has passed. "
                "A manager can override this."
            )

    items = {
        str(item.pk): item for item in OrderItem.objects.select_for_update().filter(order=order)
    }
    restock_decisions = restock_decisions or {}

    request = ReturnRequest.objects.create(
        number=next_number("return", prefix="RET"),
        order=order,
        status=ReturnStatus.REQUESTED,
        reason=reason,
        customer_comment=customer_comment,
        requested_by=actor if actor and getattr(actor, "is_authenticated", False) else None,
        refund_shipping=reason in SHOP_FAULT_REASONS,
    )

    refund_total = ZERO
    for item_id, quantity in lines:
        quantity = int(quantity)
        item = items.get(str(item_id))
        if item is None:
            raise ValidationError(f"Line {item_id} does not belong to {order.number}.")
        if quantity <= 0:
            raise ValidationError("Return quantity must be positive.")
        if quantity > item.returnable_quantity:
            raise ValidationError(
                f"Only {item.returnable_quantity} of {item.sku} can still be returned.",
                details={
                    "order_item_id": str(item.pk),
                    "requested": quantity,
                    "returnable": item.returnable_quantity,
                },
            )
        if item.variant.product.is_final_sale:
            raise ValidationError(
                f"{item.product_name} is a final-sale item and cannot be returned."
            )

        # Refund the price actually paid for that line, discount included.
        unit_net = quantize(item.line_total / item.quantity)
        line_refund = quantize(unit_net * quantity)
        refund_total += line_refund

        ReturnItem.objects.create(
            return_request=request,
            order_item=item,
            quantity=quantity,
            restock_decision=restock_decisions.get(str(item_id), RestockDecision.RESTOCK),
            refund_amount=line_refund,
        )

    if request.refund_shipping:
        refund_total += order.shipping_total

    request.refund_amount = quantize(min(refund_total, order.paid_total - order.refunded_total))
    request.save(update_fields=["refund_amount", "updated_at"])

    log_event(
        order,
        OrderEventType.RETURN_REQUESTED,
        f"Return {request.number} requested ({reason})",
        data={"return_id": str(request.pk), "amount": str(request.refund_amount)},
        actor=actor,
    )
    if order.status in {OrderStatus.DELIVERED, OrderStatus.SHIPPED}:
        transition(
            order=order,
            to_status=OrderStatus.RETURN_REQUESTED,
            actor=actor,
            reason=f"Return {request.number}",
            notify=False,
        )

    from notifications import services as notification_services

    transaction.on_commit(
        lambda: notification_services.notify_staff(
            notification_type="RETURN_REQUESTED",
            title=f"Return requested for {order.number}",
            body=f"{request.number}: {reason}",
            permission_code="sales.refund",
            branch=order.branch,
            link=f"/admin/returns/{request.pk}",
        )
    )
    return request


@transaction.atomic
def approve(
    *, return_request: ReturnRequest, actor: Any = None, comment: str = ""
) -> ReturnRequest:
    return_request = ReturnRequest.objects.select_for_update().get(pk=return_request.pk)
    if return_request.status != ReturnStatus.REQUESTED:
        raise Conflict(f"A {return_request.status} return cannot be approved.")

    return_request.status = ReturnStatus.APPROVED
    return_request.approved_by = actor
    return_request.approved_at = timezone.now()
    return_request.staff_comment = comment
    return_request.save(
        update_fields=["status", "approved_by", "approved_at", "staff_comment", "updated_at"]
    )
    log_event(
        return_request.order,
        OrderEventType.RETURN_UPDATED,
        f"Return {return_request.number} approved",
        actor=actor,
    )
    return return_request


@transaction.atomic
def reject(*, return_request: ReturnRequest, actor: Any = None, comment: str = "") -> ReturnRequest:
    return_request = ReturnRequest.objects.select_for_update().get(pk=return_request.pk)
    if return_request.status not in {ReturnStatus.REQUESTED, ReturnStatus.APPROVED}:
        raise Conflict(f"A {return_request.status} return cannot be rejected.")

    return_request.status = ReturnStatus.REJECTED
    return_request.staff_comment = comment
    return_request.save(update_fields=["status", "staff_comment", "updated_at"])

    order = return_request.order
    if order.status == OrderStatus.RETURN_REQUESTED:
        transition(
            order=order,
            to_status=OrderStatus.DELIVERED,
            actor=actor,
            reason=f"Return {return_request.number} rejected",
            notify=False,
        )
    log_event(
        order,
        OrderEventType.RETURN_UPDATED,
        f"Return {return_request.number} rejected: {comment}",
        actor=actor,
    )
    return return_request


@transaction.atomic
def receive(*, return_request: ReturnRequest, actor: Any = None) -> ReturnRequest:
    """Goods are physically back.  RESTOCK lines go back into sellable stock;
    DAMAGED and QUARANTINE lines do not (docs/business-rules.md §2.3)."""
    return_request = ReturnRequest.objects.select_for_update().get(pk=return_request.pk)
    if return_request.status != ReturnStatus.APPROVED:
        raise Conflict("Only an approved return can be received.")

    order = return_request.order
    restock_lines = [
        (item.order_item.variant_id, item.quantity)
        for item in return_request.items.select_related("order_item")
        if item.restock_decision == RestockDecision.RESTOCK
    ]
    if restock_lines:
        inventory_services.restock_return(
            branch=order.branch,
            lines=restock_lines,
            actor=actor,
            reference_type="return",
            reference_id=return_request.pk,
            reason=f"Return {return_request.number} restocked",
        )

    for item in return_request.items.select_related("order_item"):
        order_item = OrderItem.objects.select_for_update().get(pk=item.order_item_id)
        order_item.returned_quantity += item.quantity
        order_item.save(update_fields=["returned_quantity", "updated_at"])

    return_request.status = ReturnStatus.RECEIVED
    return_request.received_at = timezone.now()
    return_request.save(update_fields=["status", "received_at", "updated_at"])

    log_event(
        order,
        OrderEventType.RETURN_UPDATED,
        f"Return {return_request.number} received",
        data={"restocked_lines": len(restock_lines)},
        actor=actor,
    )
    return return_request


@transaction.atomic
def complete(
    *,
    return_request: ReturnRequest,
    actor: Any = None,
    refund_amount: Decimal | None = None,
    refund_method: str | None = None,
    idempotency_key: str | None = None,
) -> ReturnRequest:
    """Issue the refund and close the return.  Idempotent."""
    return_request = ReturnRequest.objects.select_for_update().get(pk=return_request.pk)
    if return_request.status == ReturnStatus.COMPLETED:
        return return_request
    if return_request.status != ReturnStatus.RECEIVED:
        raise Conflict("The goods must be received before a refund is issued.")

    order = Order.objects.select_for_update().get(pk=return_request.order_id)
    amount = quantize(refund_amount if refund_amount is not None else return_request.refund_amount)

    if amount > ZERO:
        payment_services.refund_order(
            order=order,
            amount=amount,
            actor=actor,
            reason=f"Return {return_request.number}",
            method=refund_method,
            return_request=return_request,
            idempotency_key=idempotency_key or f"return:{return_request.pk}",
        )

    return_request.status = ReturnStatus.COMPLETED
    return_request.refund_amount = amount
    return_request.completed_at = timezone.now()
    return_request.save(update_fields=["status", "refund_amount", "completed_at", "updated_at"])

    fully_returned = all(item.returned_quantity >= item.quantity for item in order.items.all())
    if order.status == OrderStatus.RETURN_REQUESTED and fully_returned:
        transition(
            order=order,
            to_status=OrderStatus.RETURNED,
            actor=actor,
            reason=f"Return {return_request.number}",
            notify=False,
        )
        transition(
            order=order,
            to_status=OrderStatus.REFUNDED,
            actor=actor,
            reason=f"Return {return_request.number}",
            notify=False,
        )

    audit.record(
        action=audit.AuditAction.REFUND_ISSUED,
        entity=return_request,
        actor=actor,
        new_values={"order": order.number, "amount": amount, "return": return_request.number},
        reason=return_request.reason,
        branch=order.branch,
    )
    return return_request
