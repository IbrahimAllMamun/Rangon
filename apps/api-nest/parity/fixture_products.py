"""Products for the product admin (phase 4).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_products.py

All or nothing, and a second run finds the marker product and stops. Test
data for the parity database only; nothing here is published. What each row
is for:
- "Parity Freebie": a draft whose one active variant is priced at zero --
  publishing is refused for giving the stock away.
- A draft purchase order naming Parity Twin B's SKU, which has no stock or
  sales: deleting that product is refused by the order line (`PROTECT`).
"""

from decimal import Decimal

from django.db import transaction

from accounts.models import Branch
from catalog.models import Category, Product, ProductVariant
from catalog.services import create_variant
from purchasing.models import Supplier
from purchasing.services import PurchaseLine, create_purchase_order

MARKER = "parity-freebie"


def apply() -> None:
    freebie = Product.objects.create(
        name="Parity Freebie", slug=MARKER, category=Category.objects.get(slug="parity-leaf")
    )
    create_variant(product=freebie, attribute_values=[], price=Decimal("0.00"), sku="PAR-FREE")

    create_purchase_order(
        supplier=Supplier.objects.order_by("code").first(),
        branch=Branch.objects.get(is_default=True),
        lines=[
            PurchaseLine(
                variant_id=ProductVariant.objects.get(sku="PAR-TWB").pk,
                quantity=2,
                unit_cost=Decimal("400.00"),
            )
        ],
        notes="Parity: keeps a history-free SKU on an order.",
    )


if Product.objects.filter(slug=MARKER).exists():
    print("parity products fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity products fixture applied")
