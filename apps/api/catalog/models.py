"""Product catalog.

A Product is what a customer browses; a ProductVariant is the sellable, stocked,
barcoded SKU.  Category-specific properties (size, shade, capacity...) are data
in Attribute/AttributeValue — never columns on the product table
(plan §10, docs/architecture/domain-model.md).
"""

from __future__ import annotations

from decimal import Decimal

from django.core.validators import MinValueValidator
from django.db import models
from django.utils.text import slugify

from core.models import BaseModel, money_field


class PublishStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    ACTIVE = "ACTIVE", "Active"
    ARCHIVED = "ARCHIVED", "Archived"


class Category(BaseModel):
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="children"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=140, unique=True)
    description = models.TextField(blank=True)
    image = models.ImageField(upload_to="categories/", blank=True, null=True)
    position = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    show_in_navigation = models.BooleanField(default=True)
    tax_rate = models.DecimalField(
        max_digits=6,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Overrides the organisation default VAT rate when set.",
    )
    seo_title = models.CharField(max_length=200, blank=True)
    seo_description = models.CharField(max_length=320, blank=True)

    class Meta:
        db_table = "catalog_category"
        ordering = ("position", "name")
        verbose_name_plural = "categories"
        indexes = [models.Index(fields=["parent", "position"])]

    def __str__(self) -> str:
        return self.name

    def save(self, *args, **kwargs) -> None:
        if not self.slug:
            self.slug = slugify(self.name)[:140]
        super().save(*args, **kwargs)

    @property
    def path(self) -> str:
        return f"{self.parent.path} / {self.name}" if self.parent else self.name

    def ancestors(self) -> list[Category]:
        chain, node = [], self.parent
        while node is not None:
            chain.append(node)
            node = node.parent
        return list(reversed(chain))

    def descendant_ids(self) -> list:
        """Self + every descendant id (for "show everything under Men")."""
        ids, frontier = [self.pk], [self.pk]
        while frontier:
            frontier = list(
                Category.objects.filter(parent_id__in=frontier).values_list("id", flat=True)
            )
            ids.extend(frontier)
        return ids


class Brand(BaseModel):
    name = models.CharField(max_length=120, unique=True)
    slug = models.SlugField(max_length=140, unique=True)
    description = models.TextField(blank=True)
    logo = models.ImageField(upload_to="brands/", blank=True, null=True)
    is_active = models.BooleanField(default=True)
    is_featured = models.BooleanField(default=False)

    class Meta:
        db_table = "catalog_brand"
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name

    def save(self, *args, **kwargs) -> None:
        if not self.slug:
            self.slug = slugify(self.name)[:140]
        super().save(*args, **kwargs)


class AttributeKind(models.TextChoices):
    TEXT = "TEXT", "Text"
    COLOR = "COLOR", "Colour"
    NUMBER = "NUMBER", "Number"
    SIZE = "SIZE", "Size"


