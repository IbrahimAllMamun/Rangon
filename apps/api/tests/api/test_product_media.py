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


class TestImageUrlsAreOriginRelative:
    """The API cannot know the public origin, so it must not guess one.

    Every media URL used to be `request.build_absolute_uri(...)`. The browser
    never talks to Django directly: through the storefront proxy the request
    carries `Host: api:8000`, and through Nginx it carries `Host: localhost`
    with the port stripped. Both produced URLs no browser could load, which is
    how uploaded photography reached the admin as a broken image
    (docs/architecture/product-media.md section 8).
    """

    def test_admin_upload_returns_a_relative_url(self, auth_client, owner, branch):
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)

        response = auth_client(owner).post(
            "/api/v1/product-images/",
            {"product": str(product.pk), "image": _png()},
            format="multipart",
            # The Host the Next.js proxy forwards under: an internal Docker name.
            HTTP_HOST="api:8000",
        )

        assert response.status_code == 201, response.data
        assert response.data["url"].startswith("/media/"), response.data["url"]
        # No field may leak the host, `url` or otherwise.
        assert "api:8000" not in str(response.data)

    def test_storefront_payload_returns_a_relative_url(self, api, branch):
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)
        _image(product, colours[0]).save()

        response = api.get(f"/api/v1/shop/products/{product.slug}/", HTTP_HOST="localhost")

        assert response.status_code == 200, response.data
        assert response.data["images"][0]["url"].startswith("/media/")

    def test_the_url_does_not_depend_on_the_host_header(self, api, branch):
        """The same row must serialise identically behind any proxy."""
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)
        _image(product, colours[0]).save()

        path = f"/api/v1/shop/products/{product.slug}/"
        through_nginx = api.get(path, HTTP_HOST="localhost").data["images"][0]["url"]
        through_proxy = api.get(path, HTTP_HOST="api:8000").data["images"][0]["url"]

        assert through_nginx == through_proxy


class TestMediaIsServed:
    """Uploading a photograph is only half the job; it has to come back.

    `django.conf.urls.static.static()` returns nothing unless DEBUG, so with
    DEBUG=0 the upload succeeded and every image 404ed.
    """

    def test_an_uploaded_image_is_downloadable_with_debug_off(
        self, auth_client, owner, branch, settings, tmp_path
    ):
        # The suite stores uploads in memory for speed; serving them is a
        # question about the *disk* backend, which is what every non-S3
        # deployment runs.
        settings.DEBUG = False
        settings.MEDIA_ROOT = tmp_path
        settings.STORAGES = {
            **settings.STORAGES,
            "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        }
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)

        created = auth_client(owner).post(
            "/api/v1/product-images/",
            {"product": str(product.pk), "image": _png()},
            format="multipart",
        )
        assert created.status_code == 201, created.data

        response = auth_client(owner).get(created.data["url"])

        assert response.status_code == 200, f"{created.data['url']} is not served"
        assert response["Content-Type"] == "image/png"


class TestUploadValidation:
    """The admin form's limits are a courtesy; the API has to enforce them.

    `ImageField` proves only that Pillow can decode the bytes, and
    `FILE_UPLOAD_MAX_MEMORY_SIZE` is a buffering threshold rather than a cap -
    a bigger upload spills to a temp file and is accepted (CLAUDE.md section 4).
    """

    URL = "/api/v1/product-images/"

    def test_an_oversized_image_is_refused(self, auth_client, owner, branch, settings):
        # A *decodable* image over the cap: the point is the size check, not
        # Pillow rejecting corrupt bytes before it is ever reached.
        settings.RANGON_MAX_IMAGE_BYTES = 32
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)

        oversized = _png()
        assert oversized.size > 32

        response = auth_client(owner).post(
            self.URL,
            {"product": str(product.pk), "image": oversized},
            format="multipart",
        )

        assert response.status_code == 400
        assert "image" in response.data["error"]["details"]
        assert ProductImage.objects.filter(product=product).count() == 0

    def test_an_image_declaring_a_disallowed_type_is_refused(self, auth_client, owner, branch):
        """Real PNG bytes, renamed and declared as SVG.

        SVG carries script, so it is not in `RANGON_ALLOWED_IMAGE_TYPES`. Pillow
        decodes the payload happily, which is exactly why the decode is not the
        check that matters.
        """
        _, colours = _colour_attribute(["black"])
        product = _product_in_colours(branch, colours)

        disguised = SimpleUploadedFile("payload.svg", _png().read(), content_type="image/svg+xml")
        response = auth_client(owner).post(
            self.URL,
            {"product": str(product.pk), "image": disguised},
            format="multipart",
        )

        assert response.status_code == 400
        assert "image" in response.data["error"]["details"]
        assert ProductImage.objects.filter(product=product).count() == 0


class TestEveryUploadFieldIsRelative:
    """Product photography was not the only thing carrying a broken host.

    DRF renders a `FileField`/`ImageField` by absolutising it against the
    incoming request, so *every* serializer naming one in `Meta.fields` had the
    same defect - category images, brand logos, navigation and banner artwork,
    expense receipts. `core.media.RelativeImageField` is what keeps them
    origin-relative (product-media.md section 8).
    """

    # The Host the Next.js proxy forwards under: an internal Docker name that
    # no browser can resolve.
    PROXY_HOST = "api:8000"

    def test_a_category_image_is_relative(self, auth_client, owner):
        from catalog.models import Category

        category = Category.objects.create(name="Serums", slug="serums", image=_png())
        response = auth_client(owner).get(
            f"/api/v1/categories/{category.pk}/", HTTP_HOST=self.PROXY_HOST
        )

        assert response.status_code == 200, response.data
        assert response.data["image"].startswith("/media/"), response.data["image"]
        assert self.PROXY_HOST not in str(response.data)

    def test_a_brand_logo_is_relative(self, auth_client, owner):
        from catalog.models import Brand

        brand = Brand.objects.create(name="Lumen", slug="lumen", logo=_png())
        response = auth_client(owner).get(f"/api/v1/brands/{brand.pk}/", HTTP_HOST=self.PROXY_HOST)

        assert response.status_code == 200, response.data
        assert response.data["logo"].startswith("/media/"), response.data["logo"]
        assert self.PROXY_HOST not in str(response.data)
