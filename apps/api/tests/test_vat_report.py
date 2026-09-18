"""The VAT return: collected, credited back, paid, owed.

Every figure here is one an owner files with, so each test pins a number that
would look plausible if it were wrong -- VAT counted on the wrong side of the
subtraction, a return that credits the refund instead of the tax, a draft
purchase claimed as input VAT.

The report is deliberately built on the same frozen columns as
`business_summary`, and one test below holds the two to the same answer.
"""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from accounts.models import TaxMode
from core.money import quantize
from orders.models import PaymentMethod, RestockDecision, ReturnStatus
from orders.services import pos, pricing
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from purchasing.services import (
    PurchaseLine,
    ReturnLine,
    create_purchase_order,
    create_purchase_return,
    receive_purchase,
    send_purchase_order,
)
from reports.services import DateRange, business_summary, vat_report
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


def _sell(shop, *, quantity: int = 1, price: str = "1000.00"):
    """Sell a freshly stocked variant, so nothing blends into the figures."""
    variant = factories.variant(shop["product"], price=Decimal(price))
    factories.stock(variant, shop["branch"], quantity, unit_cost=Decimal("400.00"))

    total = pricing.calculate(pricing.price_lines([(variant, quantity, None)])).grand_total
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)],
        ),
    )


def _return(shop, order, quantity: int = 1):
    """Take `quantity` of the order's only line back, all the way to refunded."""
    item = order.items.first()
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


def _purchase(shop, *, unit_cost: str = "500.00", quantity: int = 10, tax_rate: str = "0.1500"):
    """A purchase order sent to the supplier, carrying the VAT they charged."""
    order = create_purchase_order(
        supplier=factories.supplier(),
        branch=shop["branch"],
        lines=[
            PurchaseLine(
                variant_id=shop["variants"][0].pk,
                quantity=quantity,
                unit_cost=Decimal(unit_cost),
                tax_rate=Decimal(tax_rate),
            )
        ],
        actor=shop["manager"],
    )
    return send_purchase_order(purchase_order=order, actor=shop["manager"])


class TestOutputVat:
    def test_exclusive_charges_the_tax_on_top_of_the_base(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["output"]["taxable_sales"] == Decimal("1000.00")
        assert report["output"]["vat"] == Decimal("150.00")
        assert report["output"]["orders"] == 1

    def test_inclusive_reaches_the_same_base_from_inside_the_price(self, shop, period):
        """1,150 inclusive and 1,000 exclusive are the same trade to the VAT office."""
        _set_tax(shop, TaxMode.INCLUSIVE, "0.1500")
        _sell(shop, price="1150.00")

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["output"]["taxable_sales"] == Decimal("1000.00")
        assert report["output"]["vat"] == Decimal("150.00")

    def test_it_agrees_with_the_business_summary(self, shop, period):
        """Two reports, one figure. They read the same column on purpose."""
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, quantity=3, price="1000.00")

        report = vat_report(date_range=period, branch=shop["branch"])
        summary = business_summary(date_range=period, branch=shop["branch"])

        assert report["output"]["vat"] == summary["revenue"]["vat_collected"]
        assert report["output"]["taxable_sales"] == summary["revenue"]["goods"]

    def test_taxable_means_the_base_the_tax_was_computed_on(self, shop, period):
        """A period spanning a rate change holds zero-rated orders too.

        Folding them into `taxable_sales` put 885.00 of VAT beside 149,790.00
        on the screen -- a ratio of 0.6% where the rate was 15%, and nothing on
        the page explained it.  Zero-rated supply is reported beside the taxable
        base, never inside it.
        """
        _sell(shop, price="4000.00")  # priced at the shipped 0%
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["output"]["taxable_sales"] == Decimal("1000.00")
        assert report["output"]["zero_rated_sales"] == Decimal("4000.00")
        # The headline ratio now reads as the rate it was charged at.
        assert report["output"]["vat"] == quantize(
            report["output"]["taxable_sales"] * Decimal("0.15")
        )

    def test_a_zero_rated_purchase_is_reported_beside_the_taxable_one(self, shop, period):
        _purchase(shop, unit_cost="500.00", quantity=10, tax_rate="0.1500")
        _purchase(shop, unit_cost="800.00", quantity=10, tax_rate="0.0000")

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["input"]["taxable_purchases"] == Decimal("5000.00")
        assert report["input"]["zero_rated_purchases"] == Decimal("8000.00")
        assert report["input"]["vat"] == Decimal("750.00")

    def test_nothing_is_owed_at_the_rate_the_platform_ships_with(self, shop, period):
        _sell(shop, price="1000.00")

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["output"]["vat"] == Decimal("0.00")
        assert report["net_payable"] == Decimal("0.00")


