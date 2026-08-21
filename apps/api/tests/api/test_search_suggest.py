"""Navbar search: type-ahead suggestions and the term log behind them.

docs/architecture/navigation.md §7 N4 — products, categories and popular
searches, sourced from `catalog.search`.
"""

from __future__ import annotations

import pytest

from catalog.models import SearchTerm
from tests import factories

pytestmark = pytest.mark.django_db

URL = "/api/v1/shop/search/suggest/"
LISTING_URL = "/api/v1/shop/products/"


class TestSuggest:
    def test_a_short_query_returns_no_product_or_category_matches(self, api):
        response = api.get(URL, {"q": "s"})

        assert response.status_code == 200
        assert response.data["products"] == []
        assert response.data["categories"] == []

    def test_matches_a_product_by_partial_name(self, api):
        factories.product(name="Classic Oxford Shirt")

        response = api.get(URL, {"q": "oxford"})

        assert [p["name"] for p in response.data["products"]] == ["Classic Oxford Shirt"]

    def test_does_not_suggest_an_unpublished_product(self, api):
        factories.product(name="Classic Oxford Shirt", published=False)

        response = api.get(URL, {"q": "oxford"})

        assert response.data["products"] == []

    def test_matches_a_category_by_partial_name(self, api):
        factories.category(name="Sneakers", slug="sneakers")

        response = api.get(URL, {"q": "sneak"})

        assert [c["name"] for c in response.data["categories"]] == ["Sneakers"]

    def test_popular_searches_exclude_terms_with_no_results(self, api):
        factories.product(name="Signature Polo Shirt")

        api.get(LISTING_URL, {"q": "Signature Polo Shirt"})  # a hit, logged
        api.get(LISTING_URL, {"q": "zzz-nonexistent-zzz"})  # a miss, logged

        popular = api.get(URL, {"q": "xx"}).data["popular"]

        assert "signature polo shirt" in popular
        assert "zzz-nonexistent-zzz" not in popular


class TestSearchLogging:
    def test_a_search_creates_one_term_row(self, api, shop):
        api.get(LISTING_URL, {"q": "Backpack"})

        term = SearchTerm.objects.get(term="backpack")
        assert term.hits == 1

    def test_repeating_a_search_increments_the_same_row_not_a_new_one(self, api):
        api.get(LISTING_URL, {"q": "Backpack"})
        api.get(LISTING_URL, {"q": "backpack"})  # case-insensitive, same term

        assert SearchTerm.objects.count() == 1
        assert SearchTerm.objects.get().hits == 2

    def test_paging_the_same_search_does_not_log_again(self, api):
        # Enough matches that page 2 is real, not a 404 for a page that
        # doesn't exist (page_size is 25).
        for _ in range(30):
            factories.product(name=f"Rangon Polo {factories.unique()}")

        api.get(LISTING_URL, {"q": "Rangon Polo"})
        second = api.get(LISTING_URL, {"q": "Rangon Polo", "page": 2})

        assert second.status_code == 200
        assert SearchTerm.objects.get(term="rangon polo").hits == 1

    def test_a_blank_query_is_not_logged(self, api):
        api.get(LISTING_URL)

        assert SearchTerm.objects.count() == 0


class TestHomeHero:
    HOME_URL = "/api/v1/shop/home/"

    def test_no_hero_configured_is_not_an_error(self, api):
        response = api.get(self.HOME_URL)

        assert response.status_code == 200
        assert response.data["hero"] is None

    def test_a_live_hero_banner_is_returned(self, api):
        from content.models import BannerPlacement, StorefrontBanner

        StorefrontBanner.objects.create(
            placement=BannerPlacement.HOME_HERO, title="Eid Collection", cta_label="Shop now"
        )

        response = api.get(self.HOME_URL)

        assert response.data["hero"]["title"] == "Eid Collection"
