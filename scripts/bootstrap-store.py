"""Give a blank database the organization, first branch and cash drawer a store needs.

Run it through Django's shell, after `migrate`, on a database with no demo seed:

    docker compose -p rangon-prod --env-file .env.prod.local \
      -f docker-compose.yml -f docker-compose.prodlocal.yml \
      exec -T -e SHOP_NAME="Rangon Fashion" -e BRANCH_NAME="Rangon Panthapath" \
      -e BRANCH_CODE=DHK1 api python manage.py shell < scripts/bootstrap-store.py

Why it exists: `migrate` creates the roles and permissions, but nothing in the
app creates the *organization* -- `GET /organization/` answers 404 and a branch
created from the admin is saved against an organization that is not there. Only
`seed_demo` made one, and that also fills the shop with demo products and
orders. Walkthrough: docs/operations/new-store-from-scratch.md.

Safe to run twice. The app is single-tenant and reads the oldest active
organization, so an existing one is reused rather than a second created that
nothing would ever see; the same goes for the branch and the drawer.

It invents no money. The drawer opens at zero with no OPENING row, exactly as
finance/migrations/0002 does for a branch that existed at install; the real
opening float is the owner's to post from /admin/finance.
"""

import os
import sys

from django.db import transaction
from django.utils.text import slugify

from accounts.models import Branch, Organization, Status
from finance.models import Account, AccountKind
from finance.services import create_account

SHOP_NAME = os.environ.get("SHOP_NAME", "Rangon Fashion").strip()
BRANCH_NAME = os.environ.get("BRANCH_NAME", "Main branch").strip()
BRANCH_CODE = os.environ.get("BRANCH_CODE", "MAIN").strip().upper()

if not SHOP_NAME or not BRANCH_NAME or not BRANCH_CODE:
    raise SystemExit("SHOP_NAME, BRANCH_NAME and BRANCH_CODE must not be blank.")
if len(BRANCH_CODE) > 16:
    raise SystemExit("BRANCH_CODE is printed on receipts and holds at most 16 characters.")

with transaction.atomic():
    org = Organization.objects.order_by("created_at").first()
    if org is None:
        org = Organization.objects.create(
            name=SHOP_NAME, slug=slugify(SHOP_NAME), currency="BDT", status=Status.ACTIVE
        )

    branch = Branch.objects.filter(organization=org).order_by("created_at").first()
    if branch is None:
        branch = Branch.objects.create(
            organization=org,
            name=BRANCH_NAME,
            code=BRANCH_CODE,
            is_default=True,
            register_count=1,
        )

    if not Account.objects.filter(branch=branch, kind=AccountKind.CASH).exists():
        create_account(
            branch=branch,
            name=f"{branch.code} Cash Drawer",
            kind=AccountKind.CASH,
            is_default=True,
        )

drawers = Account.objects.filter(branch=branch, kind=AccountKind.CASH).count()
sys.stdout.write(
    f"Organization: {org.name} ({org.slug})\n"
    f"Branch:       {branch.name} ({branch.code}), default={branch.is_default}\n"
    f"Cash drawers: {drawers}\n"
)
