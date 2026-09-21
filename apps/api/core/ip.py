"""Which address a request actually came from.

`X-Forwarded-For` is a list the client starts and every proxy appends to, so
the only entries worth believing are the ones *our own* proxies wrote. How many
that is depends on the deployment, not on the request, so it is configuration:
``settings.TRUSTED_PROXY_HOPS`` (``DJANGO_TRUSTED_PROXY_HOPS``).

    hops = 0   no proxy: ignore the header entirely and use REMOTE_ADDR.
    hops = 1   one reverse proxy (the shipped Nginx): trust its entry only.
    hops = n   n proxies we control, chained.

Counting from the **right** is the whole point. The left-hand entries are
whatever the client sent; each proxy appends the peer it actually saw, so the
n-th entry from the right is the address our outermost trusted proxy observed.
Reading from the left hands the attacker the answer, which is what this module
was written to stop -- 40 password guesses in a row went unthrottled and were
logged under 40 addresses of the attacker's choosing, because both the throttle
key and the audit trail took the left-hand entry.

Both consumers read the same number through this module: `core.middleware`
stamps the audit trail, and `core.throttling` keys DRF's rate limits.
`tests/test_client_ip.py` pins them to the same answer.
"""

from __future__ import annotations

from django.conf import settings
from django.http import HttpRequest
from rest_framework.request import Request

#: Nothing longer than this is an address; `AuditLog.ip_address` is a
#: `GenericIPAddressField`, which refuses anything it cannot parse.
MAX_LENGTH = 45


def trusted_proxy_hops() -> int:
    """How many proxies in front of us append to `X-Forwarded-For`.

    Read at call time rather than at import, so a test can override it.
    """
    return max(0, int(getattr(settings, "TRUSTED_PROXY_HOPS", 0)))


def client_ip(request: HttpRequest | Request) -> str | None:
    """The peer address, believing only what our own proxies appended.

    Returns `REMOTE_ADDR` when there is no trusted proxy, when the header is
    absent, or when it holds fewer entries than there are trusted hops -- the
    last of which means the request did not arrive the way we were told it
    would, and the socket is the only thing left worth believing.
    """
    remote_addr = request.META.get("REMOTE_ADDR")
    hops = trusted_proxy_hops()
    if hops == 0:
        return remote_addr

    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    entries = [entry.strip() for entry in forwarded.split(",") if entry.strip()]
    if len(entries) < hops:
        # Fewer hops than configured: either the header was stripped or the
        # request reached us without passing the proxy. Do not fall back to an
        # entry the client may have written -- that is the bypass itself.
        return remote_addr
    return entries[-hops][:MAX_LENGTH]
