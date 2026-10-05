"""Held sales and a till at the second branch, for the POS (phase 5).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_pos.py

All or nothing, and a second run finds the till and stops. Test data for the
parity database only. What each row is for:
- "Parity Mirpur Till": an active cash account at PAR3, so the register there
  opens with one and a sale there has somewhere to put its takings.
- At DHK1: twenty-two holds, a minute apart, so the session shows the newest
  twenty and the list shows them all. Among them a hold for a named customer
  parked by the manager, one whose cashier is gone (`created_by` empty), one
  with a register and no label, and payloads that are not a cart: a list, a
  string, an integer past 2^53, floats and Bengali text.
- At PAR3: two holds parked by its manager -- a hold at another branch is
  not found, and an owner reads them with `?branch=`.
"""

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, User
from catalog.models import ProductVariant
from customers.models import Customer
from finance.models import Account, AccountKind
from orders.models import HeldSale

MARKER = "Parity Mirpur Till"


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    cashier = User.objects.get(email="cashier@rangon.test")
    manager = User.objects.get(email="manager@rangon.test")
    mirpur_manager = User.objects.get(email="parity.mirpur@rangon.test")
    customer = Customer.objects.get(email="parity.customer@rangon.test")
    variant = ProductVariant.objects.get(sku="RGN-CLA-L-WHI")

    Account.objects.create(branch=mirpur, name=MARKER, kind=AccountKind.CASH, is_default=True)

    start = timezone.now() - timedelta(hours=3)
    cart = {
        "lines": [{"variant": str(variant.pk), "sku": variant.sku, "quantity": 2}],
        "manual_discount": "50.00",
        "note": "Back in ten minutes",
    }
    special = {
        5: {"created_by": manager, "customer": customer, "label": "Parvin, fitting room"},
        7: {"created_by": None, "label": "Cashier gone"},
        10: {"payload": [1, 2.5, "x", None, True]},
        11: {"payload": "just a note"},
        12: {"payload": 12345678901234567890},
        13: {"payload": {"a": 1.0, "b": 1000.0, "c": -0.5, "ব": "৳ 1,290"}},
        14: {"label": "", "register": "R2"},
        15: {"payload": {}},
    }
    for index in range(1, 23):
        fields = {
            "branch": home,
            "register": "R1",
            "label": f"H{index:02d}",
            "payload": cart,
            "created_by": cashier,
            **special.get(index, {}),
        }
        hold = HeldSale.objects.create(**fields)
        HeldSale.objects.filter(pk=hold.pk).update(created_at=start + timedelta(minutes=index))
    for index in range(1, 3):
        hold = HeldSale.objects.create(
            branch=mirpur,
            register="M1",
            label=f"Mirpur {index}",
            payload=cart,
            created_by=mirpur_manager,
        )
        HeldSale.objects.filter(pk=hold.pk).update(created_at=start + timedelta(minutes=index))
    print("parity POS fixture applied")


if Account.objects.filter(name=MARKER).exists():
    print("parity POS fixture already applied")
else:
    with transaction.atomic():
        apply()
