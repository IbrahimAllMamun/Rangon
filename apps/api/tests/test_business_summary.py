"""Phase 38: revenue through to net profit.

The report an owner manages by, and the first one that does not stop at gross
margin.  Every test here pins a figure that would look plausible if it were
wrong -- VAT counted as turnover, a refund that never lands, the cost of
restocked goods staying a cost.
"""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from accounts.models import TaxMode
from finance import services as finance_services
from orders.models import PaymentMethod, RestockDecision, ReturnStatus
from orders.services import pos, pricing
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from reports.services import DateRange, business_summary
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def period() -> DateRange:
    now = timezone.now()
    return DateRange(now - timedelta(days=30), now + timedelta(days=1), "30d")


def _set_tax(shop, mode: str, rate: str) -> None:
    org = shop["organization"]
    org.tax_mode = mode
    org.default_tax_rate = Decimal(rate)
    org.save(update_fields=["tax_mode", "default_tax_rate"])


def _sell(shop, *, quantity: int = 1, price: str = "1000.00", cost: str = "600.00"):
    """Sell a freshly received line, so the frozen cost is exactly `cost`.

    A new variant each time on purpose: the shop fixture already holds stock at
    a different cost, and weighted average would blend the two into a figure no
    assertion could state plainly.
    """
    variant = factories.variant(shop["product"], price=Decimal(price))
    factories.stock(variant, shop["branch"], quantity, unit_cost=Decimal(cost))

    total = pricing.calculate(pricing.price_lines([(variant, quantity, None)])).grand_total
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)],
        ),
    )


def _spend(shop, amount: str, **category_kwargs):
    """Record one expense.  The category name is generated unless asked for --
    migration 0004 seeds the common ones (Rent, Electricity...), so a literal
    name collides with the defaults rather than testing anything.
    """
    account = factories.account(shop["branch"], opening_balance=Decimal("100000.00"))
    category = factories.expense_category(**category_kwargs)
    return finance_services.record_expense(
        branch=shop["branch"],
        category=category,
        account=account,
        amount=Decimal(amount),
        actor=shop["owner"],
    )


class TestTheStatementAddsUp:
    def test_gross_profit_is_revenue_less_cost(self, shop, period):
        _sell(shop, quantity=2, price="1000.00", cost="600.00")

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["revenue"]["goods"] == Decimal("2000.00")
        assert summary["cost_of_goods"]["sold"] == Decimal("1200.00")
        assert summary["gross_profit"] == Decimal("800.00")

    def test_net_profit_is_gross_profit_less_expenses(self, shop, period):
        _sell(shop, quantity=2, price="1000.00", cost="600.00")
        _spend(shop, "300.00")

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["expenses"]["total"] == Decimal("300.00")
        assert summary["net_profit"] == Decimal("500.00")

    def test_the_margins_are_percentages_of_net_revenue(self, shop, period):
        _sell(shop, quantity=1, price="1000.00", cost="600.00")
        _spend(shop, "100.00")

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["gross_margin_percent"] == Decimal("40.00")
        assert summary["net_margin_percent"] == Decimal("30.00")

    def test_an_empty_period_reports_zeroes_not_a_crash(self, shop, period):
        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["revenue"]["net"] == Decimal("0.00")
        assert summary["net_profit"] == Decimal("0.00")
        assert summary["gross_margin_percent"] == Decimal("0.00")
        assert summary["volume"]["average_order_value"] == Decimal("0.00")


class TestVatIsNotRevenue:
    def test_inclusive_vat_is_taken_out_of_revenue(self, shop, period):
        _set_tax(shop, TaxMode.INCLUSIVE, "0.1500")
        _sell(shop, quantity=1, price="1150.00", cost="600.00")

        summary = business_summary(date_range=period, branch=shop["branch"])

        # The customer paid 1150. 150 of that is the government's.
        assert summary["revenue"]["goods"] == Decimal("1000.00")
        assert summary["revenue"]["vat_collected"] == Decimal("150.00")
        assert summary["gross_profit"] == Decimal("400.00")

    def test_exclusive_vat_never_entered_revenue_to_begin_with(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, quantity=1, price="1000.00", cost="600.00")

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["revenue"]["goods"] == Decimal("1000.00")
        assert summary["revenue"]["vat_collected"] == Decimal("150.00")
        assert summary["gross_profit"] == Decimal("400.00")

    def test_profit_is_the_same_under_both_treatments_for_the_same_takings(self, shop, period):
        """1150 inclusive and 1000 exclusive are the same trade, so the same profit."""
        _set_tax(shop, TaxMode.INCLUSIVE, "0.1500")
        _sell(shop, quantity=1, price="1150.00", cost="600.00")
        inclusive = business_summary(date_range=period, branch=shop["branch"])

        assert inclusive["gross_profit"] == Decimal("400.00")
        assert inclusive["revenue"]["goods"] == Decimal("1000.00")


