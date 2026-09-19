from __future__ import annotations

import copy
import re
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
    CategoryAttribute,
    Product,
    ProductAttributeValue,
    ProductImage,
    ProductVariant,
    VariantAttributeValue,
)
from catalog.services import spec_payload, unique_slug
from core.media import RelativeImageField, media_url

#: `#rgb`, `#rrggbb` or `#rrggbbaa`, which is everything a CSS colour input can
#: emit and everything `background-color` will accept from us.
_HEX_COLOUR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


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

    def validate_swatch(self, value: str) -> str:
        """A swatch is a colour or it is nothing.

        It is rendered straight into `style={{ backgroundColor }}` on the
        product form and the media grouper, so anything that is not a colour
        silently paints nothing at all -- the swatch just disappears and the
        shopper is left choosing between two identical circles. The field is a
        plain `CharField(max_length=32)`, so until now "navy", "rgb(0,0,128)"
        and "#12345" were all accepted and all equally invisible.
        """
        cleaned = (value or "").strip()
        if not cleaned:
            return ""
        if not _HEX_COLOUR.match(cleaned):
            raise serializers.ValidationError(
                "Use a hex colour such as #1E3A8A. A colour name or an rgb() "
                "string is stored happily and then renders as nothing."
            )
        return cleaned.lower()


class AttributeSerializer(serializers.ModelSerializer):
    values = AttributeValueSerializer(many=True, read_only=True)
    #: So the admin can warn *before* the save rather than refuse after it.
    variant_usage = serializers.SerializerMethodField()

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
            "variant_usage",
        ]

    def get_variant_usage(self, obj: Attribute) -> int:
        """How many variants are defined by this attribute.

        Read from the annotation the viewset adds, so a list of attributes stays
        one query. `VariantAttributeValue.attribute` is `related_name="+"`, so
        there is no reverse accessor to annotate across and no prefetch to fall
        back on -- the fallback below is a real query, and exists only for
        callers that build this serializer by hand.
        """
        annotated = getattr(obj, "variant_usage_count", None)
        if annotated is not None:
            return int(annotated)
        return VariantAttributeValue.objects.filter(attribute=obj).count()

    def validate_is_variant_defining(self, value: bool) -> bool:
        """It may be turned on freely, and off only while nothing depends on it.

        Variants were generated from the attributes that were variant-defining
        at the time, and `VariantAttributeValue` still points at this row. Turn
        it off underneath them and the matrix that produced those SKUs no longer
        describes them: `models.py` refuses to attach a value whose attribute is
        not variant-defining, so the existing variants become rows the app can
        read but could never have created. Rename it or retire it instead.
        """
        if self.instance is None or self.instance.is_variant_defining == value:
            return value

        if value:
            # The mirror image, and the reason it is no longer free: a
            # variant-defining attribute cannot also be a product
            # specification (`catalog.services.set_product_specs`), so turning
            # it on underneath products that state it would leave rows the app
            # can read but could never have written.
            stated_by = ProductAttributeValue.objects.filter(
                attribute_value__attribute=self.instance
            ).count()
            if stated_by:
                raise serializers.ValidationError(
                    f"{stated_by} product{'' if stated_by == 1 else 's'} state this "
                    "attribute as a specification, so it cannot start defining variants. "
                    "Clear it from those products first, or add a separate attribute."
                )
            return value

        used_by = VariantAttributeValue.objects.filter(attribute=self.instance).count()
        if used_by:
            raise serializers.ValidationError(
                f"{used_by} variant{'' if used_by == 1 else 's'} are defined by this "
                "attribute, so it cannot stop being variant-defining. Those SKUs exist "
                "because of it."
            )
        return value


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


