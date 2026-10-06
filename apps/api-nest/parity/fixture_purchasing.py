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
"""

from decimal import Decimal

from django.db import transaction

from accounts.models import User
from catalog.models import ProductVariant
from purchasing import services as purchasing
from purchasing.models import Supplier, SupplierProduct, SupplierStatus

MARKER = "PARITY-IDLE"


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
