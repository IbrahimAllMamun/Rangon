"""Discounts at the counter: coupons, the whole-sale discount, manager approval.

The register takes the coupons the admin defines, and prices every discount on
the server (docs/business-rules.md §3.3). What the browser sends is a code and
a percentage -- claims -- and every figure here is the service's own.

Prices in this file: every variant is ৳1,000, and VAT is at the shipped 0%.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from freezegun import freeze_time

from accounts.models import RoleCode, Status
from core.exceptions import CouponInvalid, PermissionDenied, PriceChanged, ValidationError
from core.models import AuditLog
from customers.models import Customer
from inventory.models import Inventory
from orders.models import Channel, Order, PaymentMethod
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from promotions.models import Coupon, CouponRedemption, DiscountType
from tests import factories

pytestmark = pytest.mark.django_db


def _coupon(**kwargs) -> Coupon:
    defaults = {
        "code": f"POS{factories.unique()}",
        "discount_type": DiscountType.PERCENTAGE,
        "value": Decimal("10.00"),
        # Unlimited per customer unless a test says otherwise, so an anonymous
        # sale may use it; the limited kind has tests of its own below.
        "usage_limit_per_customer": None,
    }
    return Coupon.objects.create(**{**defaults, **kwargs})


def _data(shop, *, quantity: int = 2, variant=None, **kwargs) -> SaleInput:
    variant = variant or shop["variants"][0]
    return SaleInput(lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)], **kwargs)


def _sell(shop, data: SaleInput, *, actor=None, paid: Decimal | None = None) -> Order:
    """Ring the sale up and pay for it.

    Left to itself this pays what the server prices the sale at, as the
    register does. A test expecting a refusal passes `paid`, so the refusal it
    sees is the sale's and not the pricing call's.
    """
    actor = actor or shop["cashier"]
    if paid is None:
        paid = pos.price_sale(branch=shop["branch"], actor=actor, data=data).priced.grand_total
    data.payments = [PaymentInput(method=PaymentMethod.CASH, amount=paid, tendered_amount=paid)]
    return pos.create_pos_sale(branch=shop["branch"], actor=actor, data=data)


def _on_hand(shop) -> int:
    return Inventory.objects.get(branch=shop["branch"], variant=shop["variants"][0]).on_hand


def _token(shop, *, max_percent="30.00", approver=None, cashier=None) -> str:
    return pos.approval_token(
        approver=approver or shop["manager"],
        requested_by=cashier or shop["cashier"],
        permission=pos.DISCOUNT_OVERRIDE,
        max_percent=Decimal(max_percent) if max_percent is not None else None,
    )


class TestCouponAtTheCounter:
    def test_a_coupon_comes_off_the_sale_and_is_counted(self, shop):
        coupon = _coupon(value=Decimal("10.00"))

        order = _sell(shop, _data(shop, coupon_code=coupon.code))

        assert order.subtotal == Decimal("2000.00")
        assert order.coupon_discount == Decimal("200.00")
        assert order.discount_total == Decimal("200.00")
        assert order.grand_total == Decimal("1800.00")
        assert order.coupon_id == coupon.pk
        coupon.refresh_from_db()
        assert coupon.used_count == 1
        redemption = CouponRedemption.objects.get(coupon=coupon)
        assert redemption.order_id == order.pk
        assert redemption.discount_amount == Decimal("200.00")
        # An anonymous sale: the redemption is nobody's, not the walk-in row's.
        assert redemption.customer_id is None
        assert order.customer.is_walk_in

    def test_the_code_is_read_however_it_was_typed(self, shop):
        coupon = _coupon(code="STORE100", discount_type=DiscountType.FIXED, value=Decimal("100"))

        order = _sell(shop, _data(shop, coupon_code="  store100 "))

        assert order.coupon_id == coupon.pk
        assert order.grand_total == Decimal("1900.00")

    def test_an_online_only_coupon_is_refused_in_store(self, shop):
        coupon = _coupon(channels=[Channel.ONLINE])

        with pytest.raises(CouponInvalid, match="cannot be used in store"):
            _sell(shop, _data(shop, coupon_code=coupon.code), paid=Decimal("2000.00"))

        assert not Order.objects.exists()
        assert _on_hand(shop) == 10

    def test_an_in_store_coupon_is_taken(self, shop):
        coupon = _coupon(channels=[Channel.POS])

        order = _sell(shop, _data(shop, coupon_code=coupon.code))

        assert order.coupon_discount == Decimal("200.00")

    def test_a_free_delivery_coupon_is_refused_at_the_counter(self, shop):
        """There is no delivery line to zero, and spending it would use it up."""
        coupon = _coupon(discount_type=DiscountType.FREE_SHIPPING, value=Decimal("0.00"))

        with pytest.raises(CouponInvalid, match="delivery"):
            _sell(shop, _data(shop, coupon_code=coupon.code), paid=Decimal("2000.00"))

        coupon.refresh_from_db()
        assert coupon.used_count == 0

    def test_an_unknown_code_is_refused(self, shop):
        with pytest.raises(CouponInvalid, match="not recognised"):
            _sell(shop, _data(shop, coupon_code="NO-SUCH-CODE"), paid=Decimal("2000.00"))

    def test_a_coupon_below_its_minimum_is_refused(self, shop):
        coupon = _coupon(minimum_order_value=Decimal("5000.00"))

        with pytest.raises(CouponInvalid, match="minimum"):
            _sell(shop, _data(shop, coupon_code=coupon.code), paid=Decimal("2000.00"))

    def test_only_the_eligible_lines_are_discounted(self, shop):
        coupon = _coupon(value=Decimal("10.00"))
        coupon.categories.add(shop["product"].category)
        elsewhere = factories.variant(factories.product())  # another category
        factories.stock(elsewhere, shop["branch"], 5)

        data = SaleInput(
            lines=[
                SaleLineInput(variant_id=shop["variants"][0].pk, quantity=1),
                SaleLineInput(variant_id=elsewhere.pk, quantity=1),
            ],
            coupon_code=coupon.code,
        )
        order = _sell(shop, data)

        assert order.subtotal == Decimal("2000.00")
        assert order.coupon_discount == Decimal("100.00")

    def test_the_total_usage_limit_holds_at_the_counter(self, shop):
        coupon = _coupon(usage_limit=1)
        _sell(shop, _data(shop, quantity=1, coupon_code=coupon.code))

        with pytest.raises(CouponInvalid, match="usage limit"):
            _sell(shop, _data(shop, quantity=1, coupon_code=coupon.code), paid=Decimal("1000.00"))

        coupon.refresh_from_db()
        assert coupon.used_count == 1
        assert Order.objects.count() == 1

    def test_an_unlimited_coupon_serves_every_anonymous_customer(self, shop):
        coupon = _coupon(usage_limit_per_customer=None)

        for _ in range(2):
            _sell(shop, _data(shop, quantity=1, coupon_code=coupon.code))

        coupon.refresh_from_db()
        assert coupon.used_count == 2

    def test_a_coupon_needs_no_discount_permission_however_large(self, shop):
        """The coupon was authorised when it was made; the cashier gives nothing."""
        coupon = _coupon(value=Decimal("50.00"))

        order = _sell(shop, _data(shop, coupon_code=coupon.code))

        assert order.grand_total == Decimal("1000.00")
        assert not AuditLog.objects.filter(action="DISCOUNT_OVERRIDE").exists()

    def test_voiding_the_sale_gives_the_coupon_use_back(self, shop):
        """A void is how a mis-rung sale is corrected; the re-ring must work."""
        coupon = _coupon(usage_limit_per_customer=1)
        data = _data(shop, coupon_code=coupon.code, customer_id=shop["customer"].pk)
        order = _sell(shop, data)

        pos.void_sale(order=order, actor=shop["manager"], reason="Wrong size rung up")

        coupon.refresh_from_db()
        assert coupon.used_count == 0
        assert CouponRedemption.objects.get(order=order).released_at is not None
        again = _sell(shop, _data(shop, coupon_code=coupon.code, customer_id=shop["customer"].pk))
        assert again.coupon_id == coupon.pk


class TestPerCustomerLimitAtTheCounter:
    """An anonymous sale has no one to count a per-customer limit against.

    The walk-in row is shared by every unnamed sale at the branch: counting
    against it would let the first stranger spend everybody's use, and not
    counting would make the limit meaningless at the counter.
    """

    def test_a_limited_coupon_needs_a_named_customer(self, shop):
        coupon = _coupon(usage_limit_per_customer=1)

        with pytest.raises(CouponInvalid) as refused:
            _sell(shop, _data(shop, coupon_code=coupon.code), paid=Decimal("2000.00"))

        assert refused.value.details["needs_customer"] is True
        assert "once per customer" in refused.value.message
        coupon.refresh_from_db()
        assert coupon.used_count == 0

    def test_the_walk_in_record_is_not_a_named_customer(self, shop):
        coupon = _coupon(usage_limit_per_customer=1)
        walk_in = pos.walk_in_customer(shop["branch"])

        with pytest.raises(CouponInvalid):
            _sell(
                shop,
                _data(shop, coupon_code=coupon.code, customer_id=walk_in.pk),
                paid=Decimal("2000.00"),
            )

    def test_a_named_customer_spends_a_once_each_coupon_once(self, shop):
        coupon = _coupon(usage_limit_per_customer=1)
        customer = shop["customer"]

        first = _sell(
            shop, _data(shop, quantity=1, coupon_code=coupon.code, customer_id=customer.pk)
        )
        with pytest.raises(CouponInvalid, match="already used"):
            _sell(
                shop,
                _data(shop, quantity=1, coupon_code=coupon.code, customer_id=customer.pk),
                paid=Decimal("1000.00"),
            )

        assert CouponRedemption.objects.get(coupon=coupon).customer_id == customer.pk
        assert first.customer_id == customer.pk
        coupon.refresh_from_db()
        assert coupon.used_count == 1

    def test_the_limit_counts_online_uses_too(self, shop):
        """One limit per customer, whichever channel spent it."""
        coupon = _coupon(usage_limit_per_customer=1)
        online = factories.order(shop, customer=shop["customer"], channel=Channel.ONLINE)
        CouponRedemption.objects.create(
            coupon=coupon, order=online, customer=shop["customer"], discount_amount=Decimal("10")
        )

        with pytest.raises(CouponInvalid, match="already used"):
            _sell(
                shop,
                _data(shop, coupon_code=coupon.code, customer_id=shop["customer"].pk),
                paid=Decimal("2000.00"),
            )


class TestTheWholeSaleDiscount:
    def test_a_percentage_is_turned_into_money_by_the_server(self, shop):
        order = _sell(shop, _data(shop, manual_discount_percent=Decimal("10")))

        assert order.manual_discount == Decimal("200.00")
        assert order.grand_total == Decimal("1800.00")

    def test_a_percentage_comes_off_what_is_left_after_the_coupon(self, shop):
        """ "Another 10%" is 10% of what the customer would otherwise pay."""
        coupon = _coupon(value=Decimal("10.00"))

        order = _sell(
            shop, _data(shop, coupon_code=coupon.code, manual_discount_percent=Decimal("10"))
        )

        assert order.coupon_discount == Decimal("200.00")
        assert order.manual_discount == Decimal("180.00")
        assert order.discount_total == Decimal("380.00")
        assert order.grand_total == Decimal("1620.00")

    def test_an_amount_and_a_percentage_together_are_refused(self, shop):
        with pytest.raises(ValidationError, match="not both"):
            _sell(
                shop,
                _data(
                    shop,
                    manual_discount=Decimal("100.00"),
                    manual_discount_percent=Decimal("10"),
                ),
                paid=Decimal("1900.00"),
            )

    def test_a_percentage_above_the_threshold_needs_a_manager(self, shop):
        with pytest.raises(PermissionDenied) as refused:
            _sell(shop, _data(shop, manual_discount_percent=Decimal("30")), paid=Decimal("1400"))

        assert refused.value.details["requires"] == "sales.discount_override"
        assert refused.value.details["discount_percent"] == "30.00"
        # The money too, so the register can say what the percentage is of.
        assert refused.value.details["discount"] == "600.00"
        assert not Order.objects.exists()

    def test_the_cashiers_share_is_measured_without_the_coupon(self, shop):
        """A 50% coupon plus 30% of what is left is 15% of the cashier's giving."""
        coupon = _coupon(value=Decimal("50.00"))

        order = _sell(
            shop, _data(shop, coupon_code=coupon.code, manual_discount_percent=Decimal("30"))
        )

        assert order.coupon_discount == Decimal("1000.00")
        assert order.manual_discount == Decimal("300.00")
        assert order.grand_total == Decimal("700.00")
        assert not AuditLog.objects.filter(action="DISCOUNT_OVERRIDE").exists()


