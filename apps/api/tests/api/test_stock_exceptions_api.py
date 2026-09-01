"""The oversell report through the API.

The screen is built over these endpoints, so the rules that matter are settled
here first — every previous pass that built the screen before the API found the
defect afterwards (docs/roadmap.md).

The security question this file exists to answer: *who may decide that a hole
in the stock was acceptable?* Resolving does not move stock, so it is easy to
mistake for a read. It is not: it is the act that closes the only record of an
oversell, and it takes `inventory.adjust` for exactly that reason.
"""

from __future__ import annotations

import pytest

from inventory import services as inventory_services
from inventory.models import (
    StockException,
    StockExceptionResolution,
    StockExceptionStatus,
    TransactionType,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def exception(shop):
    """One open oversell, the way an offline register would leave it."""
    inventory_services.apply_transaction(
        branch=shop["branch"],
        variant=shop["variants"][1],  # five on the shelf
        transaction_type=TransactionType.SALE,
        quantity=8,
        allow_negative=True,
        reference_type="pos_sale",
        reference_id="OFFLINE-1",
    )
    return StockException.objects.get()


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


class TestListing:
    def test_the_report_lists_open_exceptions(self, admin, exception):
        response = admin.get("/api/v1/stock-exceptions/")

        assert response.status_code == 200
        row = response.data["results"][0]
        assert row["shortfall"] == 3
        assert row["status"] == StockExceptionStatus.OPEN
        assert row["sku"]
        assert row["reference_id"] == "OFFLINE-1"

    def test_the_row_carries_the_balance_now_as_well_as_then(self, admin, exception, shop):
        """`on_hand_after` freezes how bad it was. A delivery since then may
        have covered it, and a manager triaging the queue has to be able to
        tell those two situations apart."""
        from decimal import Decimal

        inventory_services.receive_stock(
            branch=shop["branch"],
            variant=shop["variants"][1],
            quantity=10,
            unit_cost=Decimal("400.00"),
        )

        row = admin.get("/api/v1/stock-exceptions/").data["results"][0]
        assert row["on_hand_after"] == -3
        assert row["on_hand_now"] == 7

    def test_the_list_can_be_filtered_to_what_is_still_open(self, admin, exception, shop):
        inventory_services.resolve_stock_exception(
            exception=exception,
            resolution=StockExceptionResolution.WRITTEN_OFF,
            note="Gone.",
            actor=shop["owner"],
        )

        assert admin.get("/api/v1/stock-exceptions/?status=OPEN").data["count"] == 0
        assert admin.get("/api/v1/stock-exceptions/?status=RESOLVED").data["count"] == 1

    def test_the_summary_counts_without_pulling_the_list(self, admin, exception):
        response = admin.get("/api/v1/stock-exceptions/summary/")

        assert response.status_code == 200
        assert response.data == {"open": 1, "resolved": 0}


class TestResolving:
    def test_resolving_closes_it_and_returns_the_updated_row(self, admin, exception):
        response = admin.post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": StockExceptionResolution.RESTOCKED, "note": "Delivery 4412 covered it."},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["status"] == StockExceptionStatus.RESOLVED
        assert response.data["resolution"] == StockExceptionResolution.RESTOCKED
        assert response.data["resolved_by_name"]
        # The response has to be renderable as-is or the screen shows a blank
        # cell where the current balance was.
        assert "on_hand_now" in response.data

    def test_a_resolution_with_no_note_is_refused(self, admin, exception):
        response = admin.post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": StockExceptionResolution.WRITTEN_OFF, "note": ""},
            format="json",
        )

        assert response.status_code == 400
        exception.refresh_from_db()
        assert exception.is_open

    def test_an_invented_resolution_is_refused(self, admin, exception):
        response = admin.post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": "HANDWAVED", "note": "Looked fine."},
            format="json",
        )

        assert response.status_code == 400

    def test_resolving_twice_is_a_conflict_not_a_silent_overwrite(self, admin, exception):
        body = {"resolution": StockExceptionResolution.COUNTED, "note": "Count 19 fixed it."}
        assert (
            admin.post(
                f"/api/v1/stock-exceptions/{exception.pk}/resolve/", body, format="json"
            ).status_code
            == 200
        )

        second = admin.post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": StockExceptionResolution.NOT_AN_ERROR, "note": "Changed my mind."},
            format="json",
        )

        assert second.status_code == 409
        assert second.data["error"]["code"]
        exception.refresh_from_db()
        assert exception.resolution == StockExceptionResolution.COUNTED

    def test_resolving_does_not_move_stock(self, admin, exception, shop):
        admin.post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": StockExceptionResolution.NOT_AN_ERROR, "note": "Consignment."},
            format="json",
        )

        snapshot = inventory_services.get_or_create_inventory(shop["branch"], shop["variants"][1])
        assert snapshot.on_hand == -3


class TestPermissions:
    def test_a_cashier_can_see_the_report(self, shop, cashier, auth_client, exception):
        """Cashiers hold `inventory.view`, and the register they work on is
        where the hole came from."""
        assert auth_client(cashier).get("/api/v1/stock-exceptions/").status_code == 200

    def test_a_cashier_cannot_decide_a_hole_was_acceptable(
        self, shop, cashier, auth_client, exception
    ):
        response = auth_client(cashier).post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": StockExceptionResolution.NOT_AN_ERROR, "note": "It's fine."},
            format="json",
        )

        assert response.status_code == 403
        exception.refresh_from_db()
        assert exception.is_open

    def test_a_manager_can_resolve(self, shop, auth_client, exception):
        response = auth_client(shop["manager"]).post(
            f"/api/v1/stock-exceptions/{exception.pk}/resolve/",
            {"resolution": StockExceptionResolution.WRITTEN_OFF, "note": "Written off."},
            format="json",
        )

        assert response.status_code == 200

    def test_an_anonymous_request_sees_nothing(self, api, exception):
        assert api.get("/api/v1/stock-exceptions/").status_code in {401, 403}


class TestTheQueueCannotBeEmptied:
    """A report that can be deleted is not a control. These are the two ways
    somebody would try to make the number go away without answering for it."""

    def test_an_exception_cannot_be_deleted(self, admin, exception):
        response = admin.delete(f"/api/v1/stock-exceptions/{exception.pk}/")

        assert response.status_code == 405
        assert StockException.objects.filter(pk=exception.pk).exists()

    def test_an_exception_cannot_be_invented_through_the_api(self, admin, shop):
        """Only `inventory.services` may create one, so the count always
        matches what the ledger actually did."""
        response = admin.post(
            "/api/v1/stock-exceptions/",
            {
                "branch": str(shop["branch"].pk),
                "variant": str(shop["variants"][0].pk),
                "shortfall": 1,
            },
            format="json",
        )

        assert response.status_code == 405
