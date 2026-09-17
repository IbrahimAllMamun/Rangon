"""Catalog services: SKU/barcode generation and variant matrix creation."""

from __future__ import annotations

import itertools
import re
from typing import Any

from django.db import transaction
from django.utils.text import slugify

from catalog.models import (
    Attribute,
    AttributeValue,
    Category,
    CategoryAttribute,
    Product,
    ProductAttributeValue,
    ProductVariant,
    PublishStatus,
    VariantAttributeValue,
)
from core import audit
from core.exceptions import ValidationError
from core.services import next_number


def _token(value: str, length: int = 3) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]", "", value).upper()
    return cleaned[:length] or "X"


def build_sku(product: Product, values: list[AttributeValue]) -> str:
    """Readable SKU: RGN-POL-BLK-M.  Uniqueness is guaranteed by a suffix if needed."""
    parts = ["RGN", _token(product.name, 3)]
    parts.extend(_token(value.value, 3) for value in values)
    base = "-".join(parts)

    candidate = base
    counter = 1
    while ProductVariant.objects.filter(sku=candidate).exists():
        counter += 1
        candidate = f"{base}-{counter}"
    return candidate


def generate_barcode(variant: ProductVariant) -> str:
    """Internal EAN-13-style barcode with a valid check digit.

    Prefix 200-299 is reserved for in-store use, so these never collide with a
    manufacturer's barcode.
    """
    sequence = next_number("barcode", prefix="", padding=9)
    body = f"20{sequence[-10:]}"[:12].ljust(12, "0")

    total = sum(int(digit) * (1 if index % 2 == 0 else 3) for index, digit in enumerate(body))
    check_digit = (10 - (total % 10)) % 10
    return f"{body}{check_digit}"


@transaction.atomic
def create_variant(
    *,
    product: Product,
    attribute_values: list[AttributeValue],
    price: Any,
    cost: Any = 0,
    sku: str = "",
    barcode: str = "",
    compare_at_price: Any = None,
    actor: Any = None,
    **extra: Any,
) -> ProductVariant:
    variant = ProductVariant.objects.create(
        product=product,
        sku=sku or build_sku(product, attribute_values),
        price=price,
        cost=cost,
        compare_at_price=compare_at_price,
        name=" / ".join(value.display for value in attribute_values),
        **extra,
    )
    variant.barcode = barcode or generate_barcode(variant)
    variant.save(update_fields=["barcode"])

    for value in attribute_values:
        VariantAttributeValue.objects.create(
            variant=variant, attribute=value.attribute, attribute_value=value
        )
    return variant


@transaction.atomic
def generate_variants(
    *,
    product: Product,
    selections: dict[str, list[str]],
    price: Any,
    cost: Any = 0,
    actor: Any = None,
) -> list[ProductVariant]:
    """Create the cartesian product of chosen attribute values.

    `selections` maps attribute code -> values, e.g.
    {"size": ["S", "M"], "color": ["Black"]} produces 2 variants.
    Existing combinations are skipped, so re-running is safe.
    """
    if not selections:
        raise ValidationError("Choose at least one attribute value.")

    groups: list[list[AttributeValue]] = []
    for attribute_code, values in selections.items():
        attribute = Attribute.objects.filter(code=attribute_code).first()
        if attribute is None:
            raise ValidationError(f"Unknown attribute {attribute_code!r}.")
        options = list(attribute.values.filter(value__in=values))
        if not options:
            raise ValidationError(f"No matching values for {attribute_code!r}.")
        groups.append(options)

    existing = {
        frozenset(str(link.attribute_value_id) for link in variant.attribute_values.all())
        for variant in product.variants.prefetch_related("attribute_values")
    }

    created: list[ProductVariant] = []
    for combination in itertools.product(*groups):
        signature = frozenset(str(value.pk) for value in combination)
        if signature in existing:
            continue
        created.append(
            create_variant(
                product=product,
                attribute_values=list(combination),
                price=price,
                cost=cost,
                actor=actor,
            )
        )

    audit.record(
        action=audit.AuditAction.CREATE,
        entity=product,
        actor=actor,
        new_values={"variants_created": len(created)},
        reason="Variant matrix generated",
    )
    return created


@transaction.atomic
def publish_product(*, product: Product, actor: Any = None) -> Product:
    """Put a product on the storefront.

    Two gates, both asking the same question — is there anything here to sell?

      1. **At least one active variant.** Without one the product page renders
         with no buy panel at all.
      2. **At least one active variant priced above zero.** Zero is a legitimate
         price in the database and deliberately allowed by
         `catalog_variant_price_gte_0` — a sample, a gift line, something bundled
         — but nothing downstream refuses it: `orders.services.pricing` computes
         `unit_price * quantity`, so a checkout for 0.00 is a perfectly valid
         order and the goods leave for nothing (D75).

    The second gate is per product, not per variant, because a free sample
    alongside a priced row is a real arrangement. What it refuses is a product
    with *nothing* a shopper can pay for.

    Lives here rather than in the viewset because it is a business rule, and
    `publish` is the one place it can be enforced: the price itself stays
    editable, so a variant can always be set back to zero afterwards. Unpublish
    it first, which is what `unpublish` is for.
    """
    sellable = product.variants.filter(status=PublishStatus.ACTIVE)
    if not sellable.exists():
        raise ValidationError("A product needs at least one active variant before publishing.")

    if not sellable.filter(price__gt=0).exists():
        raise ValidationError(
            "Every variant of this product is priced at zero, so publishing it would "
            "give the stock away. Set a retail price first.",
            details={"product_id": str(product.pk)},
        )

    product.published = True
    product.status = PublishStatus.ACTIVE
    product.save(update_fields=["published", "status", "updated_at"])
    audit.record(
        action=audit.AuditAction.UPDATE,
        entity=product,
        actor=actor,
        new_values={"published": True},
    )
    return product


