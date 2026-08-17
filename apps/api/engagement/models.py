"""Wishlist and reviews.

Reviews require a verified purchase and pass through moderation before they are
visible (plan §25).
"""

from __future__ import annotations

from django.db import models

from core.models import BaseModel


class Wishlist(BaseModel):
    customer = models.OneToOneField(
        "customers.Customer", on_delete=models.CASCADE, related_name="wishlist"
    )

    class Meta:
        db_table = "engagement_wishlist"

    def __str__(self) -> str:
        return f"Wishlist of {self.customer_id}"


class WishlistItem(BaseModel):
    wishlist = models.ForeignKey(Wishlist, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey("catalog.Product", on_delete=models.CASCADE, related_name="+")
    variant = models.ForeignKey(
        "catalog.ProductVariant", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "engagement_wishlistitem"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["wishlist", "product"], name="engagement_wishlistitem_uniq"
            )
        ]


class ReviewStatus(models.TextChoices):
    PENDING = "PENDING", "Awaiting moderation"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"


class Review(BaseModel):
    product = models.ForeignKey("catalog.Product", on_delete=models.CASCADE, related_name="reviews")
    customer = models.ForeignKey(
        "customers.Customer", on_delete=models.CASCADE, related_name="reviews"
    )
    order = models.ForeignKey(
        "orders.Order",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="reviews",
        help_text="The purchase being reviewed; drives verified_purchase.",
    )
    rating = models.PositiveSmallIntegerField()
    title = models.CharField(max_length=140, blank=True)
    comment = models.TextField(blank=True)
    verified_purchase = models.BooleanField(default=False)
    status = models.CharField(
        max_length=16, choices=ReviewStatus.choices, default=ReviewStatus.PENDING
    )
    moderated_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    moderated_at = models.DateTimeField(null=True, blank=True)
    moderation_note = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "engagement_review"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["product", "customer", "order"], name="engagement_review_uniq"
            ),
            models.CheckConstraint(
                condition=models.Q(rating__gte=1) & models.Q(rating__lte=5),
                name="engagement_review_rating_range",
            ),
        ]
        indexes = [
            models.Index(fields=["product", "status", "-created_at"]),
            models.Index(fields=["status", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.rating}★ {self.product_id}"
