from __future__ import annotations

import copy
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from catalog.models import (
    Attribute,
    AttributeValue,
    Brand,
    Category,
    Product,
    ProductImage,
    ProductVariant,
    VariantAttributeValue,
)
from catalog.services import unique_slug


class AttributeValueSerializer(serializers.ModelSerializer):
    attribute_code = serializers.CharField(source="attribute.code", read_only=True)
    display = serializers.CharField(read_only=True)

    class Meta:
        model = AttributeValue
        fields = [
            "id",
            "attribute",
            "attribute_code",
            "value",
            "label",
            "display",
            "swatch",
            "position",
        ]


class AttributeSerializer(serializers.ModelSerializer):
    values = AttributeValueSerializer(many=True, read_only=True)

    class Meta:
        model = Attribute
        fields = [
            "id",
            "name",
            "code",
            "kind",
            "is_variant_defining",
            "is_filterable",
            "position",
            "values",
        ]


class CategorySerializer(serializers.ModelSerializer):
    product_count = serializers.IntegerField(read_only=True, required=False)
    children = serializers.SerializerMethodField()
    parent_name = serializers.CharField(source="parent.name", read_only=True, default="")

    class Meta:
        model = Category
        fields = [
            "id",
            "parent",
            "parent_name",
            "name",
            "slug",
            "description",
            "image",
            "position",
            "is_active",
            "show_in_navigation",
            "tax_rate",
            "seo_title",
            "seo_description",
            "product_count",
            "children",
        ]
        read_only_fields = ["id"]
        extra_kwargs = {"slug": {"required": False}}

    def get_children(self, category: Category) -> list[dict[str, Any]]:
        if self.context.get("tree") is False:
            return []
        return CategorySerializer(
            category.children.filter(is_active=True).order_by("position", "name"),
            many=True,
            context=self.context,
        ).data

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = unique_slug(Category, attrs["name"])
        return attrs


class BrandSerializer(serializers.ModelSerializer):
    class Meta:
        model = Brand
        fields = ["id", "name", "slug", "description", "logo", "is_active", "is_featured"]
        read_only_fields = ["id"]
        extra_kwargs = {"slug": {"required": False}}

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = unique_slug(Brand, attrs["name"])
        return attrs


class ProductImageSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    alt = serializers.CharField(source="effective_alt", read_only=True)
    color = serializers.SerializerMethodField()

    class Meta:
        model = ProductImage
        fields = [
            "id",
            "product",
            "attribute_value",
            "color",
            "image",
            "url",
            "alt_text",
            "alt",
            "position",
            "is_primary",
        ]
        read_only_fields = ["id"]

    def get_url(self, image: ProductImage) -> str:
        if not image.image:
            return ""
        request = self.context.get("request")
        url = image.image.url
        return request.build_absolute_uri(url) if request else url

    def get_color(self, image: ProductImage) -> dict[str, str] | None:
        return colour_payload(image.attribute_value if image.attribute_value_id else None)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # The colour rules live on the model so the Django admin obeys them too.
        candidate = copy.copy(self.instance) if self.instance else ProductImage()
        for key, value in attrs.items():
            setattr(candidate, key, value)
        try:
            candidate.clean()
        except DjangoValidationError as error:
            raise serializers.ValidationError(error.message_dict) from error
        return attrs


def colour_payload(value: Any) -> dict[str, str] | None:
    """The colour an image or variant carries, or None for a shared image."""
    if value is None:
        return None
    return {
        "code": value.attribute.code,
        "value": value.value,
        "label": value.display,
        "swatch": value.swatch,
    }


class VariantAttributeValueSerializer(serializers.ModelSerializer):
    attribute_code = serializers.CharField(source="attribute.code", read_only=True)
    attribute_name = serializers.CharField(source="attribute.name", read_only=True)
    value = serializers.CharField(source="attribute_value.value", read_only=True)
    label = serializers.CharField(source="attribute_value.display", read_only=True)
    swatch = serializers.CharField(source="attribute_value.swatch", read_only=True)

    class Meta:
        model = VariantAttributeValue
        fields = ["attribute_code", "attribute_name", "value", "label", "swatch"]


