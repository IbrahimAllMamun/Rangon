"""The parity customer's orders, parcels, addresses and reviews.

Run through Django after fixture_accounts.py, like the other fixtures:

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_orders.py

All or nothing, and a second run finds the marker order and stops. Rows are
written with the models' own `create`, so each is one Django accepts; the few
timestamps a comparison depends on (ties, a timeline out of order) are set
afterwards with `update()`, which is the only way to backdate an append-only row.

What each piece is for:
- RGN-PARITY-0001, delivered: two lines (one partly returned, one with a
  product image and one without), a captured and a failed payment, a timeline
  with hidden entries, a tie, a payment logged before the order and a return
  step, and two parcels (one with a courier's tracking link, one bare).
- RGN-PARITY-0002, pending, with a note -- and a product only it contains
  (reviews: "not received").
- RGN-PARITY-0003, a cancelled counter sale with no guest token (D113).
- RGN-PARITY-0004, returned, with the same product as 0001: one review per
  purchase.
- RGN-PARITY-0009, the guest customer's, with its own token.
- `parity.many`: 52 orders, two of them sharing a `placed_at` -- the list's
  50-row cap and its order.
- Reviews: one already written for 0001's second product; one with no order
  at all, which makes `exclude(pk__in=...)` exclude every order (NULL in the
  subquery) -- a Django behaviour the port has to reproduce, not tidy up.
- Addresses: a default and a second one; `parity.many` has exactly one; the
  demo customer has none (its first becomes the default whatever was asked).
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from django.db import transaction

from accounts.models import Branch, Role, RoleCode, User
from accounts.services import get_organization
from catalog.models import Product, ProductImage, ProductVariant
from customers.models import AddressType, Customer, CustomerAddress, CustomerType
from engagement.models import Review, ReviewStatus
from orders.models import (
    Channel,
    Order,
    OrderEvent,
    OrderItem,
    OrderPaymentStatus,
    OrderStatus,
    Payment,
    PaymentMethod,
    PaymentState,
)
from shipping.models import Courier, Shipment, ShipmentEvent, ShipmentStatus, ShippingMethod

MARKER = "RGN-PARITY-0001"
BASE = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)


def at(hours: float) -> datetime:
    return BASE + timedelta(hours=hours)


def variant(slug: str) -> ProductVariant:
    return ProductVariant.objects.filter(product__slug=slug).order_by("sku").first()


def order(number: str, customer: Customer, **fields) -> Order:
    defaults = {
        "channel": Channel.ONLINE,
        "branch": Branch.objects.filter(is_default=True).first(),
        "customer": customer,
        "currency": "BDT",
    }
    return Order.objects.create(number=number, **{**defaults, **fields})


def line(order_: Order, slug: str, quantity: int, price: str, **fields) -> OrderItem:
    item = variant(slug)
    total = Decimal(price) * quantity
    return OrderItem.objects.create(
        order=order_,
        variant=item,
        sku=item.sku,
        product_name=item.product.name,
        variant_label=fields.pop("variant_label", "M / Blue"),
        quantity=quantity,
        unit_price=Decimal(price),
        unit_cost=Decimal("100.00"),
        line_total=total,
        **fields,
    )


def event(order_: Order, kind: str, hours: float, message: str = "", **fields) -> None:
    row = OrderEvent.objects.create(order=order_, event_type=kind, message=message, **fields)
    OrderEvent.objects.filter(pk=row.pk).update(created_at=at(hours))


def apply() -> None:
    customer = Customer.objects.get(user__email="parity.customer@rangon.test")
    guest = Customer.objects.get(email="parity.guest@rangon.test")
    method = ShippingMethod.objects.order_by("name").first()

    # A primary image placed after a plain one: `primary_image` takes the flag.
    top = Product.objects.get(slug="linen-blend-top")
    ProductImage.objects.create(product=top, image="products/linen-plain.jpg", position=0)
    ProductImage.objects.create(
        product=top, image="products/linen primary ü.jpg", position=5, is_primary=True
    )

    delivered = order(
        MARKER,
        customer,
        status=OrderStatus.DELIVERED,
        payment_status=OrderPaymentStatus.PAID,
        subtotal=Decimal("2990.00"),
        discount_total=Decimal("100.00"),
        coupon_discount=Decimal("100.00"),
        tax_total=Decimal("0.00"),
        shipping_total=Decimal("70.00"),
        grand_total=Decimal("2960.00"),
        paid_total=Decimal("2960.00"),
        refunded_total=Decimal("450.00"),
        shipping_method=method,
        shipping_address={
            "recipient_name": "Parvin Sultana",
            "phone": "8801711000001",
            "line1": "House 7, Road 3",
            "city": "Dhaka",
            "geo": {"lat": 23.75, "lng": 90.39},
        },
        guest_token="parity-token-0001",
        placed_at=at(0),
        delivered_at=at(48.5),
    )
    line(delivered, "parity-cotton-tee", 2, "1000.00", returned_quantity=1, fulfilled_quantity=2)
    line(delivered, "essential-cotton-t-shirt", 1, "990.00", variant_label="")
    line(delivered, "block-print-kurti", 1, "0.00")
    Payment.objects.create(
        order=delivered, method=PaymentMethod.MOBILE_MFS, status=PaymentState.FAILED,
        amount=Decimal("2960.00"), failed_at=at(0.1),
    )
    Payment.objects.create(
        order=delivered, method=PaymentMethod.COD, status=PaymentState.CAPTURED,
        amount=Decimal("2960.00"), captured_at=at(48.5),
    )
    # The timeline, deliberately out of order: the payment is logged before the
    # order's own "placed" entry, as checkout does it.
    event(delivered, "PAYMENT_RECORDED", -0.01, "COD recorded", data={"status": "PENDING"})
    event(delivered, "CREATED", 0, "Order placed online")
    event(delivered, "PAYMENT_FAILED", 0.1, "bKash declined")
    event(delivered, "STATUS_CHANGED", 1, "PENDING → CONFIRMED", data={"to": "CONFIRMED"})
    event(delivered, "NOTE_ADDED", 1, "Customer asked for gift wrap")
    event(delivered, "STATUS_CHANGED", 2, "CONFIRMED → PACKED", data={"to": "PACKED", "reason": "x"})
    event(delivered, "SHIPMENT_CREATED", 2, "Booked with Pathao")  # the same instant: a tie
    event(delivered, "STATUS_CHANGED", 3, "Internal only", data={"to": "SHIPPED"},
          is_customer_visible=False)
    event(delivered, "STATUS_CHANGED", 48.5, "SHIPPED → DELIVERED", data={"to": "DELIVERED"})
    event(delivered, "PAYMENT_RECORDED", 48.5, "Cash collected", data={"status": "CAPTURED"})
    event(delivered, "STATUS_CHANGED", 49, "to nowhere", data={"to": "ON_HOLD"})
    event(delivered, "RETURN_REQUESTED", 60, "Return RET-900 requested")
    event(delivered, "RETURN_UPDATED", 61, "Return RET-900 rejected: stained, not our fault")
    event(delivered, "RETURN_UPDATED", 62, "Return RET-900 changed")
    event(delivered, "REFUND_ISSUED", 63, "Refund 450.00")
    event(delivered, "SHIPMENT_EVENT", 30, "IN_TRANSIT: At the hub")

    courier = Courier.objects.create(
        name="Parity Courier", code="parity-courier",
        tracking_url_template="https://track.parity.test/{tracking_number}?ref=rangon",
    )
    parcel = Shipment.objects.create(
        order=delivered, courier=courier, tracking_number="PT 0001/ü", status=ShipmentStatus.DELIVERED,
        cost=Decimal("70.00"), dispatched_at=at(3), delivered_at=at(48.5), notes="Fragile",
    )
    for status, hours, message, location in [
        (ShipmentStatus.DELIVERED, 48.5, "Handed to the customer", "Dhanmondi"),
        (ShipmentStatus.DISPATCHED, 3, "Collected from the shop", "Panthapath"),
        (ShipmentStatus.IN_TRANSIT, 30, "", ""),
    ]:
        ShipmentEvent.objects.create(
            shipment=parcel, status=status, message=message, location=location, occurred_at=at(hours)
        )
    Shipment.objects.create(order=delivered, status=ShipmentStatus.PENDING)

    pending = order(
        "RGN-PARITY-0002",
        customer,
        subtotal=Decimal("1800.00"),
        grand_total=Decimal("1800.00"),
        customer_note="Leave it at the door",
        guest_token="parity-token-0002",
        placed_at=at(100),
    )
    line(pending, "slim-fit-chinos", 1, "1800.00")
    line(pending, "linen-blend-top", 1, "0.00")

    cancelled = order(
        "RGN-PARITY-0003",
        customer,
        channel=Channel.POS,
        status=OrderStatus.CANCELLED,
        subtotal=Decimal("500.00"),
        grand_total=Decimal("500.00"),
        cancel_reason="Customer changed their mind",
        cancelled_at=at(-47),
        placed_at=at(-48),
    )
    line(cancelled, "matte-lipstick", 1, "500.00")
    event(cancelled, "CANCELLED", -47, "Cancelled at the counter")

    returned = order(
        "RGN-PARITY-0004",
        customer,
        status=OrderStatus.RETURNED,
        subtotal=Decimal("1000.00"),
        grand_total=Decimal("1000.00"),
        guest_token="parity-token-0004",
        placed_at=at(20),
    )
    line(returned, "parity-cotton-tee", 1, "1000.00", returned_quantity=1)

    guest_order = order(
        "RGN-PARITY-0009",
        guest,
        subtotal=Decimal("990.00"),
        grand_total=Decimal("990.00"),
        guest_token="parity-token-0009",
        placed_at=at(5),
    )
    line(guest_order, "essential-cotton-t-shirt", 1, "990.00")

    # Reviews already written: 0001's second product, and one attached to no
    # order at all.
    for slug, order_ in [("essential-cotton-t-shirt", delivered), ("block-print-kurti", None)]:
        Review.objects.create(
            product=Product.objects.get(slug=slug),
            customer=customer,
            order=order_,
            rating=4,
            title="Parity fixture review",
            verified_purchase=order_ is not None,
            status=ReviewStatus.APPROVED,
            moderation_note="parity-fixture",
        )

    CustomerAddress.objects.create(
        customer=customer, label="Home", recipient_name="Parvin Sultana", phone="01711000001",
        line1="House 7, Road 3", area="Dhanmondi", city="Dhaka", is_default=True,
    )
    CustomerAddress.objects.create(
        customer=customer, label="Office", address_type=AddressType.SHIPPING,
        recipient_name="Parvin Sultana", phone="+880 1811-000002", line1="Level 4, 12 Kemal Ataturk Ave",
        city="Dhaka", district="Dhaka", postal_code="1213", notes="Reception desk",
    )

    many_user = User.objects.create_user(
        email="parity.many@rangon.test",
        password="Parity-Pass-2026!",
        role=Role.objects.get(code=RoleCode.CUSTOMER),
        organization=get_organization(),
    )
    many = Customer.objects.create(
        user=many_user, name="Parity Many", email=many_user.email,
        customer_type=CustomerType.REGISTERED,
    )
    # Exactly one address: un-defaulting it is refused.
    CustomerAddress.objects.create(
        customer=many, recipient_name="Parity Many", phone="01711000005", line1="Road 1",
        city="Sylhet", is_default=True,
    )
    for index in range(52):
        # Orders 10 and 11 share an instant: the list's ORDER BY decides the tie.
        placed = at(200 + (10 if index == 11 else index))
        row = order(f"RGN-PARITY-M{index:03d}", many, placed_at=placed,
                    subtotal=Decimal("10.00"), grand_total=Decimal("10.00"))
        line(row, "matte-lipstick", 1 + index % 3, "10.00")


if Order.objects.filter(number=MARKER).exists():
    print("parity orders fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity orders fixture applied")
