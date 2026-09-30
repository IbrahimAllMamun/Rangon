"""Staff accounts and catalogue rows for the admin endpoints (phase 4).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_staff.py

All or nothing, and a second run finds the marker account and stops. Test
data for the parity database only; every account shares the password in
fixture_accounts.py. What each row is for:
- `parity.admin`: an ADMIN, who holds every code and may cross branches.
- `parity.norole`: a staff account with no role at all -- refused everywhere.
- `parity.super`: a superuser whose role is CASHIER -- the superuser bypass.
- "Parity Unused": a brand no product names, so a delete succeeds.
- "Parity Doomed": an inactive category with no products or children, an
  attribute link, and a header navigation item with a child of its own -- a
  delete takes all three with it. Everything is inactive, so no storefront
  answer changes (the harness's category-fallback case turns back on only
  the header items that were on).
"""

from django.db import transaction

from accounts.models import Branch, Role, RoleCode, User
from accounts.services import get_organization
from catalog.models import Attribute, Brand, Category, CategoryAttribute
from content.models import NavigationItem

PARITY_PASSWORD = "Parity-Pass-2026!"
MARKER = "parity.admin@rangon.test"


def account(email: str, role: str | None, **extra) -> User:
    return User.objects.create_user(
        email=email,
        password=PARITY_PASSWORD,
        role=Role.objects.get(code=role) if role else None,
        organization=get_organization(),
        **extra,
    )


def item(**fields) -> NavigationItem:
    row = NavigationItem(**fields)
    row.full_clean()
    row.save()
    return row


def apply() -> None:
    home = Branch.objects.filter(is_default=True).first()
    account(MARKER, RoleCode.ADMIN, branch=home)
    account("parity.norole@rangon.test", None, branch=home)
    account("parity.super@rangon.test", RoleCode.CASHIER, branch=home, is_superuser=True)

    Brand.objects.create(name="Parity Unused", slug="parity-unused", is_active=False)
    doomed = Category.objects.create(
        name="Parity Doomed",
        slug="parity-doomed",
        parent=Category.objects.get(slug="parity"),
        is_active=False,
        show_in_navigation=False,
        position=5,
    )
    CategoryAttribute.objects.create(
        category=doomed, attribute=Attribute.objects.get(code="size"), is_required=True
    )
    link = item(placement="HEADER", type="CATEGORY", category=doomed, is_active=False, position=90)
    item(
        placement="HEADER",
        type="LINK",
        label="Parity doomed child",
        url="/doomed",
        parent=link,
        is_active=False,
        position=0,
    )


if User.objects.filter(email=MARKER).exists():
    print("parity staff fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity staff fixture applied")
