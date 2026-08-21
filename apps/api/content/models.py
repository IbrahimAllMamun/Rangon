"""Storefront content: navigation overrides and banners.

The category tree *is* the navigation (ADR-0009).  `NavigationItem` is an
override list for the handful of things a category cannot express — a filter
("Sale"), a sort ("New Arrivals"), a scheduled campaign, a badge, a promo card,
an external link.  An install with no rows here still renders a correct navbar.

`StorefrontBanner` is the first content model Rangon has had: it drives the
announcement bar and the homepage hero, both of which were hardcoded before.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import models
from django.utils import timezone

from core.models import BaseModel


class Placement(models.TextChoices):
    HEADER = "HEADER", "Header"
    FOOTER = "FOOTER", "Footer"


class NavigationItemType(models.TextChoices):
    CATEGORY = "CATEGORY", "Category"
    LINK = "LINK", "Link"
    PROMO = "PROMO", "Promo card"


class NavigationLayout(models.TextChoices):
    AUTO = "AUTO", "Automatic"
    DROPDOWN = "DROPDOWN", "Dropdown"
    MEGA = "MEGA", "Mega menu"


class ScheduledQuerySet(models.QuerySet):
    """Rows that are active *and* inside their publish window.

    Visibility is enforced here rather than in the frontend so a stale cache
    cannot show an expired campaign (navigation.md §2 rule 1).
    """

    def live(self, *, now=None):
        moment = now or timezone.now()
        return self.filter(is_active=True).filter(
            models.Q(starts_at__isnull=True) | models.Q(starts_at__lte=moment),
            models.Q(ends_at__isnull=True) | models.Q(ends_at__gte=moment),
        )


class NavigationItem(BaseModel):
    placement = models.CharField(max_length=16, choices=Placement.choices, default=Placement.HEADER)
    type = models.CharField(
        max_length=16, choices=NavigationItemType.choices, default=NavigationItemType.CATEGORY
    )
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="children"
    )
    category = models.ForeignKey(
        "catalog.Category",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="navigation_items",
        help_text="CATEGORY items only. Supplies the name, slug and children.",
    )
    label = models.CharField(
        max_length=120, blank=True, help_text="Overrides the category name when set."
    )
    url = models.CharField(
        max_length=300, blank=True, help_text="LINK and PROMO items only, e.g. /shop?sort=newest"
    )
    badge = models.CharField(
        max_length=24,
        blank=True,
        help_text='Rendered as data, e.g. "NEW", "SALE", "20% OFF". Never branched on.',
    )
    image = models.ImageField(upload_to="navigation/", blank=True, null=True)
    description = models.CharField(max_length=200, blank=True)
    layout = models.CharField(
        max_length=16, choices=NavigationLayout.choices, default=NavigationLayout.AUTO
    )
    position = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)

    objects = ScheduledQuerySet.as_manager()

    class Meta:
        db_table = "content_navigationitem"
        ordering = ("position", "label")
        indexes = [
            models.Index(fields=["placement", "position"], name="content_navitem_place_idx"),
            models.Index(fields=["parent", "position"], name="content_navitem_parent_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ends_at__isnull=True)
                | models.Q(starts_at__isnull=True)
                | models.Q(ends_at__gte=models.F("starts_at")),
                name="content_navitem_window_ordered",
            )
        ]

    def __str__(self) -> str:
        return self.display_label or f"{self.type} item"

    def clean(self) -> None:
        if self.type == NavigationItemType.CATEGORY and self.category_id is None:
            raise DjangoValidationError({"category": "A CATEGORY item needs a category."})
        if self.type != NavigationItemType.CATEGORY and self.category_id is not None:
            raise DjangoValidationError(
                {"category": "Only a CATEGORY item may reference a category."}
            )
        if self.type == NavigationItemType.LINK and not self.url:
            raise DjangoValidationError({"url": "A LINK item needs a URL."})
        if self.type == NavigationItemType.LINK and not self.label:
            raise DjangoValidationError({"label": "A LINK item needs a label."})
        if self.parent_id and self.parent_id == self.pk:
            raise DjangoValidationError({"parent": "An item cannot be its own parent."})

    @property
    def display_label(self) -> str:
        if self.label:
            return self.label
        return self.category.name if self.category_id else ""


class BannerPlacement(models.TextChoices):
    ANNOUNCEMENT = "ANNOUNCEMENT", "Announcement bar"
    HOME_HERO = "HOME_HERO", "Homepage hero"


class StorefrontBanner(BaseModel):
    placement = models.CharField(max_length=16, choices=BannerPlacement.choices)
    message = models.CharField(
        max_length=200, blank=True, help_text="Announcement bar copy (one line)."
    )
    title = models.CharField(max_length=120, blank=True, help_text="Hero headline.")
    subtitle = models.CharField(max_length=200, blank=True)
    cta_label = models.CharField(max_length=40, blank=True)
    url = models.CharField(max_length=300, blank=True)
    image = models.ImageField(upload_to="banners/", blank=True, null=True)
    dismissible = models.BooleanField(default=True)
    priority = models.IntegerField(
        default=0, help_text="Highest priority wins when several are live."
    )
    is_active = models.BooleanField(default=True)
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)

    objects = ScheduledQuerySet.as_manager()

    class Meta:
        db_table = "content_storefrontbanner"
        ordering = ("-priority", "-created_at")
        indexes = [models.Index(fields=["placement", "-priority"], name="content_banner_place_idx")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ends_at__isnull=True)
                | models.Q(starts_at__isnull=True)
                | models.Q(ends_at__gte=models.F("starts_at")),
                name="content_banner_window_ordered",
            )
        ]

    def __str__(self) -> str:
        return f"{self.get_placement_display()}: {self.message or self.title}"

    def clean(self) -> None:
        if self.placement == BannerPlacement.ANNOUNCEMENT and not self.message:
            raise DjangoValidationError({"message": "An announcement needs a message."})
        if self.placement == BannerPlacement.HOME_HERO and not self.title:
            raise DjangoValidationError({"title": "A hero banner needs a title."})
