from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db.models import Count, Q
from rest_framework import serializers
from rest_framework.validators import UniqueTogetherValidator

from catalog.models import Product, PublishStatus
from core.fields import ContactPhoneField
from purchasing.models import (
    PurchaseOrder,
    PurchaseOrderItem,
    PurchaseReceipt,
    PurchaseReceiptItem,
    PurchaseReturn,
    PurchaseReturnItem,
    PurchaseReturnReason,
    Supplier,
    SupplierPayment,
    SupplierProduct,
)
from purchasing.services import unique_supplier_code


class SupplierSerializer(serializers.ModelSerializer):
    outstanding_orders = serializers.IntegerField(read_only=True, required=False)
    phone = ContactPhoneField(max_length=32, required=False, allow_blank=True)

    class Meta:
        model = Supplier
        extra_kwargs = {"code": {"required": False}}
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

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # `code` is unique with no default. Deriving it from the name keeps the
        # admin form from asking a buyer to invent an identifier — the same
        # treatment `slug` gets on Category, Brand and Product.
        if not attrs.get("code") and not self.instance:
            attrs["code"] = unique_supplier_code(attrs.get("name", ""))
        return attrs


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
            "quantity_returned",
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


class PurchaseReturnItemSerializer(serializers.ModelSerializer):
    sku = serializers.CharField(source="purchase_order_item.variant.sku", read_only=True)
    product_name = serializers.CharField(
        source="purchase_order_item.variant.product.name", read_only=True
    )
    variant_label = serializers.CharField(
        source="purchase_order_item.variant.label", read_only=True
    )

    class Meta:
        model = PurchaseReturnItem
        fields = [
            "id",
            "purchase_order_item",
            "sku",
            "product_name",
            "variant_label",
            "quantity",
            "unit_cost",
        ]
        read_only_fields = fields


class PurchaseReturnSerializer(serializers.ModelSerializer):
    items = PurchaseReturnItemSerializer(many=True, read_only=True)
    returned_by_email = serializers.CharField(
        source="returned_by.email", read_only=True, default=""
    )
    reason_label = serializers.CharField(source="get_reason_display", read_only=True)

    class Meta:
        model = PurchaseReturn
        fields = [
            "id",
            "number",
            "purchase_order",
            "reason",
            "reason_label",
            "notes",
            "returned_at",
            "returned_by_email",
            "credit_total",
            "items",
            "created_at",
        ]
        read_only_fields = fields


class ReturnLineSerializer(serializers.Serializer):
    item = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)


class CreatePurchaseReturnSerializer(serializers.Serializer):
    """The body of `POST /purchase-orders/{id}/return/`.

    No unit cost: the credit is what the supplier charged, read from the order
    line. Letting a client name it would be trusting the browser with money
    (CLAUDE.md §13).
    """

    lines = ReturnLineSerializer(many=True)
    reason = serializers.ChoiceField(choices=PurchaseReturnReason.choices)
    notes = serializers.CharField(required=False, allow_blank=True)


class UnpublishedProductSerializer(serializers.Serializer):
    """A product on this order that a shopper cannot see yet.

    Shaped for the panel that appears once goods are received. `can_publish`
    mirrors `catalog.services.publish_product` exactly, so the screen never
    offers a button the API would refuse — and never hides one it would allow.
    """

    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)
    slug = serializers.CharField(read_only=True)
    status = serializers.CharField(read_only=True)
    published = serializers.BooleanField(read_only=True)
    variant_count = serializers.IntegerField(read_only=True)
    priced_variant_count = serializers.IntegerField(read_only=True)
    can_publish = serializers.SerializerMethodField()

    def get_can_publish(self, product: Any) -> bool:
        return product.priced_variant_count > 0


