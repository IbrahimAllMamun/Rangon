"""Catalog services: SKU/barcode generation and variant matrix creation."""

from __future__ import annotations

import itertools
import re
from typing import Any

from django.db import transaction

from catalog.models import (
    Attribute,
    AttributeKind,
    AttributeValue,
    Category,
    CategoryAttribute,
    Product,
    ProductAttributeValue,
    ProductVariant,
    PublishStatus,
    SizeChart,
    SizeChartRow,
    VariantAttributeValue,
)
from core import audit
from core.exceptions import Conflict, ValidationError
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
        # A specification builds no SKUs (business-rules §5a rule 1). The guard
        # used to live only on the specification side, so Material could be
        # stated on a product *and* sprout variants -- the one state §5a exists
        # to make impossible (D84).
        if not attribute.is_variant_defining:
            message = f"{attribute.name} is a specification, not a variant option."
            raise ValidationError(message, details={"selections": [message]})
        if not values:
            message = f"Choose at least one {attribute.name} value."
            raise ValidationError(message, details={"selections": [message]})
        options = list(attribute.values.filter(value__in=values))
        # All or nothing: an unknown value used to be skipped as long as one
        # other matched, so S and XXXL made S alone and said nothing (D84).
        unknown = sorted(set(values) - {option.value for option in options})
        if unknown:
            message = f"{attribute.name} has no value {', '.join(unknown)}."
            raise ValidationError(message, details={"selections": [message]})
        groups.append(options)

    existing = {
        frozenset(str(link.attribute_value_id) for link in variant.attribute_values.all())
        for variant in product.variants.prefetch_related("attribute_values")
    }
    _refuse_options_beside_a_single_version(product)

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


def _live_variants(product: Product) -> list[ProductVariant]:
    return list(
        product.variants.exclude(status=PublishStatus.ARCHIVED).prefetch_related("attribute_values")
    )


def _refuse_options_beside_a_single_version(product: Product) -> None:
    """A product is one version or several, never both.

    A SKU with no options beside sized ones is a version the storefront's picker
    cannot select and the POS cannot describe. Archiving the single SKU first
    keeps its history and frees the product to take options.
    """
    single = next((v for v in _live_variants(product) if not v.attribute_values.all()), None)
    if single is not None:
        raise Conflict(
            f"{product.name} is sold as one version ({single.sku}). Archive that SKU "
            "before giving it sizes or colours.",
            details={"single_variant": str(single.pk), "sku": single.sku},
        )


@transaction.atomic
def create_single_variant(
    *,
    product: Product,
    price: Any,
    cost: Any = 0,
    actor: Any = None,
) -> list[ProductVariant]:
    """One SKU with no sizes or colours: a lipstick in one shade, a one-size bag.

    `generate_variants` needs at least one attribute value, so until this
    existed such a product could be created by the CSV import and nowhere else
    -- not on the product form, and not on a purchase order (business-rules.md
    § 7a.6). The SKU is derived the way every generated one is.

    Returns a list, the shape `generate_variants` returns: the new variant, or
    nothing when the product already has its single SKU, so a retried submit
    cannot make a second. The product row is locked for that decision.
    """
    locked = Product.objects.select_for_update().get(pk=product.pk)
    live = _live_variants(locked)
    if any(not variant.attribute_values.all() for variant in live):
        return []
    if live:
        raise Conflict(
            f"{locked.name} already comes in {len(live)} version"
            f"{'' if len(live) == 1 else 's'}. Add another size or colour instead.",
            details={"variant_count": len(live)},
        )

    variant = create_variant(
        product=locked, attribute_values=[], price=price, cost=cost, actor=actor
    )
    audit.record(
        action=audit.AuditAction.CREATE,
        entity=locked,
        actor=actor,
        new_values={"variants_created": 1, "sku": variant.sku},
        reason="Single-version SKU created",
    )
    return [variant]


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


#: Wider than any real chart (a garment chart runs to six or seven columns), and
#: narrow enough that the product-page table still fits a dialog.
MAX_CHART_COLUMNS = 12
MAX_COLUMN_LABEL = 40
MAX_CELL_LENGTH = 32
MAX_CHART_NOTES = 2000


