"""A discount on the whole sale is not revenue, in any report.

A coupon or a cashier's discount is frozen on the order, not on its lines, so a
report that sums `line_total` counts money the customer never paid.  The
dashboard did exactly that: a ৳1,000 item sold with ৳100 off showed the profit
of a ৳1,000 sale.  Every report shares one revenue expression, so every test
here pins the same trade from a different screen.

Prices in this file: the goods cost ৳600 and sell at ৳1,000 unless a test says
otherwise, and every discount stays at 10% so no sale needs a manager.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from accounts.models import TaxMode
from orders.models import Order, PaymentMethod, RestockDecision, ReturnStatus
from orders.services import pos
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from promotions.models import Coupon, DiscountType
from reports.services import (
    DateRange,
    business_summary,
    dashboard,
    product_performance,
    profit_report,
    vat_report,
)
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


def _sell(
    shop,
    *,
    prices: tuple[str, ...] = ("1000.00",),
    cost: str = "600.00",
    quantity: int = 1,
    line_discount: str = "0.00",
    **sale,
) -> Order:
    """Sell one freshly received variant per price, so each frozen cost is `cost`.

    Paid at whatever the server prices the sale at, as the register does.
    """
    lines = []
    for price in prices:
        variant = factories.variant(shop["product"], price=Decimal(price))
        factories.stock(variant, shop["branch"], quantity, unit_cost=Decimal(cost))
        lines.append(
            SaleLineInput(
                variant_id=variant.pk, quantity=quantity, line_discount=Decimal(line_discount)
            )
        )

    data = SaleInput(lines=lines, **sale)
    total = pos.price_sale(
        branch=shop["branch"], actor=shop["cashier"], data=data
    ).priced.grand_total
    data.payments = [PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)]
    return pos.create_pos_sale(branch=shop["branch"], actor=shop["cashier"], data=data)


def _return(shop, order: Order, quantity: int = 1):
    """Take `quantity` of the order's only line back, all the way to refunded."""
    item = order.items.get()
    request = return_services.request_return(
        order=order,
        lines=[(item.pk, quantity)],
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


class TestTheDashboard:
    def test_a_whole_sale_discount_comes_out_of_gross_profit(self, shop, period):
        order = _sell(shop, manual_discount=Decimal("100.00"))
        assert order.grand_total == Decimal("900.00")

        kpis = dashboard(date_range=period, branch=shop["branch"])["kpis"]

        # 900 taken for goods that cost 600 -- not the 400 a 1,000 sale earns.
        assert kpis["revenue"] == Decimal("900.00")
        assert kpis["discount_total"] == Decimal("100.00")
        assert kpis["gross_profit"] == Decimal("300.00")
        assert kpis["margin_percent"] == Decimal("33.33")

    def test_a_coupon_comes_out_of_gross_profit(self, shop, period):
        coupon = Coupon.objects.create(
            code=f"RPT{factories.unique()}",
            discount_type=DiscountType.PERCENTAGE,
            value=Decimal("10.00"),
            usage_limit_per_customer=None,
        )

        order = _sell(shop, coupon_code=coupon.code)
        assert order.coupon_discount == Decimal("100.00")

        kpis = dashboard(date_range=period, branch=shop["branch"])["kpis"]
        assert kpis["gross_profit"] == Decimal("300.00")

    def test_a_line_discount_is_still_counted_once(self, shop, period):
        """Already inside `line_total`, so it must not be taken off a second time."""
        order = _sell(shop, line_discount="100.00")
        assert order.discount_total == Decimal("0.00")
        assert order.grand_total == Decimal("900.00")

        kpis = dashboard(date_range=period, branch=shop["branch"])["kpis"]
        assert kpis["gross_profit"] == Decimal("300.00")

    def test_the_report_agrees_with_the_order_itself(self, shop, period):
        order = _sell(shop, prices=("1000.00", "500.00"), manual_discount_percent=Decimal("10"))

        kpis = dashboard(date_range=period, branch=shop["branch"])["kpis"]
        assert kpis["gross_profit"] == order.gross_profit == Decimal("150.00")

    def test_the_lines_of_one_sale_add_up_to_what_was_paid(self, shop, period):
        """Each line's share of 10.00 is 3.33 recurring.  Rounded per line the
        three come to 290.01, which is 0.01 the customer never handed over.
        """
        _sell(
            shop,
            prices=("100.00", "100.00", "100.00"),
            cost="60.00",
            manual_discount=Decimal("10.00"),
        )

        kpis = dashboard(date_range=period, branch=shop["branch"])["kpis"]
        assert kpis["revenue"] == Decimal("290.00")
        assert kpis["gross_profit"] == Decimal("110.00")

    def test_a_sale_given_away_entirely_does_not_divide_by_zero(self, shop, period):
        _sell(shop, prices=("0.00",))

        kpis = dashboard(date_range=period, branch=shop["branch"])["kpis"]
        assert kpis["gross_profit"] == Decimal("-600.00")


class TestTheBusinessSummary:
    def test_the_discount_is_out_of_revenue_and_out_of_profit(self, shop, period):
        _sell(shop, manual_discount=Decimal("100.00"))

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["revenue"]["goods"] == Decimal("900.00")
        assert summary["revenue"]["discounts_given"] == Decimal("100.00")
        assert summary["gross_profit"] == Decimal("300.00")
        assert summary["net_profit"] == Decimal("300.00")

    def test_inclusive_vat_is_taken_off_the_discounted_price(self, shop, period):
        _set_tax(shop, TaxMode.INCLUSIVE, "0.1500")
        order = _sell(shop, prices=("1150.00", "1150.00"), manual_discount_percent=Decimal("10"))
        # 2,300 less 230 is 2,070 at the till, 270 of it the government's.
        assert order.grand_total == Decimal("2070.00")

        summary = business_summary(date_range=period, branch=shop["branch"])

        assert summary["revenue"]["vat_collected"] == Decimal("270.00")
        assert summary["revenue"]["goods"] == Decimal("1800.00")
        assert summary["gross_profit"] == Decimal("600.00")


class TestTheOtherReports:
    def test_the_profit_report(self, shop, period):
        _sell(shop, manual_discount=Decimal("100.00"))

        report = profit_report(date_range=period, branch=shop["branch"])

        assert report["totals"]["revenue"] == Decimal("900.00")
        assert report["totals"]["gross_profit"] == Decimal("300.00")
        assert [row["gross_profit"] for row in report["daily"]] == [Decimal("300.00")]

    def test_each_product_bears_its_share_of_the_discount(self, shop, period):
        order = _sell(shop, prices=("1000.00", "500.00"), manual_discount_percent=Decimal("10"))
        dear, cheap = order.items.order_by("-unit_price")

        rows = {
            row["sku"]: row for row in product_performance(date_range=period, branch=shop["branch"])
        }

        assert rows[dear.sku]["revenue"] == Decimal("900.00")
        assert rows[dear.sku]["gross_profit"] == Decimal("300.00")
        assert rows[cheap.sku]["revenue"] == Decimal("450.00")
        assert rows[cheap.sku]["gross_profit"] == Decimal("-150.00")


class TestTheVatReport:
    def test_taxable_sales_is_the_base_the_tax_was_charged_on(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, quantity=2, manual_discount_percent=Decimal("10"))

        report = vat_report(date_range=period, branch=shop["branch"])

        # 15% of 1,800, which is what the customer was charged tax on.
        assert report["output"]["taxable_sales"] == Decimal("1800.00")
        assert report["output"]["vat"] == Decimal("270.00")
        assert report["by_rate"][0]["taxable"] == Decimal("1800.00")

    def test_a_return_credits_the_discounted_base(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        order = _sell(shop, quantity=2, manual_discount_percent=Decimal("10"))

        _return(shop, order, quantity=1)

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["credits"]["taxable_returns"] == Decimal("900.00")
        assert report["credits"]["vat"] == Decimal("135.00")