class CategoryAttributeSerializer(serializers.ModelSerializer):
    """One attribute a category uses, with the values it can take.

    `GET /categories/{id}/attributes/` is what lets the product form ask a
    category what it needs rather than showing every attribute in the shop:
    a handbag never offers a Shoe size, and cosmetics offer Volume.
    `is_variant_defining` is what splits the answer into the two halves the
    form renders separately -- axes that build SKUs, and specs stated once.
    """

    id = serializers.UUIDField(source="attribute.id", read_only=True)
    code = serializers.CharField(source="attribute.code", read_only=True)
    name = serializers.CharField(source="attribute.name", read_only=True)
    kind = serializers.CharField(source="attribute.kind", read_only=True)
    is_variant_defining = serializers.BooleanField(
        source="attribute.is_variant_defining", read_only=True
    )
    #: Which category in the chain declared it, so the admin can say where a
    #: requirement came from rather than appearing to invent one.
    declared_by = serializers.CharField(source="category.name", read_only=True)
    values = AttributeValueSerializer(source="attribute.values", many=True, read_only=True)

    class Meta:
        model = CategoryAttribute
        fields = [
            "id",
            "code",
            "name",
            "kind",
            "is_variant_defining",
            "is_required",
            "declared_by",
            "values",
        ]


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
    # Brand is nullable, so `default` rather than letting a null propagate: the
    # barcode label prints this as its heading and wants "" for an unbranded
    # product, not the string "None".
    brand_name = serializers.CharField(source="product.brand.name", read_only=True, default="")
    stock = serializers.SerializerMethodField()

    class Meta:
        model = ProductVariant
        fields = [
            "id",
            "product",
            "product_name",
            "brand_name",
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
    specs = serializers.SerializerMethodField()
    spec_value_ids = serializers.SerializerMethodField()

    class Meta(ProductListSerializer.Meta):
        fields = [
            *ProductListSerializer.Meta.fields,
            "description",
            "material",
            "care_instructions",
            "is_final_sale",
            "seo_title",
            "seo_description",
            "specs",
            "spec_value_ids",
            "variants",
            "images",
        ]

    def get_specs(self, product: Product) -> list[dict[str, Any]]:
        """Grouped, because one attribute may hold several values. On detail
        only -- a listing renders no spec list and should not pay for one."""
        return spec_payload(product)

    def get_spec_value_ids(self, product: Product) -> list[str]:
        """The flat set the admin form ticks with, and the exact shape it
        sends back as `spec_values`. `specs` above is for reading -- it groups
        and drops the ids, because no shopper needs them."""
        return [str(link.attribute_value_id) for link in product.spec_values.all()]


class ProductWriteSerializer(serializers.ModelSerializer):
    #: The specification values this product states, as attribute-value ids.
    #: Write-only and **replacing**: the payload is the set as it now stands,
    #: so omitting the key leaves the specs alone and sending `[]` clears them.
    #: Only the ids travel -- the attribute is derived from the value in
    #: `catalog.services.set_product_specs`, so the two cannot disagree.
    spec_values = serializers.ListField(
        child=serializers.UUIDField(), required=False, write_only=True
    )

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
            "spec_values",
        ]
        read_only_fields = ["id"]
        extra_kwargs = {"slug": {"required": False}}

    def validate_spec_values(self, value: list[Any]) -> list[Any]:
        """Refuse here as well as in the service, and say which field is wrong.

        `catalog.services.set_product_specs` is the authority -- a shell or a
        management command reaches it without passing through here. This runs
        first so a bad payload is refused **before** anything is written, which
        on create is the difference between a 400 and a 400 plus an orphaned
        draft product; and it raises a field error, so the form can put the
        message beside the tick-list rather than at the top of the page.
        """
        ids = [str(item) for item in value]
        found = {
            str(row.pk): row
            for row in AttributeValue.objects.filter(pk__in=ids).select_related("attribute")
        }
        missing = [item for item in ids if item not in found]
        if missing:
            raise serializers.ValidationError(
                "Those specification values no longer exist. Reload the form."
            )
        axes = sorted(
            {row.attribute.name for row in found.values() if row.attribute.is_variant_defining}
        )
        if axes:
            joined = ", ".join(axes)
            raise serializers.ValidationError(
                f"{joined} build separate SKUs, so {'they' if len(axes) > 1 else 'it'} "
                "cannot also be stated as a specification. Pick the values in the "
                "variant matrix instead."
            )
        return value

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


class QuickProductSerializer(serializers.Serializer):
    """`POST /products/quick-create/` -- a product made on the purchase order.

    `price` has a floor of 0.01 here and not on the product form: a product
    made this way can be received and sold at the counter within the minute,
    and a price nobody set sells it for nothing. The product form is where a
    deliberate zero belongs.
    """

    name = serializers.CharField(max_length=200)
    category = serializers.PrimaryKeyRelatedField(queryset=Category.objects.all())
    brand = serializers.PrimaryKeyRelatedField(
        queryset=Brand.objects.all(), required=False, allow_null=True
    )
    selections = serializers.DictField(
        child=serializers.ListField(child=serializers.CharField()), required=False, default=dict
    )
    price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.01"))
    cost = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.00"))


class ProductImportSerializer(serializers.Serializer):
    """The upload behind `POST /products/import/`.

    `dry_run` defaults to **true** on purpose. A client that forgets the flag
    gets a preview, never several hundred products it did not mean to create;
    committing has to be asked for.
    """

    #: 5 MB. `importers.MAX_ROWS` is the real limit; this stops a wrong file
    #: (a photograph, a database dump) from being read into memory at all.
    MAX_BYTES = 5 * 1024 * 1024

    file = serializers.FileField(write_only=True)
    dry_run = serializers.BooleanField(required=False, default=True)
    branch = serializers.UUIDField(required=False, allow_null=True)

    def validate_file(self, uploaded: Any) -> str:
        if uploaded.size > self.MAX_BYTES:
            raise serializers.ValidationError(
                f"The file is {uploaded.size // 1024} KB. The limit is "
                f"{self.MAX_BYTES // 1024 // 1024} MB — is this a spreadsheet?"
            )
        raw = uploaded.read()
        try:
            # `utf-8-sig` because Excel on Windows writes a byte-order mark, and
            # without stripping it the first header reads as "\ufeffproduct_name"
            # and the file is rejected for a column it plainly has.
            return raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise serializers.ValidationError(
                "The file is not readable as UTF-8 text. Export it from your "
                "spreadsheet as CSV UTF-8."
            ) from None
