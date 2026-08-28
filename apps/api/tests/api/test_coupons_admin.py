"""The coupon endpoints as the admin screen uses them.

Coupons had an engine, unit tests for the maths, and no API tests at all. What
the screen needs is the part that was unexamined: who may manage a coupon, what
the form is allowed to submit, and whether an *edit* is held to the same rules
as a create.

The maths itself lives in tests/unit/test_pricing.py and is not repeated here.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.utils import timezone

from accounts.permissions import RoleCode
from orders.models import Channel, Order
from promotions.models import Coupon, DiscountType
from tests import factories

pytestmark = pytest.mark.django_db


def _payload(**overrides) -> dict:
    return {
        "code": "SUMMER25",
        "discount_type": DiscountType.PERCENTAGE,
        "value": "25.00",
        **overrides,
    }


def _coupon(**kwargs) -> Coupon:
    defaults = {
        "code": f"TEST{factories.unique()}",
        "discount_type": DiscountType.PERCENTAGE,
        "value": Decimal("10.00"),
    }
    return Coupon.objects.create(**{**defaults, **kwargs})


class TestWhoMayManageCoupons:
    def test_a_manager_can_create_one(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post("/api/v1/coupons/", _payload(), format="json")

        assert response.status_code == 201, response.data
        assert response.data["code"] == "SUMMER25"

    def test_the_code_is_normalised_to_upper_case(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/", _payload(code="  spring-10 "), format="json"
        )

        assert response.status_code == 201, response.data
        assert response.data["code"] == "SPRING-10"

    def test_a_cashier_cannot_manage_coupons(self, shop, auth_client) -> None:
        """A discount a cashier may give is a line discount, not a coupon."""
        response = auth_client(shop["cashier"]).post("/api/v1/coupons/", _payload(), format="json")

        assert response.status_code == 403
        assert not Coupon.objects.filter(code="SUMMER25").exists()

    def test_an_accountant_cannot_manage_coupons(self, shop, auth_client) -> None:
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])

        response = auth_client(accountant).get("/api/v1/coupons/")

        assert response.status_code == 403

    def test_duplicate_codes_are_refused(self, shop, auth_client) -> None:
        _coupon(code="SUMMER25")

        response = auth_client(shop["manager"]).post("/api/v1/coupons/", _payload(), format="json")

        assert response.status_code == 400


class TestTheActiveWindow:
    """`ends_at` after `starts_at` — on an edit as well as a create.

    A window the wrong way round can never be satisfied by
    `promotions.services.active_coupons`, so the coupon silently never applies.
    """

    def test_an_inverted_window_is_refused_on_create(self, shop, auth_client) -> None:
        now = timezone.now()
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/",
            _payload(
                starts_at=(now + timezone.timedelta(days=5)).isoformat(),
                ends_at=now.isoformat(),
            ),
            format="json",
        )

        assert response.status_code == 400

    def test_an_edit_cannot_invert_the_window(self, shop, auth_client) -> None:
        """The half-payload case: only `ends_at` is sent, so only the stored
        `starts_at` makes it invalid."""
        now = timezone.now()
        coupon = _coupon(
            starts_at=now + timezone.timedelta(days=5),
            ends_at=now + timezone.timedelta(days=10),
        )

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/coupons/{coupon.pk}/",
            {"ends_at": now.isoformat()},
            format="json",
        )

        assert response.status_code == 400
        coupon.refresh_from_db()
        assert coupon.ends_at > coupon.starts_at

    def test_an_edit_may_extend_the_window(self, shop, auth_client) -> None:
        now = timezone.now()
        coupon = _coupon(starts_at=now, ends_at=now + timezone.timedelta(days=1))
        extended = now + timezone.timedelta(days=30)

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/coupons/{coupon.pk}/", {"ends_at": extended.isoformat()}, format="json"
        )

        assert response.status_code == 200, response.data


class TestPercentageBounds:
    def test_over_100_percent_is_refused_on_create(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/", _payload(value="150.00"), format="json"
        )

        assert response.status_code == 400

    def test_an_edit_cannot_push_a_percentage_over_100(self, shop, auth_client) -> None:
        """Only `value` is sent, so the stored `discount_type` makes it invalid.

        The database `CheckConstraint` refuses this either way — the point is
        that it comes back as a validation error the form can render against a
        field, not as an unhandled integrity error.
        """
        coupon = _coupon(discount_type=DiscountType.PERCENTAGE, value=Decimal("10.00"))

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/coupons/{coupon.pk}/", {"value": "150.00"}, format="json"
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        coupon.refresh_from_db()
        assert coupon.value == Decimal("10.00")

    def test_a_fixed_amount_over_100_is_fine(self, shop, auth_client) -> None:
        """৳150 off is ordinary; 150% off is not."""
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/",
            _payload(discount_type=DiscountType.FIXED, value="150.00"),
            format="json",
        )

        assert response.status_code == 201, response.data

    def test_a_zero_or_negative_value_is_refused(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/", _payload(value="0.00"), format="json"
        )

        assert response.status_code == 400


class TestFreeShipping:
    """A free-shipping coupon carries no amount.

    `validate_coupon` sets its discount to zero and the checkout zeroes the
    shipping line instead, so `value` means nothing here. The form must not have
    to invent a number to satisfy a constraint.
    """

    def test_free_shipping_needs_no_value(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/",
            {"code": "FREESHIP", "discount_type": DiscountType.FREE_SHIPPING},
            format="json",
        )

        assert response.status_code == 201, response.data
        coupon = Coupon.objects.get(code="FREESHIP")
        assert coupon.value == Decimal("0.00")

    def test_an_amount_coupon_still_needs_a_value(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/",
            {"code": "NOVALUE", "discount_type": DiscountType.FIXED},
            format="json",
        )

        assert response.status_code == 400


class TestDeletion:
    def test_an_unused_coupon_is_deleted(self, shop, auth_client) -> None:
        coupon = _coupon()

        response = auth_client(shop["manager"]).delete(f"/api/v1/coupons/{coupon.pk}/")

        assert response.status_code == 204
        assert not Coupon.objects.filter(pk=coupon.pk).exists()

    def test_a_redeemed_coupon_is_deactivated_not_deleted(self, shop, auth_client) -> None:
        """Its redemptions are part of order history (CLAUDE.md §3.3)."""
        coupon = _coupon()
        order = Order.objects.create(
            number=f"RGN-TEST-{factories.unique()}",
            channel=Channel.ONLINE,
            branch=shop["branch"],
            customer=factories.customer(),
        )
        coupon.redemptions.create(order=order, discount_amount=Decimal("10.00"))

        response = auth_client(shop["manager"]).delete(f"/api/v1/coupons/{coupon.pk}/")

        assert response.status_code == 204
        coupon.refresh_from_db()
        assert coupon.is_active is False
