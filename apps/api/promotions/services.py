"""Coupon validation and discount calculation.

The client sends a *code*.  Everything else — eligibility, amount, caps, usage —
is decided here (docs/business-rules.md §3.3).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core.exceptions import CouponInvalid
from core.money import ZERO, quantize
from promotions.models import Coupon, CouponRedemption, DiscountType


@dataclass(frozen=True)
class CouponResult:
    coupon: Coupon
    discount: Decimal
    free_shipping: bool
    eligible_subtotal: Decimal
    message: str = ""


def get_coupon(code: str) -> Coupon:
    coupon = Coupon.objects.filter(code=code.strip().upper()).first()
    if coupon is None:
        raise CouponInvalid("That coupon code was not recognised.", details={"code": code})
    return coupon


def _eligible_subtotal(coupon: Coupon, lines: list[Any]) -> Decimal:
    """Sum of the lines the coupon actually applies to."""
    category_ids = set(coupon.categories.values_list("id", flat=True))
    product_ids = set(coupon.products.values_list("id", flat=True))
    if not category_ids and not product_ids:
        return quantize(sum((line.line_total for line in lines), ZERO))

    # A category restriction covers its descendants too.
    expanded: set = set()
    for category in coupon.categories.all():
        expanded.update(category.descendant_ids())

    total = ZERO
    for line in lines:
        product = line.variant.product
        if product.id in product_ids or product.category_id in expanded:
            total += line.line_total
    return quantize(total)


def validate_coupon(
    *,
    coupon: Coupon,
    lines: list[Any],
    subtotal: Decimal,
    customer: Any = None,
    channel: str = "ONLINE",
    now: Any = None,
) -> CouponResult:
    """Raise CouponInvalid, or return the discount the backend will honour."""
    now = now or timezone.now()

    if not coupon.is_active:
        raise CouponInvalid("This coupon is no longer active.")
    if coupon.starts_at and now < coupon.starts_at:
        raise CouponInvalid("This coupon is not valid yet.")
    if coupon.ends_at and now > coupon.ends_at:
        raise CouponInvalid("This coupon has expired.")
    if coupon.is_exhausted:
        raise CouponInvalid("This coupon has reached its usage limit.")
    if coupon.channels and channel not in coupon.channels:
        raise CouponInvalid("This coupon cannot be used on this channel.")

    if coupon.usage_limit_per_customer and customer is not None:
        used = CouponRedemption.objects.filter(
            coupon=coupon, customer=customer, released_at__isnull=True
        ).count()
        if used >= coupon.usage_limit_per_customer:
            raise CouponInvalid("You have already used this coupon.")

    if subtotal < coupon.minimum_order_value:
        raise CouponInvalid(
            f"This coupon needs a minimum order of {coupon.minimum_order_value}.",
            details={
                "minimum_order_value": str(coupon.minimum_order_value),
                "subtotal": str(subtotal),
            },
        )

    eligible = _eligible_subtotal(coupon, lines)
    if eligible <= ZERO:
        raise CouponInvalid("No items in your cart are eligible for this coupon.")

    free_shipping = coupon.discount_type == DiscountType.FREE_SHIPPING
    if free_shipping:
        discount = ZERO
    elif coupon.discount_type == DiscountType.PERCENTAGE:
        discount = quantize(eligible * coupon.value / Decimal("100"))
    else:
        discount = quantize(min(coupon.value, eligible))

    if coupon.maximum_discount is not None and discount > coupon.maximum_discount:
        discount = quantize(coupon.maximum_discount)

    discount = min(discount, subtotal)

    return CouponResult(
        coupon=coupon,
        discount=discount,
        free_shipping=free_shipping,
        eligible_subtotal=eligible,
        message=coupon.description,
    )


@transaction.atomic
def redeem(
    *, coupon: Coupon, order: Any, discount: Decimal, customer: Any = None
) -> CouponRedemption:
    """Count the usage.  Called when the order is created, inside its transaction."""
    locked = Coupon.objects.select_for_update().get(pk=coupon.pk)
    if locked.is_exhausted:
        raise CouponInvalid("This coupon has reached its usage limit.")

    redemption, created = CouponRedemption.objects.get_or_create(
        coupon=locked,
        order=order,
        defaults={"customer": customer, "discount_amount": quantize(discount)},
    )
    if created:
        locked.used_count += 1
        locked.save(update_fields=["used_count", "updated_at"])
    return redemption


@transaction.atomic
def release(*, order: Any, reason: str = "Order cancelled") -> None:
    """Give the usage back when an order is cancelled before fulfilment."""
    redemptions = CouponRedemption.objects.select_for_update().filter(
        order=order, released_at__isnull=True
    )
    for redemption in redemptions:
        coupon = Coupon.objects.select_for_update().get(pk=redemption.coupon_id)
        coupon.used_count = max(coupon.used_count - 1, 0)
        coupon.save(update_fields=["used_count", "updated_at"])
        redemption.released_at = timezone.now()
        redemption.save(update_fields=["released_at", "updated_at"])


def active_coupons(now: Any = None):
    now = now or timezone.now()
    return Coupon.objects.filter(is_active=True).filter(
        Q(starts_at__isnull=True) | Q(starts_at__lte=now),
        Q(ends_at__isnull=True) | Q(ends_at__gte=now),
    )
