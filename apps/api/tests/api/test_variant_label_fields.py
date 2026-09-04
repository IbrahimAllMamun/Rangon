"""What a barcode label needs to print, and where it comes from.

The label carries a brand heading and one line per variant attribute
("Size M", "Colour Black"). The attributes were already serialised; the brand
was not, and reaching it goes through a nullable FK on the product -- which is
the shape that costs a query per row on a screen that renders a page of
variants at a time.
"""

from __future__ import annotations

import pytest

from tests import factories

pytestmark = pytest.mark.django_db

VARIANTS = "/api/v1/variants/"


class TestTheBrandHeading:
    def test_a_variant_carries_its_product_brand(self, shop, auth_client) -> None:
        product = factories.product(brand=factories.brand(name="Fashion Street"))
        variant = factories.variant(product)

        response = auth_client(shop["owner"]).get(f"{VARIANTS}{variant.pk}/")

        assert response.json()["brand_name"] == "Fashion Street"

    def test_an_unbranded_product_sends_an_empty_string(self, shop, auth_client) -> None:
        """`brand` is nullable, and a label heading wants "" rather than the
        string "None" printed across the top of it.

        Cleared after creation because `factories.product` reads its argument
        as `kwargs.pop("brand", None) or brand()`, so passing None asks for a
        generated brand rather than for no brand.
        """
        product = factories.product()
        product.brand = None
        product.save(update_fields=["brand"])
        variant = factories.variant(product)

        response = auth_client(shop["owner"]).get(f"{VARIANTS}{variant.pk}/")

        assert response.status_code == 200
        assert response.json()["brand_name"] == ""

    def test_listing_variants_costs_no_query_per_brand(
        self, shop, auth_client, django_assert_num_queries
    ) -> None:
        """Reaching `product.brand.name` per row without a join is exactly the
        N+1 that D10 fixed on the three busiest list endpoints."""
        client = auth_client(shop["owner"])
        for _ in range(3):
            factories.variant(factories.product(brand=factories.brand()))

        def count() -> int:
            from django.db import connection
            from django.test.utils import CaptureQueriesContext

            with CaptureQueriesContext(connection) as captured:
                assert client.get(VARIANTS, {"limit": 50}).status_code == 200
            return len(captured)

        count()  # warm the per-instance permission cache
        for_three = count()

        for _ in range(7):
            factories.variant(factories.product(brand=factories.brand()))
        for_ten = count()

        assert for_ten == for_three, (
            f"{for_three} queries for three variants but {for_ten} for ten: "
            "the brand join is missing again"
        )


class TestTheAttributeLines:
    def test_each_attribute_arrives_named_and_displayable(self, shop, auth_client) -> None:
        """The label prints one line per attribute, so it needs the attribute's
        own name ("Size") beside the value ("M") -- not the joined `label`,
        which is a single "M / Black" string with no way to split it safely."""
        size, values = factories.attribute("size", name="Size", values=["M"])
        variant = factories.variant(shop["product"], attribute_values=values)

        response = auth_client(shop["owner"]).get(f"{VARIANTS}{variant.pk}/")

        attributes = response.json()["attributes"]
        assert len(attributes) == 1
        assert attributes[0]["attribute_name"] == "Size"
        assert attributes[0]["label"] == "M"

    def test_a_variant_with_no_attributes_sends_an_empty_list(self, shop, auth_client) -> None:
        variant = factories.variant(shop["product"])

        response = auth_client(shop["owner"]).get(f"{VARIANTS}{variant.pk}/")

        assert response.json()["attributes"] == []
