"""Shipping settings and parcels for the parity suite (phase 6 part 8).

Applied by `scripts/nest-parity.sh seed`, after fixture_customers.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_shipping.py

Idempotent: it does nothing when its first order is already there.

Settings, beside the demo seed's and fixture_cart.py's zones and methods:

- "Parity Empty Zone": inactive, no cities, no methods. Nothing names it.
- "Parity Idle Courier" (`parity-idle`): inactive, no tracking page, no parcel.

Orders of one tee each, by number, and the parcels on them. Each order's stock
is received for it first, so nothing else's available stock moves:

- H01: CONFIRMED. A PENDING parcel with Parity Courier, number PAR-H01: it
  cannot leave before the order is packed.
- H02: PACKED. A PENDING parcel with Pathao, number PAR-H02: its DISPATCHED
  ships the order, its DELIVERED delivers it.
- H03: SHIPPED. A DISPATCHED parcel (PAR-H03) and a second PENDING one with
  no courier: a split delivery.
- H04: DELIVERED. A DELIVERED parcel (PAR-H04) and a second PENDING one
  (PAR-H04-B) that has not left.
- H05: SHIPPED at PAR3, for a guest. An IN_TRANSIT parcel with Rangon
  Delivery, which has no tracking page.
- H06: SHIPPED. A RETURNED parcel (PAR-H06): its history is closed.
- H07: PROCESSING, no parcel.
- H08: SHIPPED. A FAILED parcel (PAR-H08): a failed attempt is retried.
"""

from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, User
from catalog.models import ProductVariant
from customers.models import Customer
from inventory import services as stock
from inventory.models import Inventory
from orders.models import Channel, Order, OrderItem, OrderStatus, PaymentState
from orders.services import lifecycle, payments
from shipping import services as shipping
from shipping.models import Courier, ShipmentStatus, ShippingMethod, ShippingZone

MARKER = "RGN-PARITY-H01"
TEE = "RGN-ESS-M-OLI"  # 890.00


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    manager = User.objects.get(email="manager@rangon.test")
    member = Customer.objects.get(email="parity.customer@rangon.test")
    guest = Customer.objects.get(email="parity.guest@rangon.test")
    tee = ProductVariant.objects.get(sku=TEE)
    now = timezone.now()

    ShippingZone.objects.create(
        name="Parity Empty Zone", description="Nothing ships here", position=9, is_active=False
    )
    Courier.objects.create(name="Parity Idle Courier", code="parity-idle", is_active=False)
    parity = Courier.objects.get(code="parity-courier")
    pathao = Courier.objects.get(code="pathao")
    house = Courier.objects.get(code="in-house")
    method = ShippingMethod.objects.get(code="p-std")

    def order(number, *statuses, customer=member, branch=home, **fields):
        # Received at what the shelf already averages, so the average stays.
        shelf = Inventory.objects.get(branch=branch, variant=tee)
        stock.receive_stock(
            branch=branch, variant=tee, quantity=1, unit_cost=shelf.average_cost, actor=manager
        )
        made = Order.objects.create(
            number=number,
            channel=Channel.ONLINE,
            status=OrderStatus.CONFIRMED,
            branch=branch,
            customer=customer,
            currency="BDT",
            placed_at=now - timedelta(minutes=200 - int(number[-2:])),
            subtotal=tee.price,
            grand_total=tee.price,
            **fields,
        )
        OrderItem.objects.create(
            order=made,
            variant=tee,
            sku=tee.sku,
            product_name=tee.product.name,
            variant_label=tee.label,
            quantity=1,
            unit_price=tee.price,
            unit_cost=Decimal("400.00"),
            line_total=tee.price,
        )
        stock.reserve(branch=branch, lines=[(tee, 1)], reference_id=made.pk)
        payments.record_payment(
            order=made,
            method="COD",
            amount=tee.price,
            actor=manager,
            status=PaymentState.PENDING,
        )
        # The customer is not told: these orders moved before the suite began.
        for status in statuses:
            made = lifecycle.transition(order=made, to_status=status, actor=manager, notify=False)
        return made

    def parcel(made, courier=None, number="", cost="0.00", **fields):
        return shipping.create_shipment(
            order=made,
            courier=courier,
            tracking_number=number,
            cost=Decimal(cost),
            actor=manager,
            **fields,
        )

    def told(shipment, *updates):
        for status, hours, message, location in updates:
            shipping.record_event(
                shipment=shipment,
                status=status,
                message=message,
                location=location,
                occurred_at=now - timedelta(hours=hours),
                actor=manager,
            )

    packing = (OrderStatus.PROCESSING, OrderStatus.PACKED)
    shipped = (*packing, OrderStatus.SHIPPED)

    waiting = order(MARKER, shipping_method=method)
    parcel(waiting, parity, "PAR-H01", "60.00", shipping_method=method, notes="Fragile")

    packed = order("RGN-PARITY-H02", *packing)
    parcel(packed, pathao, "PAR-H02", "80.00")

    split = order("RGN-PARITY-H03", *shipped)
    told(parcel(split, parity, "PAR-H03", "60.00"), (ShipmentStatus.DISPATCHED, 20, "", "Tejgaon"))
    parcel(split, notes="The second box")

    # Both booked while it was on its way: a delivered order takes no new parcel.
    home_already = order("RGN-PARITY-H04", *shipped)
    first = parcel(home_already, parity, "PAR-H04", "60.00")
    parcel(home_already, parity, "PAR-H04-B", "60.00")
    told(
        first,
        (ShipmentStatus.DISPATCHED, 30, "Collected", "Panthapath"),
        (ShipmentStatus.IN_TRANSIT, 26, "", ""),
    )
    lifecycle.transition(
        order=home_already, to_status=OrderStatus.DELIVERED, actor=manager, notify=False
    )
    told(first, (ShipmentStatus.DELIVERED, 22, "Handed over", "Dhanmondi"))

    away = order("RGN-PARITY-H05", *shipped, customer=guest, branch=mirpur)
    told(
        parcel(away, house, "RD-5", "0.00"),
        (ShipmentStatus.DISPATCHED, 12, "", ""),
        (ShipmentStatus.IN_TRANSIT, 10, "On the van", "Mirpur 10"),
    )

    back = order("RGN-PARITY-H06", *shipped)
    told(
        parcel(back, pathao, "PAR-H06", "80.00", shipping_method=method),
        (ShipmentStatus.DISPATCHED, 50, "", ""),
        (ShipmentStatus.FAILED, 44, "Nobody home", "Uttara"),
        (ShipmentStatus.RETURNED, 40, "Sent back", ""),
    )

    order("RGN-PARITY-H07", OrderStatus.PROCESSING)

    retried = order("RGN-PARITY-H08", *shipped, customer=guest)
    told(
        parcel(retried, pathao, "PAR-H08", "80.00"),
        (ShipmentStatus.DISPATCHED, 9, "", ""),
        (ShipmentStatus.FAILED, 5, "Phone switched off", "Banani"),
    )
    print("parity shipping fixture applied")


if Order.objects.filter(number=MARKER).exists():
    print("parity shipping fixture already applied")
else:
    with transaction.atomic():
        apply()
