"""Suppliers and their price lists, for the buying screens (phase 6).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_purchasing.py

All or nothing, and a second run finds the first supplier and stops. Test data
for the parity database only.

- "Parity Idle Traders" (PARITY-IDLE): INACTIVE, with a landline, an email, a
  tax id and terms of its own, and never ordered from or paid -- the one
  supplier that can be deleted, its price list with it. It quotes two SKUs
  nobody else supplies: PAR-TEE-S-WHT under its own code, lead time and
  minimum, and PAR-TEE-S-BLK, an offer since withdrawn.
- "Parity Sole Agent" (PARITY-SOLE): ACTIVE, never ordered from either, and
  the preferred supplier of PAR-TEE-S-WHT, promoted by the service -- so that
  SKU has two offers and one preference to move.

For purchase orders (their own marker, the invoice number "PAR-PO-DRAFT"),
all on three draft products made here -- PAR-BUY-A and PAR-BUY-C priced,
PAR-BUY-B at nothing -- so no other check's stock moves. Each order is named
by its invoice number:
- PAR-PO-DRAFT: a draft from the sole agent, a line with a discount and VAT,
  shipping on top, and a date it is expected.
- PAR-PO-SENT: sent, nothing received.
- PAR-PO-PART: five of eight PAR-BUY-A received at 190.00 against an order
  at 200.00; none of the five PAR-BUY-B.
- PAR-PO-DONE: received in full, then two PAR-BUY-C sent back as damaged
  under an `Idempotency-Key` a case replays: 600.00 of credit.
- PAR-PO-CANCELLED: a draft cancelled; PAR-PO-CLOSED: a sent order closed by
  hand, the one status no service sets.
- PAR-PO-PAID: sent, with 500.00 recorded as paid against it (written to the
  row: no account is touched), which cancelling refuses.
- PAR-PO-MIRPUR: sent from PAR3 by its own manager, which staff bound to DHK1
  cannot see.
"""

from datetime import date
from decimal import Decimal

from django.db import transaction

from accounts.models import Branch, User
from catalog.models import Category, Product, ProductVariant
from catalog.services import create_variant
from purchasing import services as purchasing
from purchasing.models import (
    PaymentStatus,
    PurchaseOrder,
    PurchaseOrderStatus,
    PurchaseReturnReason,
    Supplier,
    SupplierProduct,
    SupplierStatus,
)
from purchasing.services import PurchaseLine, ReturnLine

MARKER = "PARITY-IDLE"
ORDERS_MARKER = "PAR-PO-DRAFT"


def apply() -> None:
    buyer = User.objects.get(email="manager@rangon.test")
    white = ProductVariant.objects.get(sku="PAR-TEE-S-WHT")
    black = ProductVariant.objects.get(sku="PAR-TEE-S-BLK")

    idle = Supplier.objects.create(
        name="Parity Idle Traders",
        code=MARKER,
        contact_person="Shahana Akter",
        phone="02-9612345",
        email="orders@parity-idle.test",
        address="12 Nawabpur Road, Dhaka",
        tax_id="BIN-000123456",
        payment_terms_days=45,
        lead_time_days=14,
        status=SupplierStatus.INACTIVE,
        notes="Parity: closed for the season",
    )
    SupplierProduct.objects.create(
        supplier=idle,
        variant=white,
        supplier_sku="IDLE-TS-W",
        last_cost=Decimal("210.00"),
        lead_time_days=3,
        minimum_order_quantity=12,
        notes="Parity quote",
        created_by=buyer,
    )
    SupplierProduct.objects.create(
        supplier=idle,
        variant=black,
        last_cost=Decimal("199.99"),
        is_active=False,
        notes="Parity withdrawn",
        created_by=buyer,
    )

    sole = Supplier.objects.create(name="Parity Sole Agent", code="PARITY-SOLE", lead_time_days=5)
    SupplierProduct.objects.create(
        supplier=sole, variant=white, last_cost=Decimal("205.00"), created_by=buyer
    )
    purchasing.set_preferred_supplier(variant_id=white.pk, supplier=sole, actor=buyer)
    print("parity purchasing fixture applied")


if Supplier.objects.filter(code=MARKER).exists():
    print("parity purchasing fixture already applied")
else:
    with transaction.atomic():
        apply()


