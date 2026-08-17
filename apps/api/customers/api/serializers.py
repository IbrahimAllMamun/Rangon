from __future__ import annotations

from rest_framework import serializers

from customers.models import Customer, CustomerAddress, CustomerNote


class CustomerAddressSerializer(serializers.ModelSerializer):
    class Meta:
        model = CustomerAddress
        fields = [
            "id",
            "customer",
            "label",
            "address_type",
            "recipient_name",
            "phone",
            "line1",
            "line2",
            "area",
            "city",
            "district",
            "postal_code",
            "country",
            "is_default",
            "notes",
        ]
        read_only_fields = ["id"]


class CustomerNoteSerializer(serializers.ModelSerializer):
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")

    class Meta:
        model = CustomerNote
        fields = ["id", "customer", "body", "is_pinned", "created_by_email", "created_at"]
        read_only_fields = ["id", "created_at"]


class CustomerSerializer(serializers.ModelSerializer):
    addresses = CustomerAddressSerializer(many=True, read_only=True)
    has_account = serializers.SerializerMethodField()

    class Meta:
        model = Customer
        fields = [
            "id",
            "name",
            "phone",
            "email",
            "customer_type",
            "is_walk_in",
            "is_active",
            "date_of_birth",
            "notes",
            "tags",
            "total_orders",
            "total_spent",
            "loyalty_points",
            "last_order_at",
            "has_account",
            "addresses",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "total_orders",
            "total_spent",
            "loyalty_points",
            "last_order_at",
            "created_at",
            "is_walk_in",
        ]

    def get_has_account(self, customer: Customer) -> bool:
        return customer.user_id is not None

    def validate(self, attrs: dict) -> dict:
        # Phone-first identity: a customer with neither contact detail cannot be
        # found again, which defeats the point of creating the record.
        if not attrs.get("phone") and not attrs.get("email") and not self.instance:
            raise serializers.ValidationError(
                {"phone": ["Provide a phone number or an email address."]}
            )
        return attrs
