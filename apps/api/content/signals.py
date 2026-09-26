"""Anything that changes the navbar or the footer asks the storefront to drop its cache.

`Category` is in here as well as the content models: the navbar falls back
to the category tree, so renaming a category changes the menu even when no
`NavigationItem` row exists (ADR-0009) -- and a footer "Top categories" entry
follows the same tree.

The footer receivers fire on commit: the storefront refetches the moment it is
told to, and a ping sent from inside the transaction would let it read the old
row back and cache that for another five minutes.
"""

from __future__ import annotations

from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from accounts.models import Organization
from catalog.models import Category
from content.models import NavigationItem, SitePage, SiteSettings, SocialLink, StorefrontBanner
from content.tasks import request_revalidation

#: `site` is the footer: its columns are `NavigationItem` rows and its
#: "Top categories" entries follow the category tree.
NAVIGATION_TAGS = ("navigation", "categories", "site")


def _on_commit(*tags: str) -> None:
    transaction.on_commit(lambda: request_revalidation(*tags))


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


@receiver(post_save, sender=SiteSettings)
@receiver(post_save, sender=SocialLink)
# The footer falls back to the organisation's name and contact details.
@receiver(post_save, sender=Organization)
def _site_changed(sender, **kwargs) -> None:
    _on_commit("site")


@receiver(post_save, sender=SitePage)
@receiver(post_delete, sender=SitePage)
def _page_changed(sender, instance: SitePage, **kwargs) -> None:
    # `site` too: the footer shows a page's title and hides it when unpublished.
    _on_commit("site", "pages", f"page:{instance.slug}")
