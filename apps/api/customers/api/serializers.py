from __future__ import annotations

from rest_framework import serializers

from customers.models import Customer, CustomerAddress, CustomerNote


class CustomerAddressSerializer(serializers.ModelSerializer):
    """Validates an address. The owning customer is never taken from the body.

    Both callers (the admin viewset and the storefront account view) know whose
    address this is from the URL or the session, so `customer` is read-only —
    a client cannot write an address onto somebody else's record by posting an
    id.  `customers.services` attaches the customer.
    """

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
        read_only_fields = ["id", "customer"]


class CustomerNoteSerializer(serializers.ModelSerializer):
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")

    class Meta:
        model = CustomerNote
        fields = ["id", "customer", "body", "is_pinned", "created_by_email", "created_at"]
        # As with addresses: the customer comes from the URL, not the body.
        read_only_fields = ["id", "created_at", "customer"]


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
        #
        # This is checked against the *resulting* record, not just the payload:
        # an edit that clears both fields leaves exactly the unfindable customer
        # the rule exists to prevent, so it is refused on update as well as on
        # create.  A partial update that touches neither field keeps whatever
        # the record already has.
        phone = attrs.get("phone", getattr(self.instance, "phone", None))
        email = attrs.get("email", getattr(self.instance, "email", None))
        if not phone and not email:
            raise serializers.ValidationError(
                {"phone": ["Provide a phone number or an email address."]}
            )
        return attrs
