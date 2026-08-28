"""Coupons.

The backend computes every discount.  A coupon code from the browser is a
*claim*, never an amount (docs/business-rules.md §3.3).
"""

from __future__ import annotations

from decimal import Decimal

from django.db import models

from core.models import BaseModel, money_field


class DiscountType(models.TextChoices):
    PERCENTAGE = "PERCENTAGE", "Percentage"
    FIXED = "FIXED", "Fixed amount"
    FREE_SHIPPING = "FREE_SHIPPING", "Free shipping"


class Coupon(BaseModel):
    code = models.CharField(max_length=32, unique=True)
    description = models.CharField(max_length=255, blank=True)
    discount_type = models.CharField(max_length=16, choices=DiscountType.choices)
    value = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.00"),
        help_text=(
            "Percent (0–100) or a fixed amount, depending on discount_type. "
            "Always 0 for FREE_SHIPPING, which carries no amount."
        ),
    )

    minimum_order_value = money_field()
    maximum_discount = money_field(
        null=True, blank=True, default=None, help_text="Caps a percentage discount."
    )

    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)

    usage_limit = models.PositiveIntegerField(
        null=True, blank=True, help_text="Total redemptions allowed. Null = unlimited."
    )
    usage_limit_per_customer = models.PositiveIntegerField(null=True, blank=True, default=1)
    used_count = models.PositiveIntegerField(default=0)

    categories = models.ManyToManyField(
        "catalog.Category",
        blank=True,
        related_name="coupons",
        help_text="Restrict to these categories. Empty = whole catalogue.",
    )
    products = models.ManyToManyField(
        "catalog.Product",
        blank=True,
        related_name="coupons",
    )
    channels = models.JSONField(
        default=list, blank=True, help_text="Allowed channels, e.g. ['ONLINE']. Empty = all."
    )

    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "promotions_coupon"
        ordering = ("-created_at",)
        constraints = [
            # A free-shipping coupon carries no amount — the discount is the
            # shipping line being zeroed, not a number on the coupon — so it is
            # the one type allowed a value of 0. Every other type giving away
            # nothing would be a coupon that silently does nothing.
            models.CheckConstraint(
                condition=models.Q(discount_type="FREE_SHIPPING")
                | models.Q(value__gt=Decimal("0.00")),
                name="promotions_coupon_value_gt_0",
            ),
            models.CheckConstraint(
                condition=~models.Q(discount_type="PERCENTAGE")
                | models.Q(value__lte=Decimal("100.00")),
                name="promotions_coupon_percentage_lte_100",
            ),
        ]

    def __str__(self) -> str:
        return self.code

    def save(self, *args, **kwargs) -> None:
        self.code = self.code.strip().upper()
        super().save(*args, **kwargs)

    @property
    def is_exhausted(self) -> bool:
        return self.usage_limit is not None and self.used_count >= self.usage_limit


class CouponRedemption(BaseModel):
    coupon = models.ForeignKey(Coupon, on_delete=models.PROTECT, related_name="redemptions")
    order = models.ForeignKey("orders.Order", on_delete=models.CASCADE, related_name="+")
    customer = models.ForeignKey(
        "customers.Customer", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    discount_amount = money_field()
    released_at = models.DateTimeField(
        null=True, blank=True, help_text="Set when a cancelled order gives the usage back."
    )

    class Meta:
        db_table = "promotions_couponredemption"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(fields=["coupon", "order"], name="promotions_redemption_uniq")
        ]
        indexes = [models.Index(fields=["coupon", "customer"])]

    def __str__(self) -> str:
        return f"{self.coupon_id} on {self.order_id}"
