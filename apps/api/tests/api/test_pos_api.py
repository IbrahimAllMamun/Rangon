"""POS HTTP surface.

The service layer was well covered, but nothing exercised the POS *endpoints*.
That gap let two real bugs reach a running register: holds rejected with
"branch: This field is required", and every sale 500ing because the frontend
proxy dropped the trailing slash Django requires.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from orders.models import HeldSale, Order, PaymentMethod

pytestmark = pytest.mark.django_db


@pytest.fixture
def cashier_client(auth_client, shop):
    return auth_client(shop["cashier"])


class TestPosSession:
    def test_session_returns_branch_cashier_and_permissions(self, cashier_client, shop):
        response = cashier_client.get("/api/v1/pos/session/")

        assert response.status_code == 200
        assert response.data["branch"]["code"] == shop["branch"].code
        assert "sales.create" in response.data["cashier"]["permissions"]


class TestPosLookup:
    def test_barcode_lookup_returns_the_variant_with_stock(self, cashier_client, shop):
        variant = shop["variants"][0]

        response = cashier_client.get(f"/api/v1/pos/lookup/?code={variant.barcode}")

        assert response.status_code == 200
        assert response.data["sku"] == variant.sku
        assert response.data["stock"]["available"] == 10

    def test_unknown_code_is_a_clean_404(self, cashier_client):
        response = cashier_client.get("/api/v1/pos/lookup/?code=NOT-A-REAL-CODE")

        assert response.status_code == 404
        assert response.data["error"]["code"] == "NOT_FOUND"


class TestPosSaleEndpoint:
    def _payload(self, shop, quantity=1):
        variant = shop["variants"][0]
        total = variant.price * quantity
        return {
            "lines": [{"variant": str(variant.pk), "quantity": quantity}],
            "payments": [
                {"method": PaymentMethod.CASH, "amount": str(total), "tendered_amount": str(total)}
            ],
            "register": "REG-01",
        }

    def test_a_cashier_can_complete_a_sale(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/sales/",
            self._payload(shop),
            format="json",
            HTTP_IDEMPOTENCY_KEY="pos-api-1",
        )

        assert response.status_code == 201, response.data
        assert response.data["status"] == "DELIVERED"
        # Regression: the service used to return a stale order that still read
        # UNPAID, so the receipt printed the wrong payment status.
        assert response.data["payment_status"] == "PAID"
        assert Decimal(response.data["grand_total"]) == shop["variants"][0].price

    def test_the_same_idempotency_key_does_not_sell_twice(self, cashier_client, shop):
        for _ in range(2):
            response = cashier_client.post(
                "/api/v1/pos/sales/",
                self._payload(shop),
                format="json",
                HTTP_IDEMPOTENCY_KEY="pos-api-repeat",
            )
            assert response.status_code == 201

        assert Order.objects.count() == 1

    def test_short_payment_is_refused(self, cashier_client, shop):
        payload = self._payload(shop)
        payload["payments"][0]["amount"] = "1.00"

        response = cashier_client.post("/api/v1/pos/sales/", payload, format="json")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_selling_more_than_stock_is_refused(self, cashier_client, shop):
        response = cashier_client.post(
            "/api/v1/pos/sales/", self._payload(shop, quantity=99), format="json"
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "INSUFFICIENT_STOCK"


class TestHeldSales:
    def test_a_hold_does_not_require_the_client_to_send_a_branch(self, cashier_client, shop):
        """Regression: `branch` was writable and therefore required, so every
        hold failed validation before the view could set it."""
        response = cashier_client.post(
            "/api/v1/pos/holds/",
            {"label": "Mrs Rahman", "register": "REG-01", "payload": {"lines": []}},
            format="json",
        )

        assert response.status_code == 201, response.data
        hold = HeldSale.objects.get()
        # The branch comes from the cashier's session, not the request body.
        assert hold.branch_id == shop["branch"].pk

    def test_a_client_cannot_park_a_sale_against_another_branch(self, cashier_client, shop):
        """Asking for someone else's branch is refused outright, not ignored.

        The serializer treats `branch` as read-only, but the view still resolves
        the requested branch through accounts.services.resolve_branch, which
        refuses a branch the user may not act on. A loud 403 beats silently
        writing the row somewhere the caller did not intend.
        """
        from tests import factories

        other = factories.branch(shop["organization"])

        response = cashier_client.post(
            "/api/v1/pos/holds/",
            {"label": "spoofed", "branch": str(other.pk), "payload": {"lines": []}},
            format="json",
        )

        assert response.status_code == 403
        assert response.data["error"]["code"] == "PERMISSION_DENIED"
        assert not HeldSale.objects.exists()

    def test_resuming_returns_the_cart_and_clears_the_hold(self, cashier_client, shop):
        created = cashier_client.post(
            "/api/v1/pos/holds/",
            {"label": "resume me", "payload": {"lines": [{"sku": "X", "quantity": 2}]}},
            format="json",
        )
        hold_id = created.data["id"]

        response = cashier_client.post(f"/api/v1/pos/holds/{hold_id}/resume/")

        assert response.status_code == 200
        assert response.data["payload"]["lines"][0]["quantity"] == 2
        assert not HeldSale.objects.filter(pk=hold_id).exists()


class TestPosPermissions:
    def test_an_accountant_cannot_take_a_sale(self, auth_client, shop):
        from tests import factories

        accountant = factories.user("ACCOUNTANT", branch_obj=shop["branch"])

        response = auth_client(accountant).post("/api/v1/pos/sales/", {}, format="json")

        assert response.status_code == 403

    def test_anonymous_cannot_reach_the_register(self, api):
        assert api.get("/api/v1/pos/session/").status_code == 401
