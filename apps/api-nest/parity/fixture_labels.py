"""Label marks on two products, for the barcode label sheet (phase 5).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_labels.py

All or nothing, and a second run finds the marks and stops. Test data for the
parity database only; every mark is written by `inventory.labels.mark_labels`.

"Everyday Canvas Backpack", at DHK1:
- RGN-EVE-BLA-20L: marked printed by the stock manager, then twenty more
  received -- so the sheet says twenty have no sticker yet.
- RGN-EVE-BLA-25L: marked printed by a member of staff with no name, whose
  email stands in for it; nothing received since.
- RGN-EVE-OLI-20L: marked printed, then un-marked: the newest row is the state.
- RGN-EVE-OLI-25L: never marked.
And at PAR3, which holds none of it: RGN-EVE-BLA-20L marked by its manager.

"Matte Lipstick", at DHK1: RGN-MAT-NUD marked with the most one mark may
claim, by someone whose account has since gone.
"""

from decimal import Decimal

from django.db import transaction

from accounts.models import Branch, User
from catalog.models import ProductVariant
from inventory import services as stock
from inventory.labels import LabelMark, mark_labels
from inventory.models import LabelPrint


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    manager = User.objects.get(email="manager@rangon.test")
    keeper = User.objects.get(email="stock@rangon.test")
    nameless = User.objects.get(email="parity.super@rangon.test")

    def sku(code: str) -> ProductVariant:
        return ProductVariant.objects.get(sku=code)

    def mark(branch, actor, code, printed=True, quantity=0):
        variant = sku(code)
        return mark_labels(
            branch=branch,
            product=variant.product,
            marks=[LabelMark(variant_id=variant.pk, printed=printed, quantity=quantity)],
            actor=actor,
        )[0]

    mark(home, keeper, "RGN-EVE-BLA-20L", quantity=47)
    stock.receive_stock(
        branch=home,
        variant=sku("RGN-EVE-BLA-20L"),
        quantity=20,
        unit_cost=Decimal("1400.00"),
        actor=keeper,
    )
    mark(home, nameless, "RGN-EVE-BLA-25L", quantity=12)
    mark(home, manager, "RGN-EVE-OLI-20L", quantity=15)
    mark(home, manager, "RGN-EVE-OLI-20L", printed=False)
    mark(mirpur, User.objects.get(email="parity.mirpur@rangon.test"), "RGN-EVE-BLA-20L", quantity=3)
    gone = mark(home, manager, "RGN-MAT-NUD", quantity=500)
    LabelPrint.objects.filter(pk=gone.pk).update(created_by=None)
    print("parity labels fixture applied")


if LabelPrint.objects.exists():
    print("parity labels fixture already applied")
else:
    with transaction.atomic():
        apply()
