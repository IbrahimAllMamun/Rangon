"""Catalog search and faceting.

PostgreSQL trigram + indexed facets, deliberately not a search engine
(ADR-0007).  Every search caller goes through here, so swapping the engine later
is one file.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from django.contrib.postgres.search import SearchQuery, SearchRank, SearchVector
from django.db import DatabaseError, IntegrityError
from django.db.models import Count, F, Max, Min, Q, QuerySet
from django.utils import timezone

from catalog.models import (
    Attribute,
    AttributeValue,
    Category,
    Product,
    ProductVariant,
    PublishStatus,
    SearchTerm,
)

logger = logging.getLogger("rangon.catalog")

SORTS = {
    "relevance": None,
    "newest": "-created_at",
    "price_asc": "min_price",
    "price_desc": "-max_price",
    "name_asc": "name",
    "name_desc": "-name",
}


def visible_products() -> QuerySet[Product]:
    return Product.objects.filter(published=True, status=PublishStatus.ACTIVE)


def search_products(
    queryset: QuerySet[Product] | None = None,
    *,
    query: str = "",
    category_slug: str = "",
    brand_slugs: list[str] | None = None,
    price_min: Decimal | None = None,
    price_max: Decimal | None = None,
    attribute_filters: dict[str, list[str]] | None = None,
    in_stock_only: bool = False,
    branch: Any = None,
    sort: str = "relevance",
) -> QuerySet[Product]:
    """Filtered, sorted product queryset.  Prices come from the variants."""
    products = queryset if queryset is not None else visible_products()
    products = products.select_related("brand", "category").prefetch_related("images")

    if category_slug:
        category = Category.objects.filter(slug=category_slug, is_active=True).first()
        if category is not None:
            products = products.filter(category_id__in=category.descendant_ids())
        else:
            return products.none()

    if brand_slugs:
        products = products.filter(brand__slug__in=brand_slugs)

    if attribute_filters:
        # Each attribute narrows further (AND); values within one attribute widen (OR).
        for attribute_code, values in attribute_filters.items():
            if not values:
                continue
            products = products.filter(
                variants__attribute_values__attribute__code=attribute_code,
                variants__attribute_values__attribute_value__value__in=values,
            )

    products = products.annotate(
        min_price=Min("variants__price"),
        max_price=Max("variants__price"),
    )

    if price_min is not None:
        products = products.filter(min_price__gte=price_min)
    if price_max is not None:
        products = products.filter(min_price__lte=price_max)

    if in_stock_only:
        stock_filter = Q(variants__inventory__on_hand__gt=F("variants__inventory__reserved"))
        if branch is not None:
            stock_filter &= Q(variants__inventory__branch=branch)
        products = products.filter(stock_filter)

    if query:
        cleaned = query.strip()
        # Exact SKU/barcode wins outright — scanning must never be fuzzy.
        exact = products.filter(Q(variants__sku__iexact=cleaned) | Q(variants__barcode=cleaned))
        if exact.exists():
            return exact.distinct()

        vector = (
            SearchVector("name", weight="A")
            + SearchVector("short_description", weight="B")
            + SearchVector("brand__name", weight="B")
            + SearchVector("description", weight="C")
        )
        search_query = SearchQuery(cleaned, search_type="websearch")
        products = (
            products.annotate(rank=SearchRank(vector, search_query))
            .filter(Q(rank__gt=0.01) | Q(name__trigram_similar=cleaned))
            .order_by("-rank")
        )
        if sort == "relevance":
            return products.distinct()

    order_by = SORTS.get(sort)
    if order_by:
        products = products.order_by(order_by)
    elif sort == "relevance" and not query:
        products = products.order_by("-featured", "-created_at")

    return products.distinct()


def facets(*, products: QuerySet[Product], branch: Any = None) -> dict[str, Any]:
    """Available filter values with counts, computed from the current result set."""
    product_ids = list(products.values_list("id", flat=True))
    if not product_ids:
        return {"brands": [], "attributes": [], "price": {"min": 0, "max": 0}}

    brands = list(
        Product.objects.filter(id__in=product_ids, brand__isnull=False)
        .values("brand__slug", "brand__name")
        .annotate(count=Count("id"))
        .order_by("-count", "brand__name")
    )

    values = (
        AttributeValue.objects.filter(
            variant_links__variant__product_id__in=product_ids,
            attribute__is_filterable=True,
        )
        .values(
            "attribute__code",
            "attribute__name",
            "attribute__kind",
            "value",
            "label",
            "swatch",
        )
        .annotate(count=Count("variant_links__variant__product", distinct=True))
        .order_by("attribute__position", "position", "value")
    )

    grouped: dict[str, dict[str, Any]] = {}
    for row in values:
        code = row["attribute__code"]
        grouped.setdefault(
            code,
            {
                "code": code,
                "name": row["attribute__name"],
                "kind": row["attribute__kind"],
                "values": [],
            },
        )
        grouped[code]["values"].append(
            {
                "value": row["value"],
                "label": row["label"] or row["value"],
                "swatch": row["swatch"],
                "count": row["count"],
            }
        )

    price_range = ProductVariant.objects.filter(product_id__in=product_ids).aggregate(
        min=Min("price"), max=Max("price")
    )

    return {
        "brands": [
            {"slug": b["brand__slug"], "name": b["brand__name"], "count": b["count"]}
            for b in brands
        ],
        "attributes": list(grouped.values()),
        "price": {
            "min": price_range["min"] or Decimal("0.00"),
            "max": price_range["max"] or Decimal("0.00"),
        },
    }


MAX_TERM_LENGTH = 120


def normalise_term(query: str) -> str:
    return " ".join((query or "").strip().lower().split())[:MAX_TERM_LENGTH]


def log_search(query: str, *, result_count: int) -> None:
    """Record a search term. Fire-and-forget: never fails a shopper's search.

    Aggregated per term, so the table stays small however busy the shop gets.
    """
    term = normalise_term(query)
    if not term:
        return
    try:
        updated = SearchTerm.objects.filter(term=term).update(
            hits=F("hits") + 1,
            last_result_count=result_count,
            last_searched_at=timezone.now(),
        )
        if not updated:
            SearchTerm.objects.create(
                term=term,
                hits=1,
                last_result_count=result_count,
                last_searched_at=timezone.now(),
            )
    except (DatabaseError, IntegrityError):  # pragma: no cover - analytics only
        logger.warning("Could not log the search term %r", term)


def popular_terms(*, limit: int = 5) -> list[str]:
    """Terms shoppers actually search *and* find something for.

    A popular term that returns nothing is a merchandising signal, not a
    suggestion — offering it would send the next shopper to an empty page.
    """
    return list(
        SearchTerm.objects.filter(last_result_count__gt=0, hits__gt=0)
        .order_by("-hits", "term")
        .values_list("term", flat=True)[:limit]
    )


def suggest(query: str, *, limit: int = 5) -> dict[str, Any]:
    """Type-ahead for the navbar: products, categories, popular searches."""
    cleaned = (query or "").strip()
    if len(cleaned) < 2:
        return {"products": [], "categories": [], "popular": popular_terms()}

    # Substring, not full text, and deliberately not trigram. `search_products`
    # ranks whole words, so "shi" scores nothing against "Cotton Shirt" —
    # correct for a results page, wrong for a box being typed into. Trigram goes
    # the other way and offers "Embroidered Panjabi" for "shi"; a suggestion
    # list that is merely plausible is worse than a short one.
    products = list(
        visible_products()
        .filter(Q(name__icontains=cleaned) | Q(brand__name__icontains=cleaned))
        .select_related("brand")
        .prefetch_related("images")
        .annotate(price_from=Min("variants__price"))
        .order_by("name")[:limit]
    )

    categories = list(
        Category.objects.filter(is_active=True, name__icontains=cleaned).select_related(
            "parent", "parent__parent"
        )[:limit]
    )

    return {"products": products, "categories": categories, "popular": popular_terms()}


def admin_search_variants(query: str, *, limit: int = 20) -> QuerySet[ProductVariant]:
    """POS/admin lookup: exact barcode, then exact SKU, then fuzzy name."""
    cleaned = (query or "").strip()
    variants = ProductVariant.objects.select_related("product", "product__category")
    if not cleaned:
        return variants.none()

    exact = variants.filter(Q(barcode=cleaned) | Q(sku__iexact=cleaned))
    if exact.exists():
        return exact[:limit]

    return variants.filter(
        Q(sku__icontains=cleaned)
        | Q(product__name__icontains=cleaned)
        | Q(product__name__trigram_similar=cleaned)
    ).order_by("product__name", "position")[:limit]


def attribute_options() -> list[dict[str, Any]]:
    return [
        {
            "code": attribute.code,
            "name": attribute.name,
            "kind": attribute.kind,
            "is_variant_defining": attribute.is_variant_defining,
            "values": [
                {"value": v.value, "label": v.display, "swatch": v.swatch}
                for v in attribute.values.all()
            ],
        }
        for attribute in Attribute.objects.prefetch_related("values").order_by("position")
    ]
