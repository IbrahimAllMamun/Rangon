from __future__ import annotations

from rest_framework import serializers

from core.fields import ContactPhoneField
from shipping.models import (
    Courier,
    Shipment,
    ShipmentEvent,
    ShipmentStatus,
    ShippingMethod,
    ShippingZone,
)


class CourierSerializer(serializers.ModelSerializer):
    phone = ContactPhoneField(max_length=32, required=False, allow_blank=True)

    class Meta:
        model = Courier
        fields = [
            "id",
            "name",
            "code",
            "phone",
            "tracking_url_template",
            "integration",
            "is_active",
        ]


class ShippingMethodSerializer(serializers.ModelSerializer):
    zone_name = serializers.CharField(source="zone.name", read_only=True)
    eta_label = serializers.CharField(read_only=True)

    def _resulting(self, attrs: dict, field: str):
        """The value this field will hold after the write (see CouponSerializer)."""
        if field in attrs:
            return attrs[field]
        return getattr(self.instance, field, None)

    def validate_free_over(self, value):
        # `price_for()` returns 0 whenever `subtotal >= free_over`, so a negative
        # threshold is always satisfied and every order ships free. A typed
        # minus sign would quietly give away the shipping revenue.
        if value is not None and value < 0:
            raise serializers.ValidationError(
                "A free-shipping threshold cannot be negative — that would make every order free."
            )
        return value

    def validate_price(self, value):
        if value is not None and value < 0:
            raise serializers.ValidationError("A shipping price cannot be negative.")
        return value

    def validate(self, attrs: dict) -> dict:
        min_days = self._resulting(attrs, "min_days")
        max_days = self._resulting(attrs, "max_days")
        if min_days is not None and max_days is not None and max_days < min_days:
            raise serializers.ValidationError(
                {"max_days": ["The longest estimate cannot be shorter than the shortest."]}
            )
        return attrs

    class Meta:
        model = ShippingMethod
        fields = [
            "id",
            "zone",
            "zone_name",
            "name",
            "code",
            "description",
            "price",
            "free_over",
            "min_days",
            "max_days",
            "eta_label",
            "is_pickup",
            "supports_cod",
            "is_active",
            "position",
        ]


class ShippingZoneSerializer(serializers.ModelSerializer):
    methods = ShippingMethodSerializer(many=True, read_only=True)

    def validate_cities(self, value):
        """`cities` must be a list of names, and is stored normalised.

        `ShippingZone.matches()` iterates this field.  Given the bare string
        `"Dhaka"` it iterates *characters*, so the zone matches the city "d" and
        never matches "Dhaka" — a misconfiguration that looks correct in the
        database and silently routes orders to the wrong zone.  A JSONField
        accepts any shape, so the check has to live here.
        """
        if not isinstance(value, list):
            raise serializers.ValidationError(
                'Provide a list of city names, e.g. ["dhaka", "gazipur"].'
            )
        names = []
        for entry in value:
            if not isinstance(entry, str):
                raise serializers.ValidationError("Every city must be a name.")
            name = entry.strip().lower()
            if name and name not in names:
                names.append(name)
        return names

    class Meta:
        model = ShippingZone
        fields = [
            "id",
            "name",
            "description",
            "cities",
            "is_default",
            "position",
            "is_active",
            "methods",
        ]


class ShipmentEventSerializer(serializers.ModelSerializer):
    # Both are required on the model but optional on the wire: a courier update
    # that omits them means "in transit, as of now", which is the common case
    # when someone is typing an update by hand.
    status = serializers.ChoiceField(choices=ShipmentStatus.choices, required=False)
    occurred_at = serializers.DateTimeField(required=False)

    class Meta:
        model = ShipmentEvent
        fields = ["id", "status", "message", "location", "occurred_at", "created_at"]


class ShipmentSerializer(serializers.ModelSerializer):
    events = ShipmentEventSerializer(many=True, read_only=True)
    order_number = serializers.CharField(source="order.number", read_only=True)
    courier_name = serializers.CharField(source="courier.name", read_only=True, default="")
    tracking_url = serializers.CharField(read_only=True)

    # Both declared explicitly, and both optional, because the model's
    # (courier, tracking_number) UniqueConstraint would otherwise make them
    # *required*: DRF derives a UniqueTogetherValidator from the constraint and
    # every field in one is forced. A parcel is normally booked before the
    # courier hands over a number, so requiring them would refuse the ordinary
    # case to protect against the rare one.
    courier = serializers.PrimaryKeyRelatedField(
        queryset=Courier.objects.all(), required=False, allow_null=True
    )
    tracking_number = serializers.CharField(required=False, allow_blank=True, max_length=120)

    class Meta:
        model = Shipment
        fields = [
            "id",
            "order",
            "order_number",
            "courier",
            "courier_name",
            "shipping_method",
            "tracking_number",
            "tracking_url",
            "status",
            "cost",
            "dispatched_at",
            "delivered_at",
            "notes",
            "events",
            "created_at",
        ]
        # `status`, `dispatched_at` and `delivered_at` are the tail of the
        # event log, not input. Writable, they let a caller create a parcel
        # already DELIVERED with no `ShipmentEvent` behind it and the order
        # left at PACKED -- a delivery nobody recorded and no correction can
        # unpick. They move through `services.record_event` or not at all.
        read_only_fields = [
            "id",
            "status",
            "dispatched_at",
            "delivered_at",
            "created_at",
        ]
        # The other half of the note above. The duplicate is caught by
        # `shipping.services.create_shipment`, which answers 409 with the
        # courier's name in the message -- not DRF's "must make a unique set",
        # which names two opaque ids and reads as a form error.
        validators: list = []


class CustomerShipmentEventSerializer(serializers.ModelSerializer):
    """One tracking update, as the person waiting for the parcel sees it."""

    class Meta:
        model = ShipmentEvent
        fields = ["status", "message", "location", "occurred_at"]


class CustomerShipmentSerializer(serializers.ModelSerializer):
    """A parcel on the customer's own order page.

    A deliberately narrower view than `ShipmentSerializer`, and the narrowing
    is the point: `cost` is what we paid the courier, which is our margin and
    not the shopper's business -- they already paid the shipping line on their
    own order. `notes` is written for the packing bench. Neither belongs on a
    page we hand to the customer, so neither is in `fields`.
    """

    courier_name = serializers.CharField(source="courier.name", read_only=True, default="")
    tracking_url = serializers.CharField(read_only=True)
    events = CustomerShipmentEventSerializer(many=True, read_only=True)

    class Meta:
        model = Shipment
        fields = [
            "id",
            "courier_name",
            "tracking_number",
            "tracking_url",
            "status",
            "dispatched_at",
            "delivered_at",
            "events",
        ]
