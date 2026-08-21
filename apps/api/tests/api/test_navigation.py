"""The storefront navbar payload.

Playwright cannot run in the dev container (roadmap D7), so the rules that
decide what a shopper sees in the menu are pinned here instead:
visibility, scheduling, fallback and who is allowed to write it
(docs/architecture/navigation.md §8).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from django.utils.text import slugify

from accounts.models import RoleCode
from catalog.models import Category
from content.models import (
    BannerPlacement,
    NavigationItem,
    NavigationItemType,
    Placement,
    StorefrontBanner,
)
from tests import factories

pytestmark = pytest.mark.django_db

URL = "/api/v1/shop/navigation/"
ADMIN_URL = "/api/v1/navigation-items/"

#: The whole menu is a handful of queries: one per tree level, not one per node.
NAVIGATION_QUERY_BUDGET = 8


def _labels(payload: dict[str, Any]) -> list[str]:
    return [item["label"] for item in payload["items"]]


def _tree(parent: Category | None = None, *, name: str, **kwargs: Any) -> Category:
    """A category whose slug follows its name, so URLs are readable in asserts."""
    kwargs.setdefault("slug", slugify(name))
    return factories.category(parent=parent, name=name, **kwargs)


class TestFallbackToCategories:
    """An unconfigured install must render a correct navbar (ADR-0009)."""

    def test_empty_override_table_falls_back_to_the_category_tree(self, api):
        women = _tree(name="Women")
        _tree(women, name="Kurti")

        payload = api.get(URL).data

        assert _labels(payload) == ["Women"]
        assert payload["items"][0]["url"] == "/category/women"
        assert payload["items"][0]["children"][0]["url"] == "/category/women/kurti"

    def test_category_hidden_from_navigation_does_not_appear(self, api):
        _tree(name="Women")
        _tree(name="Clearance", show_in_navigation=False)

        assert _labels(api.get(URL).data) == ["Women"]

    def test_inactive_category_does_not_appear(self, api):
        _tree(name="Women")
        _tree(name="Archive", is_active=False)

        assert _labels(api.get(URL).data) == ["Women"]

    def test_inactive_child_does_not_appear(self, api):
        women = _tree(name="Women")
        _tree(women, name="Kurti")
        _tree(women, name="Discontinued", is_active=False)

        children = api.get(URL).data["items"][0]["children"]
        assert [child["label"] for child in children] == ["Kurti"]


class TestOverrides:
    def test_override_rows_replace_the_category_default(self, api):
        _tree(name="Women")
        NavigationItem.objects.create(
            type=NavigationItemType.LINK,
            label="New Arrivals",
            url="/shop?sort=newest",
            badge="NEW",
            position=0,
        )

        payload = api.get(URL).data
        assert _labels(payload) == ["New Arrivals"]
        assert payload["items"][0]["badge"] == "NEW"

    def test_a_category_override_inherits_the_real_children(self, api):
        women = _tree(name="Women")
        _tree(women, name="Kurti")
        NavigationItem.objects.create(type=NavigationItemType.CATEGORY, category=women, label="Her")

        item = api.get(URL).data["items"][0]
        assert item["label"] == "Her"  # the label is overridden…
        assert [child["label"] for child in item["children"]] == ["Kurti"]  # …the tree is not

    def test_inactive_item_is_not_serialised(self, api):
        _tree(name="Women")
        NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="Sale", url="/shop?sale=1", is_active=False
        )

        # The only override row is inactive, so the menu falls back rather than
        # rendering an empty navbar.
        assert _labels(api.get(URL).data) == ["Women"]

    def test_item_before_its_window_is_not_serialised(self, api):
        NavigationItem.objects.create(
            type=NavigationItemType.LINK,
            label="Live",
            url="/shop",
        )
        NavigationItem.objects.create(
            type=NavigationItemType.LINK,
            label="Ramadan",
            url="/shop?campaign=ramadan",
            starts_at=timezone.now() + timedelta(days=7),
        )

        assert _labels(api.get(URL).data) == ["Live"]

    def test_item_after_its_window_is_not_serialised(self, api):
        now = timezone.now()
        NavigationItem.objects.create(type=NavigationItemType.LINK, label="Live", url="/shop")
        NavigationItem.objects.create(
            type=NavigationItemType.LINK,
            label="Winter",
            url="/shop?campaign=winter",
            starts_at=now - timedelta(days=30),
            ends_at=now - timedelta(days=1),
        )

        assert _labels(api.get(URL).data) == ["Live"]

    def test_a_child_of_an_expired_parent_does_not_leak(self, api):
        now = timezone.now()
        campaign = NavigationItem.objects.create(
            type=NavigationItemType.LINK,
            label="Winter",
            url="/shop?campaign=winter",
            starts_at=now - timedelta(days=30),
            ends_at=now - timedelta(days=1),
        )
        NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="Coats", url="/shop?c=coats", parent=campaign
        )
        NavigationItem.objects.create(type=NavigationItemType.LINK, label="Live", url="/shop")

        payload = api.get(URL).data
        assert _labels(payload) == ["Live"]
        assert payload["items"][0]["children"] == []

    def test_footer_placement_is_separate_from_the_header(self, api):
        NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="Header link", url="/shop"
        )
        NavigationItem.objects.create(
            type=NavigationItemType.LINK,
            label="Size guide",
            url="/policies/sizing",
            placement=Placement.FOOTER,
        )

        payload = api.get(URL).data
        assert _labels(payload) == ["Header link"]
        assert [item["label"] for item in payload["footer"]] == ["Size guide"]


class TestAnnouncement:
    def test_the_highest_priority_live_announcement_wins(self, api):
        StorefrontBanner.objects.create(
            placement=BannerPlacement.ANNOUNCEMENT, message="Low", priority=1
        )
        StorefrontBanner.objects.create(
            placement=BannerPlacement.ANNOUNCEMENT, message="High", priority=9
        )

        assert api.get(URL).data["announcement"]["message"] == "High"

    def test_an_expired_announcement_is_never_serialised(self, api):
        now = timezone.now()
        StorefrontBanner.objects.create(
            placement=BannerPlacement.ANNOUNCEMENT,
            message="Eid offer",
            starts_at=now - timedelta(days=10),
            ends_at=now - timedelta(hours=1),
        )

        assert api.get(URL).data["announcement"] is None

    def test_no_announcement_configured_is_not_an_error(self, api):
        assert api.get(URL).status_code == 200
        assert api.get(URL).data["announcement"] is None


class TestWritePermissions:
    def test_anonymous_cannot_write_navigation(self, api):
        response = api.post(ADMIN_URL, {"type": "LINK", "label": "Hack", "url": "/x"})
        assert response.status_code == 401

    def test_a_customer_cannot_write_navigation(self, auth_client):
        client = auth_client(factories.user(RoleCode.CUSTOMER))
        response = client.post(ADMIN_URL, {"type": "LINK", "label": "Hack", "url": "/x"})
        assert response.status_code == 403

    def test_a_cashier_cannot_write_navigation(self, auth_client, cashier):
        response = auth_client(cashier).post(
            ADMIN_URL, {"type": "LINK", "label": "Hack", "url": "/x"}
        )
        assert response.status_code == 403

    def test_a_manager_can_write_navigation(self, auth_client, manager):
        response = auth_client(manager).post(
            ADMIN_URL, {"type": "LINK", "label": "Sale", "url": "/shop?sale=1"}
        )
        assert response.status_code == 201, response.data

    def test_a_link_without_a_url_is_rejected(self, auth_client, owner):
        response = auth_client(owner).post(ADMIN_URL, {"type": "LINK", "label": "Sale"})
        assert response.status_code == 400
        assert "url" in response.data["error"]["details"]

    def test_a_category_item_without_a_category_is_rejected(self, auth_client, owner):
        response = auth_client(owner).post(ADMIN_URL, {"type": "CATEGORY", "label": "Women"})
        assert response.status_code == 400
        assert "category" in response.data["error"]["details"]

    def test_a_window_that_ends_before_it_starts_is_rejected(self, auth_client, owner):
        now = timezone.now()
        response = auth_client(owner).post(
            ADMIN_URL,
            {
                "type": "LINK",
                "label": "Sale",
                "url": "/shop?sale=1",
                "starts_at": now.isoformat(),
                "ends_at": (now - timedelta(days=1)).isoformat(),
            },
        )
        assert response.status_code == 400


class TestReorder:
    def test_move_swaps_position_with_the_neighbour(self, auth_client, owner):
        first = NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="A", url="/a", position=0
        )
        second = NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="B", url="/b", position=1
        )

        response = auth_client(owner).post(f"{ADMIN_URL}{second.pk}/move/", {"direction": "up"})

        assert response.status_code == 200, response.data
        first.refresh_from_db()
        second.refresh_from_db()
        assert second.position < first.position

    def test_moving_the_first_item_up_is_a_no_op(self, auth_client, owner):
        first = NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="A", url="/a", position=0
        )
        NavigationItem.objects.create(type=NavigationItemType.LINK, label="B", url="/b", position=1)

        response = auth_client(owner).post(f"{ADMIN_URL}{first.pk}/move/", {"direction": "up"})

        assert response.status_code == 200
        first.refresh_from_db()
        assert first.position == 0

    def test_equal_positions_are_renumbered_rather_than_swapped(self, auth_client, owner):
        """Two rows at position 0 fall back to label order; a swap would be invisible."""
        a = NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="A", url="/a", position=0
        )
        b = NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="B", url="/b", position=0
        )

        auth_client(owner).post(f"{ADMIN_URL}{b.pk}/move/", {"direction": "up"})

        a.refresh_from_db()
        b.refresh_from_db()
        assert b.position < a.position

    def test_an_unknown_direction_is_rejected(self, auth_client, owner):
        item = NavigationItem.objects.create(
            type=NavigationItemType.LINK, label="A", url="/a", position=0
        )
        response = auth_client(owner).post(f"{ADMIN_URL}{item.pk}/move/", {"direction": "sideways"})
        assert response.status_code == 400


class TestQueryBudget:
    def test_the_payload_does_not_grow_with_the_catalogue(self, api):
        for index in range(3):
            root = _tree(name=f"Root {index}")
            for child in range(3):
                _tree(root, name=f"Child {index}-{child}")

        api.get(URL)  # warm
        with CaptureQueriesContext(connection) as first:
            api.get(URL)

        for index in range(3, 9):
            root = _tree(name=f"Root {index}")
            for child in range(3):
                _tree(root, name=f"Child {index}-{child}")

        with CaptureQueriesContext(connection) as second:
            api.get(URL)

        assert len(second) == len(first), (
            f"Queries grew from {len(first)} to {len(second)} as the catalogue grew: "
            f"the navigation tree is being expanded per node instead of per level."
        )
        assert len(second) <= NAVIGATION_QUERY_BUDGET
