"""Notices for two readers, for the parity suite (phase 7 part 2).

Applied by `scripts/nest-parity.sh seed`, after fixture_audit.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_notifications.py

Idempotent: it does nothing when its first notice is already there.

Both readers are accounts no sale or order ever notifies, so what they hold
is what is written here:

- parity.auditor@rangon.test (fixture_audit.py), an accountant with no
  branch -- staff notices reach a branch's staff, owners and administrators:
  - "Parity notice one": unread, a warning, with a link and data that holds a
    float, a whole float, an integer past 2^53 and Bengali;
  - "Parity notice two": unread, at a branch;
  - "Parity notice three": read;
  - "Parity notice four" and "Parity notice five": unread, written at one
    instant, with data that is a list and a string;
  - "Parity notice six": read, an error, no body;
  - "parity notice seven": unread, the newest.
- parity.bare@rangon.test (fixture_accounts.py), a customer account with no
  customer record: "Parity bare one" (unread), "Parity bare two" (read),
  "Parity bare three" (unread).

And "Parity notice for nobody": addressed to a permission, not to a person.
Nobody's list holds it.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from django.db import transaction

from accounts.models import Branch, User
from notifications.models import Notification

MARKER = "Parity notice one"
DHAKA = ZoneInfo("Asia/Dhaka")


def apply() -> None:
    auditor = User.objects.get(email="parity.auditor@rangon.test")
    bare = User.objects.get(email="parity.bare@rangon.test")
    dhaka = Branch.objects.get(code="DHK1")

    def notice(title, at, *, read=None, **fields):
        made = Notification.objects.create(title=title, **fields)
        # In a known order, at known moments, whatever the clock did meanwhile.
        Notification.objects.filter(pk=made.pk).update(created_at=at, updated_at=at, read_at=read)

    def at(day, hour, minute=0, second=0, micro=0):
        return datetime(2025, 4, day, hour, minute, second, micro, tzinfo=DHAKA)

    notice(
        MARKER,
        at(1, 9),
        user=auditor,
        permission_code="finance.view",
        notification_type="LOW_STOCK",
        level="WARNING",
        body="Parity: three left of a shirt",
        link="/admin/inventory?filter=low-stock",
        data={
            "on_hand": 3,
            "threshold": 5.0,
            "ratio": 0.6,
            "big": 12345678901234567890123,
            "নাম": "শার্ট",
            "nested": {"a": [1, 2.0, None, True]},
        },
    )
    notice(
        "Parity notice two",
        at(1, 10, 30),
        user=auditor,
        branch=dhaka,
        permission_code="orders.view",
        notification_type="NEW_ONLINE_ORDER",
        body="Parity: an order to pack",
        link="/admin/orders/RGN-WEB-000001",
        data={"order_number": "RGN-WEB-000001"},
    )
    notice(
        "Parity notice three",
        at(2, 0),
        read=at(2, 8, 15, 30, 123456),
        user=auditor,
        notification_type="PAYMENT_RECEIVED",
        level="SUCCESS",
        body="Parity: paid in full",
    )
    notice(
        "Parity notice four",
        at(2, 23, 59, 59, 999999),
        user=auditor,
        notification_type="OUT_OF_STOCK",
        level="WARNING",
        body="Parity: none left",
        data=["a", 1, 2.0],
    )
    notice(
        "Parity notice five",
        at(2, 23, 59, 59, 999999),
        user=auditor,
        notification_type="INTEGRITY_ALERT",
        level="ERROR",
        body="Parity: the ledger disagrees",
        data="text",
    )
    notice(
        "Parity notice six",
        at(3, 12),
        read=at(3, 12, 0, 1),
        user=auditor,
        notification_type="STOCK_EXPIRING",
        level="ERROR",
    )
    notice(
        "parity notice seven",
        at(4, 18, 45),
        user=auditor,
        notification_type="RETURN_REQUESTED",
        body="Parity: a return to look at",
        link="/admin/returns",
    )

    notice(
        "Parity bare one",
        at(1, 8),
        user=bare,
        notification_type="ORDER_CONFIRMED",
        body="Order RGN-WEB-000001",
        link="/account/orders/RGN-WEB-000001",
        data={"order_number": "RGN-WEB-000001"},
    )
    notice(
        "Parity bare two",
        at(2, 8),
        read=at(2, 9),
        user=bare,
        notification_type="ORDER_SHIPPED",
        body="Order RGN-WEB-000001",
    )
    notice(
        "Parity bare three",
        at(3, 8),
        user=bare,
        notification_type="ORDER_DELIVERED",
        body="Order RGN-WEB-000001",
    )

    notice(
        "Parity notice for nobody",
        at(5, 8),
        permission_code="orders.view",
        notification_type="LOW_STOCK",
    )
    print("parity notifications fixture applied")


if Notification.objects.filter(title=MARKER).exists():
    print("parity notifications fixture already applied")
else:
    with transaction.atomic():
        apply()