class TestManagerApproval:
    def test_an_approval_lets_the_discount_through_and_is_filed_with_the_sale(self, shop):
        order = _sell(
            shop, _data(shop, manual_discount_percent=Decimal("30"), approval_token=_token(shop))
        )

        assert order.grand_total == Decimal("1400.00")
        entry = AuditLog.objects.get(action="DISCOUNT_OVERRIDE")
        # Against the sale itself now, not an anonymous "POS sale".
        assert entry.entity_id == str(order.pk)
        assert entry.actor == shop["cashier"]
        assert entry.new_values["approved_by"] == shop["manager"].email
        assert entry.new_values["percent"] == "30.00"
        assert entry.new_values["discount"] == "600.00"
        assert entry.branch_id == shop["branch"].pk

    def test_an_approval_covers_no_more_than_the_manager_was_shown(self, shop):
        token = _token(shop, max_percent="25.00")

        with pytest.raises(PermissionDenied, match="up to 25.00%") as refused:
            _sell(
                shop,
                _data(shop, manual_discount_percent=Decimal("30"), approval_token=token),
                paid=Decimal("1400.00"),
            )

        assert refused.value.details["approved_percent"] == "25.00"

    def test_an_approval_expires(self, shop):
        issued = timezone.now()
        with freeze_time(issued):
            token = _token(shop)

        with (
            freeze_time(issued + timedelta(seconds=pos.APPROVAL_MAX_AGE + 1)),
            pytest.raises(PermissionDenied, match="expired"),
        ):
            _sell(
                shop,
                _data(shop, manual_discount_percent=Decimal("30"), approval_token=token),
                paid=Decimal("1400.00"),
            )

    def test_an_approval_belongs_to_the_cashier_who_asked(self, shop):
        colleague = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        token = _token(shop, cashier=colleague)

        with pytest.raises(PermissionDenied, match="something else"):
            _sell(
                shop,
                _data(shop, manual_discount_percent=Decimal("30"), approval_token=token),
                paid=Decimal("1400.00"),
            )

    def test_a_tampered_approval_is_refused(self, shop):
        token = _token(shop)
        forged = token[:-2] + ("AA" if not token.endswith("AA") else "BB")

        with pytest.raises(PermissionDenied, match="not valid"):
            _sell(
                shop,
                _data(shop, manual_discount_percent=Decimal("30"), approval_token=forged),
                paid=Decimal("1400.00"),
            )

    def test_a_manager_of_another_branch_cannot_approve_here(self, shop):
        elsewhere = factories.branch(shop["organization"])
        visiting = factories.user(RoleCode.MANAGER, branch_obj=elsewhere)

        with pytest.raises(PermissionDenied, match="own branch"):
            _sell(
                shop,
                _data(
                    shop,
                    manual_discount_percent=Decimal("30"),
                    approval_token=_token(shop, approver=visiting),
                ),
                paid=Decimal("1400.00"),
            )

    def test_the_owner_may_approve_at_any_branch(self, shop):
        elsewhere = factories.branch(shop["organization"])
        owner = factories.user(RoleCode.OWNER, branch_obj=elsewhere)

        order = _sell(
            shop,
            _data(
                shop,
                manual_discount_percent=Decimal("30"),
                approval_token=_token(shop, approver=owner),
            ),
        )

        assert order.grand_total == Decimal("1400.00")

    def test_a_manager_deactivated_since_approving_approves_nothing(self, shop):
        token = _token(shop)
        # `status` is what the staff screen changes; `save()` derives
        # `is_active` from it.
        shop["manager"].status = Status.INACTIVE
        shop["manager"].save()

        with pytest.raises(PermissionDenied, match="can no longer approve"):
            _sell(
                shop,
                _data(shop, manual_discount_percent=Decimal("30"), approval_token=token),
                paid=Decimal("1400.00"),
            )

    def test_an_approval_is_not_read_when_nothing_needs_approving(self, shop):
        """A stale approval must not block a discount that never needed one."""
        order = _sell(
            shop, _data(shop, manual_discount_percent=Decimal("10"), approval_token="stale")
        )

        assert order.grand_total == Decimal("1800.00")

    def test_elevate_records_the_discount_the_manager_approved(self, shop):
        pos.elevate(
            email=shop["manager"].email,
            password="test-password-123",
            permission=pos.DISCOUNT_OVERRIDE,
            requested_by=shop["cashier"],
            discount_percent=Decimal("30"),
        )

        entry = AuditLog.objects.get(action="PERMISSION_ELEVATION")
        assert entry.new_values["discount_percent"] == "30.00"


