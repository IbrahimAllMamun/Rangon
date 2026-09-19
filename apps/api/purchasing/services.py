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
    PurchaseReturn,
    PurchaseReturnItem,
    Supplier,
    SupplierPayment,
    SupplierProduct,
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
    #: VAT the supplier charges on this line, as a fraction (0.1500 for 15%).
    #: The column has existed since the first migration and `recalculate_totals`
    #: has always read it; nothing could ever set it, so every purchase order
    #: carried tax_total 0.00 and the VAT return had no input VAT to offset.
    tax_rate: Decimal = Decimal("0.0000")


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

    Each of these used to be stored (D82): a negative shipping figure lowered
    the liability, a discount above its line made the line negative and quietly
    cancelled out other lines, and a variant named twice reached the unique
    index as a bare 409 with no field for the form to point at. The order form
    has caught all three client-side for a long time; the API took whatever it
    was sent (CLAUDE.md §3.4).
    """
    if not lines:
        raise ValidationError("A purchase order needs at least one line.")
    if quantize(shipping_total) < 0:
        message = "Shipping cannot be negative."
        raise ValidationError(message, details={"shipping_total": [message]})
    seen: set[str] = set()
    for line in lines:
        if line.quantity <= 0:
            raise ValidationError("Ordered quantity must be positive.")
        if quantize(line.unit_cost) < 0 or quantize(line.discount) < 0:
            message = "Costs and discounts cannot be negative."
            raise ValidationError(message, details={"lines": [message]})
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
) -> PurchaseOrder:
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
            tax_rate=line.tax_rate,
        )

    return recalculate_totals(purchase_order)


@transaction.atomic
def send_purchase_order(
    *, purchase_order: PurchaseOrder, actor: User | None = None
) -> PurchaseOrder:
    # Decided under the row lock, not against the caller's copy: a cancel that
    # committed after the caller read the order would otherwise be overwritten
    # with SENT (D81).
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

        # The supplier price list is a by-product of receiving, never a chore.
        # Inside the same transaction as the ledger write, so a delivery cannot
        # be half-recorded: stock in but nothing remembered about who supplied
        # it and for how much.
        record_supplier_product(
            supplier=purchase_order.supplier,
            variant_id=item.variant_id,
            unit_cost=unit_cost,
            purchased_at=receipt.received_at,
            actor=actor,
        )

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


def record_supplier_product(
    *,
    supplier: Supplier,
    variant_id: Any,
    unit_cost: Decimal,
    purchased_at: Any = None,
    actor: User | None = None,
    supplier_sku: str | None = None,
) -> SupplierProduct:
    """Remember that this supplier sells this variant, and at what.

    Called for every line of every receipt, so the supplier price list builds
    itself out of what was actually bought rather than out of data entry that
    nobody would keep up.

    The first supplier a variant is received from becomes its preferred one.
    That is a default, not a judgement: with one supplier "preferred" is simply
    true, and it means the purchase order form has something to suggest from the
    very first reorder. Changing it afterwards is an explicit act
    (`set_preferred_supplier`), so a second delivery never silently moves it.
    """
    offer, created = SupplierProduct.objects.get_or_create(
        supplier=supplier,
        variant_id=variant_id,
        defaults={
            "last_cost": quantize(unit_cost),
            "last_purchased_at": purchased_at,
            "supplier_sku": supplier_sku or "",
            "created_by": actor,
        },
    )

    if created:
        # Only claim `is_preferred` when the variant has no preferred supplier:
        # the partial unique constraint would refuse a second one, and quietly
        # losing that race is better than a 500 on a delivery that did arrive.
        already = (
            SupplierProduct.objects.filter(variant_id=variant_id, is_preferred=True)
            .exclude(pk=offer.pk)
            .exists()
        )
        if not already:
            offer.is_preferred = True
            offer.save(update_fields=["is_preferred", "updated_at"])
        return offer

    changed = ["last_cost", "updated_at"]
    offer.last_cost = quantize(unit_cost)
    if purchased_at is not None:
        offer.last_purchased_at = purchased_at
        changed.append("last_purchased_at")
    if supplier_sku and supplier_sku != offer.supplier_sku:
        offer.supplier_sku = supplier_sku
        changed.append("supplier_sku")
    # A delivery from a supplier marked discontinued means they are not.
    if not offer.is_active:
        offer.is_active = True
        changed.append("is_active")
    offer.save(update_fields=changed)
    return offer


@transaction.atomic
def set_preferred_supplier(
    *, variant_id: Any, supplier: Supplier, actor: User | None = None
) -> SupplierProduct:
    """Make this supplier the one the purchase order form suggests.

    Demoting the incumbent and promoting the replacement has to happen in one
    transaction: `purchasing_supplierproduct_one_preferred` refuses two, so
    doing it in the other order would fail on the constraint rather than on
    anything the buyer did wrong.
    """
    try:
        offer = SupplierProduct.objects.select_for_update().get(
            variant_id=variant_id, supplier=supplier
        )
    except SupplierProduct.DoesNotExist:
        raise ValidationError(
            f"{supplier.name} is not recorded as a supplier of this product.",
            details={"variant_id": str(variant_id), "supplier_id": str(supplier.pk)},
        ) from None

    if not offer.is_active:
        raise ValidationError(
            f"{supplier.name} no longer supplies this product, so it cannot be the preferred one."
        )

    previous = (
        SupplierProduct.objects.select_for_update()
        .filter(variant_id=variant_id, is_preferred=True)
        .exclude(pk=offer.pk)
        .first()
    )
    if previous is not None:
        previous.is_preferred = False
        previous.save(update_fields=["is_preferred", "updated_at"])

    if not offer.is_preferred:
        offer.is_preferred = True
        offer.save(update_fields=["is_preferred", "updated_at"])

    audit.record(
        action=audit.AuditAction.UPDATE,
        entity=offer,
        actor=actor,
        old_values={"preferred_supplier": previous.supplier.name if previous else None},
        new_values={"preferred_supplier": supplier.name},
        reason="Preferred supplier changed",
    )
    return offer


def supplier_cost_for(*, supplier: Supplier, variant_id: Any) -> Decimal | None:
    """What this supplier last charged, or None if they have never sold it.

    The purchase order form's default. Returning None rather than falling back
    to `ProductVariant.cost` here on purpose: the caller decides what to do with
    "this supplier has no history", and conflating the two is the bug this whole
    model exists to fix.
    """
    return (
        SupplierProduct.objects.filter(supplier=supplier, variant_id=variant_id)
        .values_list("last_cost", flat=True)
        .first()
    )


def _refresh_receipt_status(purchase_order: PurchaseOrder) -> None:
    items = list(purchase_order.items.all())
    if all(item.quantity_received >= item.quantity_ordered for item in items):
        purchase_order.status = PurchaseOrderStatus.RECEIVED
        purchase_order.completed_at = timezone.now()
    elif any(item.quantity_received > 0 for item in items):
        purchase_order.status = PurchaseOrderStatus.PARTIALLY_RECEIVED
    purchase_order.save(update_fields=["status", "completed_at", "updated_at"])


def _refresh_payment_status(purchase_order: PurchaseOrder) -> None:
    """Set the badge from cash paid, with credit counted only for full settlement.

    A credit is not a payment, and a partial one must not read as though money
    changed hands: an order with nothing paid and a small credit note against it
    is **unpaid**, and saying "partially paid" sends someone hunting for a
    payment that was never made. Seen on real data before it was noticed — a
    925,030 order with a 3,600 credit was badged partially paid.

    Full settlement is different. An order of 1,000 paid 700 with 300 of goods
    sent back owes nothing, and leaving it unpaid would send someone chasing a
    balance that does not exist. `finance.selectors.payables` drops it for the
    same reason, so the badge and the ledger agree.
    """
    if purchase_order.paid_total + purchase_order.credited_total >= purchase_order.grand_total:
        # Nothing further is owed, however the balance was discharged.
        purchase_order.payment_status = PaymentStatus.PAID
    elif purchase_order.paid_total > 0:
        purchase_order.payment_status = PaymentStatus.PARTIALLY_PAID
    else:
        purchase_order.payment_status = PaymentStatus.UNPAID
    purchase_order.save(update_fields=["payment_status", "updated_at"])


@dataclass(frozen=True)
class ReturnLine:
    """One line of a return: how many of a received line go back."""

    purchase_order_item_id: Any
    quantity: int


@transaction.atomic
def create_purchase_return(
    *,
    purchase_order: PurchaseOrder,
    lines: Iterable[ReturnLine],
    reason: str,
    actor: User | None = None,
    notes: str = "",
    idempotency_key: str | None = None,
) -> PurchaseReturn:
    """Send received goods back, take the stock off the shelf, credit the order.

    Three things have to happen together or not at all: the ledger loses the
    units, the order gains the credit, and the line remembers how many went
    back. Any one alone is a lie — stock gone with nothing owed back, or a
    credit against goods still sitting on the shelf.

    The credit is valued at **what the goods were received at**, not at today's
    price and not at the branch's blended average. That is what the supplier
    charged, so that is what they owe back.

    Refuses more than turned up, per line: `quantity_returnable` is received
    minus already returned, and `purchasing_poi_returned_lte_received` is the
    database saying the same thing when two returns race.
    """
    purchase_order = PurchaseOrder.objects.select_for_update().get(pk=purchase_order.pk)

    if idempotency_key:
        existing = PurchaseReturn.objects.filter(idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing

    if purchase_order.status in {PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.CANCELLED}:
        raise Conflict(
            f"A {purchase_order.status} purchase order has received nothing, so nothing "
            f"can be sent back."
        )

    materialised = [line for line in lines if int(line.quantity) > 0]
    if not materialised:
        raise ValidationError("Nothing to return.")
    if not str(reason or "").strip():
        raise ValidationError("Say why the goods are going back — it goes on the audit record.")

    items = {
        str(item.pk): item
        for item in PurchaseOrderItem.objects.select_for_update()
        .select_related("variant")
        .filter(purchase_order=purchase_order)
    }

    purchase_return = PurchaseReturn.objects.create(
        number=next_number("purchase_return", prefix="PRN"),
        purchase_order=purchase_order,
        reason=reason,
        notes=notes,
        returned_at=timezone.now(),
        returned_by=actor,
        idempotency_key=idempotency_key or None,
    )

    credit = Decimal("0.00")
    for line in materialised:
        quantity = int(line.quantity)
        item = items.get(str(line.purchase_order_item_id))
        if item is None:
            raise ValidationError(
                f"Line {line.purchase_order_item_id} does not belong to {purchase_order.number}."
            )
        if quantity > item.quantity_returnable:
            raise ValidationError(
                f"Cannot return {quantity} of {item.variant.sku}: only "
                f"{item.quantity_returnable} received and not already sent back.",
                details={
                    "item_id": str(item.pk),
                    "requested": quantity,
                    "returnable": item.quantity_returnable,
                },
            )

        unit_cost = quantize(item.unit_cost)
        PurchaseReturnItem.objects.create(
            purchase_return=purchase_return,
            purchase_order_item=item,
            quantity=quantity,
            unit_cost=unit_cost,
        )
        # Stock leaves through the ledger, which also unwinds what it did to the
        # branch's weighted average cost (ADR-0006). Never a column write.
        inventory_services.return_to_supplier(
            branch=purchase_order.branch,
            variant=item.variant_id,
            quantity=quantity,
            unit_cost=unit_cost,
            actor=actor,
            reference_type="purchase_return",
            reference_id=purchase_return.pk,
            notes=f"{purchase_order.number} / {purchase_return.number}",
        )

        item.quantity_returned += quantity
        item.save(update_fields=["quantity_returned", "updated_at"])
        credit += quantize(unit_cost * quantity)

    purchase_return.credit_total = quantize(credit)
    purchase_return.save(update_fields=["credit_total", "updated_at"])

    purchase_order.credited_total = quantize(purchase_order.credited_total + credit)
    purchase_order.save(update_fields=["credited_total", "updated_at"])
    _refresh_payment_status(purchase_order)

    audit.record(
        action=audit.AuditAction.PURCHASE_RECEIVED,
        entity=purchase_order,
        actor=actor,
        old_values={"credited_total": str(purchase_order.credited_total - credit)},
        new_values={
            "return": purchase_return.number,
            "credit": str(purchase_return.credit_total),
            "credited_total": str(purchase_order.credited_total),
        },
        reason=notes or f"Returned to supplier: {reason}",
        branch=purchase_order.branch,
    )
    return purchase_return


@transaction.atomic
def cancel_purchase_order(
    *, purchase_order: PurchaseOrder, actor: User | None = None, reason: str = ""
) -> PurchaseOrder:
    """Withdraw an order nothing has happened to yet.

    Three things make an order impossible to cancel, and each is decided under
    the order's row lock -- the lock `receive_purchase` and
    `record_supplier_payment` both take -- so a delivery or a payment
    committing at the same moment is seen rather than overwritten (D81).
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
    # Payables (business-rules §4.2) drop a cancelled order, and a supplier
    # payment can be neither edited nor deleted (§6b.1b) -- so cancelling a paid
    # order left the money with the supplier and on no list anywhere (D80).
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

        # The model property, not a second copy of the formula: it subtracts
        # `credited_total` too. Without that, goods could be sent back and the
        # original total still paid — handing the supplier money for stock now
        # sitting in their own warehouse, with D62's guard none the wiser.
        outstanding = quantize(locked_order.outstanding)
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
        locked_order.save(update_fields=["paid_total", "updated_at"])
        _refresh_payment_status(locked_order)

    audit.record(
        action=audit.AuditAction.PAYMENT_RECORDED,
        entity=payment,
        actor=actor,
        new_values={"supplier": supplier.name, "amount": amount, "method": method},
        reason=notes,
    )
    return payment
