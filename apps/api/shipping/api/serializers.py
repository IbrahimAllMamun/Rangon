from __future__ import annotations

from rest_framework import serializers

from shipping.models import Courier, Shipment, ShipmentEvent, ShippingMethod, ShippingZone


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
