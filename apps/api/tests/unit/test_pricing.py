"""Order maths, money handling and coupon rules — pure logic, no HTTP."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.utils import timezone

from core.exceptions import CouponInvalid, ValidationError
from core.money import format_money, percentage_of, quantize, to_decimal
from orders.services import pricing
from promotions import services as promotion_services
from promotions.models import Coupon, DiscountType
from tests import factories

pytestmark = pytest.mark.django_db


class TestMoney:
    def test_floats_are_converted_without_binary_error(self):
        assert to_decimal(0.1) == Decimal("0.1")
        assert to_decimal("1290.5") == Decimal("1290.5")

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("1.005", "1.01"), ("1.004", "1.00"), ("2.675", "2.68"), ("-1.005", "-1.01")],
    )
    def test_rounding_is_half_up(self, value, expected):
        assert quantize(value) == Decimal(expected)

    def test_percentage(self):
        assert percentage_of("1000.00", "12.5") == Decimal("125.00")

    def test_formatting_uses_the_configured_symbol(self):
        assert format_money("1290") == "৳ 1,290.00"
        assert format_money("1290", with_symbol=False) == "1,290.00"

    def test_rejects_nonsense(self):
        with pytest.raises(ValueError):
            to_decimal("not-a-number")


class TestOrderMaths:
    def _lines(self, *specs):
        return pricing.price_lines(
            [
                (factories.variant(price=price), quantity, Decimal(discount))
                for price, quantity, discount in specs
            ]
        )

    def test_subtotal_and_total(self):
        lines = self._lines(("1000.00", 2, "0.00"), ("500.00", 1, "0.00"))

        priced = pricing.calculate(lines)

        assert priced.subtotal == Decimal("2500.00")
        assert priced.grand_total == Decimal("2500.00")
        assert priced.item_count == 3

    def test_line_discount_reduces_the_line_and_the_subtotal(self):
        lines = self._lines(("1000.00", 2, "150.00"))

        priced = pricing.calculate(lines)

        assert lines[0].line_total == Decimal("1850.00")
        assert priced.subtotal == Decimal("1850.00")

    def test_shipping_is_added_after_discount_and_tax(self):
        lines = self._lines(("1000.00", 1, "0.00"))

        priced = pricing.calculate(
            lines, manual_discount=Decimal("100.00"), shipping_total=Decimal("70.00")
        )

        assert priced.grand_total == Decimal("970.00")

    def test_tax_applies_to_the_discounted_base(self):
        lines = self._lines(("1000.00", 1, "0.00"))

        priced = pricing.calculate(
            lines, manual_discount=Decimal("200.00"), tax_rate=Decimal("0.15")
        )

        assert priced.tax_total == Decimal("120.00")  # 15% of 800, not of 1000
        assert priced.grand_total == Decimal("920.00")

    def test_tax_allocation_across_lines_sums_to_the_order_tax(self):
        lines = self._lines(("333.33", 1, "0.00"), ("333.33", 1, "0.00"), ("333.34", 1, "0.00"))

        priced = pricing.calculate(lines, tax_rate=Decimal("0.075"))

        assert sum(line.tax_amount for line in lines) == priced.tax_total

    def test_a_discount_larger_than_the_line_is_refused(self):
        with pytest.raises(ValidationError):
            self._lines(("1000.00", 1, "1500.00"))

    def test_a_discount_larger_than_the_order_is_refused(self):
        lines = self._lines(("1000.00", 1, "0.00"))

        with pytest.raises(ValidationError):
            pricing.calculate(lines, manual_discount=Decimal("2000.00"))

    def test_zero_quantity_is_refused(self):
        with pytest.raises(ValidationError):
            pricing.price_lines([(factories.variant(), 0, Decimal("0.00"))])

    def test_change_due_is_never_negative(self):
        assert pricing.change_due(Decimal("500.00"), Decimal("1000.00")) == Decimal("500.00")
        assert pricing.change_due(Decimal("500.00"), Decimal("400.00")) == Decimal("0.00")


class TestCoupons:
    def _coupon(self, **kwargs) -> Coupon:
        defaults = {
            "code": f"TEST{factories.unique()}",
            "discount_type": DiscountType.PERCENTAGE,
            "value": Decimal("10.00"),
        }
        return Coupon.objects.create(**{**defaults, **kwargs})

    def _lines(self, price="1000.00", quantity=1):
        return pricing.price_lines([(factories.variant(price=price), quantity, Decimal("0.00"))])

    def test_percentage_discount(self):
        lines = self._lines("2000.00")
        result = promotion_services.validate_coupon(
            coupon=self._coupon(), lines=lines, subtotal=Decimal("2000.00")
        )
        assert result.discount == Decimal("200.00")

    def test_maximum_discount_caps_a_percentage(self):
        lines = self._lines("10000.00")
        coupon = self._coupon(value=Decimal("50.00"), maximum_discount=Decimal("500.00"))

        result = promotion_services.validate_coupon(
            coupon=coupon, lines=lines, subtotal=Decimal("10000.00")
        )

        assert result.discount == Decimal("500.00")

    def test_fixed_discount_never_exceeds_the_order(self):
        lines = self._lines("300.00")
        coupon = self._coupon(discount_type=DiscountType.FIXED, value=Decimal("500.00"))

        result = promotion_services.validate_coupon(
            coupon=coupon, lines=lines, subtotal=Decimal("300.00")
        )

        assert result.discount == Decimal("300.00")

    def test_minimum_order_value_is_enforced(self):
        lines = self._lines("500.00")
        coupon = self._coupon(minimum_order_value=Decimal("1000.00"))

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon, lines=lines, subtotal=Decimal("500.00")
            )

    def test_expired_coupons_are_refused(self):
        coupon = self._coupon(ends_at=timezone.now() - timezone.timedelta(days=1))

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon, lines=self._lines(), subtotal=Decimal("1000.00")
            )

    def test_not_yet_active_coupons_are_refused(self):
        coupon = self._coupon(starts_at=timezone.now() + timezone.timedelta(days=1))

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon, lines=self._lines(), subtotal=Decimal("1000.00")
            )

    def test_usage_limit_is_enforced(self):
        coupon = self._coupon(usage_limit=5, used_count=5)

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon, lines=self._lines(), subtotal=Decimal("1000.00")
            )

    def test_inactive_coupons_are_refused(self):
        coupon = self._coupon(is_active=False)

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon, lines=self._lines(), subtotal=Decimal("1000.00")
            )

    def test_channel_restriction(self):
        coupon = self._coupon(channels=["ONLINE"])

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon, lines=self._lines(), subtotal=Decimal("1000.00"), channel="POS"
            )

    def test_category_scope_only_discounts_eligible_lines(self):
        eligible_category = factories.category()
        eligible_product = factories.product(category=eligible_category)
        eligible = factories.variant(eligible_product, price="1000.00")
        ineligible = factories.variant(price="1000.00")

        lines = pricing.price_lines(
            [(eligible, 1, Decimal("0.00")), (ineligible, 1, Decimal("0.00"))]
        )
        coupon = self._coupon(value=Decimal("10.00"))
        coupon.categories.add(eligible_category)

        result = promotion_services.validate_coupon(
            coupon=coupon, lines=lines, subtotal=Decimal("2000.00")
        )

        # 10% of the eligible ৳1,000 only.
        assert result.discount == Decimal("100.00")

    def test_unknown_code_is_refused(self):
        with pytest.raises(CouponInvalid):
            promotion_services.get_coupon("NOPE")

    def test_per_customer_limit(self):
        from orders.models import Channel
        from promotions.models import CouponRedemption

        customer = factories.customer()
        coupon = self._coupon(usage_limit_per_customer=1)
        order = factories.variant()  # placeholder object not used as an order
        del order

        from orders.services import pos as pos_services  # noqa: F401  (keeps imports honest)

        CouponRedemption.objects.create(
            coupon=coupon,
            order=_dummy_order(customer),
            customer=customer,
            discount_amount=Decimal("100.00"),
        )

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon,
                lines=self._lines("2000.00"),
                subtotal=Decimal("2000.00"),
                customer=customer,
                channel=Channel.ONLINE,
            )


def _dummy_order(customer):
    """A minimal saved order, so redemption rows have something to point at."""
    from orders.models import Channel, Order

    branch = factories.branch(factories.organization())
    return Order.objects.create(
        number=f"RGN-TEST-{factories.unique()}",
        channel=Channel.ONLINE,
        branch=branch,
        customer=customer,
        grand_total=Decimal("1000.00"),
    )
