from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers

from promotions.models import Coupon, CouponRedemption, DiscountType


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

    def _resulting(self, attrs: dict, field: str):
        """The value this field will hold after the write.

        Every rule below is checked against the *resulting* coupon rather than
        the payload.  A PATCH sends only what changed, so reading the payload
        alone lets a half-payload slip an invalid combination past: `ends_at`
        with the stored `starts_at`, or `value` with the stored `discount_type`.
        Those reached the database `CheckConstraint` instead, which is a 409 with
        a generic message — correct, but not something a form can show against a
        field, and one of them (the window) had no constraint at all.
        """
        if field in attrs:
            return attrs[field]
        return getattr(self.instance, field, None)

    def validate(self, attrs: dict) -> dict:
        starts_at = self._resulting(attrs, "starts_at")
        ends_at = self._resulting(attrs, "ends_at")
        if starts_at and ends_at and ends_at <= starts_at:
            raise serializers.ValidationError(
                {"ends_at": ["The end date must be after the start."]}
            )

        discount_type = self._resulting(attrs, "discount_type")
        value = self._resulting(attrs, "value")

        if discount_type == DiscountType.FREE_SHIPPING:
            # The discount is the shipping line being zeroed. Any amount sent
            # alongside is meaningless, so it is normalised away rather than
            # stored to confuse whoever reads the coupon later.
            attrs["value"] = Decimal("0.00")
            return attrs

        if value is None:
            raise serializers.ValidationError({"value": ["This field is required."]})
        if value <= 0:
            raise serializers.ValidationError(
                {"value": ["A discount of zero gives nothing away. Enter an amount above 0."]}
            )
        if discount_type == DiscountType.PERCENTAGE and value > 100:
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
