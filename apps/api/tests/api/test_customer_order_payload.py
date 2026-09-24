"""What a customer is shown of an order, and nothing else (D97).

`GET /shop/orders/{number}/?token=` -- the link in the confirmation message, open
to anyone holding it -- returned the staff order serializer. Measured
2026-09-24 on a delivered cash-on-delivery order, anonymously, with the token:

* every timeline entry named the member of staff who acted
  (`manager@rangon.test`, `owner@rangon.test`) and carried its internal
  `data` -- the reason a manager typed when changing the status, payment and
  parcel ids;
* the order carried `internal_note`, `created_by_email`, `register` and
  `stock_committed`; each payment carried the drawer it went into and who took
  it.

The signed-in customer's own order (`/shop/account/orders/{number}/`) was worse:
it did not drop the entries marked private either -- "Stock reserved", "Stock
deducted for dispatch". And the timeline text was the staff log's:
"PENDING → CONFIRMED", "COD 960.00", a rejected return with the staff comment
after the colon.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

from orders.models import Order, OrderStatus, PaymentMethod
from orders.services import lifecycle
from orders.services import payments as payment_services
from orders.services import returns as return_services
from tests import factories

pytestmark = pytest.mark.django_db

ADDRESS = {
    "recipient_name": "Ayesha Rahman",
    "phone": "01711000000",
    "line1": "House 12, Road 5",
    "city": "Dhaka",
}

#: Written by staff, for staff. None of it may reach the customer.
STAFF_REASON = "Customer sounded drunk on the phone"
STAFF_NOTE = "Blacklist candidate -- check before the next order"
STAFF_COMMENT = "Customer is lying about the size"
DRAWER = "Counter Cash Drawer"

#: The keys the storefront's order page and checkout read, and nothing more.
ORDER_KEYS = {
    "number",
    "channel",
    "status",
    "payment_status",
    "currency",
    "placed_at",
    "delivered_at",
    "cancel_reason",
    "customer_name",
    "subtotal",
    "discount_total",
    "coupon_discount",
    "tax_total",
    "shipping_total",
    "grand_total",
    "paid_total",
    "refunded_total",
    "shipping_method_name",
    "shipping_address",
    "customer_note",
    "items",
    "payments",
    "events",
}


def _checkout(api: Any, shop: dict[str, Any]) -> Any:
    cart = api.post(
        "/api/v1/shop/cart/",
        {"variant": str(shop["variants"][0].pk), "quantity": 1},
        format="json",
    )
    return api.post(
        "/api/v1/shop/checkout/",
        {
            "shipping_address": ADDRESS,
            "payment_method": PaymentMethod.COD,
            "contact_name": "Ayesha Rahman",
            "contact_phone": "01711000000",
        },
        format="json",
        HTTP_X_CART_TOKEN=cart["X-Cart-Token"],
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


@pytest.fixture
def handled(api: Any, shop: dict[str, Any]) -> dict[str, Any]:
    """A COD order as a shop actually handles one, leaving staff traces behind."""
    factories.account(shop["branch"], name=DRAWER, opening_balance="1000.00")
    checkout = _checkout(api, shop)
    assert checkout.status_code == 201, checkout.data
    order = Order.objects.get(number=checkout.data["order"]["number"])
    manager = shop["manager"]

    lifecycle.transition(
        order=order, to_status=OrderStatus.PROCESSING, actor=manager, reason=STAFF_REASON
    )
    lifecycle.transition(order=order, to_status=OrderStatus.PACKED, actor=manager)
    lifecycle.transition(order=order, to_status=OrderStatus.DELIVERED, actor=manager)
    Order.objects.filter(pk=order.pk).update(internal_note=STAFF_NOTE)
    payment_services.capture_payment(
        payment=order.payments.get(method=PaymentMethod.COD), actor=manager
    )
    request = return_services.request_return(
        order=order,
        lines=[(order.items.get().pk, 1)],
        reason="WRONG_SIZE",
        actor=manager,
    )
    return_services.reject(return_request=request, actor=manager, comment=STAFF_COMMENT)

    order.refresh_from_db()
    return {"order": order, "checkout": checkout, "manager": manager}


def _assert_customer_shaped(response: Any, manager: Any) -> None:
    # The bytes on the wire, not `response.data`: what leaves the server.
    text = response.content.decode()
    body = json.loads(text)

    for secret in (STAFF_REASON, STAFF_NOTE, STAFF_COMMENT, DRAWER, manager.email):
        assert secret not in text, secret
    assert set(body) - {"shipments"} == ORDER_KEYS

    for payment in body["payments"]:
        assert set(payment) == {"id", "method", "status", "amount", "captured_at", "created_at"}
    for event in body["events"]:
        assert set(event) == {"id", "event_type", "message", "created_at"}
        assert "→" not in event["message"]
        assert not event["event_type"].startswith("STOCK_")
    for item in body["items"]:
        assert "unit_cost" not in item


class TestTheTrackingLink:
    def test_the_link_shows_the_customer_their_order_and_no_staff_record(
        self, api: Any, handled: dict[str, Any]
    ) -> None:
        """Fails on `main`: every staff trace above is in the anonymous payload."""
        order = handled["order"]

        response = api.get(f"/api/v1/shop/orders/{order.number}/?token={order.guest_token}")

        assert response.status_code == 200
        _assert_customer_shaped(response, handled["manager"])

    def test_the_timeline_reads_as_the_customers_story(
        self, api: Any, handled: dict[str, Any]
    ) -> None:
        """Fails on `main`: "PENDING → CONFIRMED", "COD 960.00", the staff comment."""
        order = handled["order"]

        events = api.get(f"/api/v1/shop/orders/{order.number}/?token={order.guest_token}").data[
            "events"
        ]

        messages = [event["message"] for event in events]
        assert messages[0] == "Order placed"
        assert "Order confirmed" in messages
        assert "Delivered" in messages
        assert "Payment received" in messages
        assert "Return rejected" in messages

    def test_the_page_still_has_everything_it_shows(
        self, api: Any, handled: dict[str, Any], shop: dict[str, Any]
    ) -> None:
        """The control: narrowing must not take away what the order page renders."""
        order = handled["order"]

        body = api.get(f"/api/v1/shop/orders/{order.number}/?token={order.guest_token}").data

        assert body["number"] == order.number
        assert body["status"] == order.status
        assert body["grand_total"] == str(order.grand_total)
        assert body["shipping_address"]["recipient_name"] == "Ayesha Rahman"
        assert body["items"][0]["product_name"] == shop["variants"][0].product.name
        assert body["payments"][0]["method"] == PaymentMethod.COD
        assert body["shipments"] == []

    def test_the_number_alone_still_opens_nothing(self, api: Any, handled: dict[str, Any]) -> None:
        response = api.get(f"/api/v1/shop/orders/{handled['order'].number}/")

        assert response.status_code == 404


class TestTheSignedInCustomer:
    @pytest.fixture
    def client(self, auth_client: Any, handled: dict[str, Any]) -> Any:
        account = factories.user("CUSTOMER")
        customer = handled["order"].customer
        customer.user = account
        customer.save(update_fields=["user"])
        return auth_client(account)

    def test_their_order_is_customer_shaped(self, client: Any, handled: dict[str, Any]) -> None:
        """Fails on `main`: the staff record, private entries included."""
        response = client.get(f"/api/v1/shop/account/orders/{handled['order'].number}/")

        assert response.status_code == 200
        _assert_customer_shaped(response, handled["manager"])

    def test_their_order_list_names_no_staff(self, client: Any, handled: dict[str, Any]) -> None:
        """Fails on `main`: each row carried `created_by_email`, `branch`, `customer`."""
        response = client.get("/api/v1/shop/account/orders/")

        assert response.status_code == 200
        [row] = response.data["results"]
        assert row["number"] == handled["order"].number
        assert not {"created_by_email", "branch", "branch_code", "customer"} & set(row)


class TestCheckout:
    def test_the_confirmation_is_customer_shaped(self, api: Any, shop: dict[str, Any]) -> None:
        """Fails on `main`: the new order came back as the staff record."""
        response = _checkout(api, shop)

        assert response.status_code == 201
        assert response.data["tracking_token"]
        order = response.data["order"]
        assert set(order) - {"shipments"} == ORDER_KEYS
        assert not [event for event in order["events"] if event["event_type"] == "STOCK_RESERVED"]
