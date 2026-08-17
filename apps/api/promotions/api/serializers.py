from __future__ import annotations

from rest_framework import serializers

from promotions.models import Coupon, CouponRedemption


class CouponSerializer(serializers.ModelSerializer):
    is_exhausted = serializers.BooleanField(read_only=True)

    class Meta:
        model = Coupon
        fields = [
            "id",
            "code",
            "description",
            "discount_type",
            "value",
            "minimum_order_value",
            "maximum_discount",
            "starts_at",
            "ends_at",
            "usage_limit",
            "usage_limit_per_customer",
            "used_count",
            "is_exhausted",
            "categories",
            "products",
            "channels",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "used_count", "created_at"]

    def validate(self, attrs: dict) -> dict:
        starts_at, ends_at = attrs.get("starts_at"), attrs.get("ends_at")
        if starts_at and ends_at and ends_at <= starts_at:
            raise serializers.ValidationError(
                {"ends_at": ["The end date must be after the start."]}
            )
        if attrs.get("discount_type") == "PERCENTAGE" and attrs.get("value", 0) > 100:
            raise serializers.ValidationError({"value": ["A percentage cannot exceed 100."]})
        return attrs


class CouponRedemptionSerializer(serializers.ModelSerializer):
    order_number = serializers.CharField(source="order.number", read_only=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True, default="")

    class Meta:
        model = CouponRedemption
        fields = [
            "id",
            "coupon",
            "order",
            "order_number",
            "customer",
            "customer_name",
            "discount_amount",
            "released_at",
            "created_at",
        ]
