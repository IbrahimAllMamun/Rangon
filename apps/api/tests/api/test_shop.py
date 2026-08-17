"""Storefront API: the contract the browser depends on."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from inventory import services as inventory_services
from orders.models import Order, PaymentMethod
from tests import factories

pytestmark = pytest.mark.django_db

ADDRESS = {
    "recipient_name": "Ayesha Rahman",
    "phone": "01711000000",
    "line1": "House 12, Road 5",
    "city": "Dhaka",
}


def _add_to_cart(api, variant, quantity=1, token=None):
    headers = {"HTTP_X_CART_TOKEN": token} if token else {}
    return api.post(
        "/api/v1/shop/cart/",
        {"variant": str(variant.pk), "quantity": quantity},
        format="json",
        **headers,
    )


class TestBrowsing:
    def test_product_list_shows_only_published_products(self, api, shop):
        factories.product(published=False, name="Hidden draft")

        response = api.get("/api/v1/shop/products/")

        assert response.status_code == 200
        names = [item["name"] for item in response.data["results"]]
        assert "Hidden draft" not in names

    def test_product_detail_exposes_variants_and_availability(self, api, shop):
        response = api.get(f"/api/v1/shop/products/{shop['product'].slug}/")

        assert response.status_code == 200
        assert len(response.data["variants"]) == 2
        assert response.data["in_stock"] is True
        assert response.data["variants"][0]["available"] > 0

    def test_search_finds_a_product_by_name(self, api, shop):
        product = factories.product(name="Rangon Signature Polo")
        factories.variant(product, price="1500.00")

        response = api.get("/api/v1/shop/products/", {"q": "Signature Polo"})

        assert response.status_code == 200
        assert any("Signature Polo" in item["name"] for item in response.data["results"])

    def test_facets_report_available_filters(self, api, shop):
        response = api.get("/api/v1/shop/facets/")

        assert response.status_code == 200
        assert "brands" in response.data
        assert "price" in response.data

    def test_unknown_product_returns_the_error_envelope(self, api):
        response = api.get("/api/v1/shop/products/nope/")

        assert response.status_code == 404
        assert response.data["error"]["code"] == "NOT_FOUND"


class TestCart:
    def test_adding_an_item_returns_server_computed_totals(self, api, shop):
        response = _add_to_cart(api, shop["variants"][0], 2)

        assert response.status_code == 200
        assert response.data["totals"]["subtotal"] == "2000.00"
        assert response.data["totals"]["item_count"] == 2
        assert response["X-Cart-Token"]

    def test_the_cart_persists_across_requests_via_its_token(self, api, shop):
        first = _add_to_cart(api, shop["variants"][0], 1)
        token = first["X-Cart-Token"]

        second = api.get("/api/v1/shop/cart/", HTTP_X_CART_TOKEN=token)

        assert len(second.data["items"]) == 1

    def test_adding_more_than_available_is_refused(self, api, shop):
        response = _add_to_cart(api, shop["variants"][1], 99)  # only 5 in stock

        assert response.status_code == 409
        assert response.data["error"]["code"] == "INSUFFICIENT_STOCK"

    def test_the_cart_reports_when_stock_disappears_underneath_it(self, api, shop):
        response = _add_to_cart(api, shop["variants"][1], 4)
        token = response["X-Cart-Token"]
        inventory_services.sell(
            branch=shop["branch"], lines=[(shop["variants"][1].pk, 5)], reference_id="pos"
        )

        response = api.get("/api/v1/shop/cart/", HTTP_X_CART_TOKEN=token)

        assert response.data["issues"], "the cart should flag the shortage"
        assert response.data["issues"][0]["code"] == "INSUFFICIENT_STOCK"

    def test_a_coupon_discount_is_computed_by_the_server(self, api, shop):
        from promotions.models import Coupon, DiscountType

        Coupon.objects.create(
            code="SAVE10", discount_type=DiscountType.PERCENTAGE, value=Decimal("10.00")
        )
        token = _add_to_cart(api, shop["variants"][0], 2)["X-Cart-Token"]

        response = api.post(
            "/api/v1/shop/cart/coupon/",
            {"code": "SAVE10"},
            format="json",
            HTTP_X_CART_TOKEN=token,
        )

        assert response.status_code == 200
        assert response.data["totals"]["coupon_discount"] == "200.00"
        assert response.data["totals"]["grand_total"] == "1800.00"

    def test_an_invalid_coupon_is_refused_with_a_reason(self, api, shop):
        token = _add_to_cart(api, shop["variants"][0], 1)["X-Cart-Token"]

        response = api.post(
            "/api/v1/shop/cart/coupon/",
            {"code": "NOPE"},
            format="json",
            HTTP_X_CART_TOKEN=token,
        )

        assert response.status_code == 422
        assert response.data["error"]["code"] == "COUPON_INVALID"


class TestCheckout:
    def _checkout(self, api, token, **overrides):
        payload = {
            "shipping_address": ADDRESS,
            "payment_method": PaymentMethod.COD,
            "contact_name": "Ayesha Rahman",
            "contact_phone": "01711000000",
            **overrides,
        }
        return api.post(
            "/api/v1/shop/checkout/",
            payload,
            format="json",
            HTTP_X_CART_TOKEN=token,
            HTTP_IDEMPOTENCY_KEY=overrides.pop("key", str(uuid.uuid4())),
        )

    def test_guest_checkout_with_cash_on_delivery(self, api, shop):
        token = _add_to_cart(api, shop["variants"][0], 2)["X-Cart-Token"]

        response = self._checkout(api, token)

        assert response.status_code == 201, response.data
        order = Order.objects.get(number=response.data["order"]["number"])
        assert order.status == "CONFIRMED"
        assert order.payment_status == "UNPAID"  # COD is captured on remittance
        assert order.grand_total == Decimal("2000.00")
        assert response.data["tracking_token"]

    def test_checkout_without_an_idempotency_key_is_refused(self, api, shop):
        token = _add_to_cart(api, shop["variants"][0], 1)["X-Cart-Token"]

        response = api.post(
            "/api/v1/shop/checkout/",
            {"shipping_address": ADDRESS, "payment_method": PaymentMethod.COD},
            format="json",
            HTTP_X_CART_TOKEN=token,
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_repeating_a_checkout_returns_the_same_order(self, api, shop):
        token = _add_to_cart(api, shop["variants"][0], 1)["X-Cart-Token"]
        key = str(uuid.uuid4())

        first = api.post(
            "/api/v1/shop/checkout/",
            {"shipping_address": ADDRESS, "payment_method": PaymentMethod.COD},
            format="json",
            HTTP_X_CART_TOKEN=token,
            HTTP_IDEMPOTENCY_KEY=key,
        )
        second = api.post(
            "/api/v1/shop/checkout/",
            {"shipping_address": ADDRESS, "payment_method": PaymentMethod.COD},
            format="json",
            HTTP_X_CART_TOKEN=token,
            HTTP_IDEMPOTENCY_KEY=key,
        )

        assert first.data["order"]["number"] == second.data["order"]["number"]
        assert Order.objects.count() == 1

    def test_an_incomplete_address_is_refused(self, api, shop):
        token = _add_to_cart(api, shop["variants"][0], 1)["X-Cart-Token"]

        response = self._checkout(api, token, shipping_address={"city": "Dhaka"})

        assert response.status_code == 400
        assert "recipient_name" in str(response.data["error"]["details"])

    def test_an_empty_cart_cannot_check_out(self, api, shop):
        response = self._checkout(api, "brand-new-token")

        assert response.status_code == 400

    def test_guest_can_track_the_order_with_its_token(self, api, shop):
        token = _add_to_cart(api, shop["variants"][0], 1)["X-Cart-Token"]
        checkout = self._checkout(api, token)
        number = checkout.data["order"]["number"]
        tracking = checkout.data["tracking_token"]

        allowed = api.get(f"/api/v1/shop/orders/{number}/", {"token": tracking})
        refused = api.get(f"/api/v1/shop/orders/{number}/")

        assert allowed.status_code == 200
        assert refused.status_code == 404  # the number alone is not enough


class TestReviews:
    def test_a_review_requires_a_delivered_purchase(self, auth_client, shop):
        customer_user = factories.user("CUSTOMER")
        shop["customer"].user = customer_user
        shop["customer"].save()

        response = auth_client(customer_user).post(
            f"/api/v1/shop/products/{shop['product'].slug}/reviews/",
            {"rating": 5, "comment": "Great"},
            format="json",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_an_approved_review_appears_on_the_product(self, api, shop):
        from engagement.models import Review, ReviewStatus

        Review.objects.create(
            product=shop["product"],
            customer=shop["customer"],
            rating=5,
            title="Excellent",
            comment="Fits perfectly.",
            verified_purchase=True,
            status=ReviewStatus.APPROVED,
        )

        response = api.get(f"/api/v1/shop/products/{shop['product'].slug}/")

        assert response.data["reviews"]["count"] == 1
        assert response.data["reviews"]["average"] == 5.0

    def test_a_pending_review_is_not_visible(self, api, shop):
        from engagement.models import Review, ReviewStatus

        Review.objects.create(
            product=shop["product"],
            customer=shop["customer"],
            rating=1,
            comment="Waiting for moderation",
            status=ReviewStatus.PENDING,
        )

        response = api.get(f"/api/v1/shop/products/{shop['product'].slug}/")

        assert response.data["reviews"]["count"] == 0


class TestHealth:
    def test_liveness(self, api):
        response = api.get("/api/health/")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_readiness_checks_dependencies(self, api):
        response = api.get("/api/ready/")
        assert response.status_code == 200
        assert response.json()["checks"]["database"] is True
