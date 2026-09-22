"""`Idempotency-Key` on the endpoints that move money and stock.

CLAUDE.md §7 asks for it "where a retry could double-charge or double-deduct".
Orders and purchasing honoured it; **finance and inventory accepted the header
and ignored it**. Measured against `main`, signed in as the owner, with the API
and Redis running:

    balance before ........ 342205.00
    POST #1 -> 201   POST #2 -> 201     (same Idempotency-Key)
    balance after ......... 344205.00   -- +2000, not +1000

    on_hand before ........ 9
    write-off #1 -> 201   write-off #2 -> 201
    on_hand after ......... 7           -- two units gone, not one

Neither row is malformed, so `verify_accounts` and `verify_inventory` both
reconcile afterwards: the cash book and the shelf are simply wrong, and nothing
detects it. That is what makes this worth a test rather than a button guard.

**Those two measurements are the proof that `main` doubles, not the tests
below.** Run against `main` these fail with `TypeError: unexpected keyword
argument 'idempotency_key'`, because the parameter did not exist -- which shows
the guard is absent, not that the balance moved twice. The controls pass there
too, which is what a control is for. The races live in
`tests/test_concurrency.py`, where the failure on `main` *is* behavioural.

**What is deliberately not covered here**, because it needs no key:

* `inventory/adjust` takes an absolute `new_on_hand`, so a replay is a no-op --
  asserted below rather than assumed.
* `stock-counts/{id}/apply` is a status transition and already answers 409 on
  the second call.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from finance import services as finance_services
from finance.models import AccountKind, AccountTransaction, AccountTransactionType, Expense
from inventory import services as inventory_services
from inventory.models import Inventory, InventoryTransaction, StockTransfer, TransactionType
from tests import factories

pytestmark = pytest.mark.django_db

KEY = "replay-0001"


@pytest.fixture
def shop() -> dict[str, Any]:
    org = factories.organization()
    branch = factories.branch(org)
    variant = factories.variant(price="1000.00")
    factories.stock(variant, branch, 10, "400.00")
    return {
        "org": org,
        "branch": branch,
        "variant": variant,
        "owner": factories.user("OWNER", branch_obj=branch),
        "account": factories.account(branch, kind=AccountKind.CASH, opening_balance="5000.00"),
    }


class TestMoneyReplays:
    def test_a_replayed_movement_posts_once(self, shop: dict[str, Any]) -> None:
        """Fails on `main`: the balance moves twice and two rows exist."""
        first = finance_services.record_movement(
            account=shop["account"],
            transaction_type=AccountTransactionType.DEPOSIT,
            amount=Decimal("1000.00"),
            actor=shop["owner"],
            idempotency_key=KEY,
        )
        second = finance_services.record_movement(
            account=shop["account"],
            transaction_type=AccountTransactionType.DEPOSIT,
            amount=Decimal("1000.00"),
            actor=shop["owner"],
            idempotency_key=KEY,
        )

        assert second.pk == first.pk
        assert AccountTransaction.objects.filter(idempotency_key=KEY).count() == 1
        shop["account"].refresh_from_db()
        assert shop["account"].balance == Decimal("6000.00")

    def test_two_movements_without_a_key_both_post(self, shop: dict[str, Any]) -> None:
        """A control: the guard must not collapse genuinely separate movements.

        Two deposits of the same amount on the same day are ordinary, and a
        fix that silently merged them would be worse than the defect.
        """
        for _ in range(2):
            finance_services.record_movement(
                account=shop["account"],
                transaction_type=AccountTransactionType.DEPOSIT,
                amount=Decimal("1000.00"),
                actor=shop["owner"],
            )

        shop["account"].refresh_from_db()
        assert shop["account"].balance == Decimal("7000.00")

    def test_a_replayed_transfer_moves_the_money_once(self, shop: dict[str, Any]) -> None:
        target = factories.account(
            shop["branch"], kind=AccountKind.BANK, opening_balance="0.00", is_default=False
        )

        first = finance_services.transfer(
            source_account=shop["account"],
            target_account=target,
            amount=Decimal("500.00"),
            actor=shop["owner"],
            idempotency_key=KEY,
        )
        second = finance_services.transfer(
            source_account=shop["account"],
            target_account=target,
            amount=Decimal("500.00"),
            actor=shop["owner"],
            idempotency_key=KEY,
        )

        assert second.pk == first.pk
        target.refresh_from_db()
        shop["account"].refresh_from_db()
        assert target.balance == Decimal("500.00")
        assert shop["account"].balance == Decimal("4500.00")

    def test_a_replayed_expense_leaves_one_document_and_one_movement(
        self, shop: dict[str, Any]
    ) -> None:
        category = factories.expense_category()

        first = finance_services.record_expense(
            branch=shop["branch"],
            category=category,
            account=shop["account"],
            amount=Decimal("250.00"),
            actor=shop["owner"],
            idempotency_key=KEY,
        )
        second = finance_services.record_expense(
            branch=shop["branch"],
            category=category,
            account=shop["account"],
            amount=Decimal("250.00"),
            actor=shop["owner"],
            idempotency_key=KEY,
        )

        assert second.pk == first.pk
        assert Expense.objects.count() == 1
        shop["account"].refresh_from_db()
        assert shop["account"].balance == Decimal("4750.00")


class TestStockReplays:
    def test_a_replayed_write_off_takes_the_units_once(self, shop: dict[str, Any]) -> None:
        """Fails on `main`: on_hand drops by two."""
        first = inventory_services.write_off(
            branch=shop["branch"],
            variant=shop["variant"],
            quantity=1,
            transaction_type=TransactionType.DAMAGE,
            reason="Dropped",
            actor=shop["owner"],
            idempotency_key=KEY,
        )
        second = inventory_services.write_off(
            branch=shop["branch"],
            variant=shop["variant"],
            quantity=1,
            transaction_type=TransactionType.DAMAGE,
            reason="Dropped",
            actor=shop["owner"],
            idempotency_key=KEY,
        )

        assert second.pk == first.pk
        assert InventoryTransaction.objects.filter(idempotency_key=KEY).count() == 1
        inventory = Inventory.objects.get(branch=shop["branch"], variant=shop["variant"])
        assert inventory.on_hand == 9

    def test_a_replayed_transfer_moves_the_stock_once(self, shop: dict[str, Any]) -> None:
        target = factories.branch(shop["org"])

        first = inventory_services.transfer(
            source_branch=shop["branch"],
            target_branch=target,
            lines=[(shop["variant"].pk, 2)],
            actor=shop["owner"],
            idempotency_key=KEY,
        )
        second = inventory_services.transfer(
            source_branch=shop["branch"],
            target_branch=target,
            lines=[(shop["variant"].pk, 2)],
            actor=shop["owner"],
            idempotency_key=KEY,
        )

        assert second.pk == first.pk
        assert StockTransfer.objects.count() == 1
        source_stock = Inventory.objects.get(branch=shop["branch"], variant=shop["variant"])
        target_stock = Inventory.objects.get(branch=target, variant=shop["variant"])
        assert source_stock.on_hand == 8
        assert target_stock.on_hand == 2

    def test_adjust_needs_no_key_because_it_states_an_absolute(self, shop: dict[str, Any]) -> None:
        """Why `adjust` is left alone, asserted rather than asserted in prose.

        It sets stock *to* a figure rather than *by* one, so the second call
        has nothing to do and says so.
        """
        inventory_services.adjust(
            branch=shop["branch"],
            variant=shop["variant"],
            new_on_hand=5,
            reason="Counted",
            actor=shop["owner"],
        )
        replay = inventory_services.adjust(
            branch=shop["branch"],
            variant=shop["variant"],
            new_on_hand=5,
            reason="Counted",
            actor=shop["owner"],
        )

        assert replay is None  # nothing to move
        inventory = Inventory.objects.get(branch=shop["branch"], variant=shop["variant"])
        assert inventory.on_hand == 5