class TestCredits:
    def test_a_return_credits_the_tax_it_carried(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        order = _sell(shop, quantity=2, price="1000.00")  # 2,000 + 300 VAT

        _return(shop, order, quantity=1)

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["output"]["vat"] == Decimal("300.00")
        assert report["credits"]["vat"] == Decimal("150.00")
        assert report["credits"]["taxable_returns"] == Decimal("1000.00")
        assert report["net_payable"] == Decimal("150.00")

    def test_an_inclusive_return_credits_the_tax_from_inside_the_price(self, shop, period):
        _set_tax(shop, TaxMode.INCLUSIVE, "0.1500")
        order = _sell(shop, quantity=2, price="1150.00")

        _return(shop, order, quantity=1)

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["credits"]["vat"] == Decimal("150.00")
        assert report["credits"]["taxable_returns"] == Decimal("1000.00")

    def test_returning_everything_leaves_nothing_owed(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        order = _sell(shop, quantity=2, price="1000.00")

        _return(shop, order, quantity=2)

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["credits"]["vat"] == report["output"]["vat"]
        assert report["net_payable"] == Decimal("0.00")

    def test_a_return_outside_the_window_is_not_this_period_s_credit(self, shop, period):
        """Each event lands where it happened -- the same rule as the summary."""
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        order = _sell(shop, quantity=2, price="1000.00")
        request = _return(shop, order, quantity=1)

        request.completed_at = timezone.now() - timedelta(days=90)
        request.save(update_fields=["completed_at"])

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["credits"]["vat"] == Decimal("0.00")
        assert report["net_payable"] == Decimal("300.00")


class TestInputVat:
    def test_vat_paid_to_a_supplier_offsets_what_is_owed(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, quantity=2, price="1000.00")  # 300 out
        _purchase(shop, unit_cost="500.00", quantity=10)  # 5,000 @ 15% = 750 in

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["input"]["taxable_purchases"] == Decimal("5000.00")
        assert report["input"]["vat"] == Decimal("750.00")
        # More reclaimed than collected: the government owes the shop.
        assert report["net_payable"] == Decimal("-450.00")

    def test_a_draft_purchase_is_not_a_purchase(self, shop, period):
        """Nothing has been invoiced, so there is no input VAT to reclaim."""
        create_purchase_order(
            supplier=factories.supplier(),
            branch=shop["branch"],
            lines=[
                PurchaseLine(
                    variant_id=shop["variants"][0].pk,
                    quantity=10,
                    unit_cost=Decimal("500.00"),
                    tax_rate=Decimal("0.1500"),
                )
            ],
            actor=shop["manager"],
        )

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["input"]["vat"] == Decimal("0.00")
        assert report["input"]["purchases"] == 0

    def test_the_line_rate_reaches_the_order_total(self, shop, period):
        """The column existed from the first migration; nothing could set it."""
        order = _purchase(shop, unit_cost="500.00", quantity=10, tax_rate="0.1500")

        assert order.tax_total == Decimal("750.00")
        assert order.grand_total == Decimal("5750.00")


class TestGoodsSentBackToASupplier:
    """A purchase return credits the cost, not the tax.  The input VAT has to be
    reclaimed back here or a shop that sent a delivery back keeps claiming tax
    on goods it no longer holds.
    """

    def _received(self, shop, *, quantity: int = 10, unit_cost: str = "500.00"):
        order = _purchase(shop, unit_cost=unit_cost, quantity=quantity)
        item = order.items.first()
        receive_purchase(
            purchase_order=order,
            lines={item.pk: quantity},
            actor=shop["manager"],
        )
        order.refresh_from_db()
        return order

    def test_returning_stock_gives_back_its_share_of_the_input_vat(self, shop, period):
        order = self._received(shop, quantity=10, unit_cost="500.00")  # 750 input VAT
        item = order.items.first()

        create_purchase_return(
            purchase_order=order,
            lines=[ReturnLine(purchase_order_item_id=item.pk, quantity=4)],
            reason="DAMAGED",
            actor=shop["manager"],
        )

        report = vat_report(date_range=period, branch=shop["branch"])
        # 4 of 10 at 500 is 2,000 of goods; 15% of that is 300.
        assert report["input"]["vat_given_back"] == Decimal("300.00")
        assert report["input"]["returned_to_suppliers"] == Decimal("2000.00")
        assert report["input"]["vat"] == Decimal("450.00")
        # The base stays gross of returns, like the sales side; only the VAT is
        # netted, because that is the figure the filing turns on.
        assert report["input"]["taxable_purchases"] == Decimal("5000.00")

    def test_returning_the_whole_delivery_reclaims_nothing(self, shop, period):
        order = self._received(shop, quantity=10, unit_cost="500.00")
        item = order.items.first()

        create_purchase_return(
            purchase_order=order,
            lines=[ReturnLine(purchase_order_item_id=item.pk, quantity=10)],
            reason="WRONG_ITEM",
            actor=shop["manager"],
        )

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["input"]["vat"] == Decimal("0.00")
        assert report["input"]["vat_given_back"] == report["input"]["vat_on_purchases"]
        assert report["input"]["returned_to_suppliers"] == Decimal("5000.00")

    def test_a_return_at_a_zero_rated_purchase_moves_no_vat(self, shop, period):
        order = _purchase(shop, unit_cost="500.00", quantity=10, tax_rate="0.0000")
        item = order.items.first()
        receive_purchase(purchase_order=order, lines={item.pk: 10}, actor=shop["manager"])

        create_purchase_return(
            purchase_order=order,
            lines=[ReturnLine(purchase_order_item_id=item.pk, quantity=4)],
            reason="DAMAGED",
            actor=shop["manager"],
        )

        report = vat_report(date_range=period, branch=shop["branch"])
        assert report["input"]["vat_given_back"] == Decimal("0.00")
        assert report["input"]["returned_to_suppliers"] == Decimal("2000.00")
        # Nothing VAT-bearing was bought, so the taxable base stays empty and
        # the whole purchase sits in the zero-rated figure beside it.
        assert report["input"]["taxable_purchases"] == Decimal("0.00")
        assert report["input"]["zero_rated_purchases"] == Decimal("5000.00")

    def test_the_months_still_add_up_after_a_return(self, shop, period):
        order = self._received(shop, quantity=10, unit_cost="500.00")
        item = order.items.first()
        create_purchase_return(
            purchase_order=order,
            lines=[ReturnLine(purchase_order_item_id=item.pk, quantity=4)],
            reason="DAMAGED",
            actor=shop["manager"],
        )

        report = vat_report(date_range=period, branch=shop["branch"])

        assert sum(row["input_vat"] for row in report["monthly"]) == report["input"]["vat"]
        assert sum(row["net_payable"] for row in report["monthly"]) == report["net_payable"]


class TestByRate:
    def test_each_rate_is_filed_separately(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.0500")
        _sell(shop, price="2000.00")

        rows = vat_report(date_range=period, branch=shop["branch"])["by_rate"]

        by_rate = {row["rate"]: row for row in rows}
        assert by_rate[Decimal("0.1500")]["vat"] == Decimal("150.00")
        assert by_rate[Decimal("0.0500")]["vat"] == Decimal("100.00")
        # Highest first, so the main rate leads the return.
        assert [row["rate"] for row in rows] == [Decimal("0.1500"), Decimal("0.0500")]

    def test_the_rate_split_adds_up_to_the_total(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.0500")
        _sell(shop, price="2000.00")

        report = vat_report(date_range=period, branch=shop["branch"])

        assert sum(row["vat"] for row in report["by_rate"]) == report["output"]["vat"]


class TestMonthly:
    def test_the_months_add_up_to_the_period(self, shop, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, quantity=2, price="1000.00")
        _purchase(shop, unit_cost="500.00", quantity=10)

        report = vat_report(date_range=period, branch=shop["branch"])

        assert report["monthly"], "a period that traded must produce at least one month"
        assert sum(row["output_vat"] for row in report["monthly"]) == report["output"]["vat"]
        assert sum(row["input_vat"] for row in report["monthly"]) == report["input"]["vat"]
        assert sum(row["net_payable"] for row in report["monthly"]) == report["net_payable"]


class TestEndpoint:
    def test_the_owner_can_read_it(self, shop, owner, auth_client, period):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")

        response = auth_client(owner).get("/api/v1/reports/vat/")

        assert response.status_code == 200
        assert response.json()["output"]["vat"] == "150.00"

    def test_a_cashier_cannot(self, shop, cashier, auth_client):
        """It names a liability, so it is reports.financial like the rest."""
        response = auth_client(cashier).get("/api/v1/reports/vat/")

        assert response.status_code == 403

    def test_money_leaves_as_strings_never_as_floats(self, shop, owner, auth_client):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")

        response = auth_client(owner).get("/api/v1/reports/vat/")

        payload = json.loads(response.content)
        assert isinstance(payload["net_payable"], str)
        assert isinstance(payload["output"]["vat"], str)
        assert isinstance(payload["by_rate"][0]["vat"], str)

    def test_csv_exports_the_months_not_an_empty_file(self, shop, owner, auth_client):
        """A filing is monthly, so the default `daily` key would export nothing."""
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        _sell(shop, price="1000.00")

        response = auth_client(owner).get("/api/v1/reports/vat/?format=csv")

        assert response.status_code == 200
        body = response.content.decode()
        assert "net_payable" in body
        assert "150.00" in body
