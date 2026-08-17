"""Payment recording, capture and refunds.

An order is never marked paid from a browser callback — only a staff action, a
verified provider call, or a signature-checked webhook may capture
(docs/architecture/payments.md).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from core import audit
from core.exceptions import Conflict, RefundExceedsCaptured, ValidationError
from core.money import ZERO, quantize
from orders.models import (
    Order,
    OrderEventType,
    OrderPaymentStatus,
    Payment,
    PaymentEvent,
    PaymentMethod,
    PaymentState,
    Refund,
    RefundStatus,
)
from orders.services.lifecycle import log_event

CAPTURED_STATES = {PaymentState.CAPTURED, PaymentState.PARTIALLY_REFUNDED, PaymentState.REFUNDED}


def refresh_payment_status(order: Order) -> Order:
    """Derive the order's payment status from its payment and refund rows."""
    captured = ZERO
    for payment in order.payments.all():
        if payment.status in CAPTURED_STATES:
            captured += payment.amount
    refunded = quantize(
        sum(
            (r.amount for r in order.refunds.filter(status=RefundStatus.COMPLETED)),
            ZERO,
        )
    )
    captured = quantize(captured)
    net = quantize(captured - refunded)

    if refunded > ZERO and net <= ZERO:
        status = OrderPaymentStatus.REFUNDED
    elif refunded > ZERO:
        status = OrderPaymentStatus.PARTIALLY_REFUNDED
    elif net >= order.grand_total and order.grand_total > ZERO:
        status = OrderPaymentStatus.PAID
    elif net > ZERO:
        status = OrderPaymentStatus.PARTIALLY_PAID
    else:
        status = OrderPaymentStatus.UNPAID

    order.paid_total = captured
    order.refunded_total = refunded
    order.payment_status = status
    order.save(update_fields=["paid_total", "refunded_total", "payment_status", "updated_at"])
    return order


@transaction.atomic
def record_payment(
    *,
    order: Order,
    method: str,
    amount: Decimal,
    actor: Any = None,
    status: str = PaymentState.CAPTURED,
    provider: str = "manual",
    provider_reference: str = "",
    reference: str = "",
    tendered_amount: Decimal | None = None,
    payload: dict[str, Any] | None = None,
) -> Payment:
    """Record a payment against an order (cash, card slip, MFS, bank, COD)."""
    order = Order.objects.select_for_update().get(pk=order.pk)
    amount = quantize(amount)
    if amount <= ZERO:
        raise ValidationError("Payment amount must be positive.")

    now = timezone.now()
    change = ZERO
    if tendered_amount is not None and method == PaymentMethod.CASH:
        tendered_amount = quantize(tendered_amount)
        if tendered_amount < amount:
            raise ValidationError("Cash tendered is less than the amount due.")
        change = quantize(tendered_amount - amount)

    payment = Payment.objects.create(
        order=order,
        method=method,
        status=status,
        amount=amount,
        tendered_amount=tendered_amount,
        change_amount=change,
        currency=order.currency,
        provider=provider,
        provider_reference=provider_reference,
        reference=reference,
        payload=payload or {},
        captured_at=now if status == PaymentState.CAPTURED else None,
        authorized_at=now if status == PaymentState.AUTHORIZED else None,
        failed_at=now if status == PaymentState.FAILED else None,
        created_by=actor,
    )

    refresh_payment_status(order)
    log_event(
        order,
        OrderEventType.PAYMENT_RECORDED,
        f"{method} {amount}",
        data={"payment_id": str(payment.pk), "method": method, "amount": str(amount)},
        actor=actor,
    )
    audit.record(
        action=audit.AuditAction.PAYMENT_RECORDED,
        entity=payment,
        actor=actor,
        new_values={"order": order.number, "method": method, "amount": amount, "status": status},
        branch=order.branch,
    )
    return payment


@transaction.atomic
def capture_payment(
    *,
    payment: Payment,
    actor: Any = None,
    provider_reference: str = "",
    payload: dict[str, Any] | None = None,
) -> Payment:
    """Mark a pending/authorised payment as captured.  Idempotent."""
    payment = Payment.objects.select_for_update().get(pk=payment.pk)
    if payment.status in CAPTURED_STATES:
        return payment
    if payment.status in {PaymentState.VOIDED, PaymentState.FAILED}:
        raise Conflict(f"A {payment.status} payment cannot be captured.")

    payment.status = PaymentState.CAPTURED
    payment.captured_at = timezone.now()
    if provider_reference:
        payment.provider_reference = provider_reference
    if payload:
        payment.payload = {**payment.payload, **payload}
    payment.save(
        update_fields=["status", "captured_at", "provider_reference", "payload", "updated_at"]
    )

    order = Order.objects.select_for_update().get(pk=payment.order_id)
    refresh_payment_status(order)
    log_event(
        order,
        OrderEventType.PAYMENT_CAPTURED,
        f"{payment.method} {payment.amount} captured",
        data={"payment_id": str(payment.pk)},
        actor=actor,
    )
    audit.record(
        action=audit.AuditAction.PAYMENT_RECORDED,
        entity=payment,
        actor=actor,
        old_values={"status": PaymentState.PENDING},
        new_values={"status": PaymentState.CAPTURED, "amount": payment.amount},
        branch=order.branch,
    )
    return payment


