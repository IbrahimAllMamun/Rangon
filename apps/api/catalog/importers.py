"""Loading a catalogue from a spreadsheet.

A shop that already has stock does not start with an empty database — it starts
with a few hundred items in a spreadsheet, and typing them into
`/admin/products/new` one at a time *is* the launch. This turns that file into
products, variants and opening stock.

## The shape of the file

**One row per variant, product columns repeated.** That is how a shop's own
spreadsheet already looks, and it is the same shape the product feed publishes,
so a merchant can round-trip: export the feed, edit it, import it back.

```csv
product_name,category,brand,sku,size,color,price,cost,opening_stock
Classic Kurti,Women > Ethnic,Rangon,KUR-M-MAR,M,Maroon,1290,600,12
Classic Kurti,Women > Ethnic,Rangon,KUR-L-MAR,L,Maroon,1290,600,8
```

Rows are grouped into products by `slug` when there is one and by `product_name`
otherwise, so the two rows above make one product with two variants.

## Four decisions this makes, and why

**Nothing is written until every row parses.** The whole import is one
transaction. A catalogue half-loaded, with no record of where it stopped, is
worse than one not loaded at all — you cannot safely re-run the file, and you
cannot tell by looking which half is there.

**A dry run is the default posture.** `plan()` reports exactly what would
happen, including which categories and brands do not exist yet, and `apply()`
does it. Missing categories and brands are *created*, which is what makes a
first import possible at all — but a typo would otherwise quietly become a new
category, so the preview names every one it would create. Seeing the list is
what makes creating them safe.

**The SKU is the identity.** A row whose SKU already exists updates that
variant's price, cost and barcode. A shop re-prices by editing the same
spreadsheet and importing it again, and that must not produce a second variant.

**Opening stock is only for variants this import creates.** Re-importing a file
must never double the stock, and stock is not a column you edit — it is a ledger
(`CLAUDE.md` §3.2). So `opening_stock` is a receipt written through
`inventory.services` for a brand-new variant, and ignored for one that already
exists. Correcting a figure on an existing variant is `/admin/inventory`, which
records who counted and why.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction

from accounts.models import Branch, User
from catalog.models import (
    Attribute,
    AttributeKind,
    AttributeValue,
    Brand,
    Category,
    Product,
    ProductVariant,
    PublishStatus,
    VariantAttributeValue,
)
from catalog.services import unique_slug
from core import audit
from core.exceptions import ValidationError
from inventory import services as inventory_services

#: Columns a row cannot do without. Everything else has a defensible default.
REQUIRED_COLUMNS = ("product_name", "sku", "price")

#: Recognised columns. Anything else in the file is reported and ignored rather
#: than silently dropped -- a misspelled `pirce` header is exactly the mistake
#: that otherwise imports a whole catalogue at zero.
KNOWN_COLUMNS = (
    *REQUIRED_COLUMNS,
    "slug",
    "category",
    "brand",
    "short_description",
    "description",
    "material",
    "care_instructions",
    "barcode",
    "cost",
    "compare_at_price",
    "size",
    "color",
    "weight_grams",
    "opening_stock",
    "published",
)

#: A guard on the file, not on the shop: a catalogue this size is a mistake or a
#: wrong file, and either way the operator should see it before it runs.
MAX_ROWS = 5000

TRUTHY = {"1", "true", "yes", "y", "t", "published", "active"}
FALSEY = {"0", "false", "no", "n", "f", "draft", "unpublished", ""}


@dataclass
class RowError:
    """One problem, addressed to the person looking at the spreadsheet."""

    line: int
    column: str
    message: str


@dataclass
class ImportPlan:
    """What the file would do. The preview an operator approves."""

    products_created: list[str] = field(default_factory=list)
    products_updated: list[str] = field(default_factory=list)
    variants_created: list[str] = field(default_factory=list)
    variants_updated: list[str] = field(default_factory=list)
    categories_created: list[str] = field(default_factory=list)
    brands_created: list[str] = field(default_factory=list)
    stock_receipts: int = 0
    errors: list[RowError] = field(default_factory=list)
    ignored_columns: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "products_created": self.products_created,
            "products_updated": self.products_updated,
            "variants_created": self.variants_created,
            "variants_updated": self.variants_updated,
            "categories_created": self.categories_created,
            "brands_created": self.brands_created,
            "stock_receipts": self.stock_receipts,
            "ignored_columns": self.ignored_columns,
            "errors": [
                {"line": e.line, "column": e.column, "message": e.message} for e in self.errors
            ],
        }


@dataclass
class ParsedRow:
    """One spreadsheet line, after parsing and before anything is written."""

    line: int
    product_key: str
    product_name: str
    slug: str
    category: str
    brand: str
    short_description: str
    description: str
    material: str
    care_instructions: str
    published: bool
    sku: str
    barcode: str
    price: Decimal
    cost: Decimal
    compare_at_price: Decimal | None
    size: str
    color: str
    weight_grams: int | None
    opening_stock: int


# --------------------------------------------------------------------- parsing


def _decimal(raw: str, *, line: int, column: str, errors: list[RowError]) -> Decimal | None:
    """Money, read the way a person types it: `1,290`, `৳1290`, `1290.00`."""
    cleaned = str(raw or "").strip().replace(",", "").replace("৳", "").replace("Tk", "").strip()
    if not cleaned:
        return None
    try:
        value = Decimal(cleaned)
    except (InvalidOperation, ArithmeticError):
        errors.append(RowError(line, column, f"{raw!r} is not a number."))
        return None
    if value < 0:
        errors.append(RowError(line, column, "Cannot be negative."))
        return None
    return value


def _integer(raw: str, *, line: int, column: str, errors: list[RowError]) -> int | None:
    cleaned = str(raw or "").strip().replace(",", "")
    if not cleaned:
        return None
    try:
        value = int(Decimal(cleaned))
    except (InvalidOperation, ArithmeticError, ValueError):
        errors.append(RowError(line, column, f"{raw!r} is not a whole number."))
        return None
    if value < 0:
        errors.append(RowError(line, column, "Cannot be negative."))
        return None
    return value


def _boolean(raw: str, *, default: bool = True) -> bool:
    cleaned = str(raw or "").strip().lower()
    if cleaned in TRUTHY:
        return True
    if cleaned in FALSEY:
        return False
    return default


def parse(content: str) -> tuple[list[ParsedRow], list[RowError], list[str]]:
    """Read the file into rows, collecting *every* problem rather than the first.

    An operator fixing a spreadsheet wants the whole list in one pass. Stopping
    at the first bad cell turns a five-minute correction into twenty round
    trips.
    """
    errors: list[RowError] = []
    # `utf-8-sig` handling happens at the edge; here a stray BOM would only ever
    # corrupt the first header, so strip it defensively.
    reader = csv.DictReader(io.StringIO(content.lstrip("﻿")))

    if reader.fieldnames is None:
        raise ValidationError("The file is empty.")

    headers = [(name or "").strip().lower().replace(" ", "_") for name in reader.fieldnames]
    missing = [column for column in REQUIRED_COLUMNS if column not in headers]
    if missing:
        raise ValidationError(
            f"The file is missing the column{'s' if len(missing) > 1 else ''} "
            f"{', '.join(missing)}. Every row needs at least "
            f"{', '.join(REQUIRED_COLUMNS)}."
        )
    ignored = sorted({column for column in headers if column and column not in KNOWN_COLUMNS})

    rows: list[ParsedRow] = []
    seen_skus: dict[str, int] = {}

    for index, raw_row in enumerate(reader):
        line = index + 2  # a spreadsheet's own numbering: the header is line 1
        if line - 1 > MAX_ROWS:
            errors.append(
                RowError(
                    line,
                    "",
                    f"More than {MAX_ROWS} rows. Split the file, or check it is "
                    f"the one you meant to upload.",
                )
            )
            break

        row = {
            (key or "").strip().lower().replace(" ", "_"): (value or "").strip()
            for key, value in raw_row.items()
            if key is not None
        }
        if not any(row.values()):
            continue  # a blank line between sections is not an error

        name = row.get("product_name", "")
        sku = row.get("sku", "")
        if not name:
            errors.append(RowError(line, "product_name", "Required."))
        if not sku:
            errors.append(RowError(line, "sku", "Required."))
        if sku:
            if sku in seen_skus:
                errors.append(
                    RowError(
                        line,
                        "sku",
                        f"{sku!r} is already used on line {seen_skus[sku]}. "
                        f"A SKU identifies one variant.",
                    )
                )
            else:
                seen_skus[sku] = line

        price = _decimal(row.get("price", ""), line=line, column="price", errors=errors)
        if price is None and row.get("price", "").strip() == "":
            errors.append(RowError(line, "price", "Required."))
        cost = _decimal(row.get("cost", ""), line=line, column="cost", errors=errors)
        compare = _decimal(
            row.get("compare_at_price", ""), line=line, column="compare_at_price", errors=errors
        )
        weight = _integer(
            row.get("weight_grams", ""), line=line, column="weight_grams", errors=errors
        )
        stock = _integer(
            row.get("opening_stock", ""), line=line, column="opening_stock", errors=errors
        )

        if not name or not sku or price is None:
            continue  # nothing coherent to build a row from

        slug = row.get("slug", "").strip()
        rows.append(
            ParsedRow(
                line=line,
                # Group by slug when the file gives one, because two products
                # may legitimately share a name; by name otherwise.
                product_key=slug or name.strip().lower(),
                product_name=name,
                slug=slug,
                category=row.get("category", ""),
                brand=row.get("brand", ""),
                short_description=row.get("short_description", ""),
                description=row.get("description", ""),
                material=row.get("material", ""),
                care_instructions=row.get("care_instructions", ""),
                published=_boolean(row.get("published", ""), default=True),
                sku=sku,
                barcode=row.get("barcode", ""),
                price=price,
                cost=cost if cost is not None else Decimal("0.00"),
                compare_at_price=compare,
                size=row.get("size", ""),
                color=row.get("color", ""),
                weight_grams=weight,
                opening_stock=stock or 0,
            )
        )

    if not rows and not errors:
        raise ValidationError("The file has a header but no rows.")
    return rows, errors, ignored


# ------------------------------------------------------------------- resolving


def _category_for(path: str, *, created: list[str], commit: bool) -> Category | None:
    """Resolve `Women > Ethnic > Kurti`, creating what is missing.

    Matched case-insensitively on name within the parent, so `women` finds
    `Women` rather than making a second one.
    """
    parts = [part.strip() for part in str(path or "").split(">") if part.strip()]
    if not parts:
        return None

    parent: Category | None = None
    missing_from: int | None = None

    for index, part in enumerate(parts):
        if missing_from is None:
            existing = Category.objects.filter(name__iexact=part, parent=parent).first()
            if existing is not None:
                parent = existing
                continue
            missing_from = index

        # Once one level is absent every level below it is too, and there is no
        # parent row to look them up under. Planning still names all of them:
        # the preview exists so a typo is seen as a typo, and reporting only
        # `Women` while silently intending `Women > Ethnic` as well is exactly
        # the omission it is meant to catch.
        created.append(" > ".join(parts[: index + 1]))
        if commit:
            parent = Category.objects.create(
                name=part, slug=unique_slug(Category, part), parent=parent
            )

    if not commit and missing_from is not None:
        return None  # nothing was created, so there is no row to return
    return parent


def _brand_for(name: str, *, created: list[str], commit: bool) -> Brand | None:
    cleaned = str(name or "").strip()
    if not cleaned:
        return None
    existing = Brand.objects.filter(name__iexact=cleaned).first()
    if existing is not None:
        return existing
    created.append(cleaned)
    if not commit:
        return None
    return Brand.objects.create(name=cleaned, slug=unique_slug(Brand, cleaned))


def _attribute_value(kind: str, code: str, label: str, value: str) -> AttributeValue:
    """The `Size: M` / `Colour: Maroon` row, made if the shop has not got it.

    Keyed on `kind` for the same reason the feed reads it: a shop has more than
    one colour attribute and more than one size attribute, and the kind is what
    they have in common.
    """
    attribute = Attribute.objects.filter(kind=kind).order_by("position", "pk").first()
    if attribute is None:
        attribute = Attribute.objects.create(name=label, code=code, kind=kind)
    existing = AttributeValue.objects.filter(attribute=attribute, value__iexact=value).first()
    if existing is not None:
        return existing
    return AttributeValue.objects.create(attribute=attribute, value=value, label=value)


# -------------------------------------------------------------------- planning


def plan(content: str) -> ImportPlan:
    """What this file would do, without doing any of it."""
    return _run(content, commit=False, branch=None, actor=None)


def apply(
    content: str,
    *,
    branch: Branch | None,
    actor: User | None = None,
) -> ImportPlan:
    """Do it, or do none of it.

    One transaction on purpose: a catalogue half-loaded with no record of where
    it stopped cannot be safely re-run and cannot be read to find out.
    """
    with transaction.atomic():
        result = _run(content, commit=True, branch=branch, actor=actor)
        if not result.ok:
            transaction.set_rollback(True)
        return result


def _run(
    content: str,
    *,
    commit: bool,
    branch: Branch | None,
    actor: User | None,
) -> ImportPlan:
    rows, errors, ignored = parse(content)
    result = ImportPlan(errors=list(errors), ignored_columns=ignored)
    if errors:
        return result

    if commit and branch is None and any(row.opening_stock for row in rows):
        raise ValidationError(
            "This file carries opening stock, so it needs a branch to receive it into."
        )

    grouped: dict[str, list[ParsedRow]] = {}
    for row in rows:
        grouped.setdefault(row.product_key, []).append(row)

    for group in grouped.values():
        head = group[0]
        category = _category_for(head.category, created=result.categories_created, commit=commit)
        brand = _brand_for(head.brand, created=result.brands_created, commit=commit)

        product = (
            Product.objects.filter(slug=head.slug).first()
            if head.slug
            else Product.objects.filter(name__iexact=head.product_name).first()
        )

        if product is None:
            result.products_created.append(head.product_name)
            if commit:
                if category is None:
                    raise ValidationError(
                        f"{head.product_name!r} has no category. Every product needs one: "
                        f"add a `category` column, for example 'Women > Ethnic'."
                    )
                product = Product.objects.create(
                    name=head.product_name,
                    slug=head.slug or unique_slug(Product, head.product_name),
                    category=category,
                    brand=brand,
                    short_description=head.short_description,
                    description=head.description,
                    material=head.material,
                    care_instructions=head.care_instructions,
                    status=PublishStatus.ACTIVE,
                    published=head.published,
                    created_by=actor,
                )
        else:
            result.products_updated.append(product.name)
            if commit:
                # Only overwrite what the file actually says. A blank
                # description column means "not in this file", not "erase it".
                changed: list[str] = []
                for attr, value in (
                    ("category", category),
                    ("brand", brand),
                    ("short_description", head.short_description),
                    ("description", head.description),
                    ("material", head.material),
                    ("care_instructions", head.care_instructions),
                ):
                    if value and getattr(product, attr) != value:
                        setattr(product, attr, value)
                        changed.append(attr)
                if changed:
                    product.save(update_fields=[*changed, "updated_at"])

        for row in group:
            _variant(row, product=product, result=result, commit=commit, branch=branch, actor=actor)

    if commit and result.ok:
        audit.record(
            action=audit.AuditAction.PRODUCT_IMPORT,
            entity=None,
            actor=actor,
            new_values={
                "products_created": len(result.products_created),
                "products_updated": len(result.products_updated),
                "variants_created": len(result.variants_created),
                "variants_updated": len(result.variants_updated),
                "stock_receipts": result.stock_receipts,
            },
            reason="Catalogue imported from a spreadsheet",
            branch=branch,
        )
    return result


def _variant(
    row: ParsedRow,
    *,
    product: Product | None,
    result: ImportPlan,
    commit: bool,
    branch: Branch | None,
    actor: User | None,
) -> None:
    existing = ProductVariant.objects.filter(sku=row.sku).first()

    if existing is not None:
        result.variants_updated.append(row.sku)
        if commit:
            existing.price = row.price
            if row.cost:
                existing.cost = row.cost
            existing.compare_at_price = row.compare_at_price
            if row.barcode:
                existing.barcode = row.barcode
            if row.weight_grams is not None:
                existing.weight_grams = row.weight_grams
            existing.save()
        # Deliberately no stock: see the module docstring. An existing variant's
        # figure is corrected on /admin/inventory, where it is counted, audited
        # and attributed.
        return

    result.variants_created.append(row.sku)
    if row.opening_stock:
        result.stock_receipts += 1
    if not commit or product is None:
        return

    variant = ProductVariant.objects.create(
        product=product,
        sku=row.sku,
        barcode=row.barcode or None,
        price=row.price,
        cost=row.cost,
        compare_at_price=row.compare_at_price,
        weight_grams=row.weight_grams,
        status=PublishStatus.ACTIVE,
    )
    for kind, code, label, value in (
        (AttributeKind.SIZE, "size", "Size", row.size),
        (AttributeKind.COLOR, "color", "Colour", row.color),
    ):
        if not value:
            continue
        attribute_value = _attribute_value(kind, code, label, value)
        VariantAttributeValue.objects.create(
            variant=variant,
            attribute=attribute_value.attribute,
            attribute_value=attribute_value,
        )

    if row.opening_stock and branch is not None:
        # Through the ledger, never as a column write (CLAUDE.md §3.2). This
        # leaves an InventoryTransaction saying where the figure came from.
        inventory_services.receive_stock(
            branch=branch,
            variant=variant,
            quantity=row.opening_stock,
            unit_cost=row.cost,
            actor=actor,
            reference_type="product_import",
            notes=f"Opening stock, imported from a spreadsheet (line {row.line})",
        )
