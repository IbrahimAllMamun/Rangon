"""Customers to write to, for the parity suite's background jobs (phase 7 part 4b).

Applied by `scripts/nest-parity.sh seed`, after fixture_reports.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_jobs.py

Idempotent: it does nothing when its first order is already there.

Four customers, each with one order at PAR3 dated May 2025 -- rows with
frozen figures, as fixture_reports.py's are: no stock moves and no money:

- PAR-JOB-0001  "Parity Jobs Mobile": an email, and a mobile on the parity
  stack's SMS_ALLOWLIST. Delivered, part refunded.
- PAR-JOB-0002  a name in Bengali, an email, a mobile that is not on the
  allowlist. Shipped.
- PAR-JOB-0003  "Parity Jobs Landline": no email, and a number that is no
  mobile.
- PAR-JOB-0004  "Parity Jobs Nophone": an email and no number at all.
"""

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction

from accounts.models import Branch, User
from catalog.models import ProductVariant
from customers.models import Customer
from orders.models import Order, OrderItem

MARKER = "PAR-JOB-0001"
DHAKA = ZoneInfo("Asia/Dhaka")
D = Decimal


def apply() -> None:
    owner = User.objects.get(email="owner@rangon.test")
    mirpur = Branch.objects.get(code="PAR3")
    shirt = ProductVariant.objects.select_related("product").get(sku="RGN-CLA-M-WHI")

    def order(number, day, status, customer, **totals):
        placed = datetime(2025, 5, day, 12, 0, tzinfo=DHAKA)
        made = Order.objects.create(
            number=number,
            channel="ONLINE",
            branch=mirpur,
            customer=customer,
            status=status,
            payment_status="PAID",
            placed_at=placed,
            created_by=owner,
            subtotal=D("1250.50"),
            grand_total=D("1250.50"),
            paid_total=D("1250.50"),
            **totals,
        )
        Order.objects.filter(pk=made.pk).update(created_at=placed, updated_at=placed)
        OrderItem.objects.create(
            order=made,
            variant=shirt,
            sku=shirt.sku,
            product_name=shirt.product.name,
            variant_label=shirt.label,
            quantity=1,
            unit_price=D("1250.50"),
            unit_cost=D("400.00"),
            line_total=D("1250.50"),
            fulfilled_quantity=1,
        )

    order(
        MARKER,
        5,
        "DELIVERED",
        Customer.objects.create(
            name="Parity Jobs Mobile",
            phone="8801911000801",
            email="parity.jobs.mobile@rangon.test",
        ),
        refunded_total=D("250.50"),
    )
    order(
        "PAR-JOB-0002",
        6,
        "SHIPPED",
        Customer.objects.create(
            name="প্যারিটি ক্রেতা",
            phone="8801911000802",
            email="parity.jobs.bangla@rangon.test",
        ),
    )
    # `Customer.save()` takes a mobile or nothing; rows from before it did carry
    # other numbers, and `send_sms` is written for them. Written underneath it.
    landline = Customer.objects.create(name="Parity Jobs Landline", phone=None)
    Customer.objects.filter(pk=landline.pk).update(phone="029876543")
    landline.refresh_from_db()
    order("PAR-JOB-0003", 7, "CONFIRMED", landline)
    order(
        "PAR-JOB-0004",
        8,
        "CONFIRMED",
        Customer.objects.create(
            name="Parity Jobs Nophone", phone=None, email="parity.jobs.nophone@rangon.test"
        ),
    )
    print("parity jobs fixture applied")


if Order.objects.filter(number=MARKER).exists():
    print("parity jobs fixture already applied")
else:
    with transaction.atomic():
        apply()
