"""Damage, stock counts and transfers as the admin screens drive them.

Phase 39. The write-off and transfer services were already covered in
tests/test_inventory.py; what was not covered anywhere was the stock count —
which is how it went unnoticed that `counted_quantity` had no write path at
all, leaving `apply` a permanent no-op.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from inventory import services
from inventory.models import (
    Inventory,
    InventoryTransaction,
    StockCount,
    StockCountStatus,
    TransactionType,
)
from tests import factories

pytestmark = pytest.mark.django_db


def _stock(variant: Any, branch: Any) -> Inventory:
    return Inventory.objects.get(variant=variant, branch=branch)


def _open_count(client: Any, branch: Any) -> dict[str, Any]:
    response = client.post(
        "/api/v1/stock-counts/", {"branch": str(branch.pk), "notes": "Monthly"}, format="json"
    )
    assert response.status_code == 201, response.data
    return response.data


class TestWriteOff:
    def test_damage_reduces_stock_and_writes_a_reasoned_ledger_row(self, shop, auth_client):
        variant = shop["variants"][0]

        response = auth_client(shop["manager"]).post(
            "/api/v1/inventory/write-off/",
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "quantity": 3,
                "transaction_type": "DAMAGE",
                "reason": "Water damage in the stockroom",
            },
            format="json",
        )

        assert response.status_code in (200, 201), response.data
        assert _stock(variant, shop["branch"]).on_hand == 7
        entry = InventoryTransaction.objects.filter(transaction_type=TransactionType.DAMAGE).latest(
            "created_at"
        )
        assert entry.quantity == -3
        assert entry.reason == "Water damage in the stockroom"

    def test_a_write_off_without_a_reason_is_refused(self, shop, auth_client):
        response = auth_client(shop["manager"]).post(
            "/api/v1/inventory/write-off/",
            {
                "variant": str(shop["variants"][0].pk),
                "quantity": 1,
                "transaction_type": "DAMAGE",
                "reason": "",
            },
            format="json",
        )

        assert response.status_code == 400

    def test_writing_off_more_than_is_held_is_refused(self, shop, auth_client):
        variant = shop["variants"][0]

        response = auth_client(shop["manager"]).post(
            "/api/v1/inventory/write-off/",
            {
                "variant": str(variant.pk),
                "quantity": 999,
                "transaction_type": "LOSS",
                "reason": "Stolen",
            },
            format="json",
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "INSUFFICIENT_STOCK"
        assert _stock(variant, shop["branch"]).on_hand == 10

    def test_a_cashier_cannot_write_stock_off(self, shop, auth_client):
        response = auth_client(shop["cashier"]).post(
            "/api/v1/inventory/write-off/",
            {
                "variant": str(shop["variants"][0].pk),
                "quantity": 1,
                "transaction_type": "DAMAGE",
                "reason": "Torn",
            },
            format="json",
        )

        assert response.status_code == 403


class TestStockCountSheet:
    def test_opening_a_count_snapshots_what_the_ledger_believes(self, shop, auth_client):
        data = _open_count(auth_client(shop["manager"]), shop["branch"])

        assert data["number"].startswith("SC-")
        assert data["status"] == StockCountStatus.COUNTING
        expected = {item["sku"]: item["expected_quantity"] for item in data["items"]}
        assert expected[shop["variants"][0].sku] == 10
        assert expected[shop["variants"][1].sku] == 5
        # Nothing is counted until somebody counts it.
        assert all(item["counted_quantity"] is None for item in data["items"])

    def test_recording_a_count_stores_the_figure_and_its_variance(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        variant = shop["variants"][0]

        response = client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {
                "lines": [
                    {"variant": str(variant.pk), "counted_quantity": 8, "notes": "Two missing"}
                ]
            },
            format="json",
        )

        assert response.status_code == 200, response.data
        assert response.data == {"recorded": 1, "counted": 1, "total": 2}

        sheet = client.get(f"/api/v1/stock-counts/{count['id']}/").data
        row = next(item for item in sheet["items"] if item["sku"] == variant.sku)
        assert row["counted_quantity"] == 8
        assert row["difference"] == -2
        assert row["notes"] == "Two missing"
        # Recording is not applying: stock has not moved yet.
        assert _stock(variant, shop["branch"]).on_hand == 10

    def test_recording_twice_overwrites_rather_than_accumulates(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        variant = shop["variants"][0]
        url = f"/api/v1/stock-counts/{count['id']}/record/"

        client.post(
            url, {"lines": [{"variant": str(variant.pk), "counted_quantity": 8}]}, format="json"
        )
        client.post(
            url, {"lines": [{"variant": str(variant.pk), "counted_quantity": 9}]}, format="json"
        )

        sheet = client.get(f"/api/v1/stock-counts/{count['id']}/").data
        row = next(item for item in sheet["items"] if item["sku"] == variant.sku)
        assert row["counted_quantity"] == 9

    def test_the_same_variant_twice_in_one_request_is_refused(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        variant = shop["variants"][0]

        response = client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {
                "lines": [
                    {"variant": str(variant.pk), "counted_quantity": 8},
                    {"variant": str(variant.pk), "counted_quantity": 9},
                ]
            },
            format="json",
        )

        assert response.status_code == 400

    def test_a_variant_not_on_the_sheet_is_refused(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        stranger = factories.variant()

        response = client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(stranger.pk), "counted_quantity": 4}]},
            format="json",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_a_cashier_cannot_record_a_count(self, shop, auth_client):
        count = _open_count(auth_client(shop["manager"]), shop["branch"])

        response = auth_client(shop["cashier"]).post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(shop["variants"][0].pk), "counted_quantity": 8}]},
            format="json",
        )

        assert response.status_code == 403


class TestApplyingAStockCount:
    def test_applying_writes_adjustments_only_for_what_was_counted(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        short, untouched = shop["variants"]

        client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(short.pk), "counted_quantity": 8}]},
            format="json",
        )
        response = client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json")

        assert response.status_code == 200, response.data
        assert response.data == {"adjusted_lines": 1, "status": StockCountStatus.APPLIED}
        assert _stock(short, shop["branch"]).on_hand == 8
        # An uncounted line is not treated as a count of zero.
        assert _stock(untouched, shop["branch"]).on_hand == 5

        entry = InventoryTransaction.objects.filter(
            transaction_type=TransactionType.ADJUSTMENT
        ).latest("created_at")
        assert entry.quantity == -2
        assert count["number"] in entry.reason
        assert entry.reference_type == "stock_count"

    def test_a_count_with_no_figures_cannot_be_applied(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])

        response = client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        assert StockCount.objects.get(pk=count["id"]).status == StockCountStatus.COUNTING

    def test_applying_twice_is_refused_with_the_error_envelope(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(shop["variants"][0].pk), "counted_quantity": 8}]},
            format="json",
        )
        client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json")

        again = client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json")

        assert again.status_code == 409
        assert again.data["error"]["code"] == "CONFLICT"
        # The second attempt adjusted nothing.
        assert _stock(shop["variants"][0], shop["branch"]).on_hand == 8

    def test_an_applied_count_cannot_be_recorded_against(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        variant = shop["variants"][0]
        client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(variant.pk), "counted_quantity": 8}]},
            format="json",
        )
        client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json")

        response = client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(variant.pk), "counted_quantity": 3}]},
            format="json",
        )

        assert response.status_code == 409

    def test_cancelling_leaves_stock_untouched(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        variant = shop["variants"][0]
        client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(variant.pk), "counted_quantity": 2}]},
            format="json",
        )

        response = client.post(f"/api/v1/stock-counts/{count['id']}/cancel/", {}, format="json")

        assert response.status_code == 200
        assert response.data["status"] == StockCountStatus.CANCELLED
        assert _stock(variant, shop["branch"]).on_hand == 10
        # And it can no longer be applied.
        assert (
            client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json").status_code
            == 409
        )

    def test_an_applied_count_cannot_be_cancelled(self, shop, auth_client):
        client = auth_client(shop["manager"])
        count = _open_count(client, shop["branch"])
        client.post(
            f"/api/v1/stock-counts/{count['id']}/record/",
            {"lines": [{"variant": str(shop["variants"][0].pk), "counted_quantity": 8}]},
            format="json",
        )
        client.post(f"/api/v1/stock-counts/{count['id']}/apply/", {}, format="json")

        response = client.post(f"/api/v1/stock-counts/{count['id']}/cancel/", {}, format="json")

        assert response.status_code == 409


class TestStockTransferEndpoint:
    def test_a_transfer_moves_stock_and_cost_between_branches(self, shop, auth_client):
        source = shop["branch"]
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]
        services.receive_stock(
            branch=source, variant=variant, quantity=10, unit_cost=Decimal("250.00")
        )

        # The source already held seeded stock, so its weighted average is a
        # blend — which is exactly the figure that must travel (ADR-0006).
        cost_at_source = _stock(variant, source).average_cost

        response = auth_client(shop["owner"]).post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(source.pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 6}],
                "notes": "Restocking Gulshan",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["number"].startswith("TRF-")
        assert response.data["status"] == "IN_TRANSIT"
        # Dispatched, not delivered: the stock has left the source and reached
        # nobody. Until 2026-09-01 this endpoint landed it at the destination in
        # the same request, so Gulshan could sell goods still in the van.
        assert _stock(variant, source).on_hand == 14
        assert not Inventory.objects.filter(branch=target, variant=variant).exists()

        received = auth_client(shop["owner"]).post(
            f"/api/v1/stock-transfers/{response.data['id']}/receive/", {}, format="json"
        )

        assert received.status_code == 200, received.data
        assert received.data["status"] == "RECEIVED"
        assert _stock(variant, target).on_hand == 6
        assert _stock(variant, target).average_cost == cost_at_source

    def test_a_short_receipt_writes_the_difference_off_and_needs_a_reason(self, shop, auth_client):
        source = shop["branch"]
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]
        client = auth_client(shop["owner"])
        moving = client.post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(source.pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 6}],
            },
            format="json",
        ).data

        short = {"lines": [{"variant": str(variant.pk), "received_quantity": 4}]}
        refused = client.post(
            f"/api/v1/stock-transfers/{moving['id']}/receive/", short, format="json"
        )
        assert refused.status_code == 400

        accepted = client.post(
            f"/api/v1/stock-transfers/{moving['id']}/receive/",
            {**short, "reason": "Two missing from the carton."},
            format="json",
        )

        assert accepted.status_code == 200, accepted.data
        assert accepted.data["units_lost"] == 2
        assert _stock(variant, target).on_hand == 4

    def test_a_transfer_can_be_turned_back(self, shop, auth_client):
        source = shop["branch"]
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]
        client = auth_client(shop["owner"])
        before = _stock(variant, source).on_hand
        moving = client.post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(source.pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 3}],
            },
            format="json",
        ).data

        assert (
            client.post(
                f"/api/v1/stock-transfers/{moving['id']}/cancel/", {}, format="json"
            ).status_code
            == 400
        )

        cancelled = client.post(
            f"/api/v1/stock-transfers/{moving['id']}/cancel/",
            {"reason": "Van turned back."},
            format="json",
        )

        assert cancelled.status_code == 200, cancelled.data
        assert cancelled.data["status"] == "CANCELLED"
        assert _stock(variant, source).on_hand == before

    def test_receiving_twice_is_a_conflict(self, shop, auth_client):
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]
        client = auth_client(shop["owner"])
        moving = client.post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(shop["branch"].pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 2}],
            },
            format="json",
        ).data
        assert (
            client.post(
                f"/api/v1/stock-transfers/{moving['id']}/receive/", {}, format="json"
            ).status_code
            == 200
        )

        second = client.post(f"/api/v1/stock-transfers/{moving['id']}/receive/", {}, format="json")

        assert second.status_code == 409
        assert _stock(variant, target).on_hand == 2

    def test_in_transit_lists_what_has_not_landed(self, shop, auth_client):
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]
        client = auth_client(shop["owner"])
        client.post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(shop["branch"].pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 2}],
            },
            format="json",
        )

        response = client.get(f"/api/v1/stock-transfers/in-transit/?branch={target.pk}")

        assert response.status_code == 200
        assert len(response.data) == 1
        assert response.data[0]["status"] == "IN_TRANSIT"

    def test_a_cashier_cannot_receive_or_turn_back_a_transfer(self, shop, auth_client):
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]
        moving = (
            auth_client(shop["owner"])
            .post(
                "/api/v1/stock-transfers/",
                {
                    "source_branch": str(shop["branch"].pk),
                    "target_branch": str(target.pk),
                    "lines": [{"variant": str(variant.pk), "quantity": 2}],
                },
                format="json",
            )
            .data
        )
        cashier = auth_client(shop["cashier"])

        assert (
            cashier.post(
                f"/api/v1/stock-transfers/{moving['id']}/receive/", {}, format="json"
            ).status_code
            == 403
        )
        assert (
            cashier.post(
                f"/api/v1/stock-transfers/{moving['id']}/cancel/",
                {"reason": "No."},
                format="json",
            ).status_code
            == 403
        )

    def test_transferring_more_than_the_source_holds_is_refused(self, shop, auth_client):
        target = factories.branch(shop["organization"])
        variant = shop["variants"][0]

        response = auth_client(shop["owner"]).post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(shop["branch"].pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 999}],
            },
            format="json",
        )

        assert response.status_code == 409
        assert _stock(variant, shop["branch"]).on_hand == 10

    def test_a_transfer_to_the_same_branch_is_refused(self, shop, auth_client):
        response = auth_client(shop["owner"]).post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(shop["branch"].pk),
                "target_branch": str(shop["branch"].pk),
                "lines": [{"variant": str(shop["variants"][0].pk), "quantity": 1}],
            },
            format="json",
        )

        assert response.status_code == 400

    def test_a_cashier_cannot_transfer_stock(self, shop, auth_client):
        target = factories.branch(shop["organization"])

        response = auth_client(shop["cashier"]).post(
            "/api/v1/stock-transfers/",
            {
                "source_branch": str(shop["branch"].pk),
                "target_branch": str(target.pk),
                "lines": [{"variant": str(shop["variants"][0].pk), "quantity": 1}],
            },
            format="json",
        )

        assert response.status_code == 403