def _chart_error(field: str, message: str) -> ValidationError:
    """Keyed by field, so the chart editor can put the message beside it."""
    return ValidationError(message, details={field: [message]})


def _clean_columns(columns: Any) -> list[str]:
    if not isinstance(columns, list) or not columns:
        raise _chart_error("columns", "Add at least one column, such as Chest (cm) or UK.")
    if len(columns) > MAX_CHART_COLUMNS:
        raise _chart_error("columns", f"A chart can have at most {MAX_CHART_COLUMNS} columns.")

    cleaned: list[str] = []
    seen: set[str] = set()
    for label in columns:
        text = str(label or "").strip()
        if not text:
            raise _chart_error("columns", "Every column needs a heading.")
        if len(text) > MAX_COLUMN_LABEL:
            raise _chart_error(
                "columns", f"“{text[:20]}…” is too long for a heading ({MAX_COLUMN_LABEL} max)."
            )
        # Case-insensitive: "UK" and "uk" side by side read as one column twice.
        if text.casefold() in seen:
            raise _chart_error("columns", f"“{text}” is there twice. Each heading must differ.")
        seen.add(text.casefold())
        cleaned.append(text)
    return cleaned


def _clean_rows(
    rows: Any, *, attribute: Attribute, width: int
) -> list[tuple[AttributeValue, list[str]]]:
    """Each row is `{"attribute_value": <id>, "cells": [...]}`.

    Every size must be one of the attribute's own values -- a chart for Shoe
    size cannot describe a shirt's M -- and appear once. Every row needs one
    cell per column: a short row would shift its figures under the wrong
    heading, which on a size chart is a wrong answer that looks right.
    """
    if not isinstance(rows, list) or not rows:
        raise _chart_error("rows", "Include at least one size.")

    values = {str(value.pk): value for value in AttributeValue.objects.filter(attribute=attribute)}
    cleaned: list[tuple[AttributeValue, list[str]]] = []
    seen: set[str] = set()
    for row in rows:
        value_id = str((row or {}).get("attribute_value") or "")
        value = values.get(value_id)
        if value is None:
            raise _chart_error(
                "rows", f"One of those sizes is not a {attribute.name} value. Reload and try again."
            )
        if value_id in seen:
            raise _chart_error("rows", f"{value.display} is in the chart twice.")
        seen.add(value_id)

        cells = row.get("cells")
        if not isinstance(cells, list) or len(cells) != width:
            raise _chart_error(
                "rows",
                f"{value.display} has {len(cells) if isinstance(cells, list) else 0} "
                f"figure(s) for {width} column(s). Every size needs one per column.",
            )
        texts = [str(cell if cell is not None else "").strip() for cell in cells]
        if not any(texts):
            raise _chart_error(
                "rows", f"{value.display} has no figures. Fill it in, or leave that size out."
            )
        long = next((text for text in texts if len(text) > MAX_CELL_LENGTH), None)
        if long is not None:
            raise _chart_error(
                "rows",
                f"“{long[:20]}…” under {value.display} is too long ({MAX_CELL_LENGTH} max).",
            )
        cleaned.append((value, texts))
    return cleaned


def _chart_snapshot(chart: SizeChart) -> dict[str, Any]:
    rows = SizeChartRow.objects.filter(chart=chart).select_related("attribute_value")
    return {
        "name": chart.name,
        "system": chart.system,
        "columns": list(chart.columns),
        "rows": {row.attribute_value.display: list(row.cells) for row in rows},
        "notes": chart.notes,
    }


