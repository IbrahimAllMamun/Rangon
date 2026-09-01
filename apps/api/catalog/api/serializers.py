from __future__ import annotations

import copy
from decimal import Decimal
from typing import Any

from django.conf import settings
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
from core.media import RelativeImageField, media_url


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
    # Origin-relative, like every other media URL (`core.media`).
    image = RelativeImageField(required=False, allow_null=True)
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

    def validate_tax_rate(self, value: Decimal | None) -> Decimal | None:
        """A category override replaces the organisation's VAT rate, and a
        mixed basket takes the **highest** rate present -- so one impossible
        rate here silently overcharges every order containing the category.
        The column is `DecimalField(6, 4)`, which happily stores 99.9999.
        """
        if value is None:
            return None
        if value < 0 or value > 1:
            raise serializers.ValidationError("The VAT rate must be between 0 and 1 (0.15 is 15%).")
        return value

    def validate_parent(self, value: Category | None) -> Category | None:
        """No category may be its own ancestor.

        Not a tidiness rule: `Category.path`, `ancestors()` and this
        serializer's own `get_children` all walk the tree without a depth
        guard, so a cycle recurses until the stack gives out -- and the
        navigation menu that renders on every storefront page is built from
        exactly that walk.
        """
        if value is None or self.instance is None:
            return value
        if value.pk == self.instance.pk:
            raise serializers.ValidationError("A category cannot be its own parent.")

        seen = {self.instance.pk}
        ancestor = value
        while ancestor is not None:
            if ancestor.pk in seen:
                raise serializers.ValidationError(
                    f"That would put “{self.instance.name}” underneath itself."
                )
            seen.add(ancestor.pk)
            ancestor = ancestor.parent
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Only on create. A slug is a URL: regenerating it whenever the name
        # changes silently breaks every link and every indexed page pointing at
        # the old one. Renaming and re-slugging are separate decisions, so a
        # rename keeps the slug and a caller who wants a new one sends it.
        if self.instance is None and not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = unique_slug(Category, attrs["name"])
        return attrs


class BrandSerializer(serializers.ModelSerializer):
    logo = RelativeImageField(required=False, allow_null=True)

    class Meta:
        model = Brand
        fields = ["id", "name", "slug", "description", "logo", "is_active", "is_featured"]
        read_only_fields = ["id"]
        extra_kwargs = {"slug": {"required": False}}

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # Create only -- see the note on CategorySerializer.validate.
        if self.instance is None and not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = unique_slug(Brand, attrs["name"])
        return attrs


#: Product photography, and nothing that merely looks like it. The admin form
#: applies the same rules, but the API is what has to refuse (CLAUDE.md section 4).
ALLOWED_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".avif")


class ProductImageSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    alt = serializers.CharField(source="effective_alt", read_only=True)
    color = serializers.SerializerMethodField()
    # Upload-only. DRF's `FileField` renders a file by absolutising it against
    # the incoming request, which is exactly the mistake `core.media` exists to
    # avoid — it emitted `http://api:8000/media/...` when the admin uploaded
    # through the storefront's proxy. `url` is the one public URL; nothing reads
    # this field back.
    image = serializers.ImageField(write_only=True)

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
        return media_url(image.image)

    def get_color(self, image: ProductImage) -> dict[str, str] | None:
        return colour_payload(image.attribute_value if image.attribute_value_id else None)

    def validate_image(self, value: Any) -> Any:
        """Size and type, server-side.

        `ImageField` only proves Pillow can decode the file; it caps nothing.
        Django's `FILE_UPLOAD_MAX_MEMORY_SIZE` is not a limit either — a larger
        upload simply spills to a temporary file — so without this a 200 MB
        "photograph" would be accepted and then served back forever.
        """
        if not value:
            return value
        if value.size > settings.RANGON_MAX_IMAGE_BYTES:
            limit = settings.RANGON_MAX_IMAGE_BYTES // (1024 * 1024)
            raise serializers.ValidationError(f"The image must be smaller than {limit} MB.")
        content_type = (getattr(value, "content_type", "") or "").lower()
        if content_type and content_type not in settings.RANGON_ALLOWED_IMAGE_TYPES:
            raise serializers.ValidationError("Upload a JPEG, PNG, WebP or AVIF image.")
        if not str(value.name).lower().endswith(ALLOWED_IMAGE_EXTENSIONS):
            raise serializers.ValidationError("Upload a JPEG, PNG, WebP or AVIF image.")
        return value

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
        return {
            "url": media_url(image.image),
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
