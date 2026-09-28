"""The register's discount endpoints: `POST /pos/quote/`, and what a sale sends.

The service rules are in tests/test_pos_discounts.py. These are the HTTP
contract the register is written against: the quote's shape, that it writes
nothing, and that a total the register showed is the total the sale records.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from accounts.models import RoleCode
from core.models import AuditLog
from orders.models import Order, PaymentMethod
from promotions.models import Coupon, DiscountType
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def cashier_client(auth_client, shop):
    return auth_client(shop["cashier"])


@pytest.fixture
def coupon() -> Coupon:
    return Coupon.objects.create(
        code="STORE10",
        description="10% off in store",
        discount_type=DiscountType.PERCENTAGE,
        value=Decimal("10.00"),
        usage_limit_per_customer=None,
    )


def _basket(shop, **extra) -> dict:
    return {"lines": [{"variant": str(shop["variants"][0].pk), "quantity": 2}], **extra}


def _pay(amount: str) -> list[dict]:
    return [{"method": PaymentMethod.CASH, "amount": amount, "tendered_amount": amount}]


class TestTheQuote:
    def test_the_register_is_shown_the_servers_figures(self, cashier_client, shop, coupon):
        response = cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, coupon_code="store10"), format="json"
        )

        assert response.status_code == 200, response.data
        body = response.data
        assert body["subtotal"] == "2000.00"
        assert body["coupon"] == {"code": "STORE10", "description": "10% off in store"}
        assert body["coupon_discount"] == "200.00"
        assert body["manual_discount"] == "0.00"
        assert body["discount_total"] == "200.00"
        assert body["tax_total"] == "0.00"
        assert body["grand_total"] == "1800.00"
        assert body["item_count"] == 2
        assert body["issues"] == []
        assert body["lines"][0]["line_total"] == "2000.00"

    def test_a_refused_coupon_comes_back_as_an_issue(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, coupon_code="NOPE"), format="json"
        )

        assert response.status_code == 200
        [issue] = response.data["issues"]
        assert issue["code"] == "COUPON_INVALID"
        assert issue["field"] == "coupon"
        assert response.data["coupon"] is None
        assert response.data["grand_total"] == "2000.00"

    def test_a_discount_that_needs_a_manager_is_an_issue(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, manual_discount_percent="30"), format="json"
        )

        assert response.status_code == 200
        [issue] = response.data["issues"]
        assert issue["field"] == "discount"
        assert issue["details"]["requires"] == "sales.discount_override"
        assert issue["details"]["discount_percent"] == "30.00"
        assert issue["details"]["discount"] == "600.00"
        assert response.data["grand_total"] == "1400.00"

    def test_an_amount_and_a_percentage_is_a_field_error(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/quote/",
            _basket(shop, manual_discount="100.00", manual_discount_percent="10"),
            format="json",
        )

        assert response.status_code == 400
        assert "manual_discount_percent" in response.data["error"]["details"]

    def test_a_percentage_over_100_is_a_field_error(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, manual_discount_percent="120"), format="json"
        )

        assert response.status_code == 400
        assert "manual_discount_percent" in response.data["error"]["details"]

    def test_a_discount_larger_than_the_sale_is_a_400(self, cashier_client, shop):
        """Nothing sensible can be shown for it, so it is not an issue but an error."""
        response = cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, manual_discount="5000.00"), format="json"
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_a_quote_writes_nothing(self, cashier_client, shop, coupon):
        before = (Order.objects.count(), AuditLog.objects.count())

        cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, coupon_code=coupon.code), format="json"
        )

        assert (Order.objects.count(), AuditLog.objects.count()) == before
        coupon.refresh_from_db()
        assert coupon.used_count == 0

    def test_it_needs_the_right_to_sell(self, auth_client, shop):
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])

        response = auth_client(accountant).post("/api/v1/pos/quote/", _basket(shop), format="json")

        assert response.status_code == 403

    def test_it_cannot_be_reached_anonymously(self, api, shop):
        assert api.post("/api/v1/pos/quote/", _basket(shop), format="json").status_code == 401


class TestASaleWithADiscount:
    def test_the_quoted_total_is_the_total_the_sale_records(self, cashier_client, shop, coupon):
        quote = cashier_client.post(
            "/api/v1/pos/quote/", _basket(shop, coupon_code=coupon.code), format="json"
        ).data

        response = cashier_client.post(
            "/api/v1/pos/sales/",
            _basket(
                shop,
                coupon_code=coupon.code,
                expected_total=quote["grand_total"],
                payments=_pay(quote["grand_total"]),
            ),
            format="json",
            HTTP_IDEMPOTENCY_KEY="pos-coupon-1",
        )

        assert response.status_code == 201, response.data
        assert response.data["grand_total"] == quote["grand_total"]
        # What the receipt prints.
        assert response.data["coupon_code"] == "STORE10"
        assert response.data["coupon_discount"] == "200.00"

    def test_a_total_that_moved_is_a_409(self, cashier_client, shop, coupon):
        response = cashier_client.post(
            "/api/v1/pos/sales/",
            _basket(
                shop, coupon_code=coupon.code, expected_total="2000.00", payments=_pay("2000.00")
            ),
            format="json",
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "PRICE_CHANGED"
        assert response.data["error"]["details"]["actual"] == "1800.00"
        assert not Order.objects.exists()

    def test_a_refused_coupon_refuses_the_sale(self, cashier_client, shop):
        """A quote reports it; a sale must not quietly drop it and charge more."""
        response = cashier_client.post(
            "/api/v1/pos/sales/",
            _basket(shop, coupon_code="NOPE", payments=_pay("2000.00")),
            format="json",
        )

        assert response.status_code == 422
        assert response.data["error"]["code"] == "COUPON_INVALID"
        assert not Order.objects.exists()

    def test_a_percentage_discount_is_priced_by_the_server(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/sales/",
            _basket(shop, manual_discount_percent="10", payments=_pay("1800.00")),
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["manual_discount"] == "200.00"
        assert response.data["grand_total"] == "1800.00"


class TestManagerApprovalAtTheRegister:
    def _approve(self, cashier_client, shop, percent: str | None = "30.00"):
        body = {
            "email": shop["manager"].email,
            "password": "test-password-123",
            "permission": "sales.discount_override",
        }
        if percent is not None:
            body["discount_percent"] = percent
        return cashier_client.post("/api/v1/pos/elevate/", body, format="json")

    def test_the_approval_from_elevate_is_what_the_sale_accepts(self, cashier_client, shop):
        approval = self._approve(cashier_client, shop)

        assert approval.status_code == 200, approval.data
        assert approval.data["expires_in"] == 300
        token = approval.data["approval_token"]

        quote = cashier_client.post(
            "/api/v1/pos/quote/",
            _basket(shop, manual_discount_percent="30", approval_token=token),
            format="json",
        ).data
        assert quote["issues"] == []

        response = cashier_client.post(
            "/api/v1/pos/sales/",
            _basket(
                shop,
                manual_discount_percent="30",
                approval_token=token,
                expected_total=quote["grand_total"],
                payments=_pay(quote["grand_total"]),
            ),
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["grand_total"] == "1400.00"
        entry = AuditLog.objects.get(action="DISCOUNT_OVERRIDE")
        assert entry.entity_id == response.data["id"]

    def test_approving_a_discount_must_say_how_much(self, cashier_client, shop):
        response = self._approve(cashier_client, shop, percent=None)

        assert response.status_code == 400
        assert "discount_percent" in response.data["error"]["details"]

    def test_without_the_approval_the_sale_is_refused(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/sales/",
            _basket(shop, manual_discount_percent="30", payments=_pay("1400.00")),
            format="json",
        )

        assert response.status_code == 403
        assert response.data["error"]["details"]["requires"] == "sales.discount_override"
        assert not Order.objects.exists()

    def test_the_password_never_reaches_the_audit_log(self, cashier_client, shop):
        self._approve(cashier_client, shop)

        entry = AuditLog.objects.get(action="PERMISSION_ELEVATION")
        assert "test-password-123" not in str(entry.new_values)
