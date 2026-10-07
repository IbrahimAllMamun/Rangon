"""Audit entries at known moments, for the parity suite (phase 7 part 1).

Applied by `scripts/nest-parity.sh seed`, after fixture_team.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_audit.py

Idempotent: it does nothing when its reader is already there. Test data for
the parity database only; the account shares the password in
fixture_accounts.py.

The run itself writes audit entries and deletes them by time, so these are
dated in March 2025, where a date window finds them and nothing else:

- "Parity audit one": DHK1, by the owner, on the first instant of the 10th
  in Dhaka; values with a float, a whole float, an integer past 2^53,
  Bengali, and a nested list.
- "Parity audit two": PAR3, by its manager, on the last microsecond of the
  10th; an IPv6 address. A reader bound to DHK1 never sees it.
- "Parity audit three": no branch, nobody, no address, on the first instant
  of the 11th; a reason in Bengali.
- "Parity audit four": no branch, by an account since deleted (a label and
  no actor), an action the choices do not name, values that are a list and a
  string.
- "Parity audit five": DHK1, by the accountant, at the same instant as four
  and about the same record; an IPv4 address written as IPv6.
- "PARITY AUDIT SIX": DHK1, by a label in capitals, on the 12th.

parity.auditor@rangon.test is an ACCOUNTANT with no branch: `audit.view`
with nothing to be scoped to.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from django.db import transaction

from accounts import services as accounts
from accounts.models import Branch, User
from core.models import AuditLog

MARKER = "parity.auditor@rangon.test"
PARITY_PASSWORD = "Parity-Pass-2026!"
DHAKA = ZoneInfo("Asia/Dhaka")


def apply() -> None:
    owner = User.objects.get(email="owner@rangon.test")
    accountant = User.objects.get(email="accounts@rangon.test")
    mirpur_manager = User.objects.get(email="parity.mirpur@rangon.test")
    dhaka = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")

    accounts.create_staff_user(
        email=MARKER,
        password=PARITY_PASSWORD,
        role_code="ACCOUNTANT",
        first_name="Parity",
        last_name="Auditor",
        actor=owner,
    )

    def entry(label, at, *, actor=None, actor_label=None, **fields):
        made = AuditLog.objects.create(
            entity_label=label,
            actor=actor,
            actor_label=actor.email if actor and actor_label is None else (actor_label or ""),
            **fields,
        )
        # The log is append-only through the model; a fixture dates its rows underneath it.
        AuditLog.objects.filter(pk=made.pk).update(created_at=at, updated_at=at)

    entry(
        "Parity audit one",
        datetime(2025, 3, 10, 0, 0, 0, 0, tzinfo=DHAKA),
        actor=owner,
        action="STOCK_ADJUSTMENT",
        entity_type="ParityThing",
        entity_id="parity-1",
        old_values={
            "on_hand": 10,
            "cost": 12.5,
            "ratio": 1.0,
            "big": 12345678901234567890123,
            "নাম": "শার্ট",
            "nested": {"a": [1, 2.0, None, True]},
        },
        new_values={"on_hand": 8},
        reason="Parity: damaged box, 100% wet",
        ip_address="203.0.113.7",
        user_agent="parity-agent/1.0",
        request_id="parityreq0001",
        branch=dhaka,
    )
    entry(
        "Parity audit two",
        datetime(2025, 3, 10, 23, 59, 59, 999999, tzinfo=DHAKA),
        actor=mirpur_manager,
        action="SALE_CREATED",
        entity_type="ParityThing",
        entity_id="parity-2",
        new_values={"total": "1290.00"},
        reason="Parity: under_score",
        ip_address="2001:db8::1",
        request_id="parityreq0002",
        branch=mirpur,
    )
    entry(
        "Parity audit three",
        datetime(2025, 3, 11, 0, 0, 0, 0, tzinfo=DHAKA),
        action="LOGIN_FAILED",
        entity_type="User",
        reason="প্যারিটি: ভুল পাসওয়ার্ড",
    )
    entry(
        "Parity audit four",
        datetime(2025, 3, 11, 12, 0, 0, 0, tzinfo=DHAKA),
        actor_label="parity.deleted@rangon.test",
        action="PARITY_CUSTOM",
        entity_type="ParityThing",
        entity_id="parity-4",
        old_values=[1, 2.0, "x"],
        new_values="text",
        reason="Parity: back\\slash",
        request_id="parityreq0004",
    )
    entry(
        "Parity audit five",
        datetime(2025, 3, 11, 12, 0, 0, 0, tzinfo=DHAKA),
        actor=accountant,
        action="UPDATE",
        entity_type="ParityThing",
        entity_id="parity-4",
        old_values={"name": "Before"},
        new_values={"name": "After"},
        ip_address="::ffff:10.0.0.1",
        request_id="parityreq0005",
        branch=dhaka,
    )
    entry(
        "PARITY AUDIT SIX",
        datetime(2025, 3, 12, 8, 30, 15, 123456, tzinfo=DHAKA),
        actor_label="Parity.Searcher@Rangon.Test",
        action="SETTINGS_CHANGED",
        entity_type="Organization",
        entity_id="parity-6",
        reason="",
        ip_address="10.1.2.3",
        branch=dhaka,
    )
    print("parity audit fixture applied")


if User.objects.filter(email=MARKER).exists():
    print("parity audit fixture already applied")
else:
    with transaction.atomic():
        apply()
