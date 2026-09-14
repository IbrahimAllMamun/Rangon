"""Merchandising selectors: what to put in front of a shopper, and why.

Two questions, both answered from orders that actually happened rather than
from a field someone remembered to tick.

`price_drops` ranks by how much is off, as a percentage, so the row leads with
the thing a shopper would call a bargain rather than the most expensive item
that happens to be reduced.

`bought_together` is real basket co-occurrence: the products that turned up in
the same orders as this one, most frequent first. It degrades rather than
returning an empty row — co-occurrence, then the same category, and the row is
simply short if neither has anything, because an empty shelf is better than a
shelf of things nobody asked for.
"""

from __future__ import annotations

from typing import Any

from django.db.models import Count, DecimalField, ExpressionWrapper, F
from django.db.models.functions import Cast

from catalog.models import Product
from catalog.search import visible_products
from orders.models import OrderItem, OrderStatus

#: Orders that represent real trade. Cancelled baskets are not a signal, and a
#: recommendation built on them would promote whatever people changed their
#: minds about. Mirrors `reports.services.SOLD_STATUSES`.
SOLD_STATUSES = [
    OrderStatus.CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.PACKED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.RETURN_REQUESTED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
]

MONEY = DecimalField(max_digits=14, decimal_places=2)


def price_drops(*, limit: int = 12) -> Any:
    """Visible products with a real reduction, deepest percentage first.

    `compare_at_price` is per variant and only counts when it is genuinely
    above the price -- a `compare_at` at or below the price is a leftover, not
    a discount, and `ProductVariant.is_on_sale` says the same thing in the
    model. The percentage is computed in the database so the ordering is the
    database's and the page can be sliced before anything is fetched.
    """
    discount = ExpressionWrapper(
        (Cast(F("variants__compare_at_price"), MONEY) - Cast(F("variants__price"), MONEY))
        * 100
        / Cast(F("variants__compare_at_price"), MONEY),
        output_field=MONEY,
    )
    return (
        visible_products()
        .filter(
            variants__compare_at_price__isnull=False,
            variants__compare_at_price__gt=F("variants__price"),
        )
        .annotate(drop_percent=discount)
        .order_by("-drop_percent")
        .distinct()[:limit]
    )


def bought_together(*, product: Product, limit: int = 8) -> list[Product]:
    """Products that appeared in the same orders as this one.

    Ranked by how many distinct orders they shared, which is the only honest
    reading of "customers also bought". Falls back to the same category so the
    row is not empty on a young catalogue -- a shop with forty orders has very
    little co-occurrence, and an empty row on every product page would read as
    a broken feature rather than a quiet one.
    """
    orders_with_this = OrderItem.objects.filter(
        variant__product=product, order__status__in=SOLD_STATUSES
    ).values("order_id")

    co_occurring = (
        OrderItem.objects.filter(order_id__in=orders_with_this)
        .exclude(variant__product=product)
        .values("variant__product")
        .annotate(shared=Count("order_id", distinct=True))
        .order_by("-shared")[:limit]
    )
    ranked_ids = [row["variant__product"] for row in co_occurring]

    products: list[Product] = []
    if ranked_ids:
        by_id = visible_products().in_bulk(ranked_ids)
        # `in_bulk` answers in whatever order the database likes; the ranking is
        # the whole point, so it is reapplied here.
        products = [by_id[pk] for pk in ranked_ids if pk in by_id]

    if len(products) < limit:
        seen = {item.pk for item in products} | {product.pk}
        filler = (
            visible_products()
            .filter(category=product.category)
            .exclude(pk__in=seen)
            .order_by("-created_at")[: limit - len(products)]
        )
        products.extend(filler)

    return products[:limit]


def price_drop_payload(product: Product) -> dict[str, Any]:
    """The deepest reduction on this product, for a badge.

    Read off the variants already prefetched by `_payload_queryset`, so adding
    this to a listing costs no extra query.
    """
    best = 0
    for variant in product.variants.all():
        compare_at = variant.compare_at_price
        if not compare_at or compare_at <= variant.price:
            continue
        percent = int(round((compare_at - variant.price) * 100 / compare_at))
        best = max(best, percent)
    return {"drop_percent": best}


__all__ = ["bought_together", "price_drop_payload", "price_drops"]
