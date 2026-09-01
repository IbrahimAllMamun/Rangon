"""VAT: the treatment, the arithmetic, and the guard on changing it.

Decision D-C in docs/business-rules.md §3.4 -- inclusive or exclusive, and at
what rate -- used to live in an environment variable and was never implemented
for the inclusive half.  These tests pin down the half that was missing and the
invariant that makes the setting safe to change: an order freezes the treatment
it was priced under, so history never moves.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from accounts import services as account_services
from accounts.models import Organization, TaxMode
from core.exceptions import Conflict, ValidationError
from orders.models import Order, PaymentMethod
from orders.services import pos, pricing
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput

pytestmark = pytest.mark.django_db


def _set_tax(org: Organization, mode: str, rate: str) -> None:
    org.tax_mode = mode
    org.default_tax_rate = Decimal(rate)
    org.save(update_fields=["tax_mode", "default_tax_rate"])


def _lines(shop, quantity: int = 1, price: str = "1000.00"):
    variant = shop["variants"][0]
    variant.price = Decimal(price)
    variant.save(update_fields=["price"])
    return pricing.price_lines([(variant, quantity, None)])


def _sale(shop, *, quantity: int = 1, price: str = "1000.00") -> Order:
    """A POS sale paid in full, whatever the VAT treatment makes the total."""
    variant = shop["variants"][0]
    variant.price = Decimal(price)
    variant.save(update_fields=["price"])
    total = pricing.calculate(pricing.price_lines([(variant, quantity, None)])).grand_total
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)],
        ),
    )


class TestExclusivePricing:
    def test_tax_is_added_on_top_of_the_shown_price(self, shop):
        _set_tax(shop["organization"], TaxMode.EXCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1000.00"))

        assert priced.subtotal == Decimal("1000.00")
        assert priced.tax_total == Decimal("150.00")
        assert priced.grand_total == Decimal("1150.00")

    def test_shipping_is_not_taxed(self, shop):
        _set_tax(shop["organization"], TaxMode.EXCLUSIVE, "0.1000")

        priced = pricing.calculate(_lines(shop, price="500.00"), shipping_total=Decimal("70.00"))

        assert priced.tax_total == Decimal("50.00")
        assert priced.grand_total == Decimal("620.00")

    def test_net_revenue_excludes_no_tax_because_none_is_inside(self, shop):
        _set_tax(shop["organization"], TaxMode.EXCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1000.00"))

        assert priced.net_revenue == Decimal("1000.00")


class TestInclusivePricing:
    """The half that was configured but never implemented."""

    def test_tax_is_extracted_from_the_shown_price(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1150.00"))

        # 1150 inclusive of 15% == 1000 net + 150 tax.
        assert priced.subtotal == Decimal("1150.00")
        assert priced.tax_total == Decimal("150.00")
        assert priced.grand_total == Decimal("1150.00")

    def test_the_customer_is_never_charged_the_tax_twice(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1000.00"))

        # The shelf price is what is paid.  Adding tax on top would be the bug.
        assert priced.grand_total == Decimal("1000.00")
        assert priced.tax_total < priced.subtotal

    def test_net_revenue_takes_the_tax_back_out(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1150.00"))

        # Margin must be computed on 1000, not on 1150, or profit is overstated
        # by exactly the VAT.
        assert priced.net_revenue == Decimal("1000.00")

    def test_shipping_is_added_outside_the_inclusive_base(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1150.00"), shipping_total=Decimal("70.00"))

        assert priced.tax_total == Decimal("150.00")
        assert priced.grand_total == Decimal("1220.00")

    def test_a_discount_reduces_the_tax_inside_the_price(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")

        priced = pricing.calculate(_lines(shop, price="1150.00"), manual_discount=Decimal("150.00"))

        # Base 1000 inclusive of 15% -> tax 130.43, and the total is the base.
        assert priced.tax_total == Decimal("130.43")
        assert priced.grand_total == Decimal("1000.00")

    def test_zero_rate_inclusive_behaves_like_no_tax(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.0000")

        priced = pricing.calculate(_lines(shop, price="1000.00"))

        assert priced.tax_total == Decimal("0.00")
        assert priced.grand_total == Decimal("1000.00")
        assert priced.net_revenue == Decimal("1000.00")


class TestLineAllocation:
    def test_allocated_line_tax_sums_to_the_order_tax(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")
        first, second = shop["variants"]
        first.price = Decimal("333.33")
        first.save(update_fields=["price"])
        second.price = Decimal("666.67")
        second.save(update_fields=["price"])

        priced = pricing.calculate(pricing.price_lines([(first, 1, None), (second, 1, None)]))

        assert sum(line.tax_amount for line in priced.lines) == priced.tax_total


class TestTaxSettingsService:
    def test_settling_records_who_and_when(self, shop, owner):
        organization = account_services.update_tax_settings(
            tax_mode=TaxMode.INCLUSIVE,
            default_tax_rate=Decimal("0.0750"),
            actor=owner,
        )

        assert organization.tax_mode == TaxMode.INCLUSIVE
        assert organization.default_tax_rate == Decimal("0.0750")
        assert organization.tax_is_settled
        assert organization.tax_settled_by == owner

    def test_an_out_of_range_rate_is_refused(self, shop, owner):
        with pytest.raises(ValidationError):
            account_services.update_tax_settings(
                tax_mode=TaxMode.EXCLUSIVE,
                default_tax_rate=Decimal("1.5000"),
                actor=owner,
            )

    def test_a_negative_rate_is_refused(self, shop, owner):
        with pytest.raises(ValidationError):
            account_services.update_tax_settings(
                tax_mode=TaxMode.EXCLUSIVE,
                default_tax_rate=Decimal("-0.1000"),
                actor=owner,
            )

    def test_an_unknown_mode_is_refused(self, shop, owner):
        with pytest.raises(ValidationError):
            account_services.update_tax_settings(
                tax_mode="SOMETIMES",
                default_tax_rate=Decimal("0.1000"),
                actor=owner,
            )

    def test_changing_it_after_orders_exist_needs_confirmation(self, shop, owner):
        _sale(shop)

        with pytest.raises(Conflict) as caught:
            account_services.update_tax_settings(
                tax_mode=TaxMode.INCLUSIVE,
                default_tax_rate=Decimal("0.1500"),
                actor=owner,
            )

        assert caught.value.code == "TAX_CHANGE_NEEDS_CONFIRMATION"
        assert caught.value.details["order_count"] == 1

    def test_confirmation_lets_the_change_through(self, shop, owner):
        _sale(shop)

        organization = account_services.update_tax_settings(
            tax_mode=TaxMode.INCLUSIVE,
            default_tax_rate=Decimal("0.1500"),
            actor=owner,
            confirm_historical=True,
        )

        assert organization.tax_mode == TaxMode.INCLUSIVE

    def test_re_saving_the_same_values_needs_no_confirmation(self, shop, owner):
        _sale(shop)
        organization = shop["organization"]

        settled = account_services.update_tax_settings(
            tax_mode=organization.tax_mode,
            default_tax_rate=organization.default_tax_rate,
            actor=owner,
        )

        # Confirming the existing default is how an owner says "yes, 0% is
        # right" -- it must not be blocked by the guard meant for changes.
        assert settled.tax_is_settled


class TestHistoryIsFrozen:
    def test_an_order_keeps_the_treatment_it_was_priced_under(self, shop, owner):
        _set_tax(shop["organization"], TaxMode.EXCLUSIVE, "0.1000")
        order = _sale(shop)
        original_total = order.grand_total
        original_tax = order.tax_total

        account_services.update_tax_settings(
            tax_mode=TaxMode.INCLUSIVE,
            default_tax_rate=Decimal("0.1500"),
            actor=owner,
            confirm_historical=True,
        )

        order.refresh_from_db()
        assert order.grand_total == original_total
        assert order.tax_total == original_tax
        assert order.tax_mode == TaxMode.EXCLUSIVE

    def test_gross_profit_uses_the_orders_own_mode(self, shop):
        _set_tax(shop["organization"], TaxMode.INCLUSIVE, "0.1500")
        order = _sale(shop)

        expected = order.subtotal - order.discount_total - order.tax_total - order.cogs_total
        assert order.gross_profit == expected


class TestTaxEndpoint:
    def test_owner_can_read_the_current_treatment(self, shop, owner, auth_client):
        response = auth_client(owner).get("/api/v1/organization/tax/")

        assert response.status_code == 200
        assert response.data["tax_mode"] == TaxMode.EXCLUSIVE
        assert response.data["is_settled"] is False

    def test_owner_can_settle_it(self, shop, owner, auth_client):
        response = auth_client(owner).patch(
            "/api/v1/organization/tax/",
            {"tax_mode": TaxMode.INCLUSIVE, "default_tax_rate": "0.1500"},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["tax_mode"] == TaxMode.INCLUSIVE
        assert response.data["is_settled"] is True

    def test_a_cashier_cannot_change_it(self, shop, cashier, auth_client):
        response = auth_client(cashier).patch(
            "/api/v1/organization/tax/",
            {"tax_mode": TaxMode.INCLUSIVE, "default_tax_rate": "0.1500"},
            format="json",
        )

        assert response.status_code == 403
        shop["organization"].refresh_from_db()
        assert shop["organization"].tax_mode == TaxMode.EXCLUSIVE

    def test_an_anonymous_request_is_refused(self, shop, api):
        response = api.patch(
            "/api/v1/organization/tax/",
            {"tax_mode": TaxMode.INCLUSIVE, "default_tax_rate": "0.1500"},
            format="json",
        )

        assert response.status_code in {401, 403}

    def test_an_out_of_range_rate_is_a_field_error_not_a_500(self, shop, owner, auth_client):
        response = auth_client(owner).patch(
            "/api/v1/organization/tax/",
            {"tax_mode": TaxMode.EXCLUSIVE, "default_tax_rate": "2.0"},
            format="json",
        )

        assert response.status_code == 400

    def test_the_generic_organization_patch_cannot_change_vat(self, shop, owner, auth_client):
        response = auth_client(owner).patch(
            "/api/v1/organization/",
            {"tax_mode": TaxMode.INCLUSIVE, "default_tax_rate": "0.1500"},
            format="json",
        )

        assert response.status_code == 200
        shop["organization"].refresh_from_db()
        # Changing VAT must go through the guarded, audited endpoint.
        assert shop["organization"].tax_mode == TaxMode.EXCLUSIVE
        assert shop["organization"].default_tax_rate == Decimal("0.0000")

    def test_changing_after_orders_exist_returns_409_with_the_count(self, shop, owner, auth_client):
        _sale(shop)

        response = auth_client(owner).patch(
            "/api/v1/organization/tax/",
            {"tax_mode": TaxMode.INCLUSIVE, "default_tax_rate": "0.1500"},
            format="json",
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "TAX_CHANGE_NEEDS_CONFIRMATION"
        assert response.data["error"]["details"]["order_count"] == 1

    def test_confirm_true_goes_through(self, shop, owner, auth_client):
        _sale(shop)

        response = auth_client(owner).patch(
            "/api/v1/organization/tax/",
            {"tax_mode": TaxMode.INCLUSIVE, "default_tax_rate": "0.1500", "confirm": True},
            format="json",
        )

        assert response.status_code == 200
        assert Order.objects.count() == 1
