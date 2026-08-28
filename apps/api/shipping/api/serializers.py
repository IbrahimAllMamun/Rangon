from __future__ import annotations

from rest_framework import serializers

from shipping.models import (
    Courier,
    Shipment,
    ShipmentEvent,
    ShipmentStatus,
    ShippingMethod,
    ShippingZone,
)


class CourierSerializer(serializers.ModelSerializer):
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
        read_only_fields = ["id", "created_at"]
