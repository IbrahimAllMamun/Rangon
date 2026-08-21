"""Anything that changes the navbar asks the storefront to drop its cache.

`Category` is in here as well as the two content models: the navbar falls back
to the category tree, so renaming a category changes the menu even when no
`NavigationItem` row exists (ADR-0009).
"""

from __future__ import annotations

from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from catalog.models import Category
from content.models import NavigationItem, StorefrontBanner
from content.tasks import request_revalidation

NAVIGATION_TAGS = ("navigation", "categories")


@receiver(post_save, sender=NavigationItem)
@receiver(post_delete, sender=NavigationItem)
@receiver(post_save, sender=Category)
@receiver(post_delete, sender=Category)
def _navigation_changed(sender, **kwargs) -> None:
    request_revalidation(*NAVIGATION_TAGS)


@receiver(post_save, sender=StorefrontBanner)
@receiver(post_delete, sender=StorefrontBanner)
def _banner_changed(sender, **kwargs) -> None:
    request_revalidation("navigation", "home")
