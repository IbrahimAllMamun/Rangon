"""Correcting a stock figure from the inventory screen.

The service has been built and tested since phase 06; the endpoint over it had
two tests, both about permissions, and nothing exercised what it actually does.
The screen that drives it (`/admin/inventory`) is new, so these are the edges it
now depends on: that the ledger records the *difference* rather than the counted
figure, that a no-op says so instead of writing a row, that a reason is
mandatory, and that the branch on the row is the branch that gets corrected.

That last one is the reason the row serialiser carries `branch` at all. The
table can show more than one branch, so the screen sends the row's own branch
rather than the signed-in user's — and the API has to refuse the branches that
user may not touch.
"""

from __future__ import annotations

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from accounts.permissions import RoleCode
from core.models import AuditLog
from inventory.models import Inventory, InventoryTransaction, TransactionType
from tests import factories

pytestmark = pytest.mark.django_db

ADJUST = "/api/v1/inventory/adjust/"
INVENTORY = "/api/v1/inventory/"


def _on_hand(branch, variant) -> int:
    return Inventory.objects.get(branch=branch, variant=variant).on_hand


class TestCorrectingAFigure:
    def test_counting_fewer_writes_the_difference_not_the_count(self, shop, auth_client) -> None:
        variant = shop["variants"][0]  # seeded at 10

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 7,
                "reason": "Counted the rail on Tuesday",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert _on_hand(shop["branch"], variant) == 7
        entry = InventoryTransaction.objects.filter(
            variant=variant, transaction_type=TransactionType.ADJUSTMENT
        ).latest("created_at")
        # The ledger is a record of movement. Storing 7 here would make the
        # running total meaningless.
        assert entry.quantity == -3

    def test_counting_more_writes_a_positive_movement(self, shop, auth_client) -> None:
        variant = shop["variants"][1]  # seeded at 5

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 9,
                "reason": "Found a sealed box behind the counter",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert _on_hand(shop["branch"], variant) == 9

    def test_counting_to_zero_is_allowed(self, shop, auth_client) -> None:
        """Zero is a real count — the rail is empty — not a missing value."""
        variant = shop["variants"][0]

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 0,
                "reason": "Rail is empty",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert _on_hand(shop["branch"], variant) == 0

    def test_the_reason_reaches_the_audit_trail(self, shop, auth_client) -> None:
        variant = shop["variants"][0]

        auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 8,
                "reason": "Two mis-scanned at the counter",
            },
            format="json",
        )

        entry = AuditLog.objects.filter(action="STOCK_ADJUSTMENT").latest("created_at")
        assert entry.reason == "Two mis-scanned at the counter"
        assert entry.actor == shop["manager"]
        assert entry.old_values["on_hand"] == 10
        assert entry.new_values["on_hand"] == 8


