"""Oversell exceptions — the precondition for offline POS.

`docs/architecture/offline-pos.md` relaxes the "never oversell" rule in exactly
one place: a sale that already happened at the counter while the register could
not reach the server. It pays for that relaxation with a promise —

    "It requires an explicit oversell exception report before the feature can
    be enabled — which is why it is V2, not V1."

These tests are that promise, written as assertions. Two things have to hold or
offline POS must not ship:

  1. **Nothing goes negative silently.** Every path that can take `on_hand`
     below zero funnels through `inventory.services._write_ledger`, so a single
     hook there covers all of them — present and future. The tests below reach
     that hook through as many different doors as the system has.
  2. **Closing one requires a human saying what it was.** A resolution that can
     be clicked away without a reason is a queue that empties itself, which is
     the same as having no report at all.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.exceptions import Conflict, InsufficientStock, ValidationError
from core.models import AuditLog
from inventory import services as inventory_services
from inventory.models import (
    Inventory,
    InventoryTransaction,
    StockException,
    StockExceptionResolution,
    StockExceptionStatus,
    TransactionType,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def stocked(shop):
    """One variant with five units on the shelf, received the way stock arrives."""
    variant = shop["variants"][1]  # `full_shop` receives 5 of this one
    inventory = Inventory.objects.get(branch=shop["branch"], variant=variant)
    assert inventory.on_hand == 5
    return {"branch": shop["branch"], "variant": variant, "inventory": inventory}


def _ledger_rows(stocked) -> int:
    return InventoryTransaction.objects.filter(
        branch=stocked["branch"], variant=stocked["variant"]
    ).count()


def _oversell(stocked, quantity: int = 8, **kwargs):
    """Sell more than is on the shelf, the way an offline register would."""
    return inventory_services.apply_transaction(
        branch=stocked["branch"],
        variant=stocked["variant"],
        transaction_type=TransactionType.SALE,
        quantity=quantity,
        allow_negative=True,
        reference_type="pos_sale",
        reference_id="OFFLINE-1",
        **kwargs,
    )


class TestDetection:
    def test_a_sale_that_goes_negative_raises_exactly_one_exception(self, stocked):
        entry = _oversell(stocked, quantity=8)

        exception = StockException.objects.get()
        assert exception.transaction_id == entry.pk
        assert exception.shortfall == 3  # 5 on hand, 8 sold
        assert exception.on_hand_after == -3
        assert exception.status == StockExceptionStatus.OPEN
        assert exception.is_open

    def test_a_sale_within_stock_raises_nothing(self, stocked):
        inventory_services.apply_transaction(
            branch=stocked["branch"],
            variant=stocked["variant"],
            transaction_type=TransactionType.SALE,
            quantity=5,
        )

        assert not StockException.objects.exists()

    def test_selling_exactly_to_zero_is_not_an_exception(self, stocked):
        """Zero is a legal balance. Only *below* zero is the relaxed rule."""
        _oversell(stocked, quantity=5)

        assert not StockException.objects.exists()

    def test_the_carried_reference_points_back_at_the_sale(self, stocked):
        _oversell(stocked)

        exception = StockException.objects.get()
        # Findable from the sale without walking the ledger.
        assert exception.reference_type == "pos_sale"
        assert exception.reference_id == "OFFLINE-1"
        assert exception.branch_id == stocked["branch"].pk
        assert exception.variant_id == stocked["variant"].pk


class TestWhatDoesNotRaise:
    """A report nobody trusts is a report nobody reads. These are the cases
    that would fill it with noise."""

    def test_a_receipt_onto_negative_stock_raises_nothing(self, stocked):
        """The stock arriving to cover the hole is not a second hole."""
        _oversell(stocked, quantity=8)
        assert StockException.objects.count() == 1

        inventory_services.receive_stock(
            branch=stocked["branch"],
            variant=stocked["variant"],
            quantity=2,
            unit_cost=Decimal("400.00"),
        )

        # Still negative (-1), but nothing new was raised.
        assert StockException.objects.count() == 1
        stocked["inventory"].refresh_from_db()
        assert stocked["inventory"].on_hand == -1

    def test_a_reservation_never_raises_one(self, stocked):
        """Reservations move `reserved`, not `on_hand`. Overbooking availability
        is a different problem with a different remedy, and `on_hand` is still
        five units sitting on the shelf."""
        inventory_services.apply_transaction(
            branch=stocked["branch"],
            variant=stocked["variant"],
            transaction_type=TransactionType.RESERVATION,
            quantity=20,
            allow_negative=True,
            reference_type="cart",
            reference_id="C-1",
        )

        stocked["inventory"].refresh_from_db()
        assert stocked["inventory"].on_hand == 5
        assert not StockException.objects.exists()

    def test_a_refused_sale_leaves_no_exception_behind(self, stocked):
        """The online path still refuses. A refusal is not an oversell, and the
        rollback must not leave a phantom row."""
        with pytest.raises(InsufficientStock):
            inventory_services.apply_transaction(
                branch=stocked["branch"],
                variant=stocked["variant"],
                transaction_type=TransactionType.SALE,
                quantity=9,
            )

        assert not StockException.objects.exists()
        stocked["inventory"].refresh_from_db()
        assert stocked["inventory"].on_hand == 5


class TestEveryDoorIsCovered:
    """The hook sits in `_write_ledger`, which every movement passes through.
    These reach it by different routes, so a future path that forgets about
    exceptions still gets one."""

    def test_a_damage_write_off_that_goes_negative_raises_one(self, stocked):
        inventory_services.apply_transaction(
            branch=stocked["branch"],
            variant=stocked["variant"],
            transaction_type=TransactionType.DAMAGE,
            quantity=7,
            reason="Flood",
            allow_negative=True,
        )

        assert StockException.objects.get().shortfall == 2

    def test_a_negative_adjustment_raises_one(self, stocked):
        inventory_services.apply_transaction(
            branch=stocked["branch"],
            variant=stocked["variant"],
            transaction_type=TransactionType.ADJUSTMENT,
            quantity=-6,
            reason="Recount",
            allow_negative=True,
        )

        assert StockException.objects.get().shortfall == 1

    def test_the_global_oversell_switch_also_raises_one(self, stocked, settings):
        """`RANGON["ALLOW_OVERSELL"]` bypasses the guard for the whole install.
        It must not also bypass the report -- that combination is the exact
        silent-negative-stock failure this table exists to prevent."""
        settings.RANGON = {**settings.RANGON, "ALLOW_OVERSELL": True}

        inventory_services.apply_transaction(
            branch=stocked["branch"],
            variant=stocked["variant"],
            transaction_type=TransactionType.SALE,
            quantity=6,
        )

        assert StockException.objects.get().shortfall == 1


class TestOneExceptionPerMovement:
    def test_a_second_oversell_raises_its_own_row(self, stocked):
        """Two offline registers selling the same last unit are two separate
        events for a manager to look at, not one."""
        _oversell(stocked, quantity=6)  # -1
        _oversell(stocked, quantity=2)  # -3

        shortfalls = sorted(StockException.objects.values_list("shortfall", flat=True))
        assert shortfalls == [1, 3]

    def test_each_exception_names_its_own_ledger_row(self, stocked):
        first = _oversell(stocked, quantity=6)
        second = _oversell(stocked, quantity=2)

        assert set(StockException.objects.values_list("transaction_id", flat=True)) == {
            first.pk,
            second.pk,
        }


class TestResolution:
    @pytest.fixture
    def exception(self, stocked):
        _oversell(stocked)
        return StockException.objects.get()

    def test_resolving_records_who_what_and_when(self, exception, shop):
        resolved = inventory_services.resolve_stock_exception(
            exception=exception,
            resolution=StockExceptionResolution.RESTOCKED,
            note="Delivery 4412 arrived Tuesday and covered it.",
            actor=shop["manager"],
        )

        assert resolved.status == StockExceptionStatus.RESOLVED
        assert resolved.resolution == StockExceptionResolution.RESTOCKED
        assert resolved.resolved_by_id == shop["manager"].pk
        assert resolved.resolved_at is not None
        assert not resolved.is_open

    def test_a_resolution_without_a_reason_is_refused(self, exception, shop):
        """An unexplained resolution explains nothing -- it turns the report
        into a list of buttons someone clicked."""
        with pytest.raises(ValidationError):
            inventory_services.resolve_stock_exception(
                exception=exception,
                resolution=StockExceptionResolution.WRITTEN_OFF,
                note="   ",
                actor=shop["manager"],
            )

        exception.refresh_from_db()
        assert exception.is_open

    def test_an_unknown_resolution_is_refused(self, exception, shop):
        with pytest.raises(ValidationError):
            inventory_services.resolve_stock_exception(
                exception=exception,
                resolution="HANDWAVED",
                note="Looked fine to me.",
                actor=shop["manager"],
            )

        exception.refresh_from_db()
        assert exception.is_open

    def test_resolving_twice_is_refused(self, exception, shop):
        inventory_services.resolve_stock_exception(
            exception=exception,
            resolution=StockExceptionResolution.COUNTED,
            note="Stock count 19 corrected it.",
            actor=shop["manager"],
        )

        with pytest.raises(Conflict):
            inventory_services.resolve_stock_exception(
                exception=exception,
                resolution=StockExceptionResolution.NOT_AN_ERROR,
                note="Actually it was fine.",
                actor=shop["manager"],
            )

        exception.refresh_from_db()
        # The first answer stands. A second one would overwrite the record of
        # what was concluded, which is the only thing this row is for.
        assert exception.resolution == StockExceptionResolution.COUNTED

    def test_resolving_is_audited(self, exception, shop):
        before = AuditLog.objects.count()

        inventory_services.resolve_stock_exception(
            exception=exception,
            resolution=StockExceptionResolution.WRITTEN_OFF,
            note="Never found. Written off.",
            actor=shop["manager"],
        )

        assert AuditLog.objects.count() > before

    def test_resolving_moves_no_stock(self, exception, stocked, shop):
        """Closing the report is bookkeeping about a hole, not a repair of it.
        The repair is a receipt, a write-off or a count -- each of which writes
        its own ledger row."""
        ledger_before = _ledger_rows(stocked)

        inventory_services.resolve_stock_exception(
            exception=exception,
            resolution=StockExceptionResolution.NOT_AN_ERROR,
            note="Consignment item, tracked separately.",
            actor=shop["manager"],
        )

        stocked["inventory"].refresh_from_db()
        assert stocked["inventory"].on_hand == -3
        assert _ledger_rows(stocked) == ledger_before
