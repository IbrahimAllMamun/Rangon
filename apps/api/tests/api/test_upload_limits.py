"""Every image field enforces the same limits, not just product photographs.

`docs/operations/security.md` promised a size cap and a four-format allow-list
on uploads. Measured on 2026-09-23, that held for `product-images/` alone:
category images, brand logos and navigation and banner artwork took an image
over the cap (**201**) in any of the ~70 formats Pillow decodes -- PostScript
included, which is served as `application/postscript`.

What *did* hold, and is asserted below so it stays that way: none of the four
accepts a file named `.html`, however decodable its bytes. Django's model-level
extension validator refuses it -- the probe that found the gap above was
written expecting a stored-XSS polyglot and got a 400.

Run against `main`, the size and format tests fail for all four endpoints; the
`.html` and valid-PNG tests pass there too, as controls should.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from accounts.models import RoleCode
from tests import factories

pytestmark = pytest.mark.django_db


def _image(name: str, format: str, *, extra: bytes = b"") -> SimpleUploadedFile:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (200, 40, 10)).save(buffer, format=format)
    return SimpleUploadedFile(name, buffer.getvalue() + extra, content_type="image/png")


#: (endpoint, file field, the rest of a valid payload)
ENDPOINTS = [
    ("/api/v1/categories/", "image", {"name": "Sarees", "slug": "sarees"}),
    ("/api/v1/brands/", "logo", {"name": "Lumen", "slug": "lumen"}),
    ("/api/v1/navigation-items/", "image", {"type": "LINK", "label": "Sale", "url": "/sale"}),
    (
        "/api/v1/storefront-banners/",
        "image",
        {"placement": "HOME_HERO", "title": "Eid", "message": "Eid"},
    ),
]


@pytest.fixture
def client(auth_client: Any) -> Any:
    return auth_client(factories.user(RoleCode.OWNER))


@pytest.mark.parametrize(("url", "field", "payload"), ENDPOINTS)
class TestEveryImageField:
    def test_a_png_is_accepted(self, client: Any, url: str, field: str, payload: dict) -> None:
        """The control: the limits must not refuse an ordinary upload."""
        response = client.post(
            url, {**payload, field: _image("art.png", "PNG")}, format="multipart"
        )

        assert response.status_code == 201, response.data

    def test_an_image_over_the_cap_is_refused(
        self, client: Any, settings: Any, url: str, field: str, payload: dict
    ) -> None:
        """Fails on `main`: 201."""
        settings.RANGON_MAX_IMAGE_BYTES = 32
        oversized = _image("art.png", "PNG")
        assert oversized.size > 32

        response = client.post(url, {**payload, field: oversized}, format="multipart")

        assert response.status_code == 400
        assert field in response.data["error"]["details"]

    @pytest.mark.parametrize(("name", "format"), [("art.gif", "GIF"), ("art.eps", "EPS")])
    def test_a_format_outside_the_four_is_refused(
        self, client: Any, url: str, field: str, payload: dict, name: str, format: str
    ) -> None:
        """Fails on `main`: Pillow decodes both, so both were stored."""
        response = client.post(url, {**payload, field: _image(name, format)}, format="multipart")

        assert response.status_code == 400
        assert field in response.data["error"]["details"]

    def test_a_decodable_file_named_html_is_refused(
        self, client: Any, url: str, field: str, payload: dict
    ) -> None:
        """Held before this change too. Kept so it cannot quietly stop holding."""
        polyglot = _image("art.html", "GIF", extra=b"<script>alert(document.domain)</script>")

        response = client.post(url, {**payload, field: polyglot}, format="multipart")

        assert response.status_code == 400
