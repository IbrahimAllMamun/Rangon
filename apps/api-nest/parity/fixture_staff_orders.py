"""Online orders with real reservations, for the staff order screens (phase 5).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_staff_orders.py

All or nothing, and a second run finds the first order and stops. Test data for
the parity database only. Each order's stock is reserved by `inventory.reserve`
and moved by the status machine itself, so its shelf and ledger are the ones
the API would have left. What each is for:

- S01: CONFIRMED, two lines, cash on delivery still pending, for a customer
  with an account. The order the status machine is walked on, and cancelled.
- S02: PROCESSING, paid by card, with a coupon used: cancelling it gives the
  stock, the coupon's use and the money back.
- S03: PENDING, 500.00 of 890.00 paid in cash and the rest pending on
  delivery: a cancel refunds what was paid; a payment of 390.00 captures.
- S04: PACKED by the status machine, so its stock has left the shelf.
- S05: SHIPPED the same way; delivering it tells the customer.
- S06: CONFIRMED at PAR3, on three tees received there for it, which a manager
  bound to DHK1 cannot see.
- S07: PENDING, paid and then refunded in full: nothing is left to refund.
- S08: DELIVERED and paid on delivery, for refunds from the back office.
"""

from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, User
from catalog.models import ProductVariant
from customers.models import Customer
from inventory import services as stock
from orders.models import Channel, Order, OrderItem, OrderStatus, PaymentState
from orders.services import lifecycle, payments
from promotions import services as promotions
from promotions.models import Coupon

MARKER = "RGN-PARITY-S01"
SHIRT = "RGN-CLA-M-WHI"  # 2450.00
TEE = "RGN-ESS-M-OLI"  # 890.00


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    manager = User.objects.get(email="manager@rangon.test")
    member = Customer.objects.get(email="parity.customer@rangon.test")
    guest = Customer.objects.get(email="parity.guest@rangon.test")
    now = timezone.now()

    def order(number, status, lines, customer=member, branch=home, discount="0.00", **fields):
        subtotal = Decimal("0.00")
        made = Order.objects.create(
            number=number,
            channel=Channel.ONLINE,
            status=status,
            branch=branch,
            customer=customer,
            currency="BDT",
            placed_at=now - timedelta(minutes=90 - int(number[-2:])),
            **fields,
        )
        for sku, quantity in lines:
            variant = ProductVariant.objects.get(sku=sku)
            total = variant.price * quantity
            subtotal += total
            OrderItem.objects.create(
                order=made,
                variant=variant,
                sku=variant.sku,
                product_name=variant.product.name,
                variant_label=variant.label,
                quantity=quantity,
                unit_price=variant.price,
                unit_cost=Decimal("400.00"),
                line_total=total,
            )
        made.subtotal = subtotal
        made.discount_total = Decimal(discount)
        made.coupon_discount = Decimal(discount)
        made.grand_total = subtotal - Decimal(discount)
        made.save()
        stock.reserve(
            branch=branch,
            lines=[(ProductVariant.objects.get(sku=sku), quantity) for sku, quantity in lines],
            reference_id=made.pk,
        )
        return made

    def pay(made, method, amount, status=PaymentState.CAPTURED):
        return payments.record_payment(
            order=made, method=method, amount=Decimal(amount), actor=manager, status=status
        )

    def move(made, *statuses):
        for status in statuses:
            made = lifecycle.transition(order=made, to_status=status, actor=manager, notify=False)
        return made

    first = order(MARKER, OrderStatus.CONFIRMED, [(SHIRT, 2), (TEE, 1)])
    pay(first, "COD", "5790.00", PaymentState.PENDING)

    coupon = Coupon.objects.get(code="PARITY-THRICE")
    couponed = order(
        "RGN-PARITY-S02", OrderStatus.PROCESSING, [(TEE, 2)], discount="178.00", coupon=coupon
    )
    promotions.redeem(coupon=coupon, order=couponed, discount=Decimal("178.00"), customer=member)
    pay(couponed, "CARD", "1602.00")

    part = order("RGN-PARITY-S03", OrderStatus.PENDING, [(TEE, 1)], customer=guest)
    pay(part, "CASH", "500.00")
    pay(part, "COD", "390.00", PaymentState.PENDING)

    packed = order("RGN-PARITY-S04", OrderStatus.PROCESSING, [(SHIRT, 1)])
    pay(packed, "COD", "2450.00", PaymentState.PENDING)
    move(packed, OrderStatus.PACKED)

    shipped = order("RGN-PARITY-S05", OrderStatus.PROCESSING, [(TEE, 1)])
    pay(shipped, "COD", "890.00", PaymentState.PENDING)
    move(shipped, OrderStatus.PACKED, OrderStatus.SHIPPED)

    # Its own stock: the counter's race checks sell PAR3's last units of its own tee.
    stock.receive_stock(
        branch=mirpur,
        variant=ProductVariant.objects.get(sku=TEE),
        quantity=3,
        unit_cost=Decimal("380.00"),
        actor=manager,
    )
    away = order(
        "RGN-PARITY-S06",
        OrderStatus.CONFIRMED,
        [(TEE, 1)],
        customer=guest,
        branch=mirpur,
    )
    pay(away, "COD", "890.00", PaymentState.PENDING)

    settled = order("RGN-PARITY-S07", OrderStatus.PENDING, [(TEE, 1)], customer=guest)
    pay(settled, "CASH", "890.00")
    payments.refund_order(
        order=settled, amount=Decimal("890.00"), actor=manager, reason="Paid twice"
    )

    delivered = order("RGN-PARITY-S08", OrderStatus.PROCESSING, [(SHIRT, 1), (TEE, 2)])
    cod = pay(delivered, "COD", "4230.00", PaymentState.PENDING)
    move(delivered, OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.DELIVERED)
    payments.capture_payment(payment=cod, actor=manager)
    print("parity staff orders fixture applied")


if Order.objects.filter(number=MARKER).exists():
    print("parity staff orders fixture already applied")
else:
    with transaction.atomic():
        apply()
