"""Product images bind to a colour, not to a variant.

The rules under test are the ones that keep a photo shoot safe: an image may
only reference a colour the product actually comes in, and deleting the colour
must never delete the photograph (docs/architecture/product-media.md §7).
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import pytest
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test.utils import CaptureQueriesContext

from catalog.models import (
    Attribute,
    AttributeKind,
    AttributeValue,
    ProductImage,
    VariantAttributeValue,
)
from tests import factories

pytestmark = pytest.mark.django_db


def _png() -> SimpleUploadedFile:
    """A real 2x2 PNG: ImageField refuses anything that is not decodable."""
    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (2, 2), (255, 0, 0)).save(buffer, format="PNG")
    return SimpleUploadedFile("swatch.png", buffer.getvalue(), content_type="image/png")


def _colour_attribute(values: list[str]) -> tuple[Attribute, list[AttributeValue]]:
    attribute, _ = Attribute.objects.get_or_create(
        code="color",
        defaults={"name": "Colour", "kind": AttributeKind.COLOR, "is_variant_defining": True},
    )
    created = [
        AttributeValue.objects.get_or_create(
            attribute=attribute, value=value, defaults={"label": value.title()}
        )[0]
        for value in values
    ]
    return attribute, created


def _product_in_colours(branch: Any, colours: list[AttributeValue]) -> Any:
    product = factories.product()
    for colour in colours:
        variant = factories.variant(product, attribute_values=[colour])
        factories.stock(variant, branch, 5)
    return product


def _image(product: Any, colour: AttributeValue | None = None, **kwargs: Any) -> ProductImage:
    return ProductImage(product=product, attribute_value=colour, image="products/x.jpg", **kwargs)


class TestColourBinding:
    def test_an_image_may_bind_to_a_colour_the_product_comes_in(self, branch):
        _, colours = _colour_attribute(["black", "red"])
        product = _product_in_colours(branch, colours)

        image = _image(product, colours[0])
        image.full_clean(exclude=["image"])  # does not raise

    def test_an_image_bound_to_a_non_colour_attribute_is_rejected(self, branch):
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)
        size_attr, sizes = factories.attribute("size", values=["S"])
        factories.variant(product, attribute_values=[sizes[0]])

        with pytest.raises(ValidationError) as error:
            _image(product, sizes[0]).clean()

        assert "attribute_value" in error.value.message_dict

    def test_an_image_bound_to_a_colour_the_product_does_not_use_is_rejected(self, branch):
        _, colours = _colour_attribute(["black", "lime"])
        product = _product_in_colours(branch, [colours[0]])

        with pytest.raises(ValidationError) as error:
            _image(product, colours[1]).clean()

        assert "attribute_value" in error.value.message_dict

    def test_a_shared_image_needs_no_colour(self, branch):
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)

        _image(product, None).clean()  # does not raise

    def test_a_non_variant_defining_colour_is_rejected(self, branch):
        attribute = Attribute.objects.create(
            code="accent", name="Accent", kind=AttributeKind.COLOR, is_variant_defining=False
        )
        value = AttributeValue.objects.create(attribute=attribute, value="gold")
        product = factories.product()
        variant = factories.variant(product, attribute_values=[value])
        factories.stock(variant, branch, 1)

        with pytest.raises(ValidationError):
            _image(product, value).clean()


class TestDeletingAColour:
    def test_deleting_an_attribute_value_keeps_the_image(self, branch):
        _, colours = _colour_attribute(["black", "red"])
        product = _product_in_colours(branch, colours)
        image = _image(product, colours[1])
        image.save()

        # The variant link PROTECTs the value, so remove it the way the admin
        # would: unpick the variants first, then drop the colour.
        VariantAttributeValue.objects.filter(attribute_value=colours[1]).delete()
        colours[1].delete()

        image.refresh_from_db()
        assert image.pk is not None
        assert image.attribute_value_id is None


class TestStorefrontPayload:
    URL = "/api/v1/shop/products/"

    def _payload(self, api: Any, product: Any) -> dict[str, Any]:
        response = api.get(f"{self.URL}{product.slug}/")
        assert response.status_code == 200, response.data
        return response.data

    def test_each_image_carries_its_colour(self, api, branch):
        _, colours = _colour_attribute(["black", "red"])
        product = _product_in_colours(branch, colours)
        _image(product, colours[0], position=0).save()
        _image(product, None, position=1).save()

        images = self._payload(api, product)["images"]

        assert images[0]["color"]["label"] == "Black"
        assert images[0]["color"]["value"] == "black"
        assert images[1]["color"] is None  # shared

    def test_alt_text_names_the_colour(self, api, branch):
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)
        _image(product, colours[0]).save()

        alt = self._payload(api, product)["images"][0]["alt"]
        assert "Black" in alt and product.name in alt

    def test_grouping_costs_no_extra_query(self, api, branch):
        """§3: the colour rides along on the images prefetch that already exists."""
        _, colours = _colour_attribute(["black", "red"])
        for _ in range(3):
            product = _product_in_colours(branch, colours)
            for position, colour in enumerate(colours):
                _image(product, colour, position=position).save()

        api.get(self.URL)  # warm
        with CaptureQueriesContext(connection) as first:
            api.get(self.URL)

        for _ in range(6):
            product = _product_in_colours(branch, colours)
            for position, colour in enumerate(colours):
                _image(product, colour, position=position).save()

        with CaptureQueriesContext(connection) as second:
            api.get(self.URL)

        assert len(second) == len(first), (
            f"Queries grew from {len(first)} to {len(second)} once images carried "
            f"their colour: the images prefetch lost its select_related."
        )


class TestAdminApi:
    URL = "/api/v1/product-images/"

    def test_the_api_refuses_a_colour_the_product_does_not_use(self, auth_client, owner, branch):
        _, colours = _colour_attribute(["black", "lime"])
        product = _product_in_colours(branch, [colours[0]])

        response = auth_client(owner).post(
            self.URL,
            {
                "product": str(product.pk),
                "attribute_value": str(colours[1].pk),
                "image": _png(),
            },
            format="multipart",
        )

        assert response.status_code == 400
        assert "attribute_value" in response.data["error"]["details"]

    def test_the_api_accepts_a_colour_the_product_does_use(self, auth_client, owner, branch):
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)

        response = auth_client(owner).post(
            self.URL,
            {
                "product": str(product.pk),
                "attribute_value": str(colours[0].pk),
                "image": _png(),
            },
            format="multipart",
        )

        assert response.status_code == 201, response.data
        assert response.data["color"]["label"] == "Black"
        # The first image of a product becomes its primary one.
        assert response.data["is_primary"] is True
