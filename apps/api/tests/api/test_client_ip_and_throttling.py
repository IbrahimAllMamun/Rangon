"""Rate limits and the audit trail, against a caller who lies about their address.

`X-Forwarded-For` is written by the client and appended to by each proxy. DRF's
stock throttles, with `NUM_PROXIES` unset, key on the whole header -- so varying
it bought a fresh bucket per request and every limit CLAUDE.md §8 asks for
stopped existing. The same header, read left-most, was what the audit trail
recorded as the source address.

Measured against `main` before this was written, with the API running and Redis
behind it: 40 consecutive wrong-password posts to `/auth/login/`, each carrying
a different `X-Forwarded-For`, **none refused** -- against a control run with no
header that was refused at the eleventh. The 40 attempts were then logged under
40 distinct addresses of the caller's choosing.

**Anonymous requests are the whole of it.** `ScopedRateThrottle` keys on
`request.user.pk` once the caller is authenticated, so the password-change
limit (D87) was never reachable this way. Sign-in, checkout and search are
anonymous, and they were. The first draft of these tests aimed at
`auth/password/change/` and passed against `main` -- which is the argument for
running a new test against the old code before believing it.

Re-expressed without the new modules and run against `main`, the two behaviour
tests here fail and their controls pass:

    test_..._by_changing_the_header ......... assert [401, 401] == [429, 429]
    test_..._reach_the_audit_trail .......... assert '203.0.113.9' != '203.0.113.9'
    test_control_one_address_is_still_limited  passed -- main limits a caller
                                               who does not vary the header
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIClient, APIRequestFactory
from rest_framework.throttling import ScopedRateThrottle as StockScopedRateThrottle

from accounts.api.views import LoginView
from core.ip import client_ip
from core.models import AuditAction, AuditLog
from core.throttling import ScopedRateThrottle

pytestmark = pytest.mark.django_db

LOGIN = "/api/v1/auth/login/"

#: What a caller writes, and what the proxy appends behind it. Nginx's
#: `$proxy_add_x_forwarded_for` produces exactly this shape.
FORGED = "203.0.113.9"
REAL = "198.51.100.7"


@pytest.fixture(autouse=True)
def _fresh_throttle_counts() -> None:
    # Throttle history lives in the cache, which outlives a test.
    cache.clear()


def _request(xff: str | None = None, remote_addr: str = REAL) -> Any:
    extra = {"REMOTE_ADDR": remote_addr}
    if xff is not None:
        extra["HTTP_X_FORWARDED_FOR"] = xff
    return APIRequestFactory().get("/", **extra)


class TestClientIp:
    """Which entry of the header is believed, and when none of it is."""

    def test_with_no_trusted_proxy_the_header_is_ignored_entirely(self) -> None:
        with override_settings(TRUSTED_PROXY_HOPS=0):
            assert client_ip(_request(xff=FORGED)) == REAL

    def test_with_no_header_the_socket_address_is_used(self) -> None:
        with override_settings(TRUSTED_PROXY_HOPS=1):
            assert client_ip(_request()) == REAL

    def test_one_proxy_believes_only_what_that_proxy_appended(self) -> None:
        # The caller wrote FORGED; nginx appended the peer it actually saw.
        with override_settings(TRUSTED_PROXY_HOPS=1):
            assert client_ip(_request(xff=f"{FORGED}, {REAL}")) == REAL

    def test_two_proxies_step_two_entries_in_from_the_right(self) -> None:
        with override_settings(TRUSTED_PROXY_HOPS=2):
            assert client_ip(_request(xff=f"{FORGED}, {REAL}, 10.0.0.1")) == REAL

    def test_a_header_shorter_than_the_trusted_hops_is_not_believed(self) -> None:
        """The request did not come the way we were told, so only the socket counts.

        Falling back to an entry the caller wrote is the bypass itself: a
        direct hit on the API, around the proxy, carries exactly one entry and
        the caller chose it.
        """
        with override_settings(TRUSTED_PROXY_HOPS=2):
            assert client_ip(_request(xff=FORGED)) == REAL

    def test_whitespace_and_empty_entries_do_not_shift_the_count(self) -> None:
        with override_settings(TRUSTED_PROXY_HOPS=1):
            assert client_ip(_request(xff=f"{FORGED},  , {REAL} ")) == REAL


class TestThrottleKey:
    """The bucket a caller lands in, and whether they can choose it."""

    def test_varying_the_header_does_not_buy_a_new_bucket(self) -> None:
        throttle = ScopedRateThrottle()
        with override_settings(TRUSTED_PROXY_HOPS=0):
            idents = {throttle.get_ident(_request(xff=f"203.0.113.{n}")) for n in range(20)}

        assert idents == {REAL}

    def test_behind_a_proxy_only_the_appended_entry_counts(self) -> None:
        throttle = ScopedRateThrottle()
        with override_settings(TRUSTED_PROXY_HOPS=1):
            idents = {throttle.get_ident(_request(xff=f"203.0.113.{n}, {REAL}")) for n in range(20)}

        assert idents == {REAL}

    def test_two_real_callers_still_get_two_buckets(self) -> None:
        """A control. Throttling everyone into one bucket would also pass the
        tests above, and would break the shop instead of protecting it."""
        throttle = ScopedRateThrottle()
        with override_settings(TRUSTED_PROXY_HOPS=1):
            first = throttle.get_ident(_request(xff=f"{FORGED}, 198.51.100.1"))
            second = throttle.get_ident(_request(xff=f"{FORGED}, 198.51.100.2"))

        assert first != second

    def test_the_stock_drf_class_is_what_this_replaced(self) -> None:
        """Documents the defect rather than guarding it.

        If a later DRF release changes this, the comment in `core.throttling`
        needs rereading -- but the classes above stay correct either way.
        """
        stock = StockScopedRateThrottle()
        idents = {stock.get_ident(_request(xff=f"203.0.113.{n}")) for n in range(20)}

        assert len(idents) == 20  # twenty buckets for one caller

    def test_the_throttle_and_the_audit_trail_agree(self) -> None:
        """One rule, two consumers. Two implementations is how they drift --
        and how this defect existed in two places at once."""
        throttle = ScopedRateThrottle()
        request = _request(xff=f"{FORGED}, {REAL}")
        with override_settings(TRUSTED_PROXY_HOPS=1):
            assert throttle.get_ident(request) == client_ip(request)


class TestThrottleOverHttp:
    """The whole path: a real view, a real cache, a caller varying the header.

    Anonymous requests are where this bites. `ScopedRateThrottle` keys on
    `request.user.pk` once the caller is authenticated, so the password-change
    limit (D87) was never reachable this way -- but sign-in, checkout and
    search are all anonymous, and they were.

    `config.settings.test` empties `DEFAULT_THROTTLE_CLASSES`, so the view's
    own attribute is patched rather than the setting. That is not a shortcut:
    `APIView.throttle_classes` is read from `api_settings` **once, at import**,
    so `override_settings(REST_FRAMEWORK=...)` never reaches a view that is
    already imported. The first draft did that and passed alone while failing
    inside the suite, which is the same class of mistake as a non-blocking
    gate -- a test that reports on whatever ran before it.
    """

    @contextmanager
    def _limited(self) -> Iterator[None]:
        """`LoginView` throttled exactly as production throttles it."""
        with patch.object(LoginView, "throttle_classes", [ScopedRateThrottle]):
            yield

    def _login(self, xff: str) -> int:
        return (
            APIClient()
            .post(
                LOGIN,
                {"email": "nobody@example.test", "password": "wrong"},
                format="json",
                HTTP_X_FORWARDED_FOR=xff,
            )
            .status_code
        )

    def test_a_guesser_cannot_outrun_the_limit_by_changing_the_header(self) -> None:
        """Fails on `main` -- `[401, 401]` where `[429, 429]` is asserted.

        `auth` is 10/min and this is the sign-in form: the limit between one
        address and every password in a word list.
        """
        with self._limited(), override_settings(TRUSTED_PROXY_HOPS=0):
            statuses = [self._login(xff=f"203.0.113.{n}") for n in range(12)]

        assert statuses[:10] == [401] * 10
        assert statuses[10:] == [429, 429]

    def test_behind_a_proxy_the_limit_still_holds(self) -> None:
        """Also fails on `main`: appending a real entry does not help while the
        caller's own entries are still part of the key."""
        with self._limited(), override_settings(TRUSTED_PROXY_HOPS=1):
            statuses = [self._login(xff=f"203.0.113.{n}, {REAL}") for n in range(12)]

        assert statuses[:10] == [401] * 10
        assert statuses[10:] == [429, 429]

    def test_two_real_callers_are_limited_separately(self) -> None:
        """A control: the fix must not collapse everyone into one bucket."""
        with self._limited(), override_settings(TRUSTED_PROXY_HOPS=1):
            exhausted = [self._login(xff=f"{FORGED}, 198.51.100.1") for _ in range(11)][-1]
            other = self._login(xff=f"{FORGED}, 198.51.100.2")

        assert exhausted == 429
        assert other == 401


class TestAuditTrailIp:
    """`AuditLog.ip_address` is evidence, so it may not be the caller's to write."""

    @override_settings(TRUSTED_PROXY_HOPS=1)
    def test_a_failed_sign_in_records_the_proxys_entry_not_the_callers(self) -> None:
        APIClient().post(
            LOGIN,
            {"email": "nobody@example.test", "password": "wrong"},
            format="json",
            HTTP_X_FORWARDED_FOR=f"{FORGED}, {REAL}",
        )

        row = AuditLog.objects.filter(action=AuditAction.LOGIN_FAILED).latest("created_at")
        assert row.ip_address == REAL

    @override_settings(TRUSTED_PROXY_HOPS=0)
    def test_with_no_trusted_proxy_the_header_cannot_reach_the_trail(self) -> None:
        """Fails on `main`, which recorded FORGED.

        `testserver` is the socket address the test client presents.
        """
        APIClient().post(
            LOGIN,
            {"email": "nobody@example.test", "password": "wrong"},
            format="json",
            HTTP_X_FORWARDED_FOR=FORGED,
        )

        row = AuditLog.objects.filter(action=AuditAction.LOGIN_FAILED).latest("created_at")
        assert row.ip_address != FORGED
