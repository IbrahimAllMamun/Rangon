"""Expenses: the document, the movement, and the fact they cannot diverge.

Structured like tests/test_finance.py, because an expense is a cash-book entry
with a reason attached -- the invariant it must not break is the same one.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from core.exceptions import InsufficientFunds, ValidationError
from core.models import AuditAction, AuditLog
from finance import selectors, services
from finance.models import (
    AccountTransaction,
    AccountTransactionType,
    Expense,
    ExpenseCategory,
    ExpenseStatus,
)
from tests import factories

pytestmark = pytest.mark.django_db


def _ledger_balance(account) -> Decimal:
    total = sum(
        (row.amount for row in AccountTransaction.objects.filter(account=account)),
        Decimal("0.00"),
    )
    return Decimal(total).quantize(Decimal("0.01"))


class TestExpenseCategories:
    def test_the_migration_seeds_the_heads_a_shop_starts_with(self):
        """The screen must be usable on day one, not empty until someone
        with `finance.manage` gets round to it."""
        seeded = set(ExpenseCategory.objects.values_list("code", flat=True))

        assert {"RENT", "SALARY", "UTILITIES", "TRANSPORT", "OTHER"} <= seeded
        assert all(ExpenseCategory.objects.values_list("is_active", flat=True))

    def test_a_code_is_normalised_and_derived_from_the_name(self):
        category = services.create_expense_category(name="  Shop Insurance  ")

        assert category.name == "Shop Insurance"
        assert category.code == "SHOP_INSURANCE"

    def test_a_supplied_code_is_upper_cased_and_despaced(self):
        category = services.create_expense_category(name="Legal fees", code="legal fees")

        assert category.code == "LEGAL_FEES"

    def test_duplicate_codes_are_refused(self):
        services.create_expense_category(name="Rent top-up", code="RENT_TOPUP")

        with pytest.raises(ValidationError):
            services.create_expense_category(name="Rent extra", code="rent topup")

    def test_a_seeded_code_cannot_be_taken_again(self):
        with pytest.raises(ValidationError):
            services.create_expense_category(name="Shop rent", code="RENT")

    def test_duplicate_names_are_refused_case_insensitively(self):
        with pytest.raises(ValidationError):
            services.create_expense_category(name="transport", code="TRANSPORT_2")

    def test_a_nameless_category_is_refused(self):
        with pytest.raises(ValidationError):
            services.create_expense_category(name="   ")

    def test_renaming_is_allowed_but_re_keying_is_not(self):
        category = factories.expense_category(name="Utilties bill", code="UTILITIES_BILL")

        updated = services.update_expense_category(
            category=category, name="Utilities bill", code="SOMETHING_ELSE"
        )

        assert updated.name == "Utilities bill"
        # The code an expense was filed under never moves.
        assert updated.code == "UTILITIES_BILL"

    def test_retiring_a_category_keeps_it_readable(self):
        category = factories.expense_category()
        services.update_expense_category(category=category, is_active=False)

        category.refresh_from_db()
        assert category.is_active is False
        assert ExpenseCategory.objects.filter(pk=category.pk).exists()


class TestRecordingAnExpense:
    def test_an_expense_writes_a_document_and_a_movement_together(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        category = ExpenseCategory.objects.get(code="RENT")

        expense = services.record_expense(
            branch=shop["branch"],
            category=category,
            account=account,
            amount=Decimal("1200.00"),
            note="September rent",
            actor=shop["manager"],
        )

        account.refresh_from_db()
        assert account.balance == Decimal("3800.00")
        # The invariant the whole app rests on.
        assert account.balance == _ledger_balance(account)

        entry = expense.transaction
        assert entry is not None
        assert entry.transaction_type == AccountTransactionType.EXPENSE
        assert entry.amount == Decimal("-1200.00")
        assert entry.balance_after == Decimal("3800.00")
        assert entry.reference_type == "expense"
        assert entry.reference_id == str(expense.pk)

    def test_the_number_is_sequential_and_prefixed(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        first = factories.expense(shop["branch"], account, amount=Decimal("10.00"))
        second = factories.expense(shop["branch"], account, amount=Decimal("10.00"))

        assert first.number.startswith("EXP-")
        assert int(second.number.split("-")[1]) == int(first.number.split("-")[1]) + 1

    def test_spent_at_defaults_to_now_but_a_past_date_is_kept(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        yesterday = timezone.now() - timedelta(days=1)

        dated = factories.expense(shop["branch"], account, spent_at=yesterday)

        assert dated.spent_at == yesterday
        # The movement is dated when the money moved, not when it was typed in.
        assert dated.transaction.occurred_at == yesterday

    def test_an_expense_is_audit_logged_with_who_what_and_how_much(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")

        expense = factories.expense(
            shop["branch"], account, amount=Decimal("250.00"), actor=shop["manager"]
        )

        entry = AuditLog.objects.filter(
            action=AuditAction.EXPENSE_RECORDED, entity_id=str(expense.pk)
        ).get()
        assert entry.actor_id == shop["manager"].pk
        assert entry.new_values["amount"] == "250.00"
        assert entry.branch_id == shop["branch"].pk


class TestRecordingFailurePaths:
    def test_an_expense_larger_than_the_drawer_is_refused(self, shop):
        account = factories.account(shop["branch"], opening_balance="100.00")

        with pytest.raises(InsufficientFunds):
            factories.expense(shop["branch"], account, amount=Decimal("500.00"))

    def test_a_refused_expense_leaves_no_document_behind(self, shop):
        """The rollback is the point: a rejected expense must not be half-written."""
        account = factories.account(shop["branch"], opening_balance="100.00")

        with pytest.raises(InsufficientFunds):
            factories.expense(shop["branch"], account, amount=Decimal("500.00"))

        assert not Expense.objects.exists()
        account.refresh_from_db()
        assert account.balance == Decimal("100.00")
        assert account.balance == _ledger_balance(account)

    def test_an_overdraft_account_may_go_negative(self, shop):
        account = factories.account(shop["branch"], opening_balance="100.00", allow_overdraft=True)

        factories.expense(shop["branch"], account, amount=Decimal("500.00"))

        account.refresh_from_db()
        assert account.balance == Decimal("-400.00")
        assert account.balance == _ledger_balance(account)

    @pytest.mark.parametrize("amount", ["0.00", "-25.00"])
    def test_a_zero_or_negative_expense_is_refused(self, shop, amount):
        account = factories.account(shop["branch"], opening_balance="5000.00")

        with pytest.raises(ValidationError):
            factories.expense(shop["branch"], account, amount=Decimal(amount))

    def test_a_retired_category_cannot_be_used(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        category = factories.expense_category(is_active=False)

        with pytest.raises(ValidationError):
            factories.expense(shop["branch"], account, category=category)

    def test_another_branchs_account_cannot_be_spent_from(self, shop):
        other_branch = factories.branch(shop["organization"])
        their_account = factories.account(other_branch, opening_balance="5000.00")

        with pytest.raises(ValidationError):
            factories.expense(shop["branch"], their_account)


class TestVoidingAnExpense:
    def test_voiding_puts_the_money_back_without_erasing_anything(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        expense = factories.expense(shop["branch"], account, amount=Decimal("1200.00"))
        account.refresh_from_db()
        assert account.balance == Decimal("3800.00")

        voided = services.void_expense(expense=expense, reason="Filed twice", actor=shop["manager"])

        account.refresh_from_db()
        assert account.balance == Decimal("5000.00")
        assert account.balance == _ledger_balance(account)

        assert voided.status == ExpenseStatus.VOID
        assert voided.void_reason == "Filed twice"
        assert voided.voided_by_id == shop["manager"].pk
        # Both rows survive: the money went out, then it came back.
        assert AccountTransaction.objects.filter(account=account).count() == 3
        assert voided.transaction is not None
        assert voided.reversal.transaction_type == AccountTransactionType.ADJUSTMENT
        assert voided.reversal.amount == Decimal("1200.00")

    def test_the_reversal_carries_the_reason_and_the_expense_number(self, shop):
        expense = factories.expense(shop["branch"], amount=Decimal("300.00"))

        voided = services.void_expense(expense=expense, reason="Wrong account")

        assert expense.number in voided.reversal.reason
        assert "Wrong account" in voided.reversal.reason

    def test_voiding_twice_is_refused(self, shop):
        expense = factories.expense(shop["branch"])
        services.void_expense(expense=expense, reason="First")

        with pytest.raises(ValidationError):
            services.void_expense(expense=expense, reason="Second")

    def test_voiding_without_a_reason_is_refused(self, shop):
        expense = factories.expense(shop["branch"])

        with pytest.raises(ValidationError):
            services.void_expense(expense=expense, reason="   ")

    def test_voiding_is_audit_logged(self, shop):
        expense = factories.expense(shop["branch"])

        services.void_expense(expense=expense, reason="Duplicate", actor=shop["owner"])

        entry = AuditLog.objects.filter(
            action=AuditAction.EXPENSE_VOIDED, entity_id=str(expense.pk)
        ).get()
        assert entry.reason == "Duplicate"
        assert entry.actor_id == shop["owner"].pk


class TestExpenseTotals:
    def test_totals_group_by_category_and_share_sums_to_a_hundred(self, shop):
        account = factories.account(shop["branch"], opening_balance="50000.00")
        rent = ExpenseCategory.objects.get(code="RENT")
        transport = ExpenseCategory.objects.get(code="TRANSPORT")
        factories.expense(shop["branch"], account, category=rent, amount=Decimal("6000.00"))
        factories.expense(shop["branch"], account, category=transport, amount=Decimal("2000.00"))
        factories.expense(shop["branch"], account, category=transport, amount=Decimal("2000.00"))

        totals = selectors.expense_totals(branch=shop["branch"])

        assert totals["total"] == Decimal("10000.00")
        assert totals["count"] == 3
        # Ordered by spend, largest first — what the screen shows.
        assert [row["category"] for row in totals["by_category"]] == ["Rent", "Transport"]
        assert [row["total"] for row in totals["by_category"]] == [
            Decimal("6000.00"),
            Decimal("4000.00"),
        ]
        assert [row["count"] for row in totals["by_category"]] == [1, 2]
        assert sum(row["share"] for row in totals["by_category"]) == Decimal("100.00")

    def test_an_empty_period_totals_zero_rather_than_failing(self, shop):
        totals = selectors.expense_totals(branch=shop["branch"])

        assert totals["total"] == Decimal("0.00")
        assert totals["count"] == 0
        assert totals["by_category"] == []

    def test_a_voided_expense_is_excluded_from_the_total(self, shop):
        account = factories.account(shop["branch"], opening_balance="50000.00")
        kept = factories.expense(shop["branch"], account, amount=Decimal("1000.00"))
        dropped = factories.expense(shop["branch"], account, amount=Decimal("400.00"))

        services.void_expense(expense=dropped, reason="Filed twice")

        totals = selectors.expense_totals(branch=shop["branch"])
        assert totals["total"] == Decimal("1000.00")
        assert totals["count"] == 1
        # It is excluded from the total but still readable as history.
        assert Expense.objects.filter(pk=dropped.pk).exists()
        assert selectors.expenses(include_void=True).count() == 2
        assert list(selectors.expenses()) == [kept]

    def test_the_period_window_is_respected(self, shop):
        account = factories.account(shop["branch"], opening_balance="50000.00")
        now = timezone.now()
        factories.expense(
            shop["branch"], account, amount=Decimal("100.00"), spent_at=now - timedelta(days=40)
        )
        factories.expense(
            shop["branch"], account, amount=Decimal("700.00"), spent_at=now - timedelta(days=2)
        )

        totals = selectors.expense_totals(
            branch=shop["branch"], date_from=now - timedelta(days=30), date_to=now
        )

        assert totals["total"] == Decimal("700.00")

    def test_totals_are_scoped_to_a_branch(self, shop):
        other_branch = factories.branch(shop["organization"])
        factories.expense(shop["branch"], amount=Decimal("100.00"))
        factories.expense(other_branch, amount=Decimal("900.00"))

        assert selectors.expense_totals(branch=shop["branch"])["total"] == Decimal("100.00")
        assert selectors.expense_totals(branch=other_branch)["total"] == Decimal("900.00")
        assert selectors.expense_totals()["total"] == Decimal("1000.00")


class TestExpensesAgainstTheCashBook:
    def test_expenses_do_not_disturb_verify_integrity(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        expense = factories.expense(shop["branch"], account, amount=Decimal("750.00"))
        services.void_expense(expense=expense, reason="Voided for the test")
        factories.expense(shop["branch"], account, amount=Decimal("120.00"))

        assert services.verify_integrity() == []

    def test_spending_counts_as_money_out_not_as_a_transfer(self, shop):
        account = factories.account(shop["branch"], opening_balance="5000.00")
        factories.expense(shop["branch"], account, amount=Decimal("750.00"))

        movements = selectors.movement_totals(branch=shop["branch"])

        assert movements["money_out"] == Decimal("750.00")
        assert movements["money_in"] == Decimal("0.00")
        assert movements["net"] == Decimal("-750.00")