class TestTheTotalTheRegisterShowed:
    def test_a_sale_whose_total_moved_is_refused_not_charged(self, shop):
        """The coupon took ৳200 off; the register had shown the undiscounted total."""
        coupon = _coupon()

        with pytest.raises(PriceChanged) as refused:
            _sell(
                shop,
                _data(shop, coupon_code=coupon.code, expected_total=Decimal("2000.00")),
                paid=Decimal("2000.00"),
            )

        assert refused.value.details == {"expected": "2000.00", "actual": "1800.00"}
        assert not Order.objects.exists()

    def test_the_total_that_was_shown_goes_through(self, shop):
        coupon = _coupon()

        order = _sell(shop, _data(shop, coupon_code=coupon.code, expected_total=Decimal("1800")))

        assert order.grand_total == Decimal("1800.00")


class TestTheQuote:
    """`price_sale(strict=False)`: the register's running total."""

    def _quote(self, shop, data: SaleInput):
        return pos.price_sale(branch=shop["branch"], actor=shop["cashier"], data=data, strict=False)

    def test_a_refused_coupon_is_an_issue_beside_figures_without_it(self, shop):
        coupon = _coupon(ends_at=timezone.now() - timedelta(days=1))

        quote = self._quote(shop, _data(shop, coupon_code=coupon.code))

        [issue] = quote.issues
        assert issue["code"] == "COUPON_INVALID"
        assert issue["field"] == "coupon"
        assert "expired" in issue["message"]
        assert quote.coupon is None
        assert quote.priced.coupon_discount == Decimal("0.00")
        assert quote.priced.grand_total == Decimal("2000.00")

    def test_a_discount_needing_approval_is_an_issue_with_the_discount_shown(self, shop):
        quote = self._quote(shop, _data(shop, manual_discount_percent=Decimal("30")))

        [issue] = quote.issues
        assert issue["code"] == "PERMISSION_DENIED"
        assert issue["field"] == "discount"
        assert issue["details"]["requires"] == "sales.discount_override"
        # The cashier sees what the approval is for.
        assert quote.priced.grand_total == Decimal("1400.00")

    def test_the_quote_writes_nothing(self, shop):
        coupon = _coupon()
        before = (Order.objects.count(), AuditLog.objects.count(), Customer.objects.count())

        quote = self._quote(
            shop,
            _data(
                shop,
                coupon_code=coupon.code,
                manual_discount_percent=Decimal("30"),
                approval_token=_token(shop),
            ),
        )

        assert quote.issues == []
        assert quote.override is not None
        # No walk-in row either: an anonymous quote does not need one.
        assert (Order.objects.count(), AuditLog.objects.count(), Customer.objects.count()) == before
        coupon.refresh_from_db()
        assert coupon.used_count == 0