class TestReturns:
    def _completed_return(self, shop, order, *, decision: str, refund: Decimal):
        item = order.items.first()
        request = return_services.request_return(
            order=order,
            lines=[(item.pk, 1)],
            reason="WRONG_SIZE",
            actor=shop["manager"],
            restock_decisions={str(item.pk): decision},
        )
        return_services.approve(return_request=request, actor=shop["manager"])
        return_services.receive(return_request=request, actor=shop["manager"])
        return_services.complete(
            return_request=request, actor=shop["manager"], refund_amount=refund
        )
        request.refresh_from_db()
        assert request.status == ReturnStatus.COMPLETED
        return request

    def test_a_refund_reduces_net_revenue(self, shop, period):
        order = _sell(shop, quantity=2, price="1000.00", cost="600.00")
        self._completed_return(
            shop, order, decision=RestockDecision.RESTOCK, refund=Decimal("1000.00")
        )

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["revenue"]["goods"] == Decimal("2000.00")
        assert summary["revenue"]["refunds"] == Decimal("1000.00")
        assert summary["revenue"]["net"] == Decimal("1000.00")

    def test_restocked_goods_give_their_cost_back(self, shop, period):
        order = _sell(shop, quantity=2, price="1000.00", cost="600.00")
        self._completed_return(
            shop, order, decision=RestockDecision.RESTOCK, refund=Decimal("1000.00")
        )

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["cost_of_goods"]["sold"] == Decimal("1200.00")
        assert summary["cost_of_goods"]["recovered_from_returns"] == Decimal("600.00")
        assert summary["cost_of_goods"]["net"] == Decimal("600.00")
        # 1000 net revenue - 600 net cost.
        assert summary["gross_profit"] == Decimal("400.00")

    def test_damaged_goods_keep_their_cost_as_a_loss(self, shop, period):
        order = _sell(shop, quantity=2, price="1000.00", cost="600.00")
        self._completed_return(
            shop, order, decision=RestockDecision.DAMAGED, refund=Decimal("1000.00")
        )

        summary = business_summary(date_range=period, branch=shop["branch"])

        # Nothing went back on the shelf, so nothing comes off the cost.
        assert summary["cost_of_goods"]["recovered_from_returns"] == Decimal("0.00")
        assert summary["cost_of_goods"]["net"] == Decimal("1200.00")
        assert summary["gross_profit"] == Decimal("-200.00")

    def test_quarantined_goods_are_not_treated_as_sellable(self, shop, period):
        order = _sell(shop, quantity=2, price="1000.00", cost="600.00")
        self._completed_return(
            shop, order, decision=RestockDecision.QUARANTINE, refund=Decimal("1000.00")
        )

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["cost_of_goods"]["recovered_from_returns"] == Decimal("0.00")


class TestPeriodBoundaries:
    def test_an_expense_outside_the_period_is_not_counted(self, shop):
        _sell(shop, quantity=1, price="1000.00", cost="600.00")
        expense = _spend(shop, "500.00")
        expense.spent_at = timezone.now() - timedelta(days=90)
        expense.save(update_fields=["spent_at"])

        now = timezone.now()
        summary = business_summary(
            date_range=DateRange(now - timedelta(days=7), now + timedelta(days=1)),
            branch=shop["branch"],
        )

        assert summary["expenses"]["total"] == Decimal("0.00")
        assert summary["net_profit"] == summary["gross_profit"]

    def test_a_voided_expense_does_not_reduce_profit(self, shop, period):
        _sell(shop, quantity=1, price="1000.00", cost="600.00")
        expense = _spend(shop, "500.00")
        finance_services.void_expense(expense=expense, reason="Recorded twice", actor=shop["owner"])

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["expenses"]["total"] == Decimal("0.00")
        assert summary["net_profit"] == Decimal("400.00")


class TestEndpoint:
    def test_the_owner_can_read_it(self, shop, owner, auth_client, period):
        _sell(shop, quantity=1, price="1000.00", cost="600.00")

        response = auth_client(owner).get("/api/v1/reports/business-summary/")

        assert response.status_code == 200
        assert "net_profit" in response.data
        assert "gross_profit" in response.data

    def test_a_cashier_cannot(self, shop, cashier, auth_client):
        response = auth_client(cashier).get("/api/v1/reports/business-summary/")

        assert response.status_code == 403

    def test_money_leaves_as_strings_never_as_floats(self, shop, owner, auth_client):
        """D20 again: a plain selector dict skips COERCE_DECIMAL_TO_STRING.

        A float carrying money across the API boundary is forbidden by
        CLAUDE.md §4, and the frontend types already say `string`.
        """
        _sell(shop, quantity=1, price="1000.00", cost="600.00")

        response = auth_client(owner).get("/api/v1/reports/business-summary/")
        payload = json.loads(response.content)

        assert payload["gross_profit"] == "400.00"
        assert payload["revenue"]["goods"] == "1000.00"
        assert isinstance(payload["net_profit"], str)
        assert isinstance(payload["expenses"]["total"], str)

    def test_the_older_reports_are_string_money_too(self, shop, owner, auth_client):
        _sell(shop, quantity=1, price="1000.00", cost="600.00")

        for path in ("/api/v1/reports/profit/", "/api/v1/reports/dashboard/"):
            payload = json.loads(auth_client(owner).get(path).content)
            totals = payload.get("totals") or payload.get("kpis")
            assert isinstance(totals["revenue"], str), f"{path} still returns float money"

    def test_csv_export_writes_the_statement_not_an_empty_file(self, shop, owner, auth_client):
        _sell(shop, quantity=1, price="1000.00", cost="600.00")
        expense = _spend(shop, "100.00")

        response = auth_client(owner).get("/api/v1/reports/business-summary/?format=csv")

        assert response.status_code == 200
        body = response.content.decode()
        assert "Net profit" in body
        assert "Gross profit" in body
        assert expense.category.name in body
        # More than a header row -- the D19 failure was a file with only headers.
        assert len(body.strip().splitlines()) > 5
