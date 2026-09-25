"""The order list's search box and date range, which the admin screen submits.

The API has filtered on `search`, `date_from` and `date_to` for a long time,
but no screen sent them, so nothing held them to their meaning. The date test
is the one that matters: the shop's day is Dhaka's, and an order placed just
after local midnight is still the previous day in UTC.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from tests import factories

pytestmark = pytest.mark.django_db

DHAKA = ZoneInfo("Asia/Dhaka")


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


def numbers(response) -> set[str]:
    assert response.status_code == 200, response.json()
    return {row["number"] for row in response.json()["results"]}


class TestSearch:
    def test_finds_an_order_by_part_of_its_number(self, admin, shop):
        wanted = factories.order(shop, number="RGN-260924-0042")
        factories.order(shop, number="RGN-260924-0099")

        assert numbers(admin.get("/api/v1/orders/?search=0042")) == {wanted.number}

    def test_finds_an_order_by_the_customers_phone_as_typed_locally(self, admin, shop):
        customer = factories.customer(phone="8801712345678")
        wanted = factories.order(shop, customer=customer)
        factories.order(shop)

        assert wanted.number in numbers(admin.get("/api/v1/orders/?search=01712345678"))


class TestDateRange:
    def test_a_day_is_the_shops_day_not_utcs(self, admin, shop):
        # 00:30 in Dhaka on the 24th is 18:30 UTC on the 23rd.
        just_after_midnight = factories.order(
            shop, placed_at=datetime(2026, 9, 24, 0, 30, tzinfo=DHAKA)
        )
        late_that_night = factories.order(
            shop, placed_at=datetime(2026, 9, 24, 23, 45, tzinfo=DHAKA)
        )
        day_before = factories.order(shop, placed_at=datetime(2026, 9, 23, 23, 59, tzinfo=DHAKA))
        day_after = factories.order(shop, placed_at=datetime(2026, 9, 25, 0, 1, tzinfo=DHAKA))

        found = numbers(admin.get("/api/v1/orders/?date_from=2026-09-24&date_to=2026-09-24"))

        assert found == {just_after_midnight.number, late_that_night.number}
        assert day_before.number not in found
        assert day_after.number not in found

    def test_an_open_ended_range_keeps_everything_on_the_open_side(self, admin, shop):
        old = factories.order(shop, placed_at=datetime(2026, 1, 1, 12, 0, tzinfo=DHAKA))
        recent = factories.order(shop, placed_at=datetime(2026, 9, 1, 12, 0, tzinfo=DHAKA))

        assert numbers(admin.get("/api/v1/orders/?date_from=2026-06-01")) == {recent.number}
        assert numbers(admin.get("/api/v1/orders/?date_to=2026-06-01")) == {old.number}

    def test_search_and_dates_combine(self, admin, shop):
        wanted = factories.order(
            shop, number="RGN-A-0001", placed_at=datetime(2026, 9, 10, 12, 0, tzinfo=DHAKA)
        )
        factories.order(
            shop, number="RGN-A-0002", placed_at=datetime(2026, 8, 10, 12, 0, tzinfo=DHAKA)
        )

        found = numbers(admin.get("/api/v1/orders/?search=RGN-A&date_from=2026-09-01"))

        assert found == {wanted.number}

    def test_an_unreadable_date_is_a_validation_error_not_a_crash(self, admin, shop):
        response = admin.get("/api/v1/orders/?date_from=24/09/2026")

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
