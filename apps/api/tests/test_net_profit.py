"""Net profit: expenses and purchase order shipping, on the dashboard and the statement.

`PurchaseOrder.shipping_total` -- the "Shipping / other cost" box -- was in no
profit figure at all: receiving costs stock at each line's `unit_cost`, so the
freight never reached COGS, and the statement subtracted only operating
expenses.  These pin where that money lands now, and that the dashboard's
figures are the business summary's figures rather than a second opinion.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from accounts.permissions import RoleCode
from finance import services as finance_services
from orders.models import PaymentMethod, RestockDecision, ReturnStatus
from orders.services import pos, pricing
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from purchasing import services as purchasing_services
from purchasing.models import PurchaseReceipt
from purchasing.services import PurchaseLine
from reports.services import DateRange, business_summary, dashboard, purchase_shipping
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def period() -> DateRange:
    now = timezone.now()
    return DateRange(now - timedelta(days=30), now + timedelta(days=1), "30d")


def _order(shop, *, shipping: str, branch=None, quantity: int = 4):
    """A purchase order for a fresh variant, with `shipping` on it."""
    variant = factories.variant(shop["product"])
    return purchasing_services.create_purchase_order(
        supplier=factories.supplier(),
        branch=branch or shop["branch"],
        lines=[PurchaseLine(variant_id=variant.pk, quantity=quantity, unit_cost=Decimal("100.00"))],
        shipping_total=Decimal(shipping),
        actor=shop["owner"],
    )


def _receive(shop, order, quantity: int | None = None):
    item = order.items.get()
    return purchasing_services.receive_purchase(
        purchase_order=order,
        lines={item.pk: quantity or item.quantity_ordered},
        actor=shop["owner"],
    )


def _sell(shop, *, price: str = "1000.00", cost: str = "600.00"):
    variant = factories.variant(shop["product"], price=Decimal(price))
    factories.stock(variant, shop["branch"], 1, unit_cost=Decimal(cost))
    total = pricing.calculate(pricing.price_lines([(variant, 1, None)])).grand_total
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=1)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)],
        ),
    )


def _spend(shop, amount: str):
    account = factories.account(shop["branch"], opening_balance=Decimal("100000.00"))
    return finance_services.record_expense(
        branch=shop["branch"],
        category=factories.expense_category(),
        account=account,
        amount=Decimal(amount),
        actor=shop["owner"],
    )


def _return_restocked(shop, order):
    item = order.items.get()
    request = return_services.request_return(
        order=order,
        lines=[(item.pk, 1)],
        reason="WRONG_SIZE",
        actor=shop["manager"],
        restock_decisions={str(item.pk): RestockDecision.RESTOCK},
    )
    return_services.approve(return_request=request, actor=shop["manager"])
    return_services.receive(return_request=request, actor=shop["manager"])
    return_services.complete(return_request=request, actor=shop["manager"])
    request.refresh_from_db()
    assert request.status == ReturnStatus.COMPLETED
    return request


class TestWhenPurchaseShippingLands:
    def test_it_lands_when_the_goods_arrive(self, shop, period):
        _receive(shop, _order(shop, shipping="250.00"))

        assert purchase_shipping(date_range=period, branch=shop["branch"]) == {
            "total": Decimal("250.00"),
            "orders": 1,
        }

    def test_an_order_nothing_has_arrived_against_has_not_cost_it_yet(self, shop, period):
        order = _order(shop, shipping="250.00")
        purchasing_services.send_purchase_order(purchase_order=order, actor=shop["owner"])

        assert purchase_shipping(date_range=period, branch=shop["branch"])["total"] == Decimal(
            "0.00"
        )

    def test_a_cancelled_order_never_counts(self, shop, period):
        order = _order(shop, shipping="250.00")
        purchasing_services.cancel_purchase_order(purchase_order=order, actor=shop["owner"])

        assert purchase_shipping(date_range=period, branch=shop["branch"])["total"] == Decimal(
            "0.00"
        )

    def test_two_deliveries_count_the_charge_once(self, shop, period):
        order = _order(shop, shipping="250.00", quantity=4)
        _receive(shop, order, quantity=1)
        order.refresh_from_db()
        _receive(shop, order, quantity=3)

        assert purchase_shipping(date_range=period, branch=shop["branch"]) == {
            "total": Decimal("250.00"),
            "orders": 1,
        }

    def test_the_first_delivery_decides_the_period(self, shop, period):
        """Arrived before the period, so it is that period's cost, not this one's."""
        order = _order(shop, shipping="250.00")
        receipt = _receive(shop, order)
        PurchaseReceipt.objects.filter(pk=receipt.pk).update(
            received_at=period.start - timedelta(days=3)
        )

        assert purchase_shipping(date_range=period, branch=shop["branch"])["total"] == Decimal(
            "0.00"
        )

    def test_another_branchs_freight_is_its_own(self, shop, period):
        other = factories.branch(shop["organization"])
        _receive(shop, _order(shop, shipping="250.00", branch=other))
        _receive(shop, _order(shop, shipping="40.00"))

        assert purchase_shipping(date_range=period, branch=shop["branch"])["total"] == Decimal(
            "40.00"
        )
        assert purchase_shipping(date_range=period)["total"] == Decimal("290.00")

    def test_it_is_not_already_inside_the_cost_of_the_stock(self, shop, period):
        """The reason it is subtracted at all: receiving costs each unit at the
        line's own price, so freight is not double-counted through COGS."""
        order = _order(shop, shipping="400.00", quantity=4)
        _receive(shop, order)

        inventory = order.items.get().variant.inventory.get(branch=shop["branch"])
        assert inventory.average_cost == Decimal("100.00")


