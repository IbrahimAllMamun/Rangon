"""Purchasing services.

Receiving is the only operation here that touches stock, and it does so through
inventory.services.receive_stock so the ledger and weighted average cost stay
correct (ADR-0006, ADR-0008).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import Branch, User
from core import audit
from core.exceptions import Conflict, PaymentExceedsOutstanding, ValidationError
from core.money import quantize
from core.services import next_number
from inventory import services as inventory_services
from purchasing.models import (
    PaymentStatus,
    PurchaseOrder,
    PurchaseOrderItem,
    PurchaseOrderStatus,
    PurchaseReceipt,
    PurchaseReceiptItem,
    Supplier,
    SupplierPayment,
)

#: Statuses that owe the supplier nothing, so no money may be paid against them.
#: Kept identical to the pair finance.selectors excludes when deriving payables
#: -- if the ledger says an order is not a liability, the till must agree.
UNPAYABLE_STATUSES = frozenset({PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.CANCELLED})


def unique_supplier_code(name: str) -> str:
    """A short, readable, unique code derived from the supplier's name.

    `Supplier.code` is unique and has no default, so without this every caller
    has to invent one — which in practice means an admin form asking a buyer to
    make up an identifier, and two branches inventing the same one. Mirrors
    `catalog.services.unique_slug`, but uppercase, because a supplier code is
    read aloud off a delivery note rather than put in a URL.
    """
    base = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").upper()[:24] or "SUPPLIER"
    candidate, counter = base, 1
    while Supplier.objects.filter(code=candidate).exists():
        counter += 1
        suffix = f"-{counter}"
        candidate = f"{base[: 32 - len(suffix)]}{suffix}"
    return candidate


@dataclass(frozen=True)
class PurchaseLine:
    variant_id: Any
    quantity: int
    unit_cost: Decimal
    discount: Decimal = Decimal("0.00")


def recalculate_totals(purchase_order: PurchaseOrder) -> PurchaseOrder:
    subtotal = Decimal("0.00")
    discount_total = Decimal("0.00")
    tax_total = Decimal("0.00")

    for item in purchase_order.items.all():
        gross = quantize(item.unit_cost * item.quantity_ordered)
        net = gross - item.discount
        item.line_total = quantize(net)
        item.save(update_fields=["line_total", "updated_at"])
        subtotal += gross
        discount_total += item.discount
        tax_total += quantize(net * item.tax_rate)

    purchase_order.subtotal = quantize(subtotal)
    purchase_order.discount_total = quantize(discount_total)
    purchase_order.tax_total = quantize(tax_total)
    purchase_order.grand_total = quantize(
        subtotal - discount_total + tax_total + purchase_order.shipping_total
    )
    purchase_order.save(
        update_fields=[
            "subtotal",
            "discount_total",
            "tax_total",
            "grand_total",
            "updated_at",
        ]
    )
    return purchase_order


def _check_lines(lines: list[PurchaseLine], shipping_total: Decimal) -> None:
    """What makes a purchase order's money wrong rather than merely unusual.

    Each of these used to be stored (roadmap D77): a negative shipping figure
    lowered the liability, a discount above its line made the line negative and
    quietly cancelled out other lines, and a variant named twice reached the
    unique index as a bare 409 with no field for the form to point at.
    """
    if not lines:
        raise ValidationError("A purchase order needs at least one line.")
    if quantize(shipping_total) < 0:
        raise ValidationError(
            "Shipping cannot be negative.",
            details={"shipping_total": ["Shipping cannot be negative."]},
        )
    seen: set[str] = set()
    for line in lines:
        if line.quantity <= 0:
            raise ValidationError("Ordered quantity must be positive.")
        if quantize(line.unit_cost) < 0 or quantize(line.discount) < 0:
            raise ValidationError(
                "Costs and discounts cannot be negative.",
                details={"lines": ["Costs and discounts cannot be negative."]},
            )
        if quantize(line.discount) > quantize(line.unit_cost * line.quantity):
            message = "A line's discount cannot be more than the line itself."
            raise ValidationError(message, details={"lines": [message]})
        key = str(line.variant_id)
        if key in seen:
            message = "The same product appears on two lines; change the quantity on one instead."
            raise ValidationError(message, details={"lines": [message]})
        seen.add(key)


@transaction.atomic
def create_purchase_order(
    *,
    supplier: Supplier,
    branch: Branch,
    lines: Iterable[PurchaseLine],
    actor: User | None = None,
    expected_at: Any = None,
    invoice_number: str = "",
    shipping_total: Decimal = Decimal("0.00"),
    notes: str = "",
    receive_now: bool = False,
) -> PurchaseOrder:
    """Raise a purchase order -- or, with `receive_now`, record goods that have arrived.

    `receive_now` is the counter-side case: the supplier walked in with the
    goods, so there is nothing to wait for. The order is created, sent and
    received in full in this one transaction, which is the only way the three
    can never be seen apart (business-rules §4.0b).
    """
    materialised = list(lines)
    _check_lines(materialised, shipping_total)

    purchase_order = PurchaseOrder.objects.create(
        number=next_number("purchase_order", prefix="PO"),
        supplier=supplier,
        branch=branch,
        status=PurchaseOrderStatus.DRAFT,
        expected_at=expected_at,
        invoice_number=invoice_number,
        shipping_total=quantize(shipping_total),
        notes=notes,
        created_by=actor,
    )

    for line in materialised:
        PurchaseOrderItem.objects.create(
            purchase_order=purchase_order,
            variant_id=line.variant_id,
            quantity_ordered=line.quantity,
            unit_cost=quantize(line.unit_cost),
            discount=quantize(line.discount),
        )

    purchase_order = recalculate_totals(purchase_order)
    if not receive_now:
        return purchase_order

    purchase_order = send_purchase_order(purchase_order=purchase_order, actor=actor)
    receive_purchase(
        purchase_order=purchase_order,
        lines={str(item.pk): item.quantity_ordered for item in purchase_order.items.all()},
        actor=actor,
        notes="Received on arrival",
    )
    return PurchaseOrder.objects.get(pk=purchase_order.pk)


@transaction.atomic
def send_purchase_order(
    *, purchase_order: PurchaseOrder, actor: User | None = None
) -> PurchaseOrder:
    # Decided under the row lock, not against the caller's copy: a cancel that
    # committed after the caller read the order would otherwise be overwritten
    # with SENT (roadmap D76).
    purchase_order = PurchaseOrder.objects.select_for_update().get(pk=purchase_order.pk)
    if purchase_order.status != PurchaseOrderStatus.DRAFT:
        raise Conflict("Only a draft purchase order can be sent.")
    purchase_order.status = PurchaseOrderStatus.SENT
    purchase_order.ordered_at = timezone.now()
    purchase_order.save(update_fields=["status", "ordered_at", "updated_at"])
    audit.record(
        action=audit.AuditAction.UPDATE,
        entity=purchase_order,
        actor=actor,
        new_values={"status": PurchaseOrderStatus.SENT},
        reason="Purchase order sent to supplier",
        branch=purchase_order.branch,
    )
    return purchase_order


@transaction.atomic
def receive_purchase(
    *,
    purchase_order: PurchaseOrder,
    lines: dict[Any, int],
    actor: User | None = None,
    unit_costs: dict[Any, Decimal] | None = None,
    notes: str = "",
) -> PurchaseReceipt:
    """Record a delivery and push the goods into stock.

    `lines` maps PurchaseOrderItem id -> quantity received now.
    Posting is idempotent per receipt: the ledger rows are written exactly once.
    """
    purchase_order = PurchaseOrder.objects.select_for_update().get(pk=purchase_order.pk)

    if purchase_order.status in {PurchaseOrderStatus.CANCELLED, PurchaseOrderStatus.CLOSED}:
        raise Conflict(f"A {purchase_order.status} purchase order cannot receive stock.")
    if not lines:
        raise ValidationError("Nothing to receive.")

    receipt = PurchaseReceipt.objects.create(
        number=next_number("purchase_receipt", prefix="GRN"),
        purchase_order=purchase_order,
        received_at=timezone.now(),
        received_by=actor,
        notes=notes,
    )

    items = {
        str(item.pk): item
        for item in PurchaseOrderItem.objects.select_for_update().filter(
            purchase_order=purchase_order
        )
    }
    unit_costs = unit_costs or {}

    for item_id, quantity in lines.items():
        quantity = int(quantity)
        if quantity <= 0:
            continue
        item = items.get(str(item_id))
        if item is None:
            raise ValidationError(f"Line {item_id} does not belong to {purchase_order.number}.")
        if quantity > item.quantity_outstanding:
            raise ValidationError(
                f"Cannot receive {quantity} of {item.variant.sku}: only "
                f"{item.quantity_outstanding} outstanding.",
                details={
                    "item_id": str(item.pk),
                    "requested": quantity,
                    "outstanding": item.quantity_outstanding,
                },
            )

        unit_cost = quantize(unit_costs.get(str(item_id), item.unit_cost))

        PurchaseReceiptItem.objects.create(
            receipt=receipt,
            purchase_order_item=item,
            quantity=quantity,
            unit_cost=unit_cost,
        )
        inventory_services.receive_stock(
            branch=purchase_order.branch,
            variant=item.variant_id,
            quantity=quantity,
            unit_cost=unit_cost,
            actor=actor,
            reference_type="purchase_receipt",
            reference_id=receipt.pk,
            notes=f"{purchase_order.number} / {receipt.number}",
        )

        item.quantity_received += quantity
        item.save(update_fields=["quantity_received", "updated_at"])

    receipt.is_posted = True
    receipt.save(update_fields=["is_posted", "updated_at"])

    _refresh_receipt_status(purchase_order)

    audit.record(
        action=audit.AuditAction.PURCHASE_RECEIVED,
        entity=purchase_order,
        actor=actor,
        new_values={
            "receipt": receipt.number,
            "lines": len(lines),
            "status": purchase_order.status,
        },
        reason=notes or "Stock received",
        branch=purchase_order.branch,
    )
    return receipt


def _refresh_receipt_status(purchase_order: PurchaseOrder) -> None:
    items = list(purchase_order.items.all())
    if all(item.quantity_received >= item.quantity_ordered for item in items):
        purchase_order.status = PurchaseOrderStatus.RECEIVED
        purchase_order.completed_at = timezone.now()
    elif any(item.quantity_received > 0 for item in items):
        purchase_order.status = PurchaseOrderStatus.PARTIALLY_RECEIVED
    purchase_order.save(update_fields=["status", "completed_at", "updated_at"])


@transaction.atomic
def cancel_purchase_order(
    *, purchase_order: PurchaseOrder, actor: User | None = None, reason: str = ""
) -> PurchaseOrder:
    """Withdraw an order nothing has happened to yet.

    Three things make an order impossible to cancel, and each is decided under
    the order's row lock -- the lock `receive_purchase` and
    `record_supplier_payment` both take -- so a delivery or a payment
    committing at the same moment is seen rather than overwritten (D76).
    """
    purchase_order = PurchaseOrder.objects.select_for_update().get(pk=purchase_order.pk)
    if purchase_order.status == PurchaseOrderStatus.CANCELLED:
        raise Conflict(f"{purchase_order.number} is already cancelled.")
    if purchase_order.status not in {PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT}:
        raise Conflict(
            f"A {purchase_order.get_status_display().lower()} purchase order cannot be cancelled.",
            details={"status": purchase_order.status},
        )
    if purchase_order.receipts.exists():
        raise Conflict(
            "Stock has already been received against this order; close it instead of cancelling."
        )
    # Payables (§4.2) drop a cancelled order, and a payment can be neither
    # edited nor deleted (§6b.1b) -- so cancelling a paid order would leave the
    # money with the supplier and on no list anywhere (D75).
    if purchase_order.paid_total > 0:
        raise Conflict(
            f"{purchase_order.paid_total} has already been paid against "
            f"{purchase_order.number}. Cancelling would leave that money with the supplier "
            "and on no list anywhere; receive the goods against this order instead.",
            details={"paid_total": str(purchase_order.paid_total)},
        )
    purchase_order.status = PurchaseOrderStatus.CANCELLED
    purchase_order.save(update_fields=["status", "updated_at"])
    audit.record(
        action=audit.AuditAction.UPDATE,
        entity=purchase_order,
        actor=actor,
        new_values={"status": PurchaseOrderStatus.CANCELLED},
        reason=reason,
        branch=purchase_order.branch,
    )
    return purchase_order


@transaction.atomic
def record_supplier_payment(
    *,
    supplier: Supplier,
    amount: Decimal,
    method: str,
    purchase_order: PurchaseOrder | None = None,
    reference: str = "",
    paid_at: Any = None,
    actor: User | None = None,
    notes: str = "",
    account: Any = None,
    branch: Any = None,
    idempotency_key: str | None = None,
) -> SupplierPayment:
    """Pay a supplier, taking the money out of one of our own accounts.

    ``account`` names it explicitly; otherwise the branch's default account for
    the method's kind is used.  ``branch`` is only needed when there is no
    purchase order to take it from.

    Never exceeds what is outstanding, never pays an order the supplier was not
    sent, and is idempotent on the caller's key so a retried request cannot pay
    a supplier twice (business-rules.md §6b.1b).
    """
    from finance import services as finance_services
    from finance.models import AccountTransactionType

    amount = quantize(amount)
    if amount <= 0:
        raise ValidationError("Payment amount must be positive.")

    # Before any lock is taken and before any money moves: a retry returns the
    # payment already recorded, exactly as refund_order does on the sales side.
    if idempotency_key:
        existing = SupplierPayment.objects.filter(idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing

    # The order is locked up front -- before the account lock that
    # finance.record_movement takes -- so the outstanding check below is decided
    # under the same lock that the increment uses, and two simultaneous payments
    # cannot both read the same balance.  PurchaseOrder-then-Account is also the
    # order refund_order uses (Order-then-Account), so the two money paths can
    # never deadlock against each other.
    locked_order: PurchaseOrder | None = None
    if purchase_order is not None:
        locked_order = PurchaseOrder.objects.select_for_update().get(pk=purchase_order.pk)

        # Both submits can pass the check above before either commits, and the
        # lock is what serialises them -- so the loser asks again now that the
        # winner has committed, rather than colliding with the unique index.
        if idempotency_key:
            existing = SupplierPayment.objects.filter(idempotency_key=idempotency_key).first()
            if existing is not None:
                return existing

        if locked_order.supplier_id != supplier.pk:
            raise ValidationError(
                f"{locked_order.number} belongs to a different supplier.",
                details={
                    "purchase_order_supplier": str(locked_order.supplier_id),
                    "payment_supplier": str(supplier.pk),
                },
            )

        if locked_order.status in UNPAYABLE_STATUSES:
            raise Conflict(
                f"A {locked_order.get_status_display().lower()} purchase order cannot be paid.",
                details={"status": locked_order.status},
            )

        outstanding = quantize(locked_order.grand_total - locked_order.paid_total)
        if amount > outstanding:
            raise PaymentExceedsOutstanding(
                f"Only {outstanding} is outstanding on {locked_order.number}.",
                details={
                    "requested": str(amount),
                    "outstanding": str(outstanding),
                    "grand_total": str(locked_order.grand_total),
                    "paid_total": str(locked_order.paid_total),
                },
            )

    when = paid_at or timezone.now()
    try:
        # A savepoint, so losing the race to the unique index does not poison
        # the surrounding transaction.  Reachable when there is no purchase
        # order to lock: an advance against no particular delivery.
        with transaction.atomic():
            payment = SupplierPayment.objects.create(
                supplier=supplier,
                purchase_order=purchase_order,
                amount=amount,
                method=method,
                reference=reference,
                paid_at=when,
                notes=notes,
                account=account,
                created_by=actor,
                idempotency_key=idempotency_key or None,
            )
    except IntegrityError:
        if not idempotency_key:
            raise
        existing = SupplierPayment.objects.filter(idempotency_key=idempotency_key).first()
        if existing is None:
            raise
        return existing

    # Paying a supplier is money leaving the business, so it comes out of an
    # account.  A cash drawer that does not hold enough refuses here
    # (InsufficientFunds) rather than going quietly negative.
    # The goods' branch is the one that pays for them; `branch` is only a
    # fallback for a payment made against no particular order.
    source_branch = purchase_order.branch if purchase_order else branch
    if source_branch is not None:
        entry = finance_services.record_for_reference(
            branch=source_branch,
            transaction_type=AccountTransactionType.SUPPLIER_PAYMENT,
            amount=amount,
            account=account,
            method=method,
            reference_type="supplier_payment",
            reference_id=payment.pk,
            actor=actor,
            notes=f"{supplier.name}{' ' + purchase_order.number if purchase_order else ''}",
            occurred_at=when,
        )
        if entry is not None and payment.account_id != entry.account_id:
            payment.account_id = entry.account_id
            payment.save(update_fields=["account", "updated_at"])

    if locked_order is not None:
        locked_order.paid_total = quantize(locked_order.paid_total + amount)
        if locked_order.paid_total >= locked_order.grand_total:
            locked_order.payment_status = PaymentStatus.PAID
        elif locked_order.paid_total > 0:
            locked_order.payment_status = PaymentStatus.PARTIALLY_PAID
        locked_order.save(update_fields=["paid_total", "payment_status", "updated_at"])

    audit.record(
        action=audit.AuditAction.PAYMENT_RECORDED,
        entity=payment,
        actor=actor,
        new_values={"supplier": supplier.name, "amount": amount, "method": method},
        reason=notes,
    )
    return payment
