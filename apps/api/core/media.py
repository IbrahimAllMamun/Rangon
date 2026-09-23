"""One rule for turning a stored file into a URL the browser can fetch.

Every media URL used to be absolutised with `request.build_absolute_uri()`.
That is wrong here, because the API is never reached directly by the browser:

* through the storefront's proxy route the request arrives with
  `Host: api:8000`, so the payload advertised `http://api:8000/media/...` — an
  internal Docker name no browser can resolve;
* through Nginx it arrives with `Host: localhost` (nginx forwards `$host`,
  which drops the port), so the payload advertised `http://localhost/media/...`
  and the port of the real origin was lost.

Both are the same mistake: the API cannot know the public origin, and it does
not need to. Storefront, admin and POS are all served from that one origin
(Nginx fronts `/api/`, `/media/` and the Next app together), so a **root
relative** URL is correct everywhere and survives any hostname, port or scheme
the deployment happens to use.

`FieldFile.url` already gives exactly that for `FileSystemStorage`
(`/media/products/...`), and gives a fully-qualified bucket URL under
`S3Storage` when `USE_S3=1`. Returning it untouched is therefore right in both
configurations - which is why this helper deliberately does nothing clever.
"""

from __future__ import annotations

import posixpath
from typing import Any

from django.conf import settings
from django.http import FileResponse, Http404, HttpRequest
from django.views.static import serve
from rest_framework import serializers

#: Uploads that are nobody's business but staff's. `/media/` never serves them;
#: they are reached only through an endpoint that checks who is asking --
#: `GET /api/v1/expenses/{id}/attachment/` for receipts.
#:
#: Until 2026-09-23 this route served receipts to anyone, signed in or not, at
#: `/media/expenses/<year>/<month>/<the uploader's own filename>` (D91). Nginx
#: refuses the same prefix, so the lock holds if `/media/` is ever handed to an
#: `alias` for speed. Add a prefix here *and* there when a new private upload
#: appears.
PRIVATE_PREFIXES = ("expenses/",)


def is_private(path: str) -> bool:
    """Whether `path` (relative to MEDIA_ROOT) names a staff-only upload.

    Normalised first: `./expenses/`, `a/../expenses/` and a doubled slash all
    reach the same file on disk, so they have to reach the same answer.
    """
    clean = posixpath.normpath(path).lstrip("/")
    return clean.startswith(PRIVATE_PREFIXES)


def media_url(file: Any) -> str:
    """The public URL of a `FileField`/`ImageField` value, or `""` if unset.

    Callers pass the field itself (`product.image`), not `.url`: an empty
    `FieldFile` is falsy but raises `ValueError` on `.url`.
    """
    if not file:
        return ""
    return str(file.url)


def serve_media(request: HttpRequest, path: str) -> FileResponse:
    """Serve an uploaded file from `MEDIA_ROOT` (wired up in `config.urls`).

    A thin wrapper rather than `serve` with a baked-in `document_root`, because
    that kwarg would be captured when the URLconf is imported and no later
    override of `MEDIA_ROOT` — a test's `tmp_path`, most obviously — could ever
    take effect.
    """
    if is_private(path):
        raise Http404
    return serve(request, path, document_root=str(settings.MEDIA_ROOT))


#: What a photograph may arrive as. Pillow decodes about seventy formats --
#: PostScript among them -- and a model `ImageField` accepts any of them; this
#: is the four a browser displays, which is what the policy says
#: (docs/operations/security.md).
ALLOWED_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".avif")


def validate_image_upload(value: Any) -> Any:
    """Size and type, server-side, for every image anyone uploads.

    `ImageField` only proves Pillow can decode the file; it caps nothing.
    Django's `FILE_UPLOAD_MAX_MEMORY_SIZE` is not a limit either -- a larger
    upload simply spills to a temporary file -- so without this a 200 MB
    "photograph" would be accepted and then served back forever.

    Product photography had this from the start; category images, brand logos
    and navigation and banner artwork did not, and took any size in any of
    Pillow's formats until 2026-09-23. One function now, so a sixth image field
    cannot be added without it by accident of copying the wrong serializer.

    `content_type` is the type Pillow *detected*, not the one the browser
    claimed: DRF's `ImageField` overwrites it after decoding.
    """
    if not value:
        return value
    if value.size > settings.RANGON_MAX_IMAGE_BYTES:
        limit = settings.RANGON_MAX_IMAGE_BYTES // (1024 * 1024)
        raise serializers.ValidationError(f"The image must be smaller than {limit} MB.")
    content_type = (getattr(value, "content_type", "") or "").lower()
    if content_type and content_type not in settings.RANGON_ALLOWED_IMAGE_TYPES:
        raise serializers.ValidationError("Upload a JPEG, PNG, WebP or AVIF image.")
    if not str(value.name).lower().endswith(ALLOWED_IMAGE_EXTENSIONS):
        raise serializers.ValidationError("Upload a JPEG, PNG, WebP or AVIF image.")
    return value


class RelativeFileField(serializers.FileField):
    """A `FileField` that publishes the URL `media_url` would.

    DRF renders a file by absolutising it against the incoming request, so any
    serializer naming a `FileField`/`ImageField` in `Meta.fields` reintroduces
    the bug this module exists to fix — a category image uploaded through the
    admin came back as `http://api:8000/media/categories/...`. Declaring the
    field with this class keeps it writable and makes the read origin-relative.
    """

    def to_representation(self, value: Any) -> str:
        return media_url(value)


class RelativeImageField(serializers.ImageField):
    """`RelativeFileField` for image fields: keeps Pillow's decode check."""

    def to_representation(self, value: Any) -> str:
        return media_url(value)