class PurchaseOrderSerializer(serializers.ModelSerializer):
    items = PurchaseOrderItemSerializer(many=True, read_only=True)
    receipts = PurchaseReceiptSerializer(many=True, read_only=True)
    returns = PurchaseReturnSerializer(many=True, read_only=True)
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
            "credited_total",
            "outstanding",
            "currency",
            "notes",
            "items",
            "receipts",
            "returns",
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
    #: A fraction, not a percentage: 0.1500 is 15%, matching `Organization.
    #: default_tax_rate` and the shape the model column has always had. Bounded
    #: the same way the VAT setting is, so a buyer cannot type 15 and record
    #: 1500% of tax.
    tax_rate = serializers.DecimalField(
        max_digits=6,
        decimal_places=4,
        required=False,
        default=Decimal("0.0000"),
        min_value=Decimal("0"),
        max_value=Decimal("1"),
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


class PurchaseOrderDetailSerializer(PurchaseOrderSerializer):
    """One purchase order, with what it brought in that nobody can buy yet.

    Separate from `PurchaseOrderSerializer` for a measured reason:
    `unpublished_products` costs one query per order, which is invisible on a
    detail page and an N+1 on the list. `test_query_count_does_not_grow_with_receipts`
    caught it at 15 queries for four orders against 12 for one. The list has no
    use for the field, so the fix is for the list never to have it rather than
    to make the query cheaper.
    """

    unpublished_products = serializers.SerializerMethodField()

    def get_unpublished_products(self, order: PurchaseOrder) -> Any:
        """Products this order brought in that are still invisible to shoppers.

        A buyer can now create a product from the order that is buying it
        (business-rules.md § 7a.6), and those are created `DRAFT` with the
        retail price deliberately deferred. Nothing used to say so afterwards:
        the goods arrived, the draft sat there, and the only way to notice was
        to go looking. This is what the receipt screen reads to say it.

        Everything on the order is considered, not only what was created from
        it — a product someone unpublished last month is equally invisible, and
        equally worth flagging when its stock lands.

        One query. `priced_variant_count` counts active variants above zero,
        which is the same test `publish_product` applies.
        """
        products = (
            Product.objects.filter(variants__purchase_items__purchase_order=order)
            .exclude(published=True, status=PublishStatus.ACTIVE)
            .annotate(
                variant_count=Count(
                    "variants", filter=Q(variants__status=PublishStatus.ACTIVE), distinct=True
                ),
                priced_variant_count=Count(
                    "variants",
                    filter=Q(variants__status=PublishStatus.ACTIVE, variants__price__gt=0),
                    distinct=True,
                ),
            )
            .distinct()
            .order_by("name")
        )
        return UnpublishedProductSerializer(products, many=True).data

    class Meta(PurchaseOrderSerializer.Meta):
        fields = [*PurchaseOrderSerializer.Meta.fields, "unpublished_products"]


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
    #: `SupplierPayment.paid_at` is non-null, which made DRF require it, so the
    #: endpoint could not be called without one -- while the service has always
    #: defaulted it to now().  Optional here so the two agree.
    paid_at = serializers.DateTimeField(required=False, allow_null=True)
    purchase_number = serializers.CharField(
        source="purchase_order.number", read_only=True, default=""
    )
    account_name = serializers.CharField(source="account.name", read_only=True, default="")

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
            "account",
            "account_name",
            "created_at",
        ]
        read_only_fields = ["id", "account_name", "created_at"]


class SupplierProductSerializer(serializers.ModelSerializer):
    """One supplier's offer for one variant.

    `is_preferred` is deliberately read-only. Only one offer per variant may
    carry it (`purchasing_supplierproduct_one_preferred`), so a PATCH setting it
    directly would hit the index and surface as a 500 on what is an ordinary
    business action. Promoting a supplier goes through `POST .../set-preferred/`,
    which demotes the incumbent in the same transaction.
    """

    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    supplier_code = serializers.CharField(source="supplier.code", read_only=True)
    supplier_status = serializers.CharField(source="supplier.status", read_only=True)
    sku = serializers.CharField(source="variant.sku", read_only=True)
    product_name = serializers.CharField(source="variant.product.name", read_only=True)
    variant_label = serializers.CharField(source="variant.label", read_only=True)
    effective_lead_time_days = serializers.IntegerField(read_only=True)

    class Meta:
        model = SupplierProduct
        fields = [
            "id",
            "supplier",
            "supplier_name",
            "supplier_code",
            "supplier_status",
            "variant",
            "sku",
            "product_name",
            "variant_label",
            "supplier_sku",
            "last_cost",
            "lead_time_days",
            "effective_lead_time_days",
            "minimum_order_quantity",
            "is_preferred",
            "is_active",
            "last_purchased_at",
            "notes",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "is_preferred",
            "last_purchased_at",
            "created_at",
        ]
        # Declared rather than left to DRF, which derives one from
        # `purchasing_supplierproduct_uniq` and words it "The fields supplier,
        # variant must make a unique set." — true, and no use to a buyer looking
        # at the screen. An explicit `Meta.validators` replaces the derived list
        # outright, so there is one check rather than two disagreeing.
        validators = [
            UniqueTogetherValidator(
                queryset=SupplierProduct.objects.all(),
                fields=["supplier", "variant"],
                message="This supplier already has a price recorded for this product.",
            )
        ]
