"""An error tells the caller what went wrong for them, never how the server works.

`security.md` claims no stack traces, SQL or settings in responses. The handler
(`core.handlers`) holds to it -- the two controls at the bottom. One path went
around it, found by grepping for `str(exc)` on 2026-09-24: `price_cart`
re-validates the cart's coupon on every read and caught *every* exception,
putting `str(exc)` into the cart's `issues`. A refusal (`BusinessError`) is
written for the shopper. Anything else -- a database error, a bug -- is written
for a developer, and a database error's text carries the SQL.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from django.db import ProgrammingError
from django.utils import timezone

from promotions import services as promotion_services
from promotions.models import Coupon, DiscountType

pytestmark = pytest.mark.django_db

INTERNALS = 'relation "promotions_coupon" does not exist\nLINE 1: SELECT "promotions_coupon"."id"'


def _cart_with_coupon(api: Any, shop: dict[str, Any]) -> tuple[str, Coupon]:
    coupon = Coupon.objects.create(
        code="SAVE10", discount_type=DiscountType.PERCENTAGE, value=Decimal("10.00")
    )
    token = api.post(
        "/api/v1/shop/cart/",
        {"variant": str(shop["variants"][0].pk), "quantity": 1},
        format="json",
    )["X-Cart-Token"]
    applied = api.post(
        "/api/v1/shop/cart/coupon/", {"code": "SAVE10"}, format="json", HTTP_X_CART_TOKEN=token
    )
    assert applied.status_code == 200, applied.data
    return token, coupon


class TestCouponRevalidation:
    def test_an_unexpected_failure_is_not_echoed_to_the_shopper(
        self, api: Any, shop: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Fails on `main`: the cart's `issues` carried the SQL."""
        token, _ = _cart_with_coupon(api, shop)

        def broken(**kwargs: Any) -> None:
            raise ProgrammingError(INTERNALS)

        monkeypatch.setattr(promotion_services, "validate_coupon", broken)
        response = api.get("/api/v1/shop/cart/", HTTP_X_CART_TOKEN=token)

        assert response.status_code == 200
        body = response.content.decode()
        assert "SELECT" not in body
        assert "promotions_coupon" not in body
        [issue] = [row for row in response.data["issues"] if row["code"] == "COUPON_INVALID"]
        assert issue["message"] == "This coupon could not be applied, so it has been removed."

    def test_a_refusal_still_tells_the_shopper_why(self, api: Any, shop: dict[str, Any]) -> None:
        """The control: a coupon that expired after it was applied says so."""
        token, coupon = _cart_with_coupon(api, shop)
        coupon.ends_at = timezone.now() - timezone.timedelta(minutes=1)
        coupon.save(update_fields=["ends_at"])

        response = api.get("/api/v1/shop/cart/", HTTP_X_CART_TOKEN=token)

        [issue] = [row for row in response.data["issues"] if row["code"] == "COUPON_INVALID"]
        assert issue["message"] == "This coupon has expired."


class TestTheHandler:
    """The controls: what `core.handlers` already guaranteed, kept guaranteed."""

    def test_an_unhandled_exception_is_a_bare_500(
        self, auth_client: Any, shop: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from catalog.api import views as catalog_views

        def broken(*args: Any, **kwargs: Any) -> None:
            raise RuntimeError(f"secret-key=abc123 {INTERNALS}")

        monkeypatch.setattr(catalog_views.ProductViewSet, "list", broken)
        response = auth_client(shop["owner"]).get("/api/v1/products/")

        assert response.status_code == 500
        body = response.content.decode()
        assert "abc123" not in body
        assert "SELECT" not in body
        assert "Traceback" not in body
        assert response.data["error"]["code"] == "SERVER_ERROR"
        assert response.data["error"]["request_id"]

    def test_a_database_constraint_is_a_bare_409(
        self, auth_client: Any, shop: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from django.db import IntegrityError

        from catalog.api import views as catalog_views

        def broken(*args: Any, **kwargs: Any) -> None:
            raise IntegrityError('duplicate key value violates unique constraint "catalog_sku"')

        monkeypatch.setattr(catalog_views.ProductViewSet, "list", broken)
        response = auth_client(shop["owner"]).get("/api/v1/products/")

        assert response.status_code == 409
        assert "catalog_sku" not in response.content.decode()