class TestWhatItRefuses:
    def test_counting_the_same_figure_writes_nothing(self, shop, auth_client) -> None:
        """The screen blocks this, and the API must not depend on the screen."""
        variant = shop["variants"][0]
        before = InventoryTransaction.objects.count()

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 10,
                "reason": "Counted, all correct",
            },
            format="json",
        )

        assert response.status_code == 200
        assert InventoryTransaction.objects.count() == before

    @pytest.mark.parametrize("reason", ["", "   "])
    def test_a_blank_reason_is_refused(self, shop, auth_client, reason) -> None:
        variant = shop["variants"][0]

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 4,
                "reason": reason,
            },
            format="json",
        )

        assert response.status_code == 400
        assert _on_hand(shop["branch"], variant) == 10

    def test_a_negative_count_is_refused(self, shop, auth_client) -> None:
        variant = shop["variants"][0]

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": -1,
                "reason": "Typo",
            },
            format="json",
        )

        assert response.status_code == 400
        assert _on_hand(shop["branch"], variant) == 10

    def test_reading_stock_does_not_carry_the_right_to_correct_it(self, shop, auth_client) -> None:
        cashier = shop["cashier"]
        assert "inventory.view" in cashier.permission_codes()

        response = auth_client(cashier).post(
            ADJUST,
            {
                "variant": str(shop["variants"][0].pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 3,
                "reason": "Trying it on",
            },
            format="json",
        )

        assert response.status_code == 403
        assert _on_hand(shop["branch"], shop["variants"][0]) == 10


class TestTheBranchOnTheRow:
    """The screen sends the row's branch, so the API has to police it."""

    def test_the_row_carries_the_branch_id_the_screen_posts_back(self, shop, auth_client) -> None:
        # Without this field the screen could only ever correct the signed-in
        # user's own branch, whatever row was on screen.
        response = auth_client(shop["manager"]).get(INVENTORY)

        assert response.status_code == 200
        row = response.data["results"][0]
        assert str(row["branch"]) == str(shop["branch"].pk)
        assert row["branch_code"] == shop["branch"].code

    def test_the_branch_id_survives_json_as_the_string_the_screen_sends(
        self, shop, auth_client
    ) -> None:
        """`response.data` holds a UUID; the browser only ever sees the string."""
        response = auth_client(shop["manager"]).get(INVENTORY)

        row = response.json()["results"][0]
        assert row["branch"] == str(shop["branch"].pk)

    def test_a_manager_cannot_correct_another_branch(self, shop, auth_client) -> None:
        other = factories.branch(shop["organization"], code="DHK2", name="Second branch")
        variant = shop["variants"][0]
        factories.stock(variant, other, 4)

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(other.pk),
                "new_on_hand": 1,
                "reason": "Not my branch",
            },
            format="json",
        )

        assert response.status_code == 403
        assert _on_hand(other, variant) == 4

    def test_an_owner_may_correct_any_branch(self, shop, auth_client) -> None:
        other = factories.branch(shop["organization"], code="DHK3", name="Third branch")
        variant = shop["variants"][0]
        factories.stock(variant, other, 4)

        response = auth_client(shop["owner"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(other.pk),
                "new_on_hand": 6,
                "reason": "Counted on the owner's visit",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert _on_hand(other, variant) == 6
        # The branch the owner named, not the branch they belong to.
        assert _on_hand(shop["branch"], variant) == 10

    def test_the_managers_own_branch_is_assumed_when_none_is_given(self, shop, auth_client) -> None:
        variant = shop["variants"][0]

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {"variant": str(variant.pk), "new_on_hand": 2, "reason": "No branch sent"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert _on_hand(shop["branch"], variant) == 2


def test_the_role_that_owns_stock_may_adjust(shop, auth_client) -> None:
    """`INVENTORY_MANAGER` is the role the shop gives to whoever counts."""
    counter = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])

    response = auth_client(counter).post(
        ADJUST,
        {
            "variant": str(shop["variants"][0].pk),
            "branch": str(shop["branch"].pk),
            "new_on_hand": 6,
            "reason": "Weekly count",
        },
        format="json",
    )

    assert response.status_code == 201, response.data


class TestTheListIsStablyOrdered:
    """A screen you correct a row on has to keep that row where it was.

    Every variant of a product is `position` 0 until somebody reorders them, so
    the old ordering — product name, then position — left whole groups tied.
    PostgreSQL may return tied rows in any order, which showed up the first time
    a browser drove the new adjust form: the row corrected from 11 to 15
    reappeared as a different variant reading 10, and the correction looked like
    it had hit the wrong row. It had not. The list had simply reshuffled.

    This is D13 one table over, and the fix is the same: a total order.
    """

    def _five_tied_variants(self, shop) -> None:
        product = factories.product(name="Tied Kurti")
        _, values = factories.attribute("shade", name="Shade", values=["a", "b", "c", "d", "e"])
        for index, value in enumerate(values):
            variant = factories.variant(product, attribute_values=[value], position=0)
            factories.stock(variant, shop["branch"], 10 + index)

    def test_the_sort_is_total_so_tied_rows_cannot_reshuffle(self, shop, auth_client) -> None:
        """Asserted on the SQL, because behaviour cannot catch this reliably.

        A list ordered only by tied columns is *allowed* to come back in any
        order; it is not obliged to differ. Fetching the page twice and
        comparing passes on a small table whether the bug is present or not,
        which is worse than no test. What is actually required is a total order,
        so that is what this checks: the last term of the ORDER BY must be a
        column that cannot tie.
        """
        self._five_tied_variants(shop)
        client = auth_client(shop["manager"])

        with CaptureQueriesContext(connection) as captured:
            assert client.get(INVENTORY).status_code == 200

        listing = [
            query["sql"]
            for query in captured
            if "inventory_inventory" in query["sql"] and "ORDER BY" in query["sql"]
        ]
        assert listing, "no ordered query against the inventory table"
        order_by = listing[-1].split("ORDER BY")[-1]
        assert '"inventory_inventory"."id"' in order_by, (
            f"The inventory list is ordered by {order_by.strip()}, which has no "
            f"unique tiebreaker. Every variant of a product shares position 0, "
            f"so PostgreSQL may return those rows in any order it likes."
        )

    def test_the_expiring_filter_sorts_by_expiry_not_by_name(self, shop, auth_client) -> None:
        """It set an ordering and the method's final `order_by` threw it away."""
        from datetime import timedelta

        from django.utils import timezone

        today = timezone.now().date()
        soon = factories.product(name="Zzz Last Alphabetically")
        later = factories.product(name="Aaa First Alphabetically")
        _, values = factories.attribute("batch", name="Batch", values=["one", "two"])
        factories.stock(
            factories.variant(
                soon, attribute_values=[values[0]], expiry_date=today + timedelta(days=3)
            ),
            shop["branch"],
            5,
        )
        factories.stock(
            factories.variant(
                later, attribute_values=[values[1]], expiry_date=today + timedelta(days=90)
            ),
            shop["branch"],
            5,
        )

        rows = auth_client(shop["manager"]).get(INVENTORY, {"filter": "expiring"}).json()["results"]

        assert [row["product_name"] for row in rows] == [
            "Zzz Last Alphabetically",
            "Aaa First Alphabetically",
        ], "the expiring filter is not showing the soonest first"
