"""The expense endpoints as the admin screen uses them.

Three things are asserted here that the service tests cannot: who is allowed
to spend the shop's money, that the screen's period filter and totals agree,
and that the error envelope a form has to render is the documented one.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from finance.models import Expense, ExpenseCategory, ExpenseStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _category(code: str = "RENT") -> ExpenseCategory:
    return ExpenseCategory.objects.get(code=code)


class TestRecordingThroughTheApi:
    def test_a_manager_can_record_an_expense(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")

        response = auth_client(shop["manager"]).post(
            "/api/v1/expenses/",
            {
                "branch": str(shop["branch"].pk),
                "category": str(_category().pk),
                "account": str(account.pk),
                "amount": "1200.00",
                "note": "September rent",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["number"].startswith("EXP-")
        assert response.data["amount"] == "1200.00"
        assert response.data["category_name"] == "Rent"
        assert response.data["status"] == ExpenseStatus.RECORDED

        account.refresh_from_db()
        assert account.balance == Decimal("3800.00")

    def test_the_branch_defaults_to_the_users_own(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")

        response = auth_client(shop["manager"]).post(
            "/api/v1/expenses/",
            {"category": str(_category().pk), "account": str(account.pk), "amount": "50.00"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert str(response.data["branch"]) == str(shop["branch"].pk)

    def test_a_cashier_cannot_spend_the_shops_money(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")

        response = auth_client(shop["cashier"]).post(
            "/api/v1/expenses/",
            {"category": str(_category().pk), "account": str(account.pk), "amount": "50.00"},
            format="json",
        )

        assert response.status_code == 403
        assert not Expense.objects.exists()

    def test_an_anonymous_caller_cannot_record_an_expense(self, shop, api) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")

        response = api.post(
            "/api/v1/expenses/",
            {"category": str(_category().pk), "account": str(account.pk), "amount": "50.00"},
            format="json",
        )

        assert response.status_code == 401
        assert not Expense.objects.exists()

    def test_overspending_returns_the_documented_error_envelope(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="100.00")

        response = auth_client(shop["manager"]).post(
            "/api/v1/expenses/",
            {"category": str(_category().pk), "account": str(account.pk), "amount": "500.00"},
            format="json",
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "INSUFFICIENT_FUNDS"
        assert not Expense.objects.exists()

    def test_a_future_dated_expense_is_refused(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")

        response = auth_client(shop["manager"]).post(
            "/api/v1/expenses/",
            {
                "category": str(_category().pk),
                "account": str(account.pk),
                "amount": "50.00",
                "spent_at": (timezone.now() + timedelta(days=1)).isoformat(),
            },
            format="json",
        )

        assert response.status_code == 400
        assert not Expense.objects.exists()

    def test_a_receipt_can_be_attached(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")
        receipt = SimpleUploadedFile("receipt.png", b"fake-png-bytes", content_type="image/png")

        response = auth_client(shop["manager"]).post(
            "/api/v1/expenses/",
            {
                "category": str(_category().pk),
                "account": str(account.pk),
                "amount": "75.00",
                "attachment": receipt,
            },
            format="multipart",
        )

        assert response.status_code == 201, response.data
        assert response.data["attachment_url"]

    def test_an_executable_receipt_is_refused(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")
        payload = SimpleUploadedFile(
            "evil.svg", b"<svg onload=alert(1)>", content_type="image/svg+xml"
        )

        response = auth_client(shop["manager"]).post(
            "/api/v1/expenses/",
            {
                "category": str(_category().pk),
                "account": str(account.pk),
                "amount": "75.00",
                "attachment": payload,
            },
            format="multipart",
        )

        assert response.status_code == 400
        assert not Expense.objects.exists()


class TestVoidingThroughTheApi:
    def test_voiding_restores_the_balance(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="5000.00")
        expense = factories.expense(shop["branch"], account, amount=Decimal("400.00"))

        response = auth_client(shop["manager"]).post(
            f"/api/v1/expenses/{expense.pk}/void/", {"reason": "Filed twice"}, format="json"
        )

        assert response.status_code == 200, response.data
        assert response.data["status"] == ExpenseStatus.VOID
        account.refresh_from_db()
        assert account.balance == Decimal("5000.00")

    def test_voiding_without_a_reason_is_refused(self, shop, auth_client) -> None:
        expense = factories.expense(shop["branch"])

        response = auth_client(shop["manager"]).post(
            f"/api/v1/expenses/{expense.pk}/void/", {"reason": "  "}, format="json"
        )

        assert response.status_code == 400
        expense.refresh_from_db()
        assert expense.status == ExpenseStatus.RECORDED

    def test_a_cashier_cannot_void(self, shop, auth_client) -> None:
        expense = factories.expense(shop["branch"])

        response = auth_client(shop["cashier"]).post(
            f"/api/v1/expenses/{expense.pk}/void/", {"reason": "Nope"}, format="json"
        )

        assert response.status_code == 403

    def test_an_expense_can_never_be_deleted(self, shop, auth_client) -> None:
        expense = factories.expense(shop["branch"])

        response = auth_client(shop["owner"]).delete(f"/api/v1/expenses/{expense.pk}/")

        assert response.status_code == 405
        assert Expense.objects.filter(pk=expense.pk).exists()


class TestListingAndTotals:
    def test_the_list_shows_voided_rows_but_the_summary_excludes_them(
        self, shop, auth_client
    ) -> None:
        account = factories.account(shop["branch"], opening_balance="50000.00")
        factories.expense(shop["branch"], account, amount=Decimal("1000.00"))
        dropped = factories.expense(shop["branch"], account, amount=Decimal("400.00"))
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/expenses/{dropped.pk}/void/", {"reason": "Wrong"}, format="json")

        listing = client.get("/api/v1/expenses/")
        summary = client.get("/api/v1/expenses/summary/")

        assert listing.data["count"] == 2
        assert summary.data["total"] == "1000.00"
        assert summary.data["count"] == 1

    def test_the_summary_groups_by_category(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="50000.00")
        factories.expense(
            shop["branch"], account, category=_category("RENT"), amount=Decimal("6000.00")
        )
        factories.expense(
            shop["branch"], account, category=_category("TRANSPORT"), amount=Decimal("2000.00")
        )

        response = auth_client(shop["manager"]).get("/api/v1/expenses/summary/")

        assert response.status_code == 200
        # Money leaves as a string, never a JSON float (CLAUDE.md section 4).
        assert response.data["total"] == "8000.00"
        rows = {row["code"]: row for row in response.data["by_category"]}
        assert rows["RENT"]["total"] == "6000.00"
        assert rows["RENT"]["share"] == "75.00"

    def test_the_period_filter_narrows_the_list(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="50000.00")
        now = timezone.now()
        factories.expense(
            shop["branch"], account, amount=Decimal("100.00"), spent_at=now - timedelta(days=40)
        )
        factories.expense(
            shop["branch"], account, amount=Decimal("700.00"), spent_at=now - timedelta(days=2)
        )

        response = auth_client(shop["manager"]).get(
            "/api/v1/expenses/", {"date_from": (now - timedelta(days=30)).isoformat()}
        )

        assert response.data["count"] == 1
        assert response.data["results"][0]["amount"] == "700.00"

    def test_an_unreadable_date_is_a_400_not_a_500(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).get("/api/v1/expenses/?date_from=not-a-date")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_a_whole_day_window_includes_that_days_afternoon(self, shop, auth_client) -> None:
        """`date_to=<today>` must not stop at midnight — the classic off-by-one."""
        account = factories.account(shop["branch"], opening_balance="50000.00")
        this_afternoon = timezone.localtime().replace(hour=15, minute=30, second=0, microsecond=0)
        factories.expense(
            shop["branch"], account, amount=Decimal("640.00"), spent_at=this_afternoon
        )
        today = this_afternoon.date().isoformat()

        response = auth_client(shop["manager"]).get(
            "/api/v1/expenses/", {"date_from": today, "date_to": today}
        )

        assert response.data["count"] == 1
        assert response.data["results"][0]["amount"] == "640.00"

    def test_a_branch_scoped_user_sees_only_their_own_branch(self, shop, auth_client) -> None:
        other_branch = factories.branch(shop["organization"])
        factories.expense(shop["branch"], amount=Decimal("100.00"))
        factories.expense(other_branch, amount=Decimal("900.00"))

        response = auth_client(shop["manager"]).get("/api/v1/expenses/")

        assert response.data["count"] == 1
        assert response.data["results"][0]["amount"] == "100.00"


class TestCategoryEndpoints:
    def test_the_picker_lists_the_seeded_categories_with_usage(self, shop, auth_client) -> None:
        factories.expense(shop["branch"], category=_category("RENT"), amount=Decimal("100.00"))

        response = auth_client(shop["manager"]).get("/api/v1/expense-categories/?page_size=50")

        assert response.status_code == 200
        rows = {row["code"]: row for row in response.data["results"]}
        assert rows["RENT"]["expense_count"] == 1
        assert rows["SALARY"]["expense_count"] == 0

    def test_a_manager_cannot_open_a_new_category(self, shop, auth_client) -> None:
        """Categories shape every report, so they are an owner/accountant call."""
        response = auth_client(shop["manager"]).post(
            "/api/v1/expense-categories/", {"name": "Side project"}, format="json"
        )

        assert response.status_code == 403

    def test_an_owner_can_open_and_retire_a_category(self, shop, auth_client) -> None:
        client = auth_client(shop["owner"])

        created = client.post(
            "/api/v1/expense-categories/", {"name": "Shop insurance"}, format="json"
        )
        assert created.status_code == 201, created.data
        assert created.data["code"] == "SHOP_INSURANCE"

        retired = client.patch(
            f"/api/v1/expense-categories/{created.data['id']}/",
            {"is_active": False},
            format="json",
        )
        assert retired.status_code == 200
        assert retired.data["is_active"] is False

    def test_a_category_can_never_be_deleted(self, shop, auth_client) -> None:
        response = auth_client(shop["owner"]).delete(
            f"/api/v1/expense-categories/{_category().pk}/"
        )

        assert response.status_code == 405


class TestExpenseReport:
    def test_the_report_groups_by_category_and_exports_csv(self, shop, auth_client) -> None:
        account = factories.account(shop["branch"], opening_balance="50000.00")
        factories.expense(
            shop["branch"], account, category=_category("RENT"), amount=Decimal("6000.00")
        )
        client = auth_client(shop["owner"])

        report = client.get("/api/v1/reports/expenses/")
        assert report.status_code == 200
        assert report.data["results"][0]["category"] == "Rent"
        assert report.data["results"][0]["total"] == Decimal("6000.00")

        csv_response = client.get("/api/v1/reports/expenses/?format=csv")
        assert csv_response.status_code == 200
        assert csv_response["Content-Type"] == "text/csv"
        assert b"Rent" in csv_response.content

    def test_a_cashier_cannot_read_the_expense_report(self, shop, auth_client) -> None:
        response = auth_client(shop["cashier"]).get("/api/v1/reports/expenses/")

        assert response.status_code == 403
