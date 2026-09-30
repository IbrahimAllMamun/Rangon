"""Accounts for the parity database: who signs in, and as what.

Run through Django after `seed_demo`, like the other fixtures:

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_accounts.py

All or nothing, and a second run finds the marker account and stops. Test data
for the parity database only.

Every account shares `PARITY_PASSWORD`, a test value that exists nowhere but
this file and `parity/run.ts`. What each one is for:
- `parity.customer`: a customer with a `Customer` row, a name and a mobile --
  sign-in, `me`, the password validators' similarity check.
- `parity.bare`: a customer account with no `Customer` row (staff-created, or
  unlinked) -- the account endpoints' "no profile" answers.
- `parity.staff`: a cashier with a home branch -- `me` with a branch, and the
  customer-only endpoints' 403.
- `parity.inactive`: correct password, deactivated -- sign-in and refresh refusals.
- `parity.pbkdf2`: a PBKDF2 hash with fewer iterations than Django's default,
  as an account created on an older release has. Signing in upgrades it to
  Argon2, which both APIs must do.
- `parity.taken`: an existing address for registration's duplicate check, in
  mixed case.
- A guest customer with no account: registering with its mobile links it; with
  its email and no mobile, the new customer row collides with it (409).
"""

from django.contrib.auth.hashers import PBKDF2PasswordHasher
from django.db import transaction

from accounts.models import Branch, Role, RoleCode, Status, User
from accounts.services import get_organization
from customers.models import Customer, CustomerType

PARITY_PASSWORD = "Parity-Pass-2026!"
MARKER = "parity.customer@rangon.test"


def account(email: str, role: str, **extra) -> User:
    return User.objects.create_user(
        email=email,
        password=PARITY_PASSWORD,
        role=Role.objects.get(code=role),
        organization=get_organization(),
        **extra,
    )


def apply() -> None:
    customer_user = account(
        MARKER, RoleCode.CUSTOMER, first_name="Parvin", last_name="Sultana", phone="01711000001"
    )
    Customer.objects.create(
        user=customer_user,
        name=customer_user.full_name,
        email=customer_user.email,
        phone="01711000001",
        customer_type=CustomerType.REGISTERED,
    )
    account("parity.bare@rangon.test", RoleCode.CUSTOMER)
    account(
        "parity.staff@rangon.test",
        RoleCode.CASHIER,
        first_name="Karim",
        branch=Branch.objects.filter(is_default=True).first(),
    )
    account("parity.inactive@rangon.test", RoleCode.CUSTOMER, status=Status.INACTIVE)

    legacy = account("parity.pbkdf2@rangon.test", RoleCode.CUSTOMER)
    # Written with update(), not save(): this is a stored hash, not a password.
    User.objects.filter(pk=legacy.pk).update(
        password=PBKDF2PasswordHasher().encode(PARITY_PASSWORD, "paritysaltparitysalt22", 1000)
    )
    account("Parity.Taken@Rangon.test", RoleCode.CUSTOMER)
    Customer.objects.create(
        name="Parity Guest",
        phone="01711000099",
        email="parity.guest@rangon.test",
        customer_type=CustomerType.GUEST,
    )


if User.objects.filter(email=MARKER).exists():
    print("parity accounts fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity accounts fixture applied")
