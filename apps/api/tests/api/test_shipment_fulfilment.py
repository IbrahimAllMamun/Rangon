"""Creating a shipment, which until now nothing could do.

`ShipmentViewSet` has been registered, permissioned and tested since phase 18 —
but only on the read and tracking-update side. Nothing in `apps/web` has ever
called it, so `orders.fulfil` was unreachable through the product, no tracking
number was ever recorded, and `Courier.tracking_url_template` — editable on
`/admin/shipping` since the same phase — could never be filled in.

Building the screen meant auditing the endpoint first, and the write path had
no `validate()` at all:

  - `ShipmentViewSet` was the only write viewset in the codebase with no
    `branch_queryset` call, so a manager confined to one branch could list,
    read and ship another branch's orders (D68);
  - the order's status was never consulted, so a CANCELLED or REFUNDED order
    could be handed to a courier (D69);
  - `status`, `dispatched_at` and `delivered_at` were writable on create, so a
    shipment could be born DELIVERED with no `ShipmentEvent` behind it and the
    order left sitting at PACKED — the append-only trail was optional (D70);
  - nothing stopped two parcels claiming one courier's tracking number, which
    is also what a double-clicked form produces (D71).

Every test here was run against the code as it stood and seen to fail before
the guard it describes was written.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from orders.models import Channel, Order, OrderStatus
from shipping.models import Courier, Shipment, ShipmentEvent, ShipmentStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _order(branch, status: str = OrderStatus.PACKED) -> Order:
    return Order.objects.create(
        number=f"RGN-SHIP-{factories.unique()}",
        channel=Channel.ONLINE,
        status=status,
        branch=branch,
        customer=factories.customer(),
    )


def _courier(**kwargs) -> Courier:
    token = factories.unique()
    defaults = {
        "name": f"Courier {token}",
        "code": f"courier-{token}",
        "tracking_url_template": "https://courier.example/track/{tracking_number}",
    }
    return Courier.objects.create(**{**defaults, **kwargs})


class TestBranchScoping:
    """A manager is confined to their branch everywhere else; here they were not."""

    def test_a_manager_cannot_ship_another_branchs_order(self, shop, auth_client) -> None:
        # MANAGER holds `orders.fulfil` and is not cross-branch, which is the
        # exact combination this viewset never checked.
        other = factories.branch(shop["organization"])
        elsewhere = _order(other)

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(elsewhere.pk), "cost": "70.00"},
            format="json",
        )

        # 400 naming the field, not 403: the order is a field of the body
        # rather than the resource in the URL, so an order outside the caller's
        # branch reads as one that does not exist -- the same answer every
        # other branch-scoped relation in this codebase gives, and it leaks
        # nothing about what lives in the branch next door.
        assert response.status_code == 400, response.data
        assert "order" in response.data["error"]["details"]
        assert not Shipment.objects.filter(order=elsewhere).exists()

    def test_an_owner_may_ship_any_branchs_order(self, shop, auth_client) -> None:
        other = factories.branch(shop["organization"])
        elsewhere = _order(other)

        response = auth_client(shop["owner"]).post(
            "/api/v1/shipments/",
            {"order": str(elsewhere.pk), "cost": "70.00"},
            format="json",
        )

        assert response.status_code == 201, response.data

    def test_a_manager_lists_only_their_branchs_shipments(self, shop, auth_client) -> None:
        mine = Shipment.objects.create(order=_order(shop["branch"]))
        other = factories.branch(shop["organization"])
        theirs = Shipment.objects.create(order=_order(other))

        response = auth_client(shop["manager"]).get("/api/v1/shipments/")

        assert response.status_code == 200
        rows = response.data["results"] if isinstance(response.data, dict) else response.data
        ids = {row["id"] for row in rows}
        assert str(mine.pk) in ids
        assert str(theirs.pk) not in ids


class TestWhichOrdersCanBeShipped:
    """A parcel leaves the shop once. Some orders must never produce one."""

    @pytest.mark.parametrize(
        "status",
        [OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED, OrderStatus.PENDING],
    )
    def test_an_unshippable_order_is_refused(self, shop, auth_client, status) -> None:
        order = _order(shop["branch"], status=status)

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk)},
            format="json",
        )

        assert response.status_code == 409, response.data
        assert response.data["error"]["code"] == "CONFLICT"
        assert not Shipment.objects.filter(order=order).exists()

    @pytest.mark.parametrize(
        "status", [OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.PACKED]
    )
    def test_an_order_on_its_way_out_can_be_shipped(self, shop, auth_client, status) -> None:
        order = _order(shop["branch"], status=status)

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk)},
            format="json",
        )

        assert response.status_code == 201, response.data

    def test_a_second_parcel_for_a_shipped_order_is_allowed(self, shop, auth_client) -> None:
        # Split deliveries are real: `related_name="shipments"` is plural on
        # purpose. What is refused is a *duplicate*, which the tracking number
        # identifies -- not a second parcel.
        order = _order(shop["branch"], status=OrderStatus.SHIPPED)

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {
                "order": str(order.pk),
                "courier": str(_courier().pk),
                "tracking_number": "SECOND-BOX",
            },
            format="json",
        )

        assert response.status_code == 201, response.data


class TestTheShipmentStartsPending:
    """The event log is the record. Creation must not be able to skip it."""

    def test_a_caller_cannot_create_a_shipment_already_delivered(self, shop, auth_client) -> None:
        order = _order(shop["branch"])

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {
                "order": str(order.pk),
                "status": ShipmentStatus.DELIVERED,
                "delivered_at": "2026-01-01T10:00:00Z",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        shipment = Shipment.objects.get(pk=response.data["id"])
        # Everything the caller tried to assert about the parcel's journey is
        # ignored: a shipment that has not moved has not moved.
        assert shipment.status == ShipmentStatus.PENDING
        assert shipment.delivered_at is None
        assert shipment.dispatched_at is None
        assert not ShipmentEvent.objects.filter(shipment=shipment).exists()
        order.refresh_from_db()
        assert order.status == OrderStatus.PACKED

    def test_a_delivered_shipment_takes_no_further_events(self, shop, auth_client) -> None:
        shipment = Shipment.objects.create(order=_order(shop["branch"]))
        client = auth_client(shop["manager"])
        client.post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.DELIVERED},
            format="json",
        )

        response = client.post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.IN_TRANSIT, "message": "back on the van"},
            format="json",
        )

        assert response.status_code == 409, response.data
        shipment.refresh_from_db()
        assert shipment.status == ShipmentStatus.DELIVERED
        assert ShipmentEvent.objects.filter(shipment=shipment).count() == 1


class TestTrackingNumbers:
    """One courier cannot give one number to two parcels."""

    def test_two_parcels_cannot_share_one_couriers_tracking_number(self, shop, auth_client) -> None:
        courier = _courier()
        client = auth_client(shop["manager"])
        body = {"courier": str(courier.pk), "tracking_number": "CX-88213"}

        first = client.post(
            "/api/v1/shipments/", {**body, "order": str(_order(shop["branch"]).pk)}, format="json"
        )
        assert first.status_code == 201, first.data

        # The same number again is either a typo or a double-clicked form.
        # Both are wrong, and both used to write a second row.
        second = client.post(
            "/api/v1/shipments/", {**body, "order": str(_order(shop["branch"]).pk)}, format="json"
        )

        assert second.status_code == 409, second.data
        assert Shipment.objects.filter(courier=courier, tracking_number="CX-88213").count() == 1

    def test_the_same_number_at_a_different_courier_is_fine(self, shop, auth_client) -> None:
        client = auth_client(shop["manager"])
        for courier in (_courier(), _courier()):
            response = client.post(
                "/api/v1/shipments/",
                {
                    "order": str(_order(shop["branch"]).pk),
                    "courier": str(courier.pk),
                    "tracking_number": "1",
                },
                format="json",
            )
            assert response.status_code == 201, response.data

    def test_a_tracking_number_needs_the_courier_that_issued_it(self, shop, auth_client) -> None:
        # Couriers issue these. Without one the number identifies nothing, can
        # be looked up nowhere, and cannot be turned into a link -- and two of
        # them cannot be compared for uniqueness either.
        order = _order(shop["branch"])

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk), "tracking_number": "ORPHAN-1"},
            format="json",
        )

        assert response.status_code == 400, response.data
        assert not Shipment.objects.filter(order=order).exists()

    def test_parcels_without_a_number_yet_do_not_collide(self, shop, auth_client) -> None:
        # The common case: the parcel is booked before the courier hands over a
        # number. A blank is not a value, so it cannot be a duplicate.
        courier = _courier()
        client = auth_client(shop["manager"])
        for _ in range(3):
            response = client.post(
                "/api/v1/shipments/",
                {"order": str(_order(shop["branch"]).pk), "courier": str(courier.pk)},
                format="json",
            )
            assert response.status_code == 201, response.data


class TestTheRestOfTheWritePath:
    def test_a_negative_cost_is_refused(self, shop, auth_client) -> None:
        order = _order(shop["branch"])

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk), "cost": "-1.00"},
            format="json",
        )

        assert response.status_code == 400, response.data
        assert not Shipment.objects.filter(order=order).exists()

    def test_a_cashier_cannot_create_a_shipment(self, shop, auth_client) -> None:
        order = _order(shop["branch"])

        response = auth_client(shop["cashier"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk)},
            format="json",
        )

        assert response.status_code == 403
        assert not Shipment.objects.filter(order=order).exists()

    def test_creating_a_shipment_is_written_to_the_order_timeline(self, shop, auth_client) -> None:
        courier = _courier(name="Pathao Courier", code=f"pathao-{factories.unique()}")
        order = _order(shop["branch"])

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk), "courier": str(courier.pk), "tracking_number": "PX-1"},
            format="json",
        )

        assert response.status_code == 201, response.data
        event = order.events.filter(event_type="SHIPMENT_CREATED").first()
        assert event is not None
        assert "Pathao Courier" in event.message
        assert event.data["tracking_number"] == "PX-1"

    def test_the_payload_carries_the_tracking_url(self, shop, auth_client) -> None:
        # The whole reason `Courier.tracking_url_template` is editable. Nothing
        # had ever read it back, because nothing had ever written a number.
        courier = _courier(tracking_url_template="https://track.example/{tracking_number}")
        order = _order(shop["branch"])

        response = auth_client(shop["manager"]).post(
            "/api/v1/shipments/",
            {"order": str(order.pk), "courier": str(courier.pk), "tracking_number": "ABC-9"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["tracking_url"] == "https://track.example/ABC-9"
        assert response.data["cost"] == "0.00"


class TestWhatTheShopperSees:
    """The customer's tracking page is the point of all of this."""

    def test_the_guest_tracking_payload_carries_the_shipment(self, shop, api) -> None:
        order = _order(shop["branch"])
        courier = _courier(
            name="Steadfast", tracking_url_template="https://steadfast.example/{tracking_number}"
        )
        shipment = Shipment.objects.create(
            order=order, courier=courier, tracking_number="SF-4412", cost=Decimal("70.00")
        )
        ShipmentEvent.objects.create(
            shipment=shipment,
            status=ShipmentStatus.DISPATCHED,
            message="Collected from the shop",
            location="Dhaka",
            occurred_at=shop["now"],
        )

        response = api.get(f"/api/v1/shop/orders/{order.number}/?token={order.guest_token}")

        assert response.status_code == 200, response.data
        parcels = response.data["shipments"]
        assert len(parcels) == 1
        assert parcels[0]["tracking_number"] == "SF-4412"
        assert parcels[0]["courier_name"] == "Steadfast"
        assert parcels[0]["tracking_url"] == "https://steadfast.example/SF-4412"
        assert parcels[0]["events"][0]["message"] == "Collected from the shop"

    def test_the_shipment_cost_is_not_shown_to_the_shopper(self, shop, api) -> None:
        # What we paid the courier is our margin, not the customer's business.
        # They already paid the shipping line on their own order.
        order = _order(shop["branch"])
        Shipment.objects.create(order=order, cost=Decimal("70.00"))

        response = api.get(f"/api/v1/shop/orders/{order.number}/?token={order.guest_token}")

        assert response.status_code == 200
        assert "cost" not in response.data["shipments"][0]