@transaction.atomic
def fail_payment(*, payment: Payment, reason: str = "", actor: Any = None) -> Payment:
    payment = Payment.objects.select_for_update().get(pk=payment.pk)
    if payment.status in CAPTURED_STATES:
        raise Conflict("A captured payment cannot be marked failed; refund it instead.")
    payment.status = PaymentState.FAILED
    payment.failed_at = timezone.now()
    payment.save(update_fields=["status", "failed_at", "updated_at"])
    log_event(payment.order, OrderEventType.PAYMENT_FAILED, reason or "Payment failed", actor=actor)
    return payment


@transaction.atomic
def refund_order(
    *,
    order: Order,
    amount: Decimal,
    actor: Any = None,
    reason: str = "",
    method: str | None = None,
    return_request: Any = None,
    idempotency_key: str | None = None,
) -> Refund:
    """Refund money against an order.

    Never exceeds what was actually captured, and is idempotent on the caller's
    idempotency key so a retried request cannot pay a customer twice.
    """
    order = Order.objects.select_for_update().get(pk=order.pk)
    amount = quantize(amount)
    if amount <= ZERO:
        raise ValidationError("Refund amount must be positive.")

    if idempotency_key:
        existing = Refund.objects.filter(idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing

    refundable = quantize(order.paid_total - order.refunded_total)
    if amount > refundable:
        raise RefundExceedsCaptured(
            f"Only {refundable} can be refunded on {order.number}.",
            details={
                "requested": str(amount),
                "refundable": str(refundable),
                "paid_total": str(order.paid_total),
                "refunded_total": str(order.refunded_total),
            },
        )

    # Default to refunding through the payment that took the money.
    source_payment = order.payments.filter(status__in=CAPTURED_STATES).order_by("-amount").first()
    refund_method = method or (source_payment.method if source_payment else PaymentMethod.CASH)

    try:
        refund = Refund.objects.create(
            order=order,
            payment=source_payment,
            return_request=return_request,
            amount=amount,
            method=refund_method,
            status=RefundStatus.COMPLETED,
            reason=reason[:255],
            idempotency_key=idempotency_key,
            created_by=actor,
        )
    except IntegrityError:
        # Lost the race on the idempotency key: return the winner's refund.
        existing = Refund.objects.filter(idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing
        raise

    if source_payment is not None:
        source_payment.refunded_total = quantize(source_payment.refunded_total + amount)
        source_payment.status = (
            PaymentState.REFUNDED
            if source_payment.refunded_total >= source_payment.amount
            else PaymentState.PARTIALLY_REFUNDED
        )
        source_payment.save(update_fields=["refunded_total", "status", "updated_at"])

    refresh_payment_status(order)
    log_event(
        order,
        OrderEventType.REFUND_ISSUED,
        f"Refund {amount}",
        data={"refund_id": str(refund.pk), "amount": str(amount), "reason": reason},
        actor=actor,
    )
    audit.record(
        action=audit.AuditAction.REFUND_ISSUED,
        entity=refund,
        actor=actor,
        new_values={"order": order.number, "amount": amount, "method": refund_method},
        reason=reason,
        branch=order.branch,
    )
    return refund


@transaction.atomic
def handle_provider_event(
    *,
    provider: str,
    provider_event_id: str,
    event_type: str,
    payload: dict[str, Any],
    order: Order | None = None,
    payment: Payment | None = None,
) -> PaymentEvent:
    """Store a provider webhook exactly once and act on it.

    A replayed webhook is recorded and ignored — the unique constraint on
    (provider, provider_event_id) is what makes that safe under concurrency.
    """
    try:
        with transaction.atomic():
            event = PaymentEvent.objects.create(
                provider=provider,
                provider_event_id=provider_event_id,
                event_type=event_type,
                payload=payload,
                order=order,
                payment=payment,
            )
    except IntegrityError:
        duplicate = PaymentEvent.objects.get(provider=provider, provider_event_id=provider_event_id)
        return duplicate

    if payment is not None and event_type in {"payment.captured", "payment.success"}:
        capture_payment(payment=payment, provider_reference=provider_event_id, payload=payload)
        event.result = "captured"
    elif payment is not None and event_type in {"payment.failed", "payment.cancelled"}:
        fail_payment(payment=payment, reason=event_type)
        event.result = "failed"
    else:
        event.result = "ignored"

    # PaymentEvent is append-only, so the outcome is stored with a targeted
    # UPDATE rather than a model save.
    PaymentEvent.objects.filter(pk=event.pk).update(processed=True, result=event.result)
    return event