def apply_orders() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    buyer = User.objects.get(email="manager@rangon.test")
    storeman = User.objects.get(email="stock@rangon.test")
    sole = Supplier.objects.get(code="PARITY-SOLE")
    leaf = Category.objects.get(slug="parity-leaf")

    def bought(letter: str, price: str) -> ProductVariant:
        product = Product.objects.create(
            name=f"Parity Bought {letter}", slug=f"parity-bought-{letter.lower()}", category=leaf
        )
        return create_variant(
            product=product, attribute_values=[], price=Decimal(price), sku=f"PAR-BUY-{letter}"
        )

    a = bought("A", "500.00")
    b = bought("B", "0.00")
    c = bought("C", "450.00")

    def order(invoice: str, lines: list[PurchaseLine], **extra: object) -> PurchaseOrder:
        return purchasing.create_purchase_order(
            supplier=extra.pop("supplier", sole),
            branch=extra.pop("branch", home),
            lines=lines,
            actor=extra.pop("actor", buyer),
            invoice_number=invoice,
            **extra,
        )

    def line(variant: ProductVariant, quantity: int, cost: str, **extra: Decimal) -> PurchaseLine:
        return PurchaseLine(
            variant_id=variant.pk, quantity=quantity, unit_cost=Decimal(cost), **extra
        )

    order(
        ORDERS_MARKER,
        [
            line(a, 10, "200.00", discount=Decimal("100.00"), tax_rate=Decimal("0.1500")),
            line(b, 4, "50.00"),
        ],
        expected_at=date(2026, 11, 15),
        shipping_total=Decimal("150.00"),
        notes="Parity: a draft",
    )

    sent = order("PAR-PO-SENT", [line(a, 6, "210.00"), line(c, 3, "300.00")])
    purchasing.send_purchase_order(purchase_order=sent, actor=buyer)

    part = order("PAR-PO-PART", [line(a, 8, "200.00"), line(b, 5, "55.00")])
    purchasing.send_purchase_order(purchase_order=part, actor=buyer)
    first = part.items.get(variant=a)
    purchasing.receive_purchase(
        purchase_order=part,
        lines={first.pk: 5},
        unit_costs={str(first.pk): Decimal("190.00")},
        actor=storeman,
        notes="Parity: the first cartons",
    )

    done = order("PAR-PO-DONE", [line(a, 4, "205.00"), line(c, 6, "300.00")])
    purchasing.send_purchase_order(purchase_order=done, actor=buyer)
    purchasing.receive_purchase(
        purchase_order=done,
        lines={item.pk: item.quantity_ordered for item in done.items.all()},
        actor=storeman,
    )
    purchasing.create_purchase_return(
        purchase_order=done,
        lines=[ReturnLine(purchase_order_item_id=done.items.get(variant=c).pk, quantity=2)],
        reason=PurchaseReturnReason.DAMAGED,
        actor=storeman,
        notes="Parity: crushed in the van",
        idempotency_key="parity-return-keyed",
    )

    cancelled = order("PAR-PO-CANCELLED", [line(b, 2, "50.00")])
    purchasing.cancel_purchase_order(
        purchase_order=cancelled, actor=buyer, reason="Parity: ordered twice"
    )

    closed = order("PAR-PO-CLOSED", [line(c, 2, "300.00")])
    purchasing.send_purchase_order(purchase_order=closed, actor=buyer)
    PurchaseOrder.objects.filter(pk=closed.pk).update(status=PurchaseOrderStatus.CLOSED)

    paid = order("PAR-PO-PAID", [line(c, 5, "300.00")])
    purchasing.send_purchase_order(purchase_order=paid, actor=buyer)
    PurchaseOrder.objects.filter(pk=paid.pk).update(
        paid_total=Decimal("500.00"), payment_status=PaymentStatus.PARTIALLY_PAID
    )

    away = order(
        "PAR-PO-MIRPUR",
        [line(a, 3, "200.00")],
        branch=mirpur,
        actor=User.objects.get(email="parity.mirpur@rangon.test"),
        supplier=Supplier.objects.get(code="SUP-001"),
    )
    purchasing.send_purchase_order(purchase_order=away, actor=buyer)
    print("parity purchase orders fixture applied")


if PurchaseOrder.objects.filter(invoice_number=ORDERS_MARKER).exists():
    print("parity purchase orders fixture already applied")
else:
    with transaction.atomic():
        apply_orders()
