"""The public product feed endpoints.

Deliberately thin: everything about *what* the feed says lives in
`catalog.feeds`, and these two views only choose a rendering and a content
type.

Public and unauthenticated, because that is how Meta and Google fetch a feed —
a scheduled GET from their own infrastructure, with no way to hold a
credential. Nothing here is private: the feed contains what the storefront
already shows anyone, and never `cost`, which is the one catalogue figure a
competitor would want.

The response is cached rather than rate-limited into uselessness. A feed is
re-fetched on a schedule measured in hours, so a fetch that is minutes stale is
correct; what matters is that a burst of requests cannot walk the whole
catalogue repeatedly.
"""

from __future__ import annotations

from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views.decorators.cache import cache_page
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.views import APIView

from catalog import feeds

#: Long enough that a scraper cannot use the feed to hammer the database, short
#: enough that a price change reaches Meta within the hour it would anyway.
CACHE_SECONDS = 15 * 60


class _FeedView(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list = []
    throttle_scope = "search"

    content_type = ""

    def render(self, items: list[feeds.FeedItem]) -> str:  # pragma: no cover - abstract
        raise NotImplementedError

    @method_decorator(cache_page(CACHE_SECONDS))
    def get(self, request: Request) -> HttpResponse:
        # `feed_items()` raises FeedNotConfigured when the public origin is
        # unset; the DRF exception handler turns that into the standard error
        # envelope with a 503, which is the honest answer -- the feed is not
        # broken, it is not set up.
        body = self.render(feeds.feed_items())
        response = HttpResponse(body, content_type=self.content_type)
        response["Content-Disposition"] = f'inline; filename="{self.filename}"'
        return response


class ProductFeedXMLView(_FeedView):
    """RSS 2.0 with the `g:` namespace. The format to hand Meta or Google."""

    content_type = "application/xml; charset=utf-8"
    filename = "rangon-products.xml"

    def render(self, items: list[feeds.FeedItem]) -> str:
        return feeds.render_xml(items)


class ProductFeedCSVView(_FeedView):
    """The same rows as a spreadsheet, for checking what is being advertised."""

    content_type = "text/csv; charset=utf-8"
    filename = "rangon-products.csv"

    def render(self, items: list[feeds.FeedItem]) -> str:
        return feeds.render_csv(items)
