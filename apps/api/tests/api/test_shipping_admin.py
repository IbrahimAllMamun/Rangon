"""The shipping endpoints as the admin screens use them.

Shipping had models, an API and no tests of either. It is also the one area the
business-rules document never described, so this file doubles as the executable
statement of how zones, methods and shipments are meant to behave — §10 of
docs/business-rules.md was written from it, not the other way round.

The four things asserted here are the ones a screen would otherwise expose:
who may configure shipping, that a zone's city list is a list, that a delivery
estimate reads forwards, and that a tracking update cannot write a status
nobody defined.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from orders.models import Channel, Order, OrderStatus
from shipping.models import Shipment, ShipmentEvent, ShipmentStatus, ShippingMethod, ShippingZone
from tests import factories

pytestmark = pytest.mark.django_db


def _zone(**kwargs) -> ShippingZone:
    defaults = {"name": f"Zone {factories.unique()}", "cities": ["dhaka"]}
    return ShippingZone.objects.create(**{**defaults, **kwargs})


def _order(branch) -> Order:
    return Order.objects.create(
        number=f"RGN-SHIP-{factories.unique()}",
        channel=Channel.ONLINE,
        status=OrderStatus.PACKED,
        branch=branch,
        customer=factories.customer(),
    )


class TestWhoMayConfigureShipping:
    """Zones, methods and couriers are settings; shipments are fulfilment."""

    def test_a_manager_cannot_change_shipping_settings(self, shop, auth_client) -> None:
        """A manager holds `settings.view`, deliberately not `settings.manage`."""
        response = auth_client(shop["manager"]).post(
            "/api/v1/shipping-zones/", {"name": "New zone", "cities": ["dhaka"]}, format="json"
        )

        assert response.status_code == 403

    def test_a_manager_can_read_them(self, shop, auth_client) -> None:
        _zone()

        response = auth_client(shop["manager"]).get("/api/v1/shipping-zones/")

        assert response.status_code == 200

    def test_an_owner_can_change_them(self, shop, auth_client) -> None:
        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-zones/", {"name": "Inside Dhaka", "cities": ["dhaka"]}, format="json"
        )

        assert response.status_code == 201, response.data


class TestAZonesCityList:
    """`cities` is a list of names, and must actually be one.

    `ShippingZone.matches()` iterates it. Given the bare string "Dhaka" it
    iterates *characters*, so the zone matches the city "d" and never matches
    "Dhaka" — a misconfiguration that looks right in the database and silently
    routes every order to the wrong zone.
    """

    def test_a_bare_string_is_refused(self, shop, auth_client) -> None:
        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-zones/",
            {"name": "Stringly typed", "cities": "Dhaka"},
            format="json",
        )

        assert response.status_code == 400

    def test_a_list_of_names_is_accepted_and_normalised(self, shop, auth_client) -> None:
        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-zones/",
            {"name": "Inside Dhaka", "cities": ["  Dhaka ", "GAZIPUR"]},
            format="json",
        )

        assert response.status_code == 201, response.data
        # Matching lower-cases both sides, so storing them normalised keeps the
        # list readable and the comparison honest.
        assert response.data["cities"] == ["dhaka", "gazipur"]

    def test_a_normalised_zone_matches_the_city_it_names(self, shop, auth_client) -> None:
        auth_client(shop["owner"]).post(
            "/api/v1/shipping-zones/",
            {"name": "Inside Dhaka", "cities": ["Dhaka"]},
            format="json",
        )
        zone = ShippingZone.objects.get(name="Inside Dhaka")

        assert zone.matches("Dhaka") is True
        assert zone.matches("dhaka") is True
        assert zone.matches("d") is False

    def test_an_empty_city_list_is_allowed_for_a_default_zone(self, shop, auth_client) -> None:
        """The fallback zone matches by being the default, not by naming cities."""
        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-zones/",
            {"name": "Everywhere else", "cities": [], "is_default": True},
            format="json",
        )

        assert response.status_code == 201, response.data


class TestDeliveryEstimates:
    def test_a_backwards_estimate_is_refused(self, shop, auth_client) -> None:
        """`max_days` before `min_days` renders as "5–2 days" to a shopper."""
        zone = _zone()

        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-methods/",
            {
                "zone": str(zone.pk),
                "name": "Backwards",
                "code": "backwards",
                "price": "70.00",
                "min_days": 5,
                "max_days": 2,
            },
            format="json",
        )

        assert response.status_code == 400

    def test_an_equal_estimate_is_a_single_day(self, shop, auth_client) -> None:
        zone = _zone()

        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-methods/",
            {
                "zone": str(zone.pk),
                "name": "Next day",
                "code": "next-day",
                "price": "120.00",
                "min_days": 1,
                "max_days": 1,
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["eta_label"] == "1 day"

    def test_free_over_cannot_be_negative(self, shop, auth_client) -> None:
        zone = _zone()

        response = auth_client(shop["owner"]).post(
            "/api/v1/shipping-methods/",
            {
                "zone": str(zone.pk),
                "name": "Odd",
                "code": "odd",
                "price": "70.00",
                "free_over": "-100.00",
            },
            format="json",
        )

        assert response.status_code == 400


class TestTrackingUpdates:
    """A tracking update writes to an append-only log and moves the order.

    `ShipmentEvent` is an `AppendOnlyModel`, and the status it carries drives
    `PACKED → SHIPPED → DELIVERED`. A status nobody defined is therefore not a
    cosmetic problem: it is permanent, and it silently stops the order
    progressing.
    """

    def _shipment(self, shop) -> Shipment:
        return Shipment.objects.create(order=_order(shop["branch"]), cost=Decimal("70.00"))

    def test_an_unknown_status_is_refused(self, shop, auth_client) -> None:
        shipment = self._shipment(shop)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": "BANANA", "message": "nonsense"},
            format="json",
        )

        assert response.status_code == 400
        assert not ShipmentEvent.objects.filter(shipment=shipment).exists()
        shipment.refresh_from_db()
        assert shipment.status == ShipmentStatus.PENDING

    def test_a_malformed_timestamp_is_refused(self, shop, auth_client) -> None:
        shipment = self._shipment(shop)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.IN_TRANSIT, "occurred_at": "not-a-date"},
            format="json",
        )

        assert response.status_code == 400
        assert not ShipmentEvent.objects.filter(shipment=shipment).exists()

    def test_dispatching_moves_a_packed_order_to_shipped(self, shop, auth_client) -> None:
        shipment = self._shipment(shop)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.DISPATCHED, "message": "Picked up"},
            format="json",
        )

        assert response.status_code == 201, response.data
        shipment.refresh_from_db()
        assert shipment.status == ShipmentStatus.DISPATCHED
        assert shipment.dispatched_at is not None
        shipment.order.refresh_from_db()
        assert shipment.order.status == OrderStatus.SHIPPED

    def test_delivering_moves_the_order_to_delivered(self, shop, auth_client) -> None:
        shipment = self._shipment(shop)
        client = auth_client(shop["manager"])
        client.post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.DISPATCHED},
            format="json",
        )

        response = client.post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.DELIVERED},
            format="json",
        )

        assert response.status_code == 201, response.data
        shipment.refresh_from_db()
        assert shipment.delivered_at is not None
        shipment.order.refresh_from_db()
        assert shipment.order.status == OrderStatus.DELIVERED

    def test_a_cashier_cannot_post_a_tracking_update(self, shop, auth_client) -> None:
        shipment = self._shipment(shop)

        response = auth_client(shop["cashier"]).post(
            f"/api/v1/shipments/{shipment.pk}/events/",
            {"status": ShipmentStatus.DISPATCHED},
            format="json",
        )

        assert response.status_code == 403
        assert not ShipmentEvent.objects.filter(shipment=shipment).exists()


class TestShippingOptionsAtCheckout:
    """What the storefront is offered, which is what the screens configure."""

    def test_a_city_match_beats_the_default_zone(self, shop) -> None:
        from orders.services import checkout as checkout_services

        fallback = _zone(name="Everywhere else", cities=[], is_default=True, position=10)
        dhaka = _zone(name="Inside Dhaka", cities=["dhaka"], position=1)
        ShippingMethod.objects.create(
            zone=fallback, name="National", code="nat", price=Decimal("150.00")
        )
        ShippingMethod.objects.create(zone=dhaka, name="City", code="city", price=Decimal("60.00"))

        options = checkout_services.shipping_options(city="Dhaka", subtotal=Decimal("1000.00"))

        assert [option["code"] for option in options] == ["city"]

    def test_an_unknown_city_falls_back_to_the_default_zone(self, shop) -> None:
        from orders.services import checkout as checkout_services

        fallback = _zone(name="Everywhere else", cities=[], is_default=True)
        ShippingMethod.objects.create(
            zone=fallback, name="National", code="nat", price=Decimal("150.00")
        )

        options = checkout_services.shipping_options(city="Sylhet", subtotal=Decimal("1000.00"))

        assert [option["code"] for option in options] == ["nat"]

    def test_free_over_zeroes_the_price(self, shop) -> None:
        from orders.services import checkout as checkout_services

        zone = _zone(cities=[], is_default=True)
        ShippingMethod.objects.create(
            zone=zone,
            name="Standard",
            code="std",
            price=Decimal("70.00"),
            free_over=Decimal("2000.00"),
        )

        cheap = checkout_services.shipping_options(city="", subtotal=Decimal("1000.00"))
        generous = checkout_services.shipping_options(city="", subtotal=Decimal("2500.00"))

        assert cheap[0]["price"] == Decimal("70.00")
        assert generous[0]["price"] == Decimal("0.00")

    def test_no_zone_at_all_offers_nothing(self, shop) -> None:
        """Documented so the admin screen can warn: with no default zone, a city
        nobody listed gets no delivery options and cannot check out."""
        from orders.services import checkout as checkout_services

        assert checkout_services.shipping_options(city="Sylhet", subtotal=Decimal("500.00")) == []
