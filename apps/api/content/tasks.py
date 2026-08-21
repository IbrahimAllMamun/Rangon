"""Storefront cache invalidation.

Next caches the navigation payload against the `navigation` tag, so a menu edit
would otherwise sit invisible until the ISR window expired.  This pings the web
app's revalidation endpoint.

It is a Celery job because nothing depends on it completing: if the ping is lost
the storefront keeps serving the previous menu until `revalidate` elapses.  No
financial or stock invariant is involved (CLAUDE.md §4).  Unconfigured — no
`WEB_REVALIDATE_URL` — it is a documented no-op, so a fresh install works.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from celery import shared_task
from django.conf import settings

logger = logging.getLogger("rangon.content")

TIMEOUT_SECONDS = 5


@shared_task(bind=True, max_retries=2, default_retry_delay=30)
def revalidate_storefront(self, tags: list[str]) -> str:
    url = getattr(settings, "WEB_REVALIDATE_URL", "")
    if not url or not tags:
        return "skipped"

    body = json.dumps({"tags": list(tags)}).encode()
    request = urllib.request.Request(  # noqa: S310 - fixed scheme, operator-configured
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Revalidate-Secret": getattr(settings, "WEB_REVALIDATE_SECRET", ""),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
            response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        logger.warning("Storefront revalidation failed for %s: %s", tags, exc)
        raise self.retry(exc=exc) from exc
    return "sent"


def request_revalidation(*tags: str) -> None:
    """Fire-and-forget from a request thread; never raises into the caller."""
    if not getattr(settings, "WEB_REVALIDATE_URL", ""):
        return
    try:
        revalidate_storefront.delay(list(tags))
    except Exception as exc:  # pragma: no cover - broker down
        logger.warning("Could not queue storefront revalidation %s: %s", tags, exc)
