from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from finance.models import Account
from orders.models import (
    Cart,
    CartItem,
    HeldSale,
    Order,
    OrderEvent,
    OrderItem,
    Payment,
    PaymentMethod,
    Refund,
    RestockDecision,
    ReturnItem,
    ReturnReason,
    ReturnRequest,
)


class OrderItemSerializer(serializers.ModelSerializer):
    returnable_quantity = serializers.IntegerField(read_only=True)
    image = serializers.SerializerMethodField()

    class Meta:
        model = OrderItem
        fields = [
            "id",
            "variant",
            "sku",
            "product_name",
            "variant_label",
            "quantity",
            "unit_price",
            "line_discount",
            "tax_amount",
            "line_total",
            "fulfilled_quantity",
            "returned_quantity",
            "returnable_quantity",
            "image",
        ]

    def get_image(self, item: OrderItem) -> str:
        image = item.variant.product.primary_image if item.variant_id else None
        return image.image.url if image and image.image else ""


class OrderItemCostSerializer(OrderItemSerializer):
    """Includes cost — only exposed to roles holding reports.financial."""

    class Meta(OrderItemSerializer.Meta):
        fields = [*OrderItemSerializer.Meta.fields, "unit_cost"]


class PaymentSerializer(serializers.ModelSerializer):
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")
    account_name = serializers.CharField(source="account.name", read_only=True, default="")

    class Meta:
        model = Payment
        fields = [
            "id",
            "method",
            "status",
            "amount",
            "tendered_amount",
            "change_amount",
            "currency",
            "provider",
            "provider_reference",
            "reference",
            "authorized_at",
            "captured_at",
            "failed_at",
            "refunded_total",
            "account",
            "account_name",
            "created_by_email",
            "created_at",
        ]
        read_only_fields = fields


class RefundSerializer(serializers.ModelSerializer):
    class Meta:
        model = Refund
        fields = [
            "id",
            "order",
            "payment",
            "amount",
            "method",
            "status",
            "reason",
            "provider_reference",
            "created_at",
        ]
        read_only_fields = fields


class OrderEventSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor.email", read_only=True, default="")

    class Meta:
        model = OrderEvent
        fields = [
            "id",
            "event_type",
            "message",
            "data",
            "actor_email",
            "is_customer_visible",
            "created_at",
        ]


class OrderListSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    customer_phone = serializers.CharField(source="customer.phone", read_only=True, default="")
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    item_count = serializers.IntegerField(read_only=True)
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")

    class Meta:
        model = Order
        fields = [
            "id",
            "number",
            "channel",
            "status",
            "payment_status",
            "branch",
            "branch_code",
            "customer",
            "customer_name",
            "customer_phone",
            "item_count",
            "subtotal",
            "discount_total",
            "tax_total",
            "shipping_total",
            "grand_total",
            "paid_total",
            "refunded_total",
            "currency",
            "created_by_email",
            "placed_at",
            "created_at",
        ]


class OrderDetailSerializer(OrderListSerializer):
    items = OrderItemSerializer(many=True, read_only=True)
    payments = PaymentSerializer(many=True, read_only=True)
    refunds = RefundSerializer(many=True, read_only=True)
    events = OrderEventSerializer(many=True, read_only=True)
    shipping_method_name = serializers.CharField(
        source="shipping_method.name", read_only=True, default=""
    )

    class Meta(OrderListSerializer.Meta):
        fields = [
            *OrderListSerializer.Meta.fields,
            "coupon",
            "coupon_discount",
            "manual_discount",
            "tax_rate",
            "shipping_method",
            "shipping_method_name",
            "shipping_address",
            "billing_address",
            "customer_note",
            "internal_note",
            "register",
            "stock_committed",
            "confirmed_at",
            "packed_at",
            "shipped_at",
            "delivered_at",
            "cancelled_at",
            "cancel_reason",
            "items",
            "payments",
            "refunds",
            "events",
        ]


# --- POS -------------------------------------------------------------------


class PosSaleLineSerializer(serializers.Serializer):
    variant = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)
    line_discount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, default=0, min_value=0
    )


class PosPaymentSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=PaymentMethod.choices)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0)
    tendered_amount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True
    )
    reference = serializers.CharField(required=False, allow_blank=True, max_length=128)
    account = serializers.PrimaryKeyRelatedField(
        queryset=Account.objects.filter(is_active=True), required=False, allow_null=True
    )


class PosSaleSerializer(serializers.Serializer):
    lines = PosSaleLineSerializer(many=True)
    payments = PosPaymentSerializer(many=True)
    customer = serializers.UUIDField(required=False, allow_null=True)
    manual_discount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, default=0, min_value=0
    )
    register = serializers.CharField(required=False, allow_blank=True, max_length=32)
    note = serializers.CharField(required=False, allow_blank=True)
    branch = serializers.UUIDField(required=False, allow_null=True)

    def validate_lines(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not value:
            raise serializers.ValidationError("A sale needs at least one item.")
        return value


class HeldSaleSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.name", read_only=True, default="")
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")

    class Meta:
        model = HeldSale
        fields = [
            "id",
            "branch",
            "register",
            "label",
            "customer",
            "customer_name",
            "payload",
            "created_by_email",
            "created_at",
        ]
        # `branch` is derived from the cashier's session in the view, never sent
        # by the client - a register must not be able to park a sale against
        # another branch. Leaving it writable also made it *required*, which
        # rejected every hold with "branch: This field is required."
        read_only_fields = ["id", "branch", "created_at"]


class ElevateSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)
    permission = serializers.CharField(max_length=64)


# --- returns ---------------------------------------------------------------


class ReturnItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="order_item.sku", read_only=True)
    product_name = serializers.CharField(source="order_item.product_name", read_only=True)

    class Meta:
        model = ReturnItem
        fields = [
            "id",
            "order_item",
            "sku",
            "product_name",
            "quantity",
            "restock_decision",
            "condition_note",
            "refund_amount",
        ]


class ReturnRequestSerializer(serializers.ModelSerializer):
    items = ReturnItemSerializer(many=True, read_only=True)
    order_number = serializers.CharField(source="order.number", read_only=True)
    customer_name = serializers.CharField(source="order.customer.name", read_only=True)

    class Meta:
        model = ReturnRequest
        fields = [
            "id",
            "number",
            "order",
            "order_number",
            "customer_name",
            "status",
            "reason",
            "customer_comment",
            "staff_comment",
            "refund_amount",
            "refund_shipping",
            "items",
            "created_at",
            "approved_at",
            "received_at",
            "completed_at",
        ]
        read_only_fields = fields


class ReceiveReturnLineSerializer(serializers.Serializer):
    """What was decided about one line once the goods were in hand."""

    id = serializers.UUIDField()
    restock_decision = serializers.ChoiceField(choices=RestockDecision.choices, required=False)
    condition_note = serializers.CharField(
        max_length=255, required=False, allow_blank=True, default=""
    )


class ReceiveReturnSerializer(serializers.Serializer):
    """Receiving goods back, with the per-line decision made at that moment.

    The decision lives here rather than at request time because this is the
    first point anyone has the item in their hands (docs/business-rules.md
    §2.1). Lines left out keep whatever was chosen when the return was raised.
    """

    items = ReceiveReturnLineSerializer(many=True, required=False)

    def validate_items(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen = set()
        for line in value:
            if line["id"] in seen:
                raise serializers.ValidationError(
                    f"{line['id']} appears twice; send one decision per line."
                )
            seen.add(line["id"])
        return value


class CompleteReturnSerializer(serializers.Serializer):
    refund_amount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True, min_value=Decimal("0.01")
    )
    refund_method = serializers.CharField(required=False, allow_blank=True)
    account = serializers.PrimaryKeyRelatedField(
        queryset=Account.objects.all(), required=False, allow_null=True
    )


class ReturnLineSerializer(serializers.Serializer):
    order_item = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)
    restock_decision = serializers.ChoiceField(
        choices=RestockDecision.choices, required=False, default=RestockDecision.RESTOCK
    )


class CreateReturnSerializer(serializers.Serializer):
    order = serializers.UUIDField()
    reason = serializers.ChoiceField(choices=ReturnReason.choices)
    lines = ReturnLineSerializer(many=True)
    customer_comment = serializers.CharField(required=False, allow_blank=True)


class RecordPaymentSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=PaymentMethod.choices)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0)
    reference = serializers.CharField(required=False, allow_blank=True, max_length=128)
    # Which of our own accounts the money goes into. Omitted, the branch's
    # default account for the method's kind is used (finance.resolve_account).
    account = serializers.PrimaryKeyRelatedField(
        queryset=Account.objects.filter(is_active=True), required=False, allow_null=True
    )


class RefundRequestSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0)
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)
    method = serializers.ChoiceField(choices=PaymentMethod.choices, required=False)
    #: Omitted, the refund comes out of the account the payment came in through.
    account = serializers.PrimaryKeyRelatedField(
        queryset=Account.objects.filter(is_active=True), required=False, allow_null=True
    )


class StatusChangeSerializer(serializers.Serializer):
    to_status = serializers.CharField()
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)


# --- storefront cart -------------------------------------------------------


class CartItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="variant.sku", read_only=True)
    product_name = serializers.CharField(source="variant.product.name", read_only=True)
    product_slug = serializers.CharField(source="variant.product.slug", read_only=True)
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    unit_price = serializers.DecimalField(
        source="variant.price", max_digits=14, decimal_places=2, read_only=True
    )
    image = serializers.SerializerMethodField()
    available = serializers.SerializerMethodField()

    class Meta:
        model = CartItem
        fields = [
            "id",
            "variant",
            "sku",
            "product_name",
            "product_slug",
            "variant_label",
            "quantity",
            "unit_price",
            "image",
            "available",
        ]

    def get_image(self, item: CartItem) -> str:
        image = item.variant.product.primary_image
        return image.image.url if image and image.image else ""

    def get_available(self, item: CartItem) -> int:
        snapshots = self.context.get("availability") or {}
        snapshot = snapshots.get(str(item.variant_id))
        return snapshot.available if snapshot else 0


class CartSerializer(serializers.ModelSerializer):
    items = serializers.SerializerMethodField()
    totals = serializers.SerializerMethodField()
    issues = serializers.SerializerMethodField()
    coupon_code = serializers.CharField(source="coupon.code", read_only=True, default="")

    class Meta:
        model = Cart
        fields = ["id", "token", "items", "totals", "issues", "coupon_code"]

    def get_items(self, cart: Cart) -> list[dict[str, Any]]:
        return CartItemSerializer(
            cart.items.select_related("variant", "variant__product").all(),
            many=True,
            context=self.context,
        ).data

    def get_totals(self, cart: Cart) -> dict[str, Any]:
        priced = self.context.get("priced")
        if priced is None:
            return {}
        return {
            "subtotal": str(priced.subtotal),
            "discount_total": str(priced.discount_total),
            "coupon_discount": str(priced.coupon_discount),
            "tax_total": str(priced.tax_total),
            "shipping_total": str(priced.shipping_total),
            "grand_total": str(priced.grand_total),
            "item_count": priced.item_count,
        }

    def get_issues(self, cart: Cart) -> list[dict[str, Any]]:
        return self.context.get("issues", [])


class CheckoutSerializer(serializers.Serializer):
    shipping_address = serializers.DictField()
    billing_address = serializers.DictField(required=False)
    shipping_method = serializers.UUIDField(required=False, allow_null=True)
    payment_method = serializers.ChoiceField(choices=PaymentMethod.choices)
    contact_name = serializers.CharField(required=False, allow_blank=True, max_length=160)
    contact_phone = serializers.CharField(required=False, allow_blank=True, max_length=32)
    contact_email = serializers.EmailField(required=False, allow_blank=True)
    note = serializers.CharField(required=False, allow_blank=True)
    expected_total = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True
    )

    REQUIRED_ADDRESS_FIELDS = ("recipient_name", "phone", "line1", "city")

    def validate_shipping_address(self, value: dict[str, Any]) -> dict[str, Any]:
        missing = [field for field in self.REQUIRED_ADDRESS_FIELDS if not value.get(field)]
        if missing:
            raise serializers.ValidationError(
                {field: ["This field is required."] for field in missing}
            )
        return value