def category_attributes(category: Category) -> list[CategoryAttribute]:
    """Which attributes a category uses, inherited from its ancestors.

    The seed wires attributes to leaf categories ("Shirts"), so a product filed
    against a parent ("Men") would otherwise offer nothing at all -- and the
    tree is the reason those parents exist.  Walking down from the root means a
    nearer category's link wins the `is_required` flag for the same attribute,
    which is the direction that lets a specific category tighten a general rule
    rather than a general one loosening a specific.
    """
    chain = [*category.ancestors(), category]
    links = (
        CategoryAttribute.objects.filter(category__in=chain)
        .select_related("attribute")
        .prefetch_related("attribute__values")
    )
    depth = {node.pk: index for index, node in enumerate(chain)}
    nearest: dict[Any, CategoryAttribute] = {}
    for link in links:
        current = nearest.get(link.attribute_id)
        if current is None or depth[link.category_id] >= depth[current.category_id]:
            nearest[link.attribute_id] = link
    return sorted(
        nearest.values(),
        key=lambda link: (link.attribute.position, link.attribute.name),
    )


@transaction.atomic
def set_product_specs(
    *, product: Product, value_ids: list[Any], actor: Any = None
) -> list[ProductAttributeValue]:
    """Replace a product's specification values with exactly `value_ids`.

    Replace rather than append, because that is the shape the form has: it
    sends the ticks as they now stand, and a caller that has to diff before
    saving will eventually forget to.  Re-sending the same set is a no-op.

    Two rules are enforced here rather than in the serializer, so a management
    command or a shell cannot go round them:

    1. **A variant-defining attribute is not a spec.**  Size and Colour build
       SKUs; stating "Size: M" once on the product as well would leave two
       places claiming the same fact, and only one of them sellable.
    2. **Every id must exist.**  An unknown one is a caller bug, and silently
       dropping it would store a spec list nobody asked for.

    The attribute is derived from the value rather than accepted alongside it,
    so the two can never disagree.
    """
    wanted = list(dict.fromkeys(str(value_id) for value_id in value_ids))
    values = {
        str(value.pk): value
        for value in AttributeValue.objects.filter(pk__in=wanted).select_related("attribute")
    }

    missing = [value_id for value_id in wanted if value_id not in values]
    if missing:
        raise ValidationError(
            "Those specification values no longer exist.",
            details={"spec_values": missing},
        )

    axes = sorted(
        {
            values[value_id].attribute.name
            for value_id in wanted
            if values[value_id].attribute.is_variant_defining
        }
    )
    if axes:
        joined = ", ".join(axes)
        raise ValidationError(
            f"{joined} build separate SKUs, so {'they' if len(axes) > 1 else 'it'} "
            "cannot also be stated as a specification. Pick the values in the "
            "variant matrix instead.",
            details={"spec_values": axes},
        )

    existing = {str(row.attribute_value_id): row for row in product.spec_values.all()}
    removed = [row for value_id, row in existing.items() if value_id not in set(wanted)]
    added = [value_id for value_id in wanted if value_id not in existing]

    if removed:
        ProductAttributeValue.objects.filter(pk__in=[row.pk for row in removed]).delete()
    if added:
        ProductAttributeValue.objects.bulk_create(
            [ProductAttributeValue(product=product, attribute_value=values[v]) for v in added]
        )

    if added or removed:
        audit.record(
            action=audit.AuditAction.UPDATE,
            entity=product,
            actor=actor,
            old_values={"specs": sorted(str(existing[v].attribute_value) for v in existing)},
            new_values={"specs": sorted(str(values[v]) for v in wanted)},
            reason="Specification attributes changed",
        )

    return list(product.spec_values.select_related("attribute_value__attribute").all())


def spec_payload(product: Product) -> list[dict[str, Any]]:
    """A product's specifications, grouped by attribute, ready to render.

    Reads `product.spec_values.all()`, so a caller that prefetched it pays no
    extra query and one that did not pays exactly one -- the same contract
    `merchandising.price_drop_payload` keeps with the variants.

    Grouped rather than flat because one attribute may hold several values
    ("Features: Waterproof, Lightweight") and a spec list that repeated the
    term once per value would read as several different facts.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for link in product.spec_values.all():
        value = link.attribute_value
        attribute = value.attribute
        row = grouped.setdefault(
            attribute.code,
            {
                "attribute_code": attribute.code,
                "attribute_name": attribute.name,
                "kind": attribute.kind,
                "values": [],
            },
        )
        row["values"].append({"value": value.value, "label": value.display, "swatch": value.swatch})
    return list(grouped.values())


def unique_slug(model: Any, value: str, *, field: str = "slug") -> str:
    base = slugify(value)[:200] or "item"
    candidate, counter = base, 1
    while model.objects.filter(**{field: candidate}).exists():
        counter += 1
        candidate = f"{base}-{counter}"
    return candidate
