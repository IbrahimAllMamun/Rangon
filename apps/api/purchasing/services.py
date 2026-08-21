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

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, User
from core import audit
from core.exceptions import Conflict, ValidationError
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
) -> PurchaseOrder:
    materialised = list(lines)
    if not materialised:
        raise ValidationError("A purchase order needs at least one line.")

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
        if line.quantity <= 0:
            raise ValidationError("Ordered quantity must be positive.")
        PurchaseOrderItem.objects.create(
            purchase_order=purchase_order,
            variant_id=line.variant_id,
            quantity_ordered=line.quantity,
            unit_cost=quantize(line.unit_cost),
            discount=quantize(line.discount),
        )

    return recalculate_totals(purchase_order)


@transaction.atomic
def send_purchase_order(
    *, purchase_order: PurchaseOrder, actor: User | None = None
) -> PurchaseOrder:
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
    if purchase_order.receipts.exists():
        raise Conflict(
            "Stock has already been received against this order; close it instead of cancelling."
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
) -> SupplierPayment:
    """Pay a supplier, taking the money out of one of our own accounts.

    ``account`` names it explicitly; otherwise the branch's default account for
    the method's kind is used.  ``branch`` is only needed when there is no
    purchase order to take it from.
    """
    from finance import services as finance_services
    from finance.models import AccountTransactionType

    amount = quantize(amount)
    if amount <= 0:
        raise ValidationError("Payment amount must be positive.")

    when = paid_at or timezone.now()
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
    )

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

    if purchase_order is not None:
        locked = PurchaseOrder.objects.select_for_update().get(pk=purchase_order.pk)
        locked.paid_total = quantize(locked.paid_total + amount)
        if locked.paid_total >= locked.grand_total:
            locked.payment_status = PaymentStatus.PAID
        elif locked.paid_total > 0:
            locked.payment_status = PaymentStatus.PARTIALLY_PAID
        locked.save(update_fields=["paid_total", "payment_status", "updated_at"])

    audit.record(
        action=audit.AuditAction.PAYMENT_RECORDED,
        entity=payment,
        actor=actor,
        new_values={"supplier": supplier.name, "amount": amount, "method": method},
        reason=notes,
    )
    return payment