class Attribute(BaseModel):
    """A property such as Size, Colour, Shade, Volume, Material, Capacity."""

    name = models.CharField(max_length=64, unique=True)
    code = models.SlugField(max_length=64, unique=True)
    kind = models.CharField(
        max_length=16, choices=AttributeKind.choices, default=AttributeKind.TEXT
    )
    is_variant_defining = models.BooleanField(
        default=True, help_text="Variant-defining attributes generate separate SKUs."
    )
    is_filterable = models.BooleanField(default=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "catalog_attribute"
        ordering = ("position", "name")

    def __str__(self) -> str:
        return self.name


class AttributeValue(BaseModel):
    attribute = models.ForeignKey(Attribute, on_delete=models.CASCADE, related_name="values")
    value = models.CharField(max_length=64)
    label = models.CharField(max_length=64, blank=True)
    swatch = models.CharField(
        max_length=32, blank=True, help_text="Hex colour for colour swatches, e.g. #111111"
    )
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "catalog_attributevalue"
        ordering = ("attribute", "position", "value")
        constraints = [
            models.UniqueConstraint(
                fields=["attribute", "value"], name="catalog_attributevalue_uniq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.attribute.name}: {self.label or self.value}"

    @property
    def display(self) -> str:
        return self.label or self.value


class CategoryAttribute(BaseModel):
    """Which attributes a category uses, and whether they are required."""

    category = models.ForeignKey(Category, on_delete=models.CASCADE, related_name="attribute_links")
    attribute = models.ForeignKey(
        Attribute, on_delete=models.CASCADE, related_name="category_links"
    )
    is_required = models.BooleanField(default=False)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "catalog_categoryattribute"
        ordering = ("position",)
        constraints = [
            models.UniqueConstraint(
                fields=["category", "attribute"], name="catalog_categoryattribute_uniq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.category.name} -> {self.attribute.name}"


class Product(BaseModel):
    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=220, unique=True)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="products")
    brand = models.ForeignKey(
        Brand, null=True, blank=True, on_delete=models.PROTECT, related_name="products"
    )
    short_description = models.CharField(max_length=320, blank=True)
    description = models.TextField(blank=True)
    material = models.CharField(max_length=120, blank=True)
    care_instructions = models.TextField(blank=True)

    status = models.CharField(
        max_length=16, choices=PublishStatus.choices, default=PublishStatus.DRAFT
    )
    published = models.BooleanField(default=False, help_text="Visible on the storefront.")
    featured = models.BooleanField(default=False)
    is_final_sale = models.BooleanField(
        default=False, help_text="Not returnable (docs/business-rules.md §2.2)."
    )

    seo_title = models.CharField(max_length=200, blank=True)
    seo_description = models.CharField(max_length=320, blank=True)

    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "catalog_product"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["status", "published", "category"]),
            models.Index(fields=["-created_at"]),
            models.Index(
                fields=["featured"],
                condition=models.Q(published=True),
                name="catalog_product_featured_idx",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    def save(self, *args, **kwargs) -> None:
        if not self.slug:
            self.slug = slugify(self.name)[:220]
        super().save(*args, **kwargs)

    @property
    def is_visible(self) -> bool:
        return self.published and self.status == PublishStatus.ACTIVE

    @property
    def primary_image(self):
        return self.images.filter(is_primary=True).first() or self.images.first()

    def price_range(self) -> tuple[Decimal, Decimal] | None:
        prices = [v.price for v in self.variants.all() if v.is_sellable]
        return (min(prices), max(prices)) if prices else None


class ProductVariant(BaseModel):
    """The sellable SKU: price, cost, barcode and stock hang off this row."""

    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="variants")
    sku = models.CharField(max_length=64, unique=True)
    barcode = models.CharField(max_length=64, unique=True, null=True, blank=True)
    name = models.CharField(
        max_length=200, blank=True, help_text="Variant label, e.g. 'Black / M'. Derived if blank."
    )

    price = money_field(validators=[MinValueValidator(Decimal("0.00"))])
    compare_at_price = money_field(null=True, blank=True, default=None)
    cost = money_field(
        help_text="Latest purchase cost. Stock valuation uses Inventory.average_cost."
    )

    weight_grams = models.PositiveIntegerField(null=True, blank=True)
    position = models.PositiveIntegerField(default=0)
    status = models.CharField(
        max_length=16, choices=PublishStatus.choices, default=PublishStatus.ACTIVE
    )

    # Cosmetics and anything else with a shelf life.
    batch_number = models.CharField(max_length=64, blank=True)
    expiry_date = models.DateField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = "catalog_productvariant"
        ordering = ("product", "position", "sku")
        indexes = [
            models.Index(fields=["product", "position"]),
            models.Index(fields=["barcode"]),
            models.Index(fields=["status"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(price__gte=Decimal("0.00")),
                name="catalog_variant_price_gte_0",
            ),
            models.CheckConstraint(
                condition=models.Q(cost__gte=Decimal("0.00")),
                name="catalog_variant_cost_gte_0",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.sku} — {self.product.name} {self.label}".strip()

    def save(self, *args, **kwargs) -> None:
        if self.barcode == "":
            self.barcode = None  # keep the unique index usable for many blanks
        super().save(*args, **kwargs)

    @property
    def label(self) -> str:
        if self.name:
            return self.name
        values = [str(v.attribute_value.display) for v in self.attribute_values.all()]
        return " / ".join(values)

    @property
    def is_sellable(self) -> bool:
        return self.status == PublishStatus.ACTIVE

    @property
    def is_on_sale(self) -> bool:
        return bool(self.compare_at_price and self.compare_at_price > self.price)


class VariantAttributeValue(BaseModel):
    variant = models.ForeignKey(
        ProductVariant, on_delete=models.CASCADE, related_name="attribute_values"
    )
    attribute = models.ForeignKey(Attribute, on_delete=models.PROTECT, related_name="+")
    attribute_value = models.ForeignKey(
        AttributeValue, on_delete=models.PROTECT, related_name="variant_links"
    )

    class Meta:
        db_table = "catalog_variantattributevalue"
        constraints = [
            models.UniqueConstraint(
                fields=["variant", "attribute"], name="catalog_variantattr_uniq"
            )
        ]
        indexes = [models.Index(fields=["attribute_value", "variant"])]

    def __str__(self) -> str:
        return f"{self.variant.sku}: {self.attribute_value}"


class ProductImage(BaseModel):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="images")
    variant = models.ForeignKey(
        ProductVariant,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="images",
        help_text="Set to show this image when a specific variant is selected.",
    )
    image = models.ImageField(upload_to="products/%Y/%m/")
    alt_text = models.CharField(max_length=200, blank=True)
    position = models.PositiveIntegerField(default=0)
    is_primary = models.BooleanField(default=False)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        db_table = "catalog_productimage"
        ordering = ("position", "created_at")
        indexes = [models.Index(fields=["product", "position"])]

    def __str__(self) -> str:
        return f"{self.product.name} #{self.position}"

    @property
    def effective_alt(self) -> str:
        return (
            self.alt_text
            or f"{self.product.name}{' ' + self.variant.label if self.variant else ''}"
        )
