"""Customers, their notes, and the call-back list, for the back office (phase 6).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_customers.py

All or nothing, and a second run finds the first customer and stops. Test data
for the parity database only; addresses and notes are written by
`customers.services`.

- "Parity Ledger Lady": a WHOLESALE customer with a birthday, tags that hold a
  float and an object, staff commentary, two addresses -- a default and one
  more -- and two notes, one pinned.
- "Parity Email Only": no phone, so no lookup at the counter can find them.
- "Parity Gone": deactivated, which is what deleting a customer does.
- "Parity One Address": a single address, which must stay the default.

For the call-back list (`orders_abandonedcheckout`), beside the one open lead
fixture_orders.py made:
- a lead RECOVERED by an order, one written off as LOST with a note, and an
  open one at PAR3, which staff bound to DHK1 cannot see.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, User
from customers import services as customers
from customers.models import Customer, CustomerType
from orders.models import AbandonedCheckout, AbandonedCheckoutStatus, Order

MARKER = "Parity Ledger Lady"


def apply() -> None:
    manager = User.objects.get(email="manager@rangon.test")

    def address(customer: Customer, **data: object) -> None:
        customers.add_address(
            customer=customer,
            data={"recipient_name": customer.name, "phone": customer.phone, **data},
            actor=manager,
        )

    lady = Customer.objects.create(
        name=MARKER,
        phone="01911000301",
        email="ledger.lady@parity.test",
        customer_type=CustomerType.WHOLESALE,
        date_of_birth=date(1988, 3, 14),
        notes="Parity: buys by the carton",
        tags=["vip", 2.5, {"tier": 3}],
        created_by=manager,
    )
    address(lady, label="Shop", line1="Shop 14, Gausia Market", city="Dhaka", area="New Market")
    address(
        lady,
        label="Godown",
        address_type="SHIPPING",
        line1="Plot 9, Tongi Industrial Area",
        city="Gazipur",
        district="Gazipur",
        postal_code="1710",
        notes="Ring the bell twice",
    )
    customers.add_note(
        customer=lady, body="Parity: pays on the 5th of the month", is_pinned=True, actor=manager
    )
    customers.add_note(customer=lady, body="Parity: asked for a catalogue", actor=manager)

    Customer.objects.create(name="Parity Email Only", email="email.only@parity.test")
    Customer.objects.create(
        name="Parity Gone", phone="01911000302", is_active=False, customer_type=CustomerType.GUEST
    )
    single = Customer.objects.create(name="Parity One Address", phone="01911000303")
    address(single, line1="House 1, Road 1", city="Khulna")

    home = Branch.objects.get(code="DHK1")
    now = timezone.now()
    order = Order.objects.filter(channel="ONLINE").order_by("number").first()
    AbandonedCheckout.objects.create(
        phone="8801911000311",
        name="Parity Recovered",
        email="recovered@parity.test",
        branch=home,
        status=AbandonedCheckoutStatus.RECOVERED,
        cart_total=Decimal("3120.00"),
        item_count=3,
        last_seen_at=now - timedelta(days=2),
        recovered_at=now - timedelta(days=1),
        recovered_order=order,
        customer=lady,
        note="Parity: ordered after the second call",
    )
    AbandonedCheckout.objects.create(
        phone="8801911000312",
        name="",
        branch=home,
        status=AbandonedCheckoutStatus.LOST,
        cart_total=Decimal("990.00"),
        item_count=1,
        last_seen_at=now - timedelta(days=5),
        note="Parity: wrong number",
    )
    AbandonedCheckout.objects.create(
        phone="8801911000313",
        name="Parity Mirpur Lead",
        branch=Branch.objects.get(code="PAR3"),
        cart_total=Decimal("450.00"),
        item_count=2,
        last_seen_at=now - timedelta(hours=3),
    )
    print("parity customers fixture applied")


if Customer.objects.filter(name=MARKER).exists():
    print("parity customers fixture already applied")
else:
    with transaction.atomic():
        apply()
