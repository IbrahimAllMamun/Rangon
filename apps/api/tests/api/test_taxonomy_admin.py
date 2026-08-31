"""Categories, brands and attributes through the API.

Written before the admin screens are built over them, because every previous
pass that skipped this step found defects afterwards (docs/roadmap.md).  The
taxonomy looked like the safest area left -- it is seeded once and rarely
touched -- which is exactly why nothing had ever exercised its edges.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from catalog.models import Attribute, Brand, Category
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


class TestCategoryHierarchy:
    def test_a_category_cannot_be_its_own_parent(self, admin, shop):
        category = factories.category(name="Shoes")

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"parent": str(category.pk)},
            format="json",
        )

        assert response.status_code == 400
        category.refresh_from_db()
        assert category.parent_id is None

    def test_a_category_cannot_be_moved_under_its_own_descendant(self, admin, shop):
        """A cycle is not a validation nicety: `Category.path` and `ancestors()`
        walk `parent` without a guard, so one would recurse until the stack
        gives out -- on the navigation menu, which every storefront page renders.
        """
        parent = factories.category(name="Clothing")
        child = factories.category(name="Shirts", parent=parent)

        response = admin.patch(
            f"/api/v1/categories/{parent.pk}/",
            {"parent": str(child.pk)},
            format="json",
        )

        assert response.status_code == 400
        parent.refresh_from_db()
        assert parent.parent_id is None

    def test_a_legitimate_move_still_works(self, admin, shop):
        parent = factories.category(name="Clothing")
        other = factories.category(name="Accessories")

        response = admin.patch(
            f"/api/v1/categories/{other.pk}/",
            {"parent": str(parent.pk)},
            format="json",
        )

        assert response.status_code == 200
        other.refresh_from_db()
        assert other.parent_id == parent.pk


class TestCategoryTaxRate:
    """`Category.tax_rate` overrides the organisation default, and a basket
    takes the *highest* rate present -- so one bad category poisons every order
    containing it.
    """

    def test_a_rate_above_100_percent_is_refused(self, admin, shop):
        category = factories.category(name="Cosmetics")

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"tax_rate": "5.0000"},
            format="json",
        )

        assert response.status_code == 400
        category.refresh_from_db()
        assert category.tax_rate is None

    def test_a_negative_rate_is_refused(self, admin, shop):
        category = factories.category(name="Bags")

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"tax_rate": "-0.1000"},
            format="json",
        )

        assert response.status_code == 400

    def test_a_real_rate_is_accepted(self, admin, shop):
        category = factories.category(name="Watches")

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"tax_rate": "0.1500"},
            format="json",
        )

        assert response.status_code == 200
        category.refresh_from_db()
        assert category.tax_rate == Decimal("0.1500")

    def test_clearing_the_override_falls_back_to_the_organisation(self, admin, shop):
        category = factories.category(name="Socks", tax_rate=Decimal("0.1000"))

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"tax_rate": None},
            format="json",
        )

        assert response.status_code == 200
        category.refresh_from_db()
        assert category.tax_rate is None


class TestSlugsAreStable:
    def test_renaming_a_category_keeps_its_url(self, admin, shop):
        """A slug is a URL. Regenerating it on every rename silently breaks
        every link and every indexed page pointing at the old one.
        """
        category = factories.category(name="Mens Shoes")
        original = category.slug

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"name": "Men's Footwear"},
            format="json",
        )

        assert response.status_code == 200
        category.refresh_from_db()
        assert category.name == "Men's Footwear"
        assert category.slug == original

    def test_renaming_a_brand_keeps_its_url(self, admin, shop):
        brand = Brand.objects.create(name="Northline", slug="northline")

        response = admin.patch(
            f"/api/v1/brands/{brand.pk}/",
            {"name": "Northline Apparel"},
            format="json",
        )

        assert response.status_code == 200
        brand.refresh_from_db()
        assert brand.slug == "northline"

    def test_a_slug_can_still_be_changed_deliberately(self, admin, shop):
        category = factories.category(name="Kids")

        response = admin.patch(
            f"/api/v1/categories/{category.pk}/",
            {"slug": "children"},
            format="json",
        )

        assert response.status_code == 200
        category.refresh_from_db()
        assert category.slug == "children"

    def test_a_new_category_still_gets_a_slug(self, admin, shop):
        response = admin.post(
            "/api/v1/categories/", {"name": "Winter Coats"}, format="json"
        )

        assert response.status_code == 201
        assert Category.objects.get(name="Winter Coats").slug


class TestPermissions:
    def test_a_cashier_can_read_the_taxonomy(self, shop, cashier, auth_client):
        response = auth_client(cashier).get("/api/v1/categories/")

        assert response.status_code == 200

    def test_a_cashier_cannot_create_a_category(self, shop, cashier, auth_client):
        response = auth_client(cashier).post(
            "/api/v1/categories/", {"name": "Smuggled"}, format="json"
        )

        assert response.status_code == 403

    def test_a_cashier_cannot_create_a_brand(self, shop, cashier, auth_client):
        response = auth_client(cashier).post(
            "/api/v1/brands/", {"name": "Smuggled"}, format="json"
        )

        assert response.status_code == 403

    def test_an_anonymous_request_cannot_read_the_admin_taxonomy(self, shop, api):
        response = api.get("/api/v1/categories/")

        assert response.status_code in {401, 403}


class TestDeletion:
    def test_a_category_holding_products_cannot_be_deleted(self, admin, shop):
        """`Product.category` is PROTECT, so the database refuses. The API has
        to turn that into a business error rather than a 500.
        """
        response = admin.delete(f"/api/v1/categories/{shop['product'].category_id}/")

        assert response.status_code in {400, 409}
        assert Category.objects.filter(pk=shop["product"].category_id).exists()

    def test_an_empty_category_can_be_deleted(self, admin, shop):
        category = factories.category(name="Disposable")

        response = admin.delete(f"/api/v1/categories/{category.pk}/")

        assert response.status_code == 204
        assert not Category.objects.filter(pk=category.pk).exists()

    def test_a_brand_holding_products_cannot_be_deleted(self, admin, shop):
        brand = Brand.objects.create(name="Held", slug="held")
        shop["product"].brand = brand
        shop["product"].save(update_fields=["brand"])

        response = admin.delete(f"/api/v1/brands/{brand.pk}/")

        assert response.status_code in {400, 409}
        assert Brand.objects.filter(pk=brand.pk).exists()


class TestAttributes:
    def test_an_attribute_can_be_created_with_values(self, admin, shop):
        response = admin.post(
            "/api/v1/attributes/",
            {"code": "material", "name": "Material"},
            format="json",
        )

        assert response.status_code == 201
        attribute = Attribute.objects.get(code="material")

        value = admin.post(
            "/api/v1/attribute-values/",
            {"attribute": str(attribute.pk), "value": "Cotton"},
            format="json",
        )
        assert value.status_code == 201

    def test_an_attribute_value_in_use_cannot_be_deleted(self, admin, shop):
        variant = shop["variants"][0]
        link = variant.attribute_values.first()
        assert link is not None

        response = admin.delete(f"/api/v1/attribute-values/{link.attribute_value_id}/")

        assert response.status_code in {400, 409}
