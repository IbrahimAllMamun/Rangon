from __future__ import annotations

from rest_framework import serializers

from purchasing.models import (
    PurchaseOrder,
    PurchaseOrderItem,
    PurchaseReceipt,
    PurchaseReceiptItem,
    Supplier,
    SupplierPayment,
)


class SupplierSerializer(serializers.ModelSerializer):
    outstanding_orders = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Supplier
        fields = [
            "id",
            "name",
            "code",
            "contact_person",
            "phone",
            "email",
            "address",
            "tax_id",
            "payment_terms_days",
            "lead_time_days",
            "status",
            "notes",
            "outstanding_orders",
            "created_at",
        ]
        read_only_fields = ["id", "created_at"]


class PurchaseOrderItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="variant.sku", read_only=True)
    product_name = serializers.CharField(source="variant.product.name", read_only=True)
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    quantity_outstanding = serializers.IntegerField(read_only=True)

    class Meta:
        model = PurchaseOrderItem
        fields = [
            "id",
            "variant",
            "sku",
            "product_name",
            "variant_label",
            "quantity_ordered",
            "quantity_received",
            "quantity_outstanding",
            "unit_cost",
            "discount",
            "tax_rate",
            "line_total",
        ]
        read_only_fields = ["id", "quantity_received", "line_total"]


class PurchaseReceiptItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="purchase_order_item.variant.sku", read_only=True)

    class Meta:
        model = PurchaseReceiptItem
        fields = ["id", "purchase_order_item", "sku", "quantity", "unit_cost"]


class PurchaseReceiptSerializer(serializers.ModelSerializer):
    items = PurchaseReceiptItemSerializer(many=True, read_only=True)
    received_by_email = serializers.CharField(
        source="received_by.email", read_only=True, default=""
    )

    class Meta:
        model = PurchaseReceipt
        fields = [
            "id",
            "number",
            "purchase_order",
            "received_at",
            "received_by",
            "received_by_email",
            "notes",
            "is_posted",
            "items",
        ]


class PurchaseOrderSerializer(serializers.ModelSerializer):
    items = PurchaseOrderItemSerializer(many=True, read_only=True)
    receipts = PurchaseReceiptSerializer(many=True, read_only=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    outstanding = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)

    class Meta:
        model = PurchaseOrder
        fields = [
            "id",
            "number",
            "supplier",
            "supplier_name",
            "branch",
            "branch_code",
            "status",
            "payment_status",
            "invoice_number",
            "ordered_at",
            "expected_at",
            "completed_at",
            "subtotal",
            "discount_total",
            "tax_total",
            "shipping_total",
            "grand_total",
            "paid_total",
            "outstanding",
            "currency",
            "notes",
            "items",
            "receipts",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "number",
            "status",
            "payment_status",
            "subtotal",
            "discount_total",
            "tax_total",
            "grand_total",
            "paid_total",
            "created_at",
        ]


class PurchaseLineSerializer(serializers.Serializer):
    variant = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)
    unit_cost = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0)
    discount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, default=0, min_value=0
    )


class CreatePurchaseOrderSerializer(serializers.Serializer):
    supplier = serializers.UUIDField()
    branch = serializers.UUIDField(required=False)
    lines = PurchaseLineSerializer(many=True)
    expected_at = serializers.DateField(required=False, allow_null=True)
    invoice_number = serializers.CharField(required=False, allow_blank=True, max_length=64)
    shipping_total = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, default=0
    )
    notes = serializers.CharField(required=False, allow_blank=True)


class ReceiveLineSerializer(serializers.Serializer):
    item = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)
    unit_cost = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True
    )


class ReceivePurchaseSerializer(serializers.Serializer):
    lines = ReceiveLineSerializer(many=True)
    notes = serializers.CharField(required=False, allow_blank=True)


class SupplierPaymentSerializer(serializers.ModelSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    purchase_number = serializers.CharField(
        source="purchase_order.number", read_only=True, default=""
    )

    class Meta:
        model = SupplierPayment
        fields = [
            "id",
            "supplier",
            "supplier_name",
            "purchase_order",
            "purchase_number",
            "amount",
            "method",
            "reference",
            "paid_at",
            "notes",
            "created_at",
        ]
        read_only_fields = ["id", "created_at"]
