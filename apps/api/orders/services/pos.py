"""POS sales.

A POS sale is instantaneous: the customer walks out with the goods, so stock is
deducted immediately (no reservation) and the order is created DELIVERED.
docs/business-rules.md §1.3
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import Branch, User
from catalog.models import ProductVariant
from core import audit
from core.exceptions import Conflict, PermissionDenied, ValidationError
from core.money import ZERO, quantize
from core.services import next_number
from customers.models import Customer
from inventory import services as inventory_services
from orders.models import (
    Channel,
    HeldSale,
    Order,
    OrderEventType,
    OrderItem,
    OrderStatus,
    PaymentMethod,
    PaymentState,
)
from orders.services import payments as payment_services
from orders.services import pricing
from orders.services.lifecycle import log_event


@dataclass
class SaleLineInput:
    variant_id: Any
    quantity: int
    line_discount: Decimal = ZERO


@dataclass
class PaymentInput:
    method: str
    amount: Decimal
    tendered_amount: Decimal | None = None
    reference: str = ""


@dataclass
class SaleInput:
    lines: list[SaleLineInput]
    payments: list[PaymentInput] = field(default_factory=list)
    customer_id: Any = None
    manual_discount: Decimal = ZERO
    register: str = ""
    note: str = ""
    idempotency_key: str | None = None
    elevated_by: User | None = None


def walk_in_customer(branch: Branch) -> Customer:
    """Every order needs a customer FK; anonymous counter sales use this row."""
    customer, _ = Customer.objects.get_or_create(
        is_walk_in=True,
        name=f"Walk-in ({branch.code})",
        defaults={"customer_type": "WALK_IN", "phone": None, "email": None},
    )
    return customer


def _check_discount_permission(
    *, actor: User, discount: Decimal, subtotal: Decimal, elevated_by: User | None
) -> None:
    """Large discounts need manager approval (docs/business-rules.md §3.3)."""
    if discount <= ZERO:
        return
    if not actor.has_perm_code("sales.discount"):
        raise PermissionDenied("You do not have permission to apply discounts.")
    if subtotal <= ZERO:
        return

    percent = (discount / subtotal) * Decimal("100")
    threshold = Decimal(settings.RANGON["DISCOUNT_APPROVAL_PERCENT"])
    if percent <= threshold:
        return

    approver = elevated_by or actor
    if not approver.has_perm_code("sales.discount_override"):
        raise PermissionDenied(
            f"A discount above {threshold}% needs manager approval.",
            details={"discount_percent": str(quantize(percent)), "threshold": str(threshold)},
        )
    audit.record(
        action=audit.AuditAction.DISCOUNT_OVERRIDE,
        entity_type="Order",
        entity_label="POS sale",
        actor=actor,
        new_values={
            "discount": str(discount),
            "percent": str(quantize(percent)),
            "approved_by": approver.email,
        },
        reason="Discount above threshold approved",
    )


@transaction.atomic
def create_pos_sale(*, branch: Branch, actor: User, data: SaleInput) -> Order:
    """Create a completed counter sale: stock out, money in, receipt ready."""
    if data.idempotency_key:
        existing = Order.objects.filter(idempotency_key=data.idempotency_key).first()
        if existing is not None:
            return existing

    if not data.lines:
        raise ValidationError("A sale needs at least one item.")

    variant_ids = [line.variant_id for line in data.lines]
    variants = {
        str(v.pk): v
        for v in ProductVariant.objects.select_related("product", "product__category").filter(
            pk__in=variant_ids
        )
    }
    missing = [str(v) for v in variant_ids if str(v) not in variants]
    if missing:
        raise ValidationError("Unknown product variant.", details={"variant_ids": missing})

    # Cost comes from the branch's weighted average at this moment (ADR-0006).
    snapshots = inventory_services.availability(branch=branch, variants=list(variants.values()))
    costs = {vid: snapshot.average_cost for vid, snapshot in snapshots.items()}

    priced_lines = pricing.price_lines(
        [
            (variants[str(line.variant_id)], line.quantity, line.line_discount)
            for line in data.lines
        ],
        costs=costs,
    )
    line_discounts = quantize(sum((line.line_discount for line in priced_lines), ZERO))
    gross_subtotal = quantize(sum((line.gross for line in priced_lines), ZERO))
    _check_discount_permission(
        actor=actor,
        discount=quantize(line_discounts + data.manual_discount),
        subtotal=gross_subtotal,
        elevated_by=data.elevated_by,
    )

    priced = pricing.calculate(priced_lines, manual_discount=quantize(data.manual_discount))

    customer = (
        Customer.objects.filter(pk=data.customer_id).first() if data.customer_id else None
    ) or walk_in_customer(branch)

    try:
        order = Order.objects.create(
            number=next_number("order:POS", prefix="RGN-POS"),
            channel=Channel.POS,
            status=OrderStatus.DELIVERED,
            branch=branch,
            customer=customer,
            created_by=actor,
            register=data.register,
            subtotal=priced.subtotal,
            manual_discount=priced.manual_discount,
            discount_total=priced.discount_total,
            tax_rate=priced.tax_rate,
            tax_total=priced.tax_total,
            shipping_total=ZERO,
            grand_total=priced.grand_total,
            currency=settings.RANGON["CURRENCY"],
            customer_note=data.note,
            idempotency_key=data.idempotency_key,
            placed_at=timezone.now(),
            delivered_at=timezone.now(),
            stock_committed=True,
        )
    except IntegrityError:
        existing = Order.objects.filter(idempotency_key=data.idempotency_key).first()
        if existing is not None:
            return existing
        raise

    for line in priced.lines:
        OrderItem.objects.create(
            order=order,
            variant=line.variant,
            sku=line.sku,
            product_name=line.product_name,
            variant_label=line.variant_label,
            quantity=line.quantity,
            unit_price=line.unit_price,
            unit_cost=line.unit_cost,
            line_discount=line.line_discount,
            tax_amount=line.tax_amount,
            line_total=line.line_total,
            fulfilled_quantity=line.quantity,
        )

    # Deduct stock — this is where an oversell would be caught, under a row lock.
    inventory_services.sell(
        branch=branch,
        lines=[(line.variant.pk, line.quantity) for line in priced.lines],
        actor=actor,
        reference_type="order",
        reference_id=order.pk,
    )

    total_paid = ZERO
    for payment_input in data.payments:
        amount = quantize(payment_input.amount)
        if amount <= ZERO:
            continue
        payment_services.record_payment(
            order=order,
            method=payment_input.method,
            amount=amount,
            actor=actor,
            status=PaymentState.CAPTURED,
            reference=payment_input.reference,
            tendered_amount=payment_input.tendered_amount,
        )
        total_paid += amount

    if total_paid < priced.grand_total:
        raise ValidationError(
            "Payment does not cover the sale total.",
            details={"total": str(priced.grand_total), "paid": str(quantize(total_paid))},
        )

    _touch_customer(customer, order)

    log_event(
        order,
        OrderEventType.CREATED,
        f"POS sale at {branch.code}",
        data={"register": data.register, "items": len(priced.lines)},
        actor=actor,
    )
    audit.record(
        action=audit.AuditAction.SALE_CREATED,
        entity=order,
        actor=actor,
        new_values={
            "number": order.number,
            "total": order.grand_total,
            "items": len(priced.lines),
            "register": data.register,
        },
        branch=branch,
    )

    # record_payment() updated the row through its own locked copy; refresh so
    # the caller (and therefore the receipt) sees the real payment status.
    order.refresh_from_db()
    return order


def _touch_customer(customer: Customer, order: Order) -> None:
    if customer.is_walk_in:
        return
    Customer.objects.filter(pk=customer.pk).update(
        total_orders=customer.total_orders + 1,
        total_spent=quantize(customer.total_spent + order.grand_total),
        last_order_at=order.placed_at,
    )


@transaction.atomic
def void_sale(*, order: Order, actor: User, reason: str) -> Order:
    """Void a POS sale: restock the goods and refund the money.

    The sale itself is never deleted (CLAUDE.md §3.3) — it becomes a cancelled
    order with a compensating RETURN in the ledger.
    """
    if order.channel != Channel.POS:
        raise Conflict("Only a POS sale can be voided; use returns for online orders.")
    if order.status == OrderStatus.CANCELLED:
        return order
    if not reason.strip():
        raise ValidationError("A reason is required to void a sale.")

    order = Order.objects.select_for_update().get(pk=order.pk)

    inventory_services.restock_return(
        branch=order.branch,
        lines=[(item.variant_id, item.quantity) for item in order.items.all()],
        actor=actor,
        reference_type="order_void",
        reference_id=order.pk,
        reason=f"Sale {order.number} voided: {reason}",
    )

    if order.paid_total > order.refunded_total:
        payment_services.refund_order(
            order=order,
            amount=order.paid_total - order.refunded_total,
            actor=actor,
            reason=f"Sale voided: {reason}",
        )

    # Re-read first: refund_order() wrote paid/refunded totals on its own copy.
    order.refresh_from_db()
    order.status = OrderStatus.CANCELLED
    order.cancelled_at = timezone.now()
    order.cancel_reason = reason[:255]
    order.stock_committed = False
    order.save(
        update_fields=["status", "cancelled_at", "cancel_reason", "stock_committed", "updated_at"]
    )

    log_event(order, OrderEventType.CANCELLED, f"Sale voided: {reason}", actor=actor)
    audit.record(
        action=audit.AuditAction.ORDER_CANCELLED,
        entity=order,
        actor=actor,
        old_values={"status": OrderStatus.DELIVERED},
        new_values={"status": OrderStatus.CANCELLED},
        reason=reason,
        branch=order.branch,
    )
    return order


# --- held sales ------------------------------------------------------------


def hold_sale(
    *,
    branch: Branch,
    actor: User,
    payload: dict[str, Any],
    label: str = "",
    register: str = "",
    customer_id: Any = None,
) -> HeldSale:
    """Park a cart.  Nothing is reserved: a hold must never lock up stock."""
    return HeldSale.objects.create(
        branch=branch,
        register=register,
        label=label or timezone.now().strftime("%H:%M"),
        customer_id=customer_id,
        payload=payload,
        created_by=actor,
    )


def resume_sale(*, hold: HeldSale) -> dict[str, Any]:
    """Return the parked cart and delete the hold.

    Prices and availability are deliberately *not* returned from the hold — the
    POS re-looks-up every line so a stale hold cannot sell at a stale price.
    """
    payload = hold.payload
    hold.delete()
    return payload


def lookup_variant(*, code: str) -> ProductVariant | None:
    """Barcode/SKU lookup: exact match first — a cashier scanning must not get
    a fuzzy result."""
    code = code.strip()
    if not code:
        return None
    return (
        ProductVariant.objects.select_related("product", "product__category")
        .filter(barcode=code)
        .first()
        or ProductVariant.objects.select_related("product", "product__category")
        .filter(sku__iexact=code)
        .first()
    )


def elevate(*, email: str, password: str, permission: str, requested_by: User) -> User:
    """Manager override at the counter.

    Verifies a manager's own credentials and returns the approver; the cashier's
    session is never upgraded.  Both identities land in the audit log.
    """
    from django.contrib.auth import authenticate

    approver = authenticate(username=email, password=password)
    if approver is None or not approver.is_active:
        raise PermissionDenied("Those manager credentials were not accepted.")
    if not approver.has_perm_code(permission):
        raise PermissionDenied("That user cannot approve this action.")

    audit.record(
        action=audit.AuditAction.PERMISSION_ELEVATION,
        entity=approver,
        actor=requested_by,
        new_values={"permission": permission, "approved_by": approver.email},
        reason="POS manager override",
    )
    return approver


@transaction.atomic
def pos_return(
    *,
    order: Order,
    actor: User,
    lines: list[tuple[Any, int, str]],
    reason: str,
    refund_method: str = PaymentMethod.CASH,
) -> Any:
    """In-store return: request, approve, receive and refund in one step.

    `lines` is [(order_item_id, quantity, restock_decision)].
    """
    from orders.services import returns as return_services

    request = return_services.request_return(
        order=order,
        lines=[(item_id, quantity) for item_id, quantity, _ in lines],
        reason=reason,
        actor=actor,
        restock_decisions={str(item_id): decision for item_id, _, decision in lines},
    )
    return_services.approve(return_request=request, actor=actor)
    return_services.receive(return_request=request, actor=actor)
    return return_services.complete(
        return_request=request, actor=actor, refund_method=refund_method
    )
