"""Inventory engine: the invariants the whole business rests on."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.test import override_settings

from core.exceptions import InsufficientStock, ValidationError
from core.models import AppendOnlyError
from inventory import services
from inventory.models import (
    Inventory,
    InventoryTransaction,
    TransactionType,
    TransferStatus,
)
from tests import factories

pytestmark = pytest.mark.django_db


def _inventory(variant, branch) -> Inventory:
    return Inventory.objects.get(variant=variant, branch=branch)


class TestLedger:
    def test_receiving_stock_increases_on_hand_and_writes_a_ledger_row(self, shop):
        variant, branch = factories.variant(), shop["branch"]

        entry = services.receive_stock(
            branch=branch, variant=variant, quantity=25, unit_cost=Decimal("400.00")
        )

        inventory = _inventory(variant, branch)
        assert inventory.on_hand == 25
        assert inventory.available == 25
        assert entry.transaction_type == TransactionType.PURCHASE
        assert entry.quantity == 25
        assert entry.on_hand_after == 25

    def test_selling_reduces_stock(self, shop):
        variant = shop["variants"][0]  # 10 on hand
        services.sell(branch=shop["branch"], lines=[(variant.pk, 3)], reference_id="test")

        assert _inventory(variant, shop["branch"]).on_hand == 7

    def test_cannot_sell_more_than_available(self, shop):
        variant = shop["variants"][1]  # 5 on hand

        with pytest.raises(InsufficientStock) as exc:
            services.sell(branch=shop["branch"], lines=[(variant.pk, 6)], reference_id="test")

        assert exc.value.code == "INSUFFICIENT_STOCK"
        assert exc.value.details["available"] == 5
        assert _inventory(variant, shop["branch"]).on_hand == 5  # unchanged

    def test_a_multi_line_sale_is_all_or_nothing(self, shop):
        first, second = shop["variants"]  # 10 and 5

        with pytest.raises(InsufficientStock):
            services.sell(
                branch=shop["branch"],
                lines=[(first.pk, 2), (second.pk, 99)],
                reference_id="test",
            )

        # The first line must not have been deducted.
        assert _inventory(first, shop["branch"]).on_hand == 10

    def test_ledger_rows_cannot_be_edited_or_deleted(self, shop):
        entry = services.sell(
            branch=shop["branch"], lines=[(shop["variants"][0].pk, 1)], reference_id="t"
        )[0]

        entry.quantity = -999
        with pytest.raises(AppendOnlyError):
            entry.save()
        with pytest.raises(AppendOnlyError):
            entry.delete()

    def test_adjustment_requires_a_reason(self, shop):
        with pytest.raises(ValidationError):
            services.adjust(
                branch=shop["branch"], variant=shop["variants"][0], new_on_hand=5, reason="  "
            )

    def test_adjustment_writes_the_difference_not_the_absolute_figure(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]  # 10 on hand

        entry = services.adjust(
            branch=branch, variant=variant, new_on_hand=7, reason="Stock count 2026-08"
        )

        assert entry.quantity == -3
        assert _inventory(variant, branch).on_hand == 7

    def test_write_off_requires_damage_or_loss(self, shop):
        with pytest.raises(ValidationError):
            services.write_off(
                branch=shop["branch"],
                variant=shop["variants"][0],
                quantity=1,
                transaction_type=TransactionType.SALE,
                reason="wrong type",
            )


class TestReservations:
    def test_reserving_holds_stock_without_removing_it(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]

        services.reserve(branch=branch, lines=[(variant.pk, 4)], reference_id="order-1")

        inventory = _inventory(variant, branch)
        assert inventory.on_hand == 10
        assert inventory.reserved == 4
        assert inventory.available == 6

    def test_cannot_reserve_more_than_available(self, shop):
        variant, branch = shop["variants"][1], shop["branch"]  # 5
        services.reserve(branch=branch, lines=[(variant.pk, 4)], reference_id="order-1")

        with pytest.raises(InsufficientStock):
            services.reserve(branch=branch, lines=[(variant.pk, 2)], reference_id="order-2")

    def test_releasing_returns_stock_to_available(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]
        services.reserve(branch=branch, lines=[(variant.pk, 4)], reference_id="order-1")

        services.release_reservation(branch=branch, lines=[(variant.pk, 4)], reference_id="order-1")

        inventory = _inventory(variant, branch)
        assert inventory.reserved == 0
        assert inventory.available == 10

    def test_consuming_a_reservation_deducts_stock_exactly_once(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]
        services.reserve(branch=branch, lines=[(variant.pk, 3)], reference_id="order-9")

        services.consume_reservation(branch=branch, lines=[(variant.pk, 3)], reference_id="order-9")
        # A retried fulfilment must not deduct again.
        services.consume_reservation(branch=branch, lines=[(variant.pk, 3)], reference_id="order-9")

        inventory = _inventory(variant, branch)
        assert inventory.on_hand == 7
        assert inventory.reserved == 0
        assert (
            InventoryTransaction.objects.filter(
                reference_id="order-9", transaction_type=TransactionType.SALE
            ).count()
            == 1
        )

    def test_releasing_more_than_reserved_is_clamped(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]
        services.reserve(branch=branch, lines=[(variant.pk, 2)], reference_id="order-1")

        services.release_reservation(
            branch=branch, lines=[(variant.pk, 10)], reference_id="order-1"
        )

        assert _inventory(variant, branch).reserved == 0


class TestCosting:
    def test_weighted_average_cost_blends_receipts(self, shop):
        variant, branch = factories.variant(), shop["branch"]

        services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("100.00")
        )
        services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("200.00")
        )

        # (10*100 + 10*200) / 20 = 150 — not the latest cost of 200.
        assert _inventory(variant, branch).average_cost == Decimal("150.00")

    def test_selling_does_not_change_average_cost(self, shop):
        variant, branch = factories.variant(), shop["branch"]
        services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("100.00")
        )

        services.sell(branch=branch, lines=[(variant.pk, 5)], reference_id="s")

        assert _inventory(variant, branch).average_cost == Decimal("100.00")


class TestTransfers:
    def test_dispatch_removes_stock_from_the_source_and_gives_it_to_nobody(self, shop):
        """The gap is the feature. Until 2026-09-01 both movements were written
        at once, so the destination could sell goods that were in a van --
        an oversell the ledger could not see, because as far as it knew the
        stock was on the shelf.
        """
        source = shop["branch"]
        target = factories.branch(shop["organization"])
        variant = factories.variant()
        services.receive_stock(
            branch=source, variant=variant, quantity=20, unit_cost=Decimal("250.00")
        )

        moving = services.transfer(
            source_branch=source, target_branch=target, lines=[(variant.pk, 8)], notes="Restock"
        )

        assert moving.status == TransferStatus.IN_TRANSIT
        assert moving.dispatched_at is not None
        assert _inventory(variant, source).on_hand == 12
        # Not "zero at the destination" -- the destination has no row for it at
        # all. Nothing has ever arrived, so there is nothing to have a balance.
        assert not Inventory.objects.filter(branch=target, variant=variant).exists()
        assert InventoryTransaction.objects.filter(
            transaction_type=TransactionType.TRANSFER_OUT
        ).exists()
        assert not InventoryTransaction.objects.filter(
            transaction_type=TransactionType.TRANSFER_IN
        ).exists()

    def test_receiving_lands_the_stock_and_the_cost_it_travelled_at(self, shop):
        source = shop["branch"]
        target = factories.branch(shop["organization"])
        variant = factories.variant()
        services.receive_stock(
            branch=source, variant=variant, quantity=20, unit_cost=Decimal("250.00")
        )
        moving = services.transfer(
            source_branch=source, target_branch=target, lines=[(variant.pk, 8)]
        )

        received = services.receive_transfer(transfer_row=moving)

        assert received.status == TransferStatus.RECEIVED
        assert received.received_at is not None
        target_inventory = _inventory(variant, target)
        assert target_inventory.on_hand == 8
        assert target_inventory.average_cost == Decimal("250.00")
        assert InventoryTransaction.objects.filter(
            transaction_type=TransactionType.TRANSFER_IN
        ).exists()

    def test_cannot_transfer_to_the_same_branch(self, shop):
        with pytest.raises(ValidationError):
            services.transfer(
                source_branch=shop["branch"],
                target_branch=shop["branch"],
                lines=[(shop["variants"][0].pk, 1)],
            )


class TestIntegrity:
    def test_cached_columns_match_the_ledger_after_mixed_activity(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]

        services.reserve(branch=branch, lines=[(variant.pk, 2)], reference_id="o1")
        services.sell(branch=branch, lines=[(variant.pk, 1)], reference_id="o2")
        services.restock_return(branch=branch, lines=[(variant.pk, 1)], reference_id="r1")
        services.adjust(branch=branch, variant=variant, new_on_hand=8, reason="count")
        services.write_off(
            branch=branch,
            variant=variant,
            quantity=1,
            transaction_type=TransactionType.DAMAGE,
            reason="water damage",
        )

        assert services.verify_integrity() == []

    def test_drift_is_detected_and_explained_by_a_repair_row(self, shop):
        variant, branch = shop["variants"][0], shop["branch"]
        # Simulate the bug this check exists to catch: a direct UPDATE.
        Inventory.objects.filter(variant=variant, branch=branch).update(on_hand=99)

        issues = services.verify_integrity()
        assert len(issues) == 1
        assert issues[0].on_hand_drift == 89

        services.repair_drift(issue=issues[0], reason="test reconciliation")

        assert services.verify_integrity() == []


class TestOversellConfiguration:
    @override_settings(
        RANGON={
            **__import__("django.conf", fromlist=["settings"]).settings.RANGON,
            "ALLOW_OVERSELL": True,
        }
    )
    def test_overselling_is_possible_only_when_deliberately_enabled(self, shop):
        variant, branch = shop["variants"][1], shop["branch"]  # 5 on hand

        services.sell(branch=branch, lines=[(variant.pk, 7)], reference_id="oversell")

        assert _inventory(variant, branch).on_hand == -2
