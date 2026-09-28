"""The purchase order list's date range, which the admin screen submits.

Dated by the day the order was raised -- as the VAT return dates a purchase --
and that day is Dhaka's: an order raised just after local midnight is still
the previous day in UTC. `core.dates.parse_window` makes a bare date cover the
whole of it, and refuses a date it cannot read instead of ignoring it.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from purchasing import services as purchasing_services
from purchasing.models import PurchaseOrder, PurchaseOrderStatus
from purchasing.services import PurchaseLine
from tests import factories

pytestmark = pytest.mark.django_db

DHAKA = ZoneInfo("Asia/Dhaka")
URL = "/api/v1/purchase-orders/"


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


def raised(shop, when: datetime) -> PurchaseOrder:
    """A purchase order raised at `when`, through the service like the screen."""
    order = purchasing_services.create_purchase_order(
        supplier=factories.supplier(),
        branch=shop["branch"],
        lines=[
            PurchaseLine(variant_id=shop["variants"][0].pk, quantity=2, unit_cost=Decimal("400.00"))
        ],
        actor=shop["owner"],
    )
    # `created_at` is auto_now_add, so the date is set after the fact.
    PurchaseOrder.objects.filter(pk=order.pk).update(created_at=when)
    return order


def numbers(response) -> set[str]:
    assert response.status_code == 200, response.json()
    return {row["number"] for row in response.json()["results"]}


class TestDateRange:
    def test_a_day_is_the_shops_day_not_utcs(self, admin, shop):
        # 00:30 in Dhaka on the 24th is 18:30 UTC on the 23rd.
        just_after_midnight = raised(shop, datetime(2026, 9, 24, 0, 30, tzinfo=DHAKA))
        late_that_night = raised(shop, datetime(2026, 9, 24, 23, 45, tzinfo=DHAKA))
        day_before = raised(shop, datetime(2026, 9, 23, 23, 59, tzinfo=DHAKA))
        day_after = raised(shop, datetime(2026, 9, 25, 0, 1, tzinfo=DHAKA))

        found = numbers(admin.get(URL, {"date_from": "2026-09-24", "date_to": "2026-09-24"}))

        assert found == {just_after_midnight.number, late_that_night.number}
        assert day_before.number not in found
        assert day_after.number not in found

    def test_an_open_ended_range_keeps_everything_on_the_open_side(self, admin, shop):
        old = raised(shop, datetime(2026, 1, 1, 12, 0, tzinfo=DHAKA))
        recent = raised(shop, datetime(2026, 9, 1, 12, 0, tzinfo=DHAKA))

        assert numbers(admin.get(URL, {"date_from": "2026-06-01"})) == {recent.number}
        assert numbers(admin.get(URL, {"date_to": "2026-06-01"})) == {old.number}

    def test_dates_and_status_combine(self, admin, shop):
        wanted = raised(shop, datetime(2026, 9, 10, 12, 0, tzinfo=DHAKA))
        purchasing_services.send_purchase_order(purchase_order=wanted, actor=shop["owner"])
        raised(shop, datetime(2026, 9, 10, 13, 0, tzinfo=DHAKA))  # still a draft
        sent_earlier = raised(shop, datetime(2026, 8, 10, 12, 0, tzinfo=DHAKA))
        purchasing_services.send_purchase_order(purchase_order=sent_earlier, actor=shop["owner"])

        found = numbers(
            admin.get(
                URL,
                {
                    "status": PurchaseOrderStatus.SENT,
                    "date_from": "2026-09-01",
                    "date_to": "2026-09-30",
                },
            )
        )

        assert found == {wanted.number}

    def test_an_unreadable_date_is_refused_not_ignored(self, admin, shop):
        """Dropping it would show every order and call that the answer."""
        raised(shop, datetime(2026, 9, 10, 12, 0, tzinfo=DHAKA))

        response = admin.get(URL, {"date_from": "10/09/2026"})

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
