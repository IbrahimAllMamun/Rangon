"""Finance engine: the invariants the money layer rests on.

Structured to mirror tests/test_inventory.py, because the invariants mirror
each other -- a cached figure over an append-only ledger.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from core.exceptions import InsufficientFunds, ValidationError
from core.models import AppendOnlyError
from finance import selectors, services
from finance.models import (
    Account,
    AccountKind,
    AccountTransaction,
    AccountTransactionType,
)
from tests import factories

pytestmark = pytest.mark.django_db


def _ledger_balance(account: Account) -> Decimal:
    total = sum(
        (row.amount for row in AccountTransaction.objects.filter(account=account)),
        Decimal("0.00"),
    )
    return Decimal(total).quantize(Decimal("0.01"))


class TestAccounts:
    def test_opening_a_balance_writes_a_ledger_row_not_a_column(self, shop):
        account = services.create_account(
            branch=shop["branch"], name="Front Drawer", opening_balance=Decimal("5000.00")
        )

        assert account.balance == Decimal("5000.00")
        entry = AccountTransaction.objects.get(account=account)
        assert entry.transaction_type == AccountTransactionType.OPENING
        assert entry.amount == Decimal("5000.00")
        assert entry.balance_after == Decimal("5000.00")
        # The invariant that makes the cache provable.
        assert account.balance == _ledger_balance(account)

    def test_an_account_with_no_opening_balance_has_no_ledger_row(self, shop):
        account = services.create_account(branch=shop["branch"], name="Empty Drawer")

        assert account.balance == Decimal("0.00")
        assert not AccountTransaction.objects.filter(account=account).exists()
        assert account.balance == _ledger_balance(account)

    def test_balance_cannot_be_set_directly(self, shop):
        account = factories.account(shop["branch"], opening_balance="100.00")

        with pytest.raises(ValidationError) as exc:
            services.update_account(account=account, balance=Decimal("999999.00"))

        assert "cannot be set directly" in str(exc.value)
        account.refresh_from_db()
        assert account.balance == Decimal("100.00")

    def test_only_one_default_account_per_branch_and_kind(self, shop):
        first = factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)
        second = factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)

        first.refresh_from_db()
        assert second.is_default is True
        assert first.is_default is False

    def test_an_account_name_is_unique_within_a_branch(self, shop):
        from django.db import IntegrityError

        services.create_account(branch=shop["branch"], name="Drawer")

        with pytest.raises(IntegrityError):
            services.create_account(branch=shop["branch"], name="Drawer")


class TestMovements:
    def test_a_deposit_increases_the_balance_and_appends_a_row(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")

        entry = services.record_movement(
            account=account,
            transaction_type=AccountTransactionType.DEPOSIT,
            amount=Decimal("250.50"),
        )

        account.refresh_from_db()
        assert account.balance == Decimal("1250.50")
        assert entry.amount == Decimal("250.50")
        assert entry.balance_after == Decimal("1250.50")
        assert account.balance == _ledger_balance(account)

    def test_a_withdrawal_decreases_the_balance(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")

        services.record_movement(
            account=account,
            transaction_type=AccountTransactionType.WITHDRAWAL,
            amount=Decimal("400.00"),
            reason="Petty cash",
        )

        account.refresh_from_db()
        assert account.balance == Decimal("600.00")
        assert account.balance == _ledger_balance(account)

    def test_a_withdrawal_requires_a_reason(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")

        with pytest.raises(ValidationError):
            services.record_movement(
                account=account,
                transaction_type=AccountTransactionType.WITHDRAWAL,
                amount=Decimal("10.00"),
            )

    def test_a_cash_drawer_cannot_pay_out_money_it_does_not_hold(self, shop):
        account = factories.account(shop["branch"], opening_balance="100.00")

        with pytest.raises(InsufficientFunds) as exc:
            services.record_movement(
                account=account,
                transaction_type=AccountTransactionType.WITHDRAWAL,
                amount=Decimal("150.00"),
                reason="Too much",
            )

        assert exc.value.code == "INSUFFICIENT_FUNDS"
        account.refresh_from_db()
        assert account.balance == Decimal("100.00")  # unchanged

    def test_an_overdraft_account_may_go_negative(self, shop):
        account = factories.account(
            shop["branch"], kind=AccountKind.BANK, opening_balance="100.00", allow_overdraft=True
        )

        services.record_movement(
            account=account,
            transaction_type=AccountTransactionType.WITHDRAWAL,
            amount=Decimal("150.00"),
            reason="Overdraft line",
        )

        account.refresh_from_db()
        assert account.balance == Decimal("-50.00")
        assert account.balance == _ledger_balance(account)

    def test_an_adjustment_carries_its_own_sign(self, shop):
        account = factories.account(shop["branch"], opening_balance="500.00")

        services.record_movement(
            account=account,
            transaction_type=AccountTransactionType.ADJUSTMENT,
            amount=Decimal("-25.00"),
            reason="Miscount at close",
        )

        account.refresh_from_db()
        assert account.balance == Decimal("475.00")

    def test_a_movement_amount_must_be_positive(self, shop):
        account = factories.account(shop["branch"], opening_balance="500.00")

        with pytest.raises(ValidationError):
            services.record_movement(
                account=account,
                transaction_type=AccountTransactionType.DEPOSIT,
                amount=Decimal("0.00"),
            )

    def test_money_cannot_move_through_a_closed_account(self, shop):
        account = factories.account(shop["branch"], opening_balance="500.00")
        services.update_account(account=account, is_active=False)

        with pytest.raises(ValidationError):
            services.record_movement(
                account=account,
                transaction_type=AccountTransactionType.DEPOSIT,
                amount=Decimal("10.00"),
            )

    def test_ledger_rows_cannot_be_edited_or_deleted(self, shop):
        account = factories.account(shop["branch"], opening_balance="100.00")
        entry = AccountTransaction.objects.get(account=account)

        with pytest.raises(AppendOnlyError):
            entry.amount = Decimal("999.00")
            entry.save()

        with pytest.raises(AppendOnlyError):
            entry.delete()


class TestTransfers:
    def test_a_transfer_moves_money_between_two_accounts(self, shop):
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="5000.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")

        record = services.transfer(
            source_account=drawer, target_account=bank, amount=Decimal("3000.00")
        )

        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance == Decimal("2000.00")
        assert bank.balance == Decimal("3000.00")
        assert record.number.startswith("ATR-")
        assert drawer.balance == _ledger_balance(drawer)
        assert bank.balance == _ledger_balance(bank)

    def test_a_transfer_conserves_money(self, shop):
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="5000.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="1000.00")
        before = drawer.balance + bank.balance

        services.transfer(source_account=drawer, target_account=bank, amount=Decimal("2500.00"))

        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance + bank.balance == before

    def test_cannot_transfer_more_than_the_source_holds(self, shop):
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="100.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")

        with pytest.raises(InsufficientFunds):
            services.transfer(source_account=drawer, target_account=bank, amount=Decimal("500.00"))

        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance == Decimal("100.00")
        assert bank.balance == Decimal("0.00")
        # The failed transfer left no half-applied pair behind.
        assert not AccountTransaction.objects.filter(
            transaction_type=AccountTransactionType.TRANSFER_IN
        ).exists()

    def test_cannot_transfer_to_the_same_account(self, shop):
        drawer = factories.account(shop["branch"], opening_balance="100.00")

        with pytest.raises(ValidationError):
            services.transfer(source_account=drawer, target_account=drawer, amount=Decimal("10.00"))


class TestResolution:
    def test_cash_resolves_to_the_default_cash_account(self, shop):
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)
        factories.account(shop["branch"], kind=AccountKind.BANK, is_default=True)

        assert services.resolve_account(branch=shop["branch"], method="CASH").pk == drawer.pk

    def test_card_resolves_to_a_bank_account_not_the_drawer(self, shop):
        factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, is_default=True)

        assert services.resolve_account(branch=shop["branch"], method="CARD").pk == bank.pk

    def test_an_unresolvable_method_returns_none_rather_than_guessing(self, shop):
        # Only a cash drawer exists, so card takings have nowhere honest to go.
        factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)

        assert services.resolve_account(branch=shop["branch"], method="CARD") is None

    def test_a_closed_account_is_never_resolved(self, shop):
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)
        services.update_account(account=drawer, is_active=False)

        assert services.resolve_account(branch=shop["branch"], method="CASH") is None


class TestIntegrity:
    def test_a_clean_shop_reports_no_drift(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")
        services.record_movement(
            account=account,
            transaction_type=AccountTransactionType.DEPOSIT,
            amount=Decimal("500.00"),
        )

        assert services.verify_integrity() == []

    def test_drift_is_detected_and_explained_by_a_repair_row(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")

        # Simulate the bug this app exists to catch: a balance written without
        # a ledger row, via a targeted UPDATE that bypasses the service.
        Account.objects.filter(pk=account.pk).update(balance=Decimal("1200.00"))

        issues = services.verify_integrity()
        assert len(issues) == 1
        assert issues[0].drift == Decimal("200.00")

        services.repair_drift(issue=issues[0], reason="DR-test reconciliation")

        assert services.verify_integrity() == []
        repair = AccountTransaction.objects.get(reference_type="integrity_repair")
        assert repair.amount == Decimal("200.00")
        assert repair.reason == "DR-test reconciliation"
        # The repair explains the cache; it never rewrites the ledger.
        account.refresh_from_db()
        assert account.balance == Decimal("1200.00")

    def test_a_repair_requires_a_reason(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")
        Account.objects.filter(pk=account.pk).update(balance=Decimal("1200.00"))
        issue = services.verify_integrity()[0]

        with pytest.raises(ValidationError):
            services.repair_drift(issue=issue, reason="   ")


class TestReads:
    def test_balance_at_ignores_later_movements(self, shop):
        account = factories.account(shop["branch"], opening_balance="1000.00")
        cutoff = timezone.now()

        services.record_movement(
            account=account,
            transaction_type=AccountTransactionType.DEPOSIT,
            amount=Decimal("500.00"),
            occurred_at=cutoff + timedelta(hours=1),
        )

        assert services.balance_at(account=account, at=cutoff) == Decimal("1000.00")
        account.refresh_from_db()
        assert account.balance == Decimal("1500.00")

    def test_cash_position_totals_by_kind(self, shop):
        factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="1000.00")
        factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="9000.00")

        position = selectors.cash_position(branch=shop["branch"])

        assert position["total"] == Decimal("10000.00")
        by_kind = {row["kind"]: row["total"] for row in position["by_kind"]}
        assert by_kind["CASH"] == Decimal("1000.00")
        assert by_kind["BANK"] == Decimal("9000.00")

    def test_transfers_are_excluded_from_money_in_and_out(self, shop):
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="5000.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")

        services.transfer(source_account=drawer, target_account=bank, amount=Decimal("3000.00"))
        services.record_movement(
            account=drawer,
            transaction_type=AccountTransactionType.DEPOSIT,
            amount=Decimal("200.00"),
        )

        totals = selectors.movement_totals(branch=shop["branch"])
        # Banking the takings is neither income nor spending.
        assert totals["money_in"] == Decimal("200.00")
        assert totals["money_out"] == Decimal("0.00")
