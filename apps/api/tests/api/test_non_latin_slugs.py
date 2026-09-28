"""Categories, brands and products named in Bengali get a real address.

Every Bengali name used to slug to "", so the catalogue fell back to `item`,
`item-2`, `item-3` -- a category, a brand and a product all called "item", and
nothing in the URL a shopper could read. The models' own fallback was worse:
`slugify(name)` with nothing to fall back to, so a second Bengali-named row
saved outside the serializers collided on the unique slug. Naming a category
inline on a purchase order (business-rules.md § 7a.6) made this easy to reach.
"""

from __future__ import annotations

from typing import Any

import pytest

from catalog.models import Brand, Category, Product
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin(shop: dict[str, Any], auth_client: Any) -> Any:
    return auth_client(shop["owner"])


class TestThroughTheApi:
    def test_two_bengali_categories_get_readable_distinct_slugs(self, admin: Any) -> None:
        first = admin.post("/api/v1/categories/", {"name": "শাড়ি"}, format="json")
        second = admin.post("/api/v1/categories/", {"name": "শাড়ি"}, format="json")

        assert first.status_code == 201, first.data
        assert second.status_code == 201, second.data
        assert first.data["slug"] == "shari"
        assert second.data["slug"] == "shari-2"

    def test_the_storefront_finds_the_category_by_that_slug(self, admin: Any, api: Any) -> None:
        admin.post("/api/v1/categories/", {"name": "পাঞ্জাবি", "is_active": True}, format="json")

        response = api.get("/api/v1/shop/categories/panjabi/")

        assert response.status_code == 200, response.data
        assert response.data["name"] == "পাঞ্জাবি"

    def test_a_bengali_brand(self, admin: Any) -> None:
        response = admin.post("/api/v1/brands/", {"name": "জামদানি হাউস"}, format="json")

        assert response.status_code == 201, response.data
        assert response.data["slug"] == "jamdani-haus"

    def test_a_bengali_product(self, admin: Any) -> None:
        category = factories.category()

        response = admin.post(
            "/api/v1/products/",
            {"name": "থ্রি-পিস", "category": str(category.pk), "status": "DRAFT"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["slug"] == "thri-pis"

    def test_a_script_with_no_transliteration_falls_back_to_what_it_is(self, admin: Any) -> None:
        """Not `item`: a category's fallback says it is a category."""
        first = admin.post("/api/v1/categories/", {"name": "قمصان"}, format="json")
        second = admin.post("/api/v1/categories/", {"name": "فساتين"}, format="json")
        brand = admin.post("/api/v1/brands/", {"name": "علامة"}, format="json")

        assert first.data["slug"] == "category"
        assert second.data["slug"] == "category-2"
        assert brand.data["slug"] == "brand"

    def test_a_slug_the_admin_types_is_kept(self, admin: Any) -> None:
        response = admin.post(
            "/api/v1/categories/", {"name": "শাড়ি", "slug": "saree"}, format="json"
        )

        assert response.status_code == 201, response.data
        assert response.data["slug"] == "saree"


class TestSavedWithoutASlug:
    """The models' own fallback, for rows made outside the serializers."""

    def test_two_bengali_categories_do_not_collide(self) -> None:
        first = Category.objects.create(name="শাড়ি")
        second = Category.objects.create(name="শাড়ি")

        assert first.slug == "shari"
        assert second.slug == "shari-2"

    def test_brands_and_products_too(self) -> None:
        brand = Brand.objects.create(name="আড়ং")
        product = Product.objects.create(name="লুঙ্গি", category=factories.category())

        assert brand.slug == "arang"
        assert product.slug == "lungi"

    def test_an_unknown_script_still_gets_a_unique_slug(self) -> None:
        first = Product.objects.create(name="قميص", category=factories.category())
        second = Product.objects.create(name="قميص", category=factories.category())

        assert first.slug == "product"
        assert second.slug == "product-2"
