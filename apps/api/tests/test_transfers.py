"""Stock in transit — the gap between two shelves.

`business-rules.md` §1.6 has always described transfers as two steps:

    "it leaves the source immediately and arrives when the transfer is marked
     received. A pending transfer therefore shows as reduced at the source and
     not yet present at the destination."

The code did not do that. `transfer()` wrote `TRANSFER_OUT` and `TRANSFER_IN`
in one transaction and stamped `RECEIVED`, so the destination could sell goods
that were physically in a van — an oversell the ledger cannot even see, because
as far as it knows the stock is on the shelf. `IN_TRANSIT`, `received_at` and
`received_by` existed on the model and were never written to.

A documented behaviour that does not exist is worse than a missing one: anyone
reading the doc would believe the protection was there. So these tests assert
the document, not the old code.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.exceptions import Conflict, InsufficientStock, ValidationError
from core.models import AuditLog
from inventory import selectors, services
from inventory.models import (
    Inventory,
    InventoryTransaction,
    TransactionType,
    TransferStatus,
)
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def route(shop):
    """Two branches and a variant with 20 units at the source."""
    source = shop["branch"]
    target = factories.branch(shop["organization"])
    variant = factories.variant()
    services.receive_stock(branch=source, variant=variant, quantity=20, unit_cost=Decimal("250.00"))
    return {"source": source, "target": target, "variant": variant, "shop": shop}


def _on_hand(variant, branch) -> int:
    row = Inventory.objects.filter(branch=branch, variant=variant).first()
    return row.on_hand if row else 0


def _dispatch(route, quantity: int = 8, **kwargs):
    return services.transfer(
        source_branch=route["source"],
        target_branch=route["target"],
        lines=[(route["variant"].pk, quantity)],
        **kwargs,
    )


class TestDispatch:
    def test_the_goods_leave_the_source_and_reach_nobody(self, route):
        moving = _dispatch(route)

        assert moving.status == TransferStatus.IN_TRANSIT
        assert moving.dispatched_at is not None
        assert moving.received_at is None
        assert _on_hand(route["variant"], route["source"]) == 12
        assert _on_hand(route["variant"], route["target"]) == 0

    def test_the_destination_cannot_sell_what_is_still_in_the_van(self, route):
        """The point of the whole change, stated as the thing it prevents."""
        _dispatch(route)

        with pytest.raises(InsufficientStock):
            services.apply_transaction(
                branch=route["target"],
                variant=route["variant"],
                transaction_type=TransactionType.SALE,
                quantity=1,
            )

    def test_the_source_cannot_sell_it_either(self, route):
        """It left. Dispatch is a real reduction, not a reservation."""
        _dispatch(route, quantity=20)

        with pytest.raises(InsufficientStock):
            services.apply_transaction(
                branch=route["source"],
                variant=route["variant"],
                transaction_type=TransactionType.SALE,
                quantity=1,
            )

    def test_dispatching_more_than_the_source_holds_is_refused(self, route):
        with pytest.raises(InsufficientStock):
            _dispatch(route, quantity=21)

        assert _on_hand(route["variant"], route["source"]) == 20

    def test_cost_is_frozen_at_dispatch(self, route):
        """What the stock was worth is a fact about the source at the moment it
        left. A receipt weeks later must not revalue it (ADR-0006)."""
        moving = _dispatch(route)
        # The source buys more, much dearer, while the first lot is in transit.
        services.receive_stock(
            branch=route["source"],
            variant=route["variant"],
            quantity=12,
            unit_cost=Decimal("900.00"),
        )

        services.receive_transfer(transfer_row=moving)

        target = Inventory.objects.get(branch=route["target"], variant=route["variant"])
        assert target.average_cost == Decimal("250.00")


class TestInTransitIsVisible:
    """Stock in a van is in nobody's `on_hand`, which is correct. It still has
    to be *findable*, or it is simply missing."""

    def test_the_destination_can_see_what_is_coming(self, route):
        _dispatch(route)

        assert selectors.in_transit_units(branch=route["target"]) == {str(route["variant"].pk): 8}

    def test_the_source_sees_nothing_coming_to_it(self, route):
        _dispatch(route)

        assert selectors.in_transit_units(branch=route["source"]) == {}

    def test_the_listing_is_directional(self, route):
        moving = _dispatch(route)

        incoming = selectors.in_transit(branch=route["target"], direction="in")
        outgoing = selectors.in_transit(branch=route["source"], direction="out")
        assert list(incoming.values_list("pk", flat=True)) == [moving.pk]
        assert list(outgoing.values_list("pk", flat=True)) == [moving.pk]
        assert not selectors.in_transit(branch=route["source"], direction="in").exists()

    def test_a_received_transfer_leaves_the_in_transit_list(self, route):
        moving = _dispatch(route)
        services.receive_transfer(transfer_row=moving)

        assert not selectors.in_transit(branch=route["target"], direction="in").exists()
        assert selectors.in_transit_units(branch=route["target"]) == {}


class TestReceipt:
    def test_receiving_lands_the_stock(self, route):
        moving = _dispatch(route)

        received = services.receive_transfer(transfer_row=moving, actor=route["shop"]["manager"])

        assert received.status == TransferStatus.RECEIVED
        assert received.received_by_id == route["shop"]["manager"].pk
        assert received.received_at is not None
        assert _on_hand(route["variant"], route["target"]) == 8
        assert received.items.first().received_quantity == 8

    def test_receiving_twice_is_refused(self, route):
        """Otherwise the second receipt invents eight units out of nothing."""
        moving = _dispatch(route)
        services.receive_transfer(transfer_row=moving)

        with pytest.raises(Conflict):
            services.receive_transfer(transfer_row=moving)

        assert _on_hand(route["variant"], route["target"]) == 8

    def test_receiving_is_audited(self, route):
        moving = _dispatch(route)
        before = AuditLog.objects.count()

        services.receive_transfer(transfer_row=moving, actor=route["shop"]["manager"])

        assert AuditLog.objects.count() > before

    def test_the_arrival_is_a_transfer_not_a_purchase(self, route):
        """`receive_stock` owns the weighted-average arithmetic so it is reused,
        but the row it writes says PURCHASE. Left alone that would put branch
        transfers into the purchasing and profit reports as buying."""
        moving = _dispatch(route)
        services.receive_transfer(transfer_row=moving)

        rows = InventoryTransaction.objects.filter(branch=route["target"], variant=route["variant"])
        assert rows.filter(transaction_type=TransactionType.TRANSFER_IN).exists()
        assert not rows.filter(transaction_type=TransactionType.PURCHASE).exists()


class TestShortReceipt:
    """A box goes missing between the two shops. The units left one shelf and
    reached no other, so somebody has to say what happened to them."""

    def test_a_shortfall_is_written_off_at_the_destination(self, route):
        moving = _dispatch(route, quantity=8)

        services.receive_transfer(
            transfer_row=moving,
            received={route["variant"].pk: 6},
            reason="Two units missing from the carton on arrival.",
            actor=route["shop"]["manager"],
        )

        assert _on_hand(route["variant"], route["target"]) == 6
        rows = InventoryTransaction.objects.filter(branch=route["target"], variant=route["variant"])
        # Both halves are on the ledger: eight were sent, two were lost.
        assert rows.get(transaction_type=TransactionType.TRANSFER_IN).quantity == 8
        assert rows.get(transaction_type=TransactionType.LOSS).quantity == -2

    def test_the_shortfall_is_recorded_on_the_line(self, route):
        moving = _dispatch(route, quantity=8)

        received = services.receive_transfer(
            transfer_row=moving,
            received={route["variant"].pk: 6},
            reason="Two missing.",
        )

        item = received.items.first()
        assert item.quantity == 8
        assert item.received_quantity == 6
        assert item.shortfall == 2
        assert received.units_lost == 2

    def test_a_shortfall_without_a_reason_is_refused(self, route):
        moving = _dispatch(route, quantity=8)

        with pytest.raises(ValidationError):
            services.receive_transfer(transfer_row=moving, received={route["variant"].pk: 6})

        moving.refresh_from_db()
        assert moving.status == TransferStatus.IN_TRANSIT
        assert _on_hand(route["variant"], route["target"]) == 0

    def test_receiving_more_than_was_sent_is_refused(self, route):
        """Those units have no cost and no provenance -- a data-entry error,
        not an event."""
        moving = _dispatch(route, quantity=8)

        with pytest.raises(ValidationError):
            services.receive_transfer(
                transfer_row=moving,
                received={route["variant"].pk: 9},
                reason="Found an extra one.",
            )

        assert _on_hand(route["variant"], route["target"]) == 0

    def test_nothing_arriving_at_all_is_a_total_loss_not_a_cancellation(self, route):
        """The goods left and never came back. That is shrinkage at the
        destination, not a transfer that did not happen."""
        moving = _dispatch(route, quantity=8)

        received = services.receive_transfer(
            transfer_row=moving,
            received={route["variant"].pk: 0},
            reason="Carton never arrived. Courier claim raised.",
        )

        assert received.status == TransferStatus.RECEIVED
        assert _on_hand(route["variant"], route["target"]) == 0
        assert _on_hand(route["variant"], route["source"]) == 12
        assert received.units_lost == 8


class TestCancellation:
    def test_cancelling_returns_the_stock_to_the_source(self, route):
        moving = _dispatch(route, quantity=8)

        cancelled = services.cancel_transfer(
            transfer_row=moving,
            reason="Van turned back, road closed.",
            actor=route["shop"]["manager"],
        )

        assert cancelled.status == TransferStatus.CANCELLED
        assert cancelled.cancelled_by_id == route["shop"]["manager"].pk
        assert _on_hand(route["variant"], route["source"]) == 20
        assert _on_hand(route["variant"], route["target"]) == 0

    def test_both_movements_stay_on_the_ledger(self, route):
        """It is not a delete. The stock physically left and physically came
        back, and the history has to be able to say so."""
        moving = _dispatch(route, quantity=8)
        services.cancel_transfer(transfer_row=moving, reason="Turned back.")

        rows = InventoryTransaction.objects.filter(branch=route["source"], variant=route["variant"])
        assert rows.filter(transaction_type=TransactionType.TRANSFER_OUT).exists()
        assert rows.filter(transaction_type=TransactionType.TRANSFER_IN).exists()

    def test_cancelling_without_a_reason_is_refused(self, route):
        """Stock reappearing on a shelf without one is indistinguishable from
        stock being invented."""
        moving = _dispatch(route, quantity=8)

        with pytest.raises(ValidationError):
            services.cancel_transfer(transfer_row=moving, reason="  ")

        moving.refresh_from_db()
        assert moving.status == TransferStatus.IN_TRANSIT
        assert _on_hand(route["variant"], route["source"]) == 12

    def test_a_received_transfer_cannot_be_cancelled(self, route):
        moving = _dispatch(route, quantity=8)
        services.receive_transfer(transfer_row=moving)

        with pytest.raises(Conflict):
            services.cancel_transfer(transfer_row=moving, reason="Changed my mind.")

        assert _on_hand(route["variant"], route["target"]) == 8

    def test_cancelling_twice_is_refused(self, route):
        moving = _dispatch(route, quantity=8)
        services.cancel_transfer(transfer_row=moving, reason="Turned back.")

        with pytest.raises(Conflict):
            services.cancel_transfer(transfer_row=moving, reason="Turned back again.")

        assert _on_hand(route["variant"], route["source"]) == 20
