"""Stock comes in on a receipt, never on an adjustment.

business-rules.md § 4.0a. D72 took the opening-stock box off the product form,
because an adjustment writes units at the row's `average_cost` and that is
0.00 on a variant nothing has been received against: the stock was valued at
nothing and sold at 100% margin. The box went; the door did not. Save the
product, press Adjust on its row, type 50 -- and the same zero-cost stock
arrived one click later, with no supplier, no payable and no input VAT behind
it. A stock count "finding" units did the same through the same function.

What is refused is narrow: raising the figure on a branch that has never
received the variant. Everything else an adjustment is for still works --
correcting received stock in either direction, and counting legacy stock down.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from core.exceptions import NotReceived
from core.models import AuditLog
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

ADJUST = "/api/v1/inventory/adjust/"


def _on_hand(variant: Any, branch: Any) -> int:
    row = Inventory.objects.filter(variant=variant, branch=branch).first()
    return row.on_hand if row else 0


class TestTheService:
    def test_raising_a_never_received_variant_is_refused_and_writes_nothing(self, shop):
        branch = shop["branch"]
        variant = factories.variant(price="1000.00", cost="250.00")
        audits = AuditLog.objects.count()

        with pytest.raises(NotReceived) as refused:
            services.adjust(branch=branch, variant=variant, new_on_hand=50, reason="Opening stock")

        assert refused.value.details["sku"] == variant.sku
        assert refused.value.details["requested"] == 50
        assert _on_hand(variant, branch) == 0
        assert not InventoryTransaction.objects.filter(variant=variant).exists()
        assert AuditLog.objects.count() == audits

    def test_a_receipt_at_another_branch_is_no_cost_basis_here(self, shop):
        """Cost is per branch (ADR-0006), so the evidence has to be too."""
        here = shop["branch"]
        elsewhere = factories.branch(shop["organization"], code="CTG1", name="Chattogram")
        variant = factories.variant()
        factories.stock(variant, elsewhere, 10, unit_cost="300.00")

        with pytest.raises(NotReceived):
            services.adjust(branch=here, variant=variant, new_on_hand=3, reason="Found some")

    def test_a_received_variant_can_be_corrected_upwards_at_its_average(self, shop):
        branch = shop["branch"]
        variant = factories.variant()
        factories.stock(variant, branch, 4, unit_cost="300.00")
        services.sell(branch=branch, lines=[(variant, 4)], reference_id="sold-out")

        entry = services.adjust(
            branch=branch, variant=variant, new_on_hand=2, reason="Two found behind the till"
        )

        assert entry is not None
        assert entry.quantity == 2
        # The surplus is valued like the rest of what this branch paid for it.
        assert entry.unit_cost == Decimal("300.00")
        assert _on_hand(variant, branch) == 2

    def test_stock_transferred_in_counts_as_received(self, shop):
        source = shop["branch"]
        target = factories.branch(shop["organization"], code="CTG2", name="Second")
        variant = factories.variant()
        factories.stock(variant, source, 6, unit_cost="200.00")
        services.transfer(source_branch=source, target_branch=target, lines=[(variant, 2)])

        entry = services.adjust(branch=target, variant=variant, new_on_hand=3, reason="Recount")

        assert entry is not None
        assert _on_hand(variant, target) == 3

    def test_a_free_delivery_is_still_a_delivery(self, shop):
        """A zero-cost receipt is a real one -- a sample, a replacement."""
        branch = shop["branch"]
        variant = factories.variant()
        factories.stock(variant, branch, 1, unit_cost="0.00")

        entry = services.adjust(branch=branch, variant=variant, new_on_hand=2, reason="Recount")

        assert entry is not None

    def test_legacy_stock_with_no_receipt_can_still_be_counted_down(self, shop):
        """Rows written before this rule must stay correctable towards the truth."""
        branch = shop["branch"]
        variant = factories.variant()
        factories.unreceived_stock(variant, branch, 5)

        lowered = services.adjust(branch=branch, variant=variant, new_on_hand=1, reason="Recount")
        assert lowered is not None
        assert _on_hand(variant, branch) == 1

        with pytest.raises(NotReceived):
            services.adjust(branch=branch, variant=variant, new_on_hand=4, reason="Recount")
        assert _on_hand(variant, branch) == 1

    def test_the_lower_level_door_is_shut_too(self, shop):
        """`apply_transaction` takes a signed ADJUSTMENT delta directly."""
        branch = shop["branch"]
        variant = factories.variant()

        with pytest.raises(NotReceived):
            services.apply_transaction(
                branch=branch,
                variant=variant,
                transaction_type=TransactionType.ADJUSTMENT,
                quantity=7,
                reason="Opening stock",
            )
        assert _on_hand(variant, branch) == 0

    def test_received_variant_ids_answers_for_many_in_one_query(
        self, shop, django_assert_num_queries
    ):
        branch = shop["branch"]
        bought, transferred, never = factories.variant(), factories.variant(), factories.variant()
        factories.stock(bought, branch, 1)
        other = factories.branch(shop["organization"], code="SYL1", name="Sylhet")
        factories.stock(transferred, other, 3)
        services.transfer(source_branch=other, target_branch=branch, lines=[(transferred, 1)])

        with django_assert_num_queries(1):
            received = services.received_variant_ids(
                branch=branch, variants=[bought, transferred, never]
            )

        assert received == {str(bought.pk), str(transferred.pk)}


class TestTheEndpoint:
    def test_the_refusal_is_a_409_in_the_error_envelope(self, shop, auth_client):
        variant = factories.variant()

        response = auth_client(shop["manager"]).post(
            ADJUST,
            {
                "variant": str(variant.pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 12,
                "reason": "Opening stock",
            },
            format="json",
        )

        assert response.status_code == 409
        error = response.json()["error"]
        assert error["code"] == "NOT_RECEIVED"
        assert "purchase order" in error["message"]
        assert error["details"]["sku"] == variant.sku

    def test_each_inventory_row_says_whether_it_was_received(self, shop, auth_client):
        branch = shop["branch"]
        received = shop["variants"][0]  # the fixture receives its stock
        never = factories.variant(received.product)
        factories.stock(never, branch, 0)  # an empty row, as a created product has

        rows = auth_client(shop["manager"]).get("/api/v1/inventory/", {"page_size": 100}).json()
        by_variant = {row["variant"]: row for row in rows["results"]}

        assert by_variant[str(received.pk)]["received"] is True
        assert by_variant[str(never.pk)]["received"] is False

    def test_the_product_form_is_told_which_rows_can_be_raised(self, shop, auth_client):
        branch = shop["branch"]
        received = shop["variants"][0]
        never = factories.variant(received.product)

        detail = auth_client(shop["owner"]).get(
            f"/api/v1/products/{received.product_id}/", {"branch": str(branch.pk)}
        )

        assert detail.status_code == 200, detail.data
        stock = {row["id"]: row["stock"] for row in detail.json()["variants"]}
        assert stock[str(received.pk)]["received"] is True
        assert stock[str(never.pk)]["received"] is False


class TestAStockCount:
    def _count_with(self, client: Any, branch: Any, lines: list[tuple[Any, int]]) -> str:
        opened = client.post(
            "/api/v1/stock-counts/", {"branch": str(branch.pk), "notes": "Monthly"}, format="json"
        )
        assert opened.status_code == 201, opened.data
        count_id = opened.data["id"]
        recorded = client.post(
            f"/api/v1/stock-counts/{count_id}/record/",
            {
                "lines": [
                    {"variant": str(variant.pk), "counted_quantity": quantity}
                    for variant, quantity in lines
                ]
            },
            format="json",
        )
        assert recorded.status_code == 200, recorded.data
        return count_id

    def test_a_count_that_finds_unbought_stock_is_refused_whole(self, shop, auth_client):
        """All or none: the good line is not applied either, and the count stays open."""
        client = auth_client(shop["manager"])
        branch = shop["branch"]
        good = shop["variants"][0]  # 10 on hand, received
        found = factories.variant()
        factories.stock(found, branch, 0)  # on the sheet, never received
        count_id = self._count_with(client, branch, [(good, 8), (found, 3)])

        response = client.post(f"/api/v1/stock-counts/{count_id}/apply/", {}, format="json")

        assert response.status_code == 409
        error = response.json()["error"]
        assert error["code"] == "NOT_RECEIVED"
        assert found.sku in error["message"]
        assert [line["sku"] for line in error["details"]["lines"]] == [found.sku]
        assert _on_hand(good, branch) == 10
        assert _on_hand(found, branch) == 0
        assert StockCount.objects.get(pk=count_id).status == StockCountStatus.COUNTING

    def test_receiving_the_found_goods_lets_the_same_count_apply(self, shop, auth_client):
        client = auth_client(shop["manager"])
        branch = shop["branch"]
        good = shop["variants"][0]
        found = factories.variant()
        factories.stock(found, branch, 0)
        count_id = self._count_with(client, branch, [(good, 8), (found, 3)])
        assert client.post(f"/api/v1/stock-counts/{count_id}/apply/", {}).status_code == 409

        # The three found units are bought in properly, at what they cost.
        factories.stock(found, branch, 3, unit_cost="150.00")
        response = client.post(f"/api/v1/stock-counts/{count_id}/apply/", {}, format="json")

        assert response.status_code == 200, response.data
        # Only the good line moved: the found one now matches what was received.
        assert response.data["adjusted_lines"] == 1
        assert _on_hand(good, branch) == 8
        assert _on_hand(found, branch) == 3

    def test_counting_an_unbought_line_at_zero_is_not_a_problem(self, shop, auth_client):
        client = auth_client(shop["manager"])
        branch = shop["branch"]
        empty = factories.variant()
        factories.stock(empty, branch, 0)
        count_id = self._count_with(client, branch, [(shop["variants"][0], 9), (empty, 0)])

        response = client.post(f"/api/v1/stock-counts/{count_id}/apply/", {}, format="json")

        assert response.status_code == 200, response.data
        assert _on_hand(shop["variants"][0], branch) == 9
