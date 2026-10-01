"""Parity stage for the site pages admin (phase 4 part 5b).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_pages.py

- A header PAGE item linking to the custom page, with a LINK under it, so that
  deleting the page takes both navigation items with it (on_delete=CASCADE).
- A second custom page nothing links to, for a plain delete.
Built through the model's own `full_clean`. Idempotent; one transaction.
"""

from django.db import transaction

from content.models import NavigationItem, SitePage


def apply() -> None:
    page = SitePage.objects.get(slug="parity-size-guide")
    link = NavigationItem(placement="HEADER", type="PAGE", page=page, position=9)
    link.full_clean()
    link.save()
    child = NavigationItem(
        placement="HEADER",
        type="LINK",
        label="Fit notes",
        url="/pages/parity-size-guide",
        parent=link,
    )
    child.full_clean()
    child.save()
    SitePage.objects.create(
        slug="parity-faq", title="FAQ", meta_description="Questions", body="<p>Ask.</p>"
    )
    print("parity pages fixture applied")


if SitePage.objects.filter(slug="parity-faq").exists():
    print("parity pages fixture already applied")
else:
    with transaction.atomic():
        apply()
