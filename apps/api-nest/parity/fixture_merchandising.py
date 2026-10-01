"""Parity stage for navigation items, banners and the home carousel (phase 4 part 5c).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_merchandising.py

- Seven draft products nothing else uses ("Parity Rack 1".."7"), so a case can
  fill the carousel to its 24 and still have one more to try. Drafts: the
  storefront lists none of them.
- A banner with a window that has opened and not closed, and an inactive one.
Idempotent; one transaction.
"""

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from catalog.models import Category, Product, PublishStatus
from content.models import StorefrontBanner


def apply() -> None:
    category = Category.objects.get(slug="men")
    for n in range(1, 8):
        Product.objects.create(
            name=f"Parity Rack {n}",
            slug=f"parity-rack-{n}",
            category=category,
            status=PublishStatus.DRAFT,
        )
    now = timezone.now()
    StorefrontBanner.objects.create(
        placement="ANNOUNCEMENT",
        message="Parity window",
        starts_at=now - timedelta(days=1),
        ends_at=now + timedelta(days=30),
        priority=3,
    )
    StorefrontBanner.objects.create(
        placement="HOME_HERO", title="Parity paused", is_active=False, priority=1
    )
    print("parity merchandising fixture applied")


if Product.objects.filter(slug="parity-rack-1").exists():
    print("parity merchandising fixture already applied")
else:
    with transaction.atomic():
        apply()
