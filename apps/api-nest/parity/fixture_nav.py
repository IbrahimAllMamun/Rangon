"""Third parity stage: header navigation overrides (ADR-0009 path 1).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_nav.py

Every row is created active, so the harness can switch the whole header off
for one case (`navigation: category fallback`) and back on afterwards.
- A CATEGORY override with no children of its own: inherits the real submenu.
- A CATEGORY override with a hand-built child: does not.
- A LINK with a badge and a child; a PROMO card with an image.
- A parent past its window with a live child: both hidden.
Built through the model's own `full_clean`, so every row passes Django's rules.
"""

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from catalog.models import Category
from content.models import NavigationItem


def item(**fields):
    fields.setdefault("placement", "HEADER")
    row = NavigationItem(**fields)
    row.full_clean()
    row.save()
    return row


def apply() -> None:
    men = Category.objects.get(slug="men")
    women = Category.objects.get(slug="women")
    item(type="CATEGORY", category=men, badge="New", layout="MEGA", position=0)
    parent = item(type="CATEGORY", category=women, label="Her edit", position=1)
    item(type="LINK", label="Kurti picks", url="/category/women/kurti", parent=parent, position=0)
    sale = item(type="LINK", label="Sale", url="/sale", badge="Hot", position=2)
    item(type="LINK", label="Last chance", url="/sale/last", parent=sale, position=0)
    item(type="PROMO", label="Eid edit", url="/eid", image="navigation/eid promo.jpg", description="Festive", position=3)
    gone = item(type="LINK", label="Gone", url="/gone", position=4, ends_at=timezone.now() - timedelta(days=1))
    item(type="LINK", label="Orphan", url="/orphan", parent=gone, position=0)
    print("parity navigation fixture applied")


if NavigationItem.objects.filter(placement="HEADER", label="Sale").exists():
    print("parity navigation fixture already applied")
else:
    with transaction.atomic():
        apply()
