"""A refund gives back what was paid, and a whole-sale discount was never paid.

A coupon or a cashier's discount is frozen on the order, not on its lines.  The
refund used to be worked out from `OrderItem.line_total`, which carries only the
line's own discount -- so one of two ৳1,000 items bought with 10% off the sale
came back for ৳1,000, a hundred more than the customer had handed over for it.

Prices in this file: every item sells at ৳1,000 unless a test says otherwise,
and every discount stays at 10% so no sale needs a manager.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from accounts.models import TaxMode
from orders.models import Order, PaymentMethod, RestockDecision, ReturnStatus
from orders.services import pos
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from promotions.models import Coupon, DiscountType
from tests import factories

pytestmark = pytest.mark.django_db


def _set_tax(shop, mode: str, rate: str) -> None:
    org = shop["organization"]
    org.tax_mode = mode
    org.default_tax_rate = Decimal(rate)
    org.save(update_fields=["tax_mode", "default_tax_rate"])


def _sell(
    shop,
    *,
    prices: tuple[str, ...] = ("1000.00",),
    quantity: int = 1,
    line_discount: str = "0.00",
    **sale,
) -> Order:
    """Sell one freshly received variant per price, paid at the server's total."""
    lines = []
    for price in prices:
        variant = factories.variant(shop["product"], price=Decimal(price))
        factories.stock(variant, shop["branch"], quantity)
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


def _request(shop, order: Order, *, quantity: int = 1, items=None):
    """Ask for `quantity` of each of `items` back -- every line unless told."""
    items = items if items is not None else list(order.items.all())
    return return_services.request_return(
        order=order,
        lines=[(item.pk, quantity) for item in items],
        reason="WRONG_SIZE",
        actor=shop["manager"],
        restock_decisions={str(item.pk): RestockDecision.RESTOCK for item in items},
    )


def _complete(shop, request):
    return_services.approve(return_request=request, actor=shop["manager"])
    return_services.receive(return_request=request, actor=shop["manager"])
    return_services.complete(return_request=request, actor=shop["manager"])
    request.refresh_from_db()
    assert request.status == ReturnStatus.COMPLETED
    return request


class TestAPartialReturn:
    def test_a_whole_sale_discount_is_not_refunded(self, shop):
        order = _sell(shop, quantity=2, manual_discount_percent=Decimal("10"))
        assert order.paid_total == Decimal("1800.00")

        request = _request(shop, order, quantity=1)

        # Half the goods, so half of what was paid for them -- not 1,000.
        assert request.refund_amount == Decimal("900.00")
        assert request.items.get().refund_amount == Decimal("900.00")

    def test_a_coupon_is_not_refunded(self, shop):
        coupon = Coupon.objects.create(
            code=f"RET{factories.unique()}",
            discount_type=DiscountType.PERCENTAGE,
            value=Decimal("10.00"),
            usage_limit_per_customer=None,
        )
        order = _sell(shop, quantity=2, coupon_code=coupon.code)
        assert order.coupon_discount == Decimal("200.00")

        request = _request(shop, order, quantity=1)

        assert request.refund_amount == Decimal("900.00")

    def test_a_line_discount_is_still_counted_once(self, shop):
        """Already inside `line_total`, so it must not come off a second time."""
        order = _sell(shop, quantity=2, line_discount="200.00")
        assert order.discount_total == Decimal("0.00")
        assert order.paid_total == Decimal("1800.00")

        request = _request(shop, order, quantity=1)

        assert request.refund_amount == Decimal("900.00")

    def test_each_line_gives_back_its_own_share(self, shop):
        order = _sell(shop, prices=("1000.00", "500.00"), manual_discount_percent=Decimal("10"))
        dear, cheap = order.items.order_by("-unit_price")

        assert _request(shop, order, items=[cheap]).refund_amount == Decimal("450.00")
        assert _request(shop, order, items=[dear]).refund_amount == Decimal("900.00")

    def test_what_is_left_after_the_return_is_what_the_kept_goods_cost(self, shop):
        order = _sell(shop, quantity=2, manual_discount_percent=Decimal("10"))

        _complete(shop, _request(shop, order, quantity=1))

        order.refresh_from_db()
        assert order.paid_total - order.refunded_total == Decimal("900.00")


class TestWithVat:
    def test_exclusive_refunds_the_discounted_price_and_the_tax_on_it(self, shop):
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        order = _sell(shop, quantity=2, manual_discount_percent=Decimal("10"))
        # 1,800 of goods and 270 of VAT.
        assert order.paid_total == Decimal("2070.00")

        request = _request(shop, order, quantity=1)

        assert request.refund_amount == Decimal("1035.00")

    def test_inclusive_refunds_the_discounted_price_with_the_tax_inside_it(self, shop):
        _set_tax(shop, TaxMode.INCLUSIVE, "0.1500")
        order = _sell(shop, prices=("1150.00",), quantity=2, manual_discount_percent=Decimal("10"))
        assert order.paid_total == Decimal("2070.00")

        request = _request(shop, order, quantity=1)

        assert request.refund_amount == Decimal("1035.00")

    def test_two_lines_under_exclusive_each_carry_their_own_tax(self, shop):
        """The tax on a line is 15% of what that line came to after the discount."""
        _set_tax(shop, TaxMode.EXCLUSIVE, "0.1500")
        order = _sell(shop, prices=("1000.00", "500.00"), manual_discount_percent=Decimal("10"))
        dear, cheap = order.items.order_by("-unit_price")
        assert order.paid_total == Decimal("1552.50")

        # 900 + 135 and 450 + 67.50.
        assert _request(shop, order, items=[dear]).refund_amount == Decimal("1035.00")
        assert _request(shop, order, items=[cheap]).refund_amount == Decimal("517.50")


class TestAFullReturn:
    def test_everything_back_refunds_exactly_what_was_paid(self, shop):
        order = _sell(shop, prices=("1000.00", "500.00"), manual_discount_percent=Decimal("10"))

        request = _request(shop, order)

        assert request.refund_amount == order.paid_total == Decimal("1350.00")

    def test_the_shares_of_a_discount_that_does_not_divide_still_add_up(self, shop):
        """20.00 across three equal lines is 6.67 each, short by 0.01 if every
        line is rounded on its own: 279.99 back on a 280.00 sale.
        """
        order = _sell(shop, prices=("100.00", "100.00", "100.00"), manual_discount=Decimal("20.00"))
        assert order.paid_total == Decimal("280.00")

        request = _request(shop, order)

        assert request.refund_amount == Decimal("280.00")
        assert sum(item.refund_amount for item in request.items.all()) == Decimal("280.00")

    def test_a_refund_never_exceeds_what_is_left_of_the_payment(self, shop):
        """10.00 across three lines is 3.33 each, so one line alone is 96.67 and
        three of those would be 290.01.  The last one is held to what remains.
        """
        order = _sell(shop, prices=("100.00", "100.00", "100.00"), manual_discount=Decimal("10.00"))
        first, second, third = order.items.all()

        _complete(shop, _request(shop, order, items=[first]))
        _complete(shop, _request(shop, order, items=[second]))
        last = _complete(shop, _request(shop, order, items=[third]))

        order.refresh_from_db()
        assert last.refund_amount == Decimal("96.66")
        assert order.refunded_total == order.paid_total == Decimal("290.00")
