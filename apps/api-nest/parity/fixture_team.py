"""Staff accounts, their profiles and a spare branch for the parity suite (phase 6 part 10).

Applied by `scripts/nest-parity.sh seed`, after fixture_reviews.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_team.py

Idempotent: it does nothing when its first account is already there. Test
data for the parity database only; every account shares the password in
fixture_accounts.py.

Beside the staff the demo seed and the earlier fixtures made:

- parity.owner2@rangon.test: a second OWNER, INACTIVE. A case that needs two
  owners switches this one on first; left off, owner@rangon.test stays the
  last active owner, as every earlier suite found it.
- parity.clerk@rangon.test: a CASHIER at PAR3 with a whole profile -- an ID
  number among it -- and two sessions open: a password reset ends both.
- parity.temp@rangon.test: a SUSPENDED manager with no branch, and a profile
  with no ID number.
- "Parity Spare" (PAR9): an INACTIVE branch that nothing protected names. A
  parked sale and a notice go with it when it is deleted, and one audit entry
  lets go of it.
"""

from datetime import date

from django.db import transaction

from accounts import services as accounts
from accounts.models import Branch, Organization, Status, User
from core.models import AuditLog
from notifications.models import Notification
from orders.models import HeldSale

MARKER = "parity.owner2@rangon.test"
PARITY_PASSWORD = "Parity-Pass-2026!"


def apply() -> None:
    owner = User.objects.get(email="owner@rangon.test")
    mirpur = Branch.objects.get(code="PAR3")
    organization = Organization.objects.get(slug="rangon-fashion")

    second = accounts.create_staff_user(
        email=MARKER,
        password=PARITY_PASSWORD,
        role_code="OWNER",
        first_name="Second",
        last_name="Owner",
    )
    accounts.set_user_status(user=second, status=Status.INACTIVE, actor=owner)

    clerk = accounts.create_staff_user(
        email="parity.clerk@rangon.test",
        password=PARITY_PASSWORD,
        role_code="CASHIER",
        branch=mirpur,
        first_name="Parity",
        last_name="Clerk",
        phone="01811000444",
        profile={
            "designation": "Till clerk",
            "joined_on": date(2024, 3, 1),
            "date_of_birth": date(1996, 7, 21),
            "national_id": "PARITY NID 1",
            "blood_group": "B_POS",
            "present_address": "House 4, Road 2, Mirpur 10",
            "permanent_address": "Cumilla",
            "emergency_contact_name": "Rahima Khatun",
            "emergency_contact_relation": "Mother",
            "emergency_contact_phone": "01811000445",
            "notes": "Prefers the morning shift.",
        },
        actor=owner,
    )
    accounts.mint_refresh_token(clerk)
    accounts.mint_refresh_token(clerk)

    temp = accounts.create_staff_user(
        email="parity.temp@rangon.test",
        password=PARITY_PASSWORD,
        role_code="MANAGER",
        profile={"designation": "Seasonal cover", "blood_group": "O_NEG"},
        actor=owner,
    )
    User.objects.filter(pk=temp.pk).update(status=Status.SUSPENDED, is_active=False)

    spare = Branch.objects.create(
        organization=organization,
        name="Parity Spare",
        code="PAR9",
        address="Not opened yet",
        status=Status.INACTIVE,
        fulfils_online_orders=False,
    )
    HeldSale.objects.create(branch=spare, label="Parity parked", payload={"lines": []})
    Notification.objects.create(
        branch=spare, title="Parity spare notice", notification_type="LOW_STOCK"
    )
    AuditLog.objects.create(
        action="SETTINGS_CHANGED",
        entity_type="Branch",
        entity_label="Parity Spare (PAR9)",
        reason="Parity: an entry that names the spare branch",
        branch=spare,
    )
    print("parity team fixture applied")


if User.objects.filter(email=MARKER).exists():
    print("parity team fixture already applied")
else:
    with transaction.atomic():
        apply()