@transaction.atomic
def save_size_chart(
    *,
    chart: SizeChart | None = None,
    attribute: Attribute | None = None,
    data: dict[str, Any],
    actor: Any = None,
) -> SizeChart:
    """Create a size chart, or update one, and validate the result as a whole.

    `data` may hold `name`, `system`, `notes`, `position`, `columns` and
    `rows`; on an update a missing key keeps what is stored. Rows are
    **replaced, not merged**, for the reason specifications are
    (`set_product_specs`): the editor sends the grid as it now stands.

    The *finished* chart is what gets validated, so a caller that changes the
    columns without sending rows is refused rather than left with figures
    under the wrong headings.

    The attribute is fixed at creation. Every row is one of its values, so
    moving a chart to another attribute would invalidate all of them at once.
    """
    if chart is None:
        if attribute is None:
            raise _chart_error("attribute", "Choose the size attribute this chart describes.")
    elif attribute is not None and attribute.pk != chart.attribute_id:
        raise _chart_error(
            "attribute",
            "A chart cannot move to another attribute; its sizes belong to this one. "
            "Create a new chart instead.",
        )
    else:
        attribute = chart.attribute

    assert attribute is not None  # narrowed above, for the type checker
    if attribute.kind != AttributeKind.SIZE:
        raise _chart_error(
            "attribute",
            f"{attribute.name} is a {attribute.get_kind_display().lower()} attribute. "
            "Only a Size attribute can carry a size chart.",
        )

    name = str(data.get("name", chart.name if chart else "")).strip()
    if not name:
        raise _chart_error("name", "Give the chart a name, such as “Men's shirts”.")
    if len(name) > 120:
        raise _chart_error("name", "Keep the name under 120 characters.")
    clash = SizeChart.objects.filter(attribute=attribute, name__iexact=name)
    if chart is not None:
        clash = clash.exclude(pk=chart.pk)
    if clash.exists():
        raise _chart_error("name", f"{attribute.name} already has a chart called “{name}”.")

    system = str(data.get("system", chart.system if chart else "")).strip()
    if len(system) > 40:
        raise _chart_error("system", "Keep the sizing system under 40 characters.")
    notes = str(data.get("notes", chart.notes if chart else "")).strip()
    if len(notes) > MAX_CHART_NOTES:
        raise _chart_error("notes", f"Keep the notes under {MAX_CHART_NOTES} characters.")
    position = data.get("position", chart.position if chart else 0)

    if "columns" in data:
        columns = _clean_columns(data["columns"])
    else:
        columns = _clean_columns(list(chart.columns) if chart is not None else [])

    if "rows" in data:
        raw_rows = data["rows"]
    elif chart is not None:
        raw_rows = [
            {"attribute_value": row.attribute_value_id, "cells": row.cells}
            for row in SizeChartRow.objects.filter(chart=chart)
        ]
    else:
        raw_rows = []
    rows = _clean_rows(raw_rows, attribute=attribute, width=len(columns))

    before = _chart_snapshot(chart) if chart is not None else None
    if chart is None:
        chart = SizeChart(attribute=attribute, created_by=actor if _is_user(actor) else None)
    chart.name, chart.system, chart.notes = name, system, notes
    chart.position = position or 0
    chart.columns = columns
    chart.save()

    # Through the model, not `chart.rows`: a caller that prefetched the rows
    # would otherwise read its stale cache back for the audit entry below.
    SizeChartRow.objects.filter(chart=chart).delete()
    SizeChartRow.objects.bulk_create(
        [SizeChartRow(chart=chart, attribute_value=value, cells=cells) for value, cells in rows]
    )
    getattr(chart, "_prefetched_objects_cache", {}).pop("rows", None)

    after = _chart_snapshot(chart)
    if before is None:
        audit.record(
            action=audit.AuditAction.CREATE,
            entity=chart,
            actor=actor,
            new_values={"attribute": attribute.name, **after},
            reason="Size chart created",
        )
    else:
        old, new = audit.diff(before, after)
        if new:
            audit.record(
                action=audit.AuditAction.UPDATE,
                entity=chart,
                actor=actor,
                old_values=old,
                new_values=new,
                reason="Size chart changed",
            )

    _revalidate_product_pages()
    return chart


