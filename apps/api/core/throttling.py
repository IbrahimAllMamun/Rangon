"""Rate limits keyed on an address the caller cannot choose.

DRF's `BaseThrottle.get_ident` falls back, when `NUM_PROXIES` is unset, to using
the whole of `X-Forwarded-For` as the key. That header is client-supplied, so
varying it hands the caller a fresh bucket per request and every limit CLAUDE.md
§8 asks for -- sign-in, password change, checkout, search -- stops existing.
Measured before this module existed: 40 consecutive wrong-password posts, none
refused, against a control run that was refused at the eleventh.

These subclasses key on `core.ip.client_ip` instead, which counts trusted
proxies from the right of the header. `settings.TRUSTED_PROXY_HOPS` says how
many there are, and defaults to 0 -- ignore the header altogether.
"""

from __future__ import annotations

from rest_framework import throttling
from rest_framework.request import Request

from core.ip import client_ip


class TrustedIdentMixin:
    """Key the bucket on the address, not on what the caller claims it is."""

    def get_ident(self, request: Request) -> str:
        # `client_ip` answers `None` when there is no address to be had, which
        # is the honest value for the audit trail's nullable column. A throttle
        # needs *a* key, so an address-less request shares one bucket: the
        # fail-closed direction, and the direction DRF already goes.
        return client_ip(request) or ""


class AnonRateThrottle(TrustedIdentMixin, throttling.AnonRateThrottle):
    pass


class UserRateThrottle(TrustedIdentMixin, throttling.UserRateThrottle):
    pass


class ScopedRateThrottle(TrustedIdentMixin, throttling.ScopedRateThrottle):
    pass
