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
    Product,
    ProductVariant,
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


def unique_slug(model: Any, value: str, *, field: str = "slug") -> str:
    base = slugify(value)[:200] or "item"
    candidate, counter = base, 1
    while model.objects.filter(**{field: candidate}).exists():
        counter += 1
        candidate = f"{base}-{counter}"
    return candidate