@transaction.atomic
def delete_size_chart(*, chart: SizeChart, actor: Any = None) -> None:
    """Delete a chart no product uses; refuse in words while any does.

    `Product.size_chart` is PROTECT, so the database would refuse anyway --
    with a bare 409 that leaves the admin clicking Delete again. Clearing it
    from the products instead would make their size guides vanish from the
    storefront without anyone having decided that.
    """
    used_by = chart.products.count()
    if used_by:
        raise Conflict(
            f"“{chart.name}” is the size chart for {used_by} "
            f"product{'' if used_by == 1 else 's'} and cannot be deleted. "
            "Pick another chart for them first.",
            details={"product_count": used_by},
        )
    audit.record(
        action=audit.AuditAction.DELETE,
        entity=chart,
        actor=actor,
        old_values=_chart_snapshot(chart),
        reason="Size chart deleted",
    )
    chart.delete()


def size_chart_problem(
    *, chart: SizeChart, category: Category, product: Product | None = None
) -> str | None:
    """Why `chart` cannot describe a product in `category`, or None if it can.

    The same scoping the variant axes follow (docs/business-rules.md §5a rule
    3): a chart fits when its attribute is one the category offers, inherited
    down the tree -- so a shirt is never given a shoe chart. A category that
    declares nothing offers everything. And an axis the product's saved
    variants are already built on always fits, declared or not, because those
    SKUs exist whatever the category now says.
    """
    offered = {link.attribute_id for link in category_attributes(category)}
    if not offered or chart.attribute_id in offered:
        return None
    if (
        product is not None
        and product.pk
        and VariantAttributeValue.objects.filter(
            variant__product=product, attribute_id=chart.attribute_id
        ).exists()
    ):
        return None
    attribute = chart.attribute.name
    return (
        f"“{chart.name}” is a {attribute} chart, and {category.name} does not use {attribute}. "
        "Pick a chart for one of this product's sizes."
    )


@transaction.atomic
def set_product_size_chart(
    *, product: Product, chart: SizeChart | None, actor: Any = None
) -> Product:
    """Point a product at a size chart, or clear it with None.

    The rule lives here, not only in the serializer, so a management command
    or a shell meets it too -- the same arrangement as `set_product_specs`.
    """
    if chart is not None:
        problem = size_chart_problem(chart=chart, category=product.category, product=product)
        if problem:
            raise _chart_error("size_chart", problem)

    before = product.size_chart
    if (before.pk if before else None) == (chart.pk if chart else None):
        return product

    product.size_chart = chart
    product.save(update_fields=["size_chart", "updated_at"])
    audit.record(
        action=audit.AuditAction.UPDATE,
        entity=product,
        actor=actor,
        old_values={"size_chart": before.name if before else None},
        new_values={"size_chart": chart.name if chart else None},
        reason="Size chart changed",
    )
    return product


def size_chart_payload(chart: SizeChart | None) -> dict[str, Any] | None:
    """A chart ready to render on the product page, or None.

    Reads `chart.rows.all()`, so a caller that prefetched the rows pays nothing
    and one that did not pays one query -- the contract `spec_payload` keeps.
    The value's *display* label is sent, so a renamed size reads the new name.
    """
    if chart is None:
        return None
    return {
        "name": chart.name,
        "system": chart.system,
        "attribute_code": chart.attribute.code,
        "attribute_name": chart.attribute.name,
        "columns": list(chart.columns),
        "rows": [
            {
                "value": row.attribute_value.value,
                "label": row.attribute_value.display,
                "cells": list(row.cells),
            }
            for row in chart.rows.all()
        ],
        "notes": chart.notes,
    }


def _is_user(actor: Any) -> bool:
    return actor is not None and getattr(actor, "is_authenticated", False)


def _revalidate_product_pages() -> None:
    """Drop the storefront's cached product pages once the chart is committed.

    Product pages are cached against the `products` tag with a 60-second
    window, and one chart can sit behind hundreds of them -- so the whole tag,
    not a slug per product. Fire-and-forget on commit, the same as the VAT
    setting (`accounts.services`): a lost ping costs a stale chart until the
    window elapses, and no stock or money invariant depends on it.
    """
    from content.tasks import request_revalidation

    transaction.on_commit(lambda: request_revalidation("products"))
