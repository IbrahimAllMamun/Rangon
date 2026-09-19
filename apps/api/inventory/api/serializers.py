from __future__ import annotations

from typing import Any

from rest_framework import serializers

from inventory.api import documents
from inventory.models import (
    Inventory,
    InventoryTransaction,
    StockCount,
    StockCountItem,
    StockTransfer,
    StockTransferItem,
    TransactionType,
)


class InventorySerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="variant.sku", read_only=True)
    barcode = serializers.CharField(source="variant.barcode", read_only=True, default="")
    product_name = serializers.CharField(source="variant.product.name", read_only=True)
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    category = serializers.CharField(source="variant.product.category.name", read_only=True)
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    available = serializers.IntegerField(read_only=True)
    stock_value = serializers.DecimalField(max_digits=16, decimal_places=2, read_only=True)
    is_low_stock = serializers.BooleanField(read_only=True)
    price = serializers.DecimalField(
        source="variant.price", max_digits=14, decimal_places=2, read_only=True
    )

    class Meta:
        model = Inventory
        fields = [
            "id",
            "branch",
            "branch_code",
            "variant",
            "sku",
            "barcode",
            "product_name",
            "variant_label",
            "category",
            "on_hand",
            "reserved",
            "available",
            "average_cost",
            "price",
            "stock_value",
            "reorder_point",
            "is_low_stock",
            "bin_location",
            "updated_at",
        ]
        read_only_fields = ["id", "on_hand", "reserved", "average_cost", "updated_at"]


class InventoryTransactionSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="variant.sku", read_only=True)
    product_name = serializers.CharField(source="variant.product.name", read_only=True)
    product = serializers.UUIDField(source="variant.product_id", read_only=True)
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    transaction_type_label = serializers.CharField(
        source="get_transaction_type_display", read_only=True
    )
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")
    document = serializers.SerializerMethodField()

    def get_document(self, obj: InventoryTransaction) -> dict[str, str] | None:
        # The list resolves a whole page at once and hands it over in the
        # context; a single row (retrieve) resolves itself.
        found = self.context.get("documents")
        if found is None:
            found = documents.resolve([obj])
        document = found.get((obj.reference_type, obj.reference_id))
        return document.as_dict() if document else None

    class Meta:
        model = InventoryTransaction
        fields = [
            "id",
            "branch",
            "branch_code",
            "variant",
            "variant_label",
            "product",
            "sku",
            "product_name",
            "transaction_type",
            "transaction_type_label",
            "quantity",
            "unit_cost",
            "on_hand_after",
            "reserved_after",
            "reference_type",
            "reference_id",
            "document",
            "reason",
            "notes",
            "created_by",
            "created_by_email",
            "created_at",
        ]


class AdjustStockSerializer(serializers.Serializer):
    variant = serializers.UUIDField()
    branch = serializers.UUIDField(required=False)
    new_on_hand = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=255)


class WriteOffSerializer(serializers.Serializer):
    variant = serializers.UUIDField()
    branch = serializers.UUIDField(required=False)
    quantity = serializers.IntegerField(min_value=1)
    transaction_type = serializers.ChoiceField(
        choices=[TransactionType.DAMAGE, TransactionType.LOSS]
    )
    reason = serializers.CharField(max_length=255)
    notes = serializers.CharField(required=False, allow_blank=True)


class TransferLineSerializer(serializers.Serializer):
    variant = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)


class StockTransferItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="variant.sku", read_only=True)
    product_name = serializers.CharField(source="variant.product.name", read_only=True)

    class Meta:
        model = StockTransferItem
        fields = ["id", "variant", "sku", "product_name", "quantity", "unit_cost"]


class StockTransferSerializer(serializers.ModelSerializer):
    items = StockTransferItemSerializer(many=True, read_only=True)
    source_code = serializers.CharField(source="source_branch.code", read_only=True)
    target_code = serializers.CharField(source="target_branch.code", read_only=True)

    class Meta:
        model = StockTransfer
        fields = [
            "id",
            "number",
            "source_branch",
            "source_code",
            "target_branch",
            "target_code",
            "status",
            "notes",
            "items",
            "created_at",
            "received_at",
        ]


class CreateTransferSerializer(serializers.Serializer):
    source_branch = serializers.UUIDField()
    target_branch = serializers.UUIDField()
    lines = TransferLineSerializer(many=True)
    notes = serializers.CharField(required=False, allow_blank=True)


class StockCountItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="variant.sku", read_only=True)
    product_name = serializers.CharField(source="variant.product.name", read_only=True)
    difference = serializers.IntegerField(read_only=True)

    class Meta:
        model = StockCountItem
        fields = [
            "id",
            "variant",
            "sku",
            "product_name",
            "expected_quantity",
            "counted_quantity",
            "difference",
            "notes",
        ]


class RecordCountLineSerializer(serializers.Serializer):
    variant = serializers.UUIDField()
    counted_quantity = serializers.IntegerField(min_value=0)
    notes = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")


class RecordCountSerializer(serializers.Serializer):
    """What the counter actually found on the shelf.

    Separate from `StockCountSerializer`, whose `items` are read-only: a count
    sheet is generated from the ledger, and the only field a person may write
    back is what they counted. Letting the sheet be PATCHed wholesale would let
    `expected_quantity` be edited too, which would make the variance — the one
    number the count exists to produce — meaningless.
    """

    lines = RecordCountLineSerializer(many=True, allow_empty=False)

    def validate_lines(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen = set()
        for line in value:
            if line["variant"] in seen:
                raise serializers.ValidationError(
                    f"{line['variant']} appears twice; send one figure per variant."
                )
            seen.add(line["variant"])
        return value


class StockCountSerializer(serializers.ModelSerializer):
    items = StockCountItemSerializer(many=True, read_only=True)
    branch_code = serializers.CharField(source="branch.code", read_only=True)

    class Meta:
        model = StockCount
        fields = [
            "id",
            "number",
            "branch",
            "branch_code",
            "status",
            "notes",
            "items",
            "created_at",
            "applied_at",
        ]
        read_only_fields = ["id", "number", "status", "applied_at"]