class ProductVariantSerializer(serializers.ModelSerializer):
    label = serializers.CharField(read_only=True)
    attributes = VariantAttributeValueSerializer(
        source="attribute_values", many=True, read_only=True
    )
    product_name = serializers.CharField(source="product.name", read_only=True)
    stock = serializers.SerializerMethodField()

    class Meta:
        model = ProductVariant
        fields = [
            "id",
            "product",
            "product_name",
            "sku",
            "barcode",
            "name",
            "label",
            "price",
            "compare_at_price",
            "cost",
            "weight_grams",
            "position",
            "status",
            "batch_number",
            "expiry_date",
            "attributes",
            "stock",
        ]
        read_only_fields = ["id"]

    def get_stock(self, variant: ProductVariant) -> dict[str, Any] | None:
        snapshots = self.context.get("stock")
        if snapshots is None:
            return None
        snapshot = snapshots.get(str(variant.pk))
        if snapshot is None:
            return {"on_hand": 0, "reserved": 0, "available": 0}
        return {
            "on_hand": snapshot.on_hand,
            "reserved": snapshot.reserved,
            "available": snapshot.available,
            "average_cost": str(snapshot.average_cost),
        }


class ProductListSerializer(serializers.ModelSerializer):
    brand_name = serializers.CharField(source="brand.name", read_only=True, default="")
    category_name = serializers.CharField(source="category.name", read_only=True)
    primary_image = serializers.SerializerMethodField()
    variant_count = serializers.IntegerField(source="variants.count", read_only=True)
    min_price = serializers.DecimalField(
        max_digits=14, decimal_places=2, read_only=True, required=False
    )
    max_price = serializers.DecimalField(
        max_digits=14, decimal_places=2, read_only=True, required=False
    )

    class Meta:
        model = Product
        fields = [
            "id",
            "name",
            "slug",
            "short_description",
            "category",
            "category_name",
            "brand",
            "brand_name",
            "status",
            "published",
            "featured",
            "primary_image",
            "variant_count",
            "min_price",
            "max_price",
            "created_at",
        ]

    def get_primary_image(self, product: Product) -> dict[str, Any] | None:
        image = product.primary_image
        if image is None or not image.image:
            return None
        request = self.context.get("request")
        url = image.image.url
        return {
            "url": request.build_absolute_uri(url) if request else url,
            "alt": image.effective_alt,
        }


class ProductDetailSerializer(ProductListSerializer):
    variants = ProductVariantSerializer(many=True, read_only=True)
    images = ProductImageSerializer(many=True, read_only=True)

    class Meta(ProductListSerializer.Meta):
        fields = [
            *ProductListSerializer.Meta.fields,
            "description",
            "material",
            "care_instructions",
            "is_final_sale",
            "seo_title",
            "seo_description",
            "variants",
            "images",
        ]


class ProductWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = [
            "id",
            "name",
            "slug",
            "category",
            "brand",
            "short_description",
            "description",
            "material",
            "care_instructions",
            "status",
            "published",
            "featured",
            "is_final_sale",
            "seo_title",
            "seo_description",
        ]
        read_only_fields = ["id"]
        extra_kwargs = {"slug": {"required": False}}

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = unique_slug(Product, attrs["name"])
        if attrs.get("published") and attrs.get("status") == "DRAFT":
            raise serializers.ValidationError(
                {"published": ["A draft product cannot be published. Set status to ACTIVE first."]}
            )
        return attrs


class GenerateVariantsSerializer(serializers.Serializer):
    selections = serializers.DictField(child=serializers.ListField(child=serializers.CharField()))
    price = serializers.DecimalField(max_digits=14, decimal_places=2)
    cost = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, default=0)
