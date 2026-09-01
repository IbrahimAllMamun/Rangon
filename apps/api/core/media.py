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

from typing import Any

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.views.static import serve
from rest_framework import serializers


def media_url(file: Any) -> str:
    """The public URL of a `FileField`/`ImageField` value, or `""` if unset.

    Callers pass the field itself (`product.image`), not `.url`: an empty
    `FieldFile` is falsy but raises `ValueError` on `.url`.
    """
    if not file:
        return ""
    return str(file.url)


def serve_media(request: HttpRequest, path: str) -> HttpResponse:
    """Serve an uploaded file from `MEDIA_ROOT` (wired up in `config.urls`).

    A thin wrapper rather than `serve` with a baked-in `document_root`, because
    that kwarg would be captured when the URLconf is imported and no later
    override of `MEDIA_ROOT` — a test's `tmp_path`, most obviously — could ever
    take effect.
    """
    return serve(request, path, document_root=settings.MEDIA_ROOT)


class RelativeFileField(serializers.FileField):
    """A `FileField` that publishes the URL `media_url` would.

    DRF renders a file by absolutising it against the incoming request, so any
    serializer naming a `FileField`/`ImageField` in `Meta.fields` reintroduces
    the bug this module exists to fix — a category image uploaded through the
    admin came back as `http://api:8000/media/categories/...`. Declaring the
    field with this class keeps it writable and makes the read origin-relative.
    """

    def to_representation(self, value: Any) -> str:  # type: ignore[override]
        return media_url(value)


class RelativeImageField(serializers.ImageField):
    """`RelativeFileField` for image fields: keeps Pillow's decode check."""

    def to_representation(self, value: Any) -> str:  # type: ignore[override]
        return media_url(value)