class TestTheStatement:
    def test_net_profit_is_gross_profit_less_expenses_and_shipping(self, shop, period):
        _sell(shop, price="1000.00", cost="600.00")
        _spend(shop, "100.00")
        _receive(shop, _order(shop, shipping="50.00"))

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["gross_profit"] == Decimal("400.00")
        assert summary["expenses"]["total"] == Decimal("100.00")
        assert summary["purchase_shipping"] == {"total": Decimal("50.00"), "orders": 1}
        assert summary["net_profit"] == Decimal("250.00")
        assert summary["net_margin_percent"] == Decimal("25.00")

    def test_an_empty_period_is_zeroes_not_a_crash(self, shop):
        long_ago = timezone.now() - timedelta(days=4000)
        empty = DateRange(long_ago, long_ago + timedelta(days=1), "custom")

        summary = business_summary(date_range=empty, branch=shop["branch"])

        assert summary["purchase_shipping"] == {"total": Decimal("0.00"), "orders": 0}
        assert summary["net_profit"] == Decimal("0.00")


class TestTheDashboard:
    def test_it_carries_expenses_shipping_and_net_profit(self, shop, period):
        _sell(shop, price="1000.00", cost="600.00")
        _spend(shop, "100.00")
        _receive(shop, _order(shop, shipping="50.00"))

        profit = dashboard(date_range=period, branch=shop["branch"])["profit"]

        assert profit["gross_profit"] == Decimal("400.00")
        assert profit["expenses"] == Decimal("100.00")
        assert profit["expense_count"] == 1
        assert profit["top_expense_category"]
        assert profit["purchase_shipping"] == Decimal("50.00")
        assert profit["purchase_shipping_orders"] == 1
        assert profit["net_profit"] == Decimal("250.00")

    def test_it_agrees_with_the_business_summary(self, shop, period):
        """Including a refund, which the dashboard's gross profit used to ignore."""
        order = _sell(shop, price="1000.00", cost="600.00")
        _sell(shop, price="500.00", cost="200.00")
        _return_restocked(shop, order)
        _spend(shop, "100.00")
        _receive(shop, _order(shop, shipping="50.00"))

        board = dashboard(date_range=period, branch=shop["branch"])
        summary = business_summary(date_range=period, branch=shop["branch"])

        assert board["kpis"]["gross_profit"] == summary["gross_profit"]
        assert board["kpis"]["margin_percent"] == summary["gross_margin_percent"]
        assert board["profit"]["net_profit"] == summary["net_profit"]
        assert board["profit"]["net_margin_percent"] == summary["net_margin_percent"]

    def test_the_cards_add_up(self, shop, period):
        order = _sell(shop, price="1000.00", cost="600.00")
        _return_restocked(shop, order)
        _sell(shop, price="800.00", cost="300.00")
        _spend(shop, "120.00")
        _receive(shop, _order(shop, shipping="30.00"))

        profit = dashboard(date_range=period, branch=shop["branch"])["profit"]

        assert profit["net_profit"] == (
            profit["gross_profit"] - profit["expenses"] - profit["purchase_shipping"]
        )

    def test_without_the_financial_figures_nothing_is_computed(self, shop, period):
        board = dashboard(date_range=period, branch=shop["branch"], financial=False)

        assert "profit" not in board
        assert "gross_profit" in board["kpis"]


class TestWhoSeesIt:
    URL = "/api/v1/reports/dashboard/"

    @pytest.mark.parametrize("role", [RoleCode.OWNER, RoleCode.MANAGER, RoleCode.ACCOUNTANT])
    def test_roles_with_the_financial_reports_see_net_profit(self, shop, auth_client, role):
        reader = factories.user(role, branch_obj=shop["branch"])

        body = auth_client(reader).get(self.URL).json()

        assert set(body["profit"]) >= {"expenses", "purchase_shipping", "net_profit"}
        # Money leaves as strings, never floats.
        assert isinstance(body["profit"]["net_profit"], str)

    def test_a_stock_manager_sees_the_dashboard_without_them(self, shop, auth_client):
        """`reports.view` without `reports.financial`: the same line the
        business summary draws, which refuses this role outright."""
        reader = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])
        client = auth_client(reader)

        body = client.get(self.URL).json()

        assert "profit" not in body
        assert "gross_profit" in body["kpis"]
        assert client.get("/api/v1/reports/business-summary/").status_code == 403

    def test_the_statement_csv_has_the_shipping_line(self, shop, auth_client):
        _receive(shop, _order(shop, shipping="75.00"))

        response = auth_client(shop["owner"]).get("/api/v1/reports/business-summary/?format=csv")

        assert response.status_code == 200
        assert "Purchase order shipping,-75.00" in response.content.decode()
