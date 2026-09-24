"""Signing out ends the session, whenever it happens (D92).

Nothing tested `auth/logout/` before this file. Measured against `main`:

    logout with a live access token ......... 204, refresh then refused  (works)
    logout with an expired access token ..... 401
    logout with no access token ............. 401
    refresh after either of those ........... 200, a fresh pair issued

The access token and the cookie carrying it both live thirty minutes, so
anybody signing out after half an hour away from the counter hit the second or
third row. The web route cleared the cookies either way and ignored the 401 --
so the screen said "signed out" while the refresh token stayed good for the
rest of its fourteen days. Which is the one case server-side revocation exists
for: a token copied off that machine.

Run against `main`, the two revocation tests fail on the 401 and the audit
test finds no LOGOUT row; the control passes there too.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.api.views import LogoutView
from accounts.models import RoleCode
from core.models import AuditAction, AuditLog
from tests import factories

pytestmark = pytest.mark.django_db

LOGIN = "/api/v1/auth/login/"
LOGOUT = "/api/v1/auth/logout/"
REFRESH = "/api/v1/auth/refresh/"


@pytest.fixture
def session() -> dict[str, Any]:
    user = factories.user(RoleCode.MANAGER, branch_obj=factories.branch())
    response = APIClient().post(
        LOGIN, {"email": user.email, "password": "test-password-123"}, format="json"
    )
    assert response.status_code == 200, response.data
    return {**response.data, "account": user}


def _expired_access(refresh: str) -> str:
    access = RefreshToken(refresh).access_token
    access.set_exp(lifetime=-timedelta(minutes=1))
    return str(access)


def _still_alive(refresh: str) -> bool:
    return APIClient().post(REFRESH, {"refresh": refresh}, format="json").status_code == 200


class TestLogout:
    def test_after_the_access_token_expired_it_still_ends_the_session(
        self, session: dict[str, Any]
    ) -> None:
        """Fails on `main`: 401, and the refresh token mints a new pair."""
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {_expired_access(session['refresh'])}")

        response = client.post(LOGOUT, {"refresh": session["refresh"]}, format="json")

        assert response.status_code == 204
        assert not _still_alive(session["refresh"])

    def test_with_no_access_token_at_all_it_still_ends_the_session(
        self, session: dict[str, Any]
    ) -> None:
        """The web route's actual case: the access cookie expired with its token."""
        response = APIClient().post(LOGOUT, {"refresh": session["refresh"]}, format="json")

        assert response.status_code == 204
        assert not _still_alive(session["refresh"])

    def test_with_a_live_access_token_it_ends_the_session(self, session: dict[str, Any]) -> None:
        """The control. This always worked; it must keep working."""
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {session['access']}")

        response = client.post(LOGOUT, {"refresh": session["refresh"]}, format="json")

        assert response.status_code == 204
        assert not _still_alive(session["refresh"])

    def test_the_sign_out_is_audited_against_the_tokens_owner(
        self, session: dict[str, Any]
    ) -> None:
        APIClient().post(LOGOUT, {"refresh": session["refresh"]}, format="json")

        row = AuditLog.objects.filter(action=AuditAction.LOGOUT).latest("created_at")
        assert row.actor_id == session["account"].pk

    @pytest.mark.parametrize("token", ["", "not-a-token", "eyJhbGciOiJIUzI1NiJ9.e30.x"])
    def test_a_token_that_is_not_live_is_still_a_204_and_audits_nothing(self, token: str) -> None:
        """Signing out of a session that is already over is not an error, and
        the answer must not reveal whether a token was live."""
        response = APIClient().post(LOGOUT, {"refresh": token}, format="json")

        assert response.status_code == 204
        assert not AuditLog.objects.filter(action=AuditAction.LOGOUT).exists()

    def test_signing_out_twice_is_harmless(self, session: dict[str, Any]) -> None:
        for _ in range(2):
            response = APIClient().post(LOGOUT, {"refresh": session["refresh"]}, format="json")
            assert response.status_code == 204

        assert AuditLog.objects.filter(action=AuditAction.LOGOUT).count() == 1

    def test_it_is_never_throttled(self) -> None:
        """A 429 here would leave the token alive -- D92 by another road.

        The test settings empty `DEFAULT_THROTTLE_CLASSES`, so a view that
        merely inherited the default would look unthrottled here and be
        throttled in production. The first draft of this test asked the view
        which throttles it resolves, and passed against `main` for exactly that
        reason. What makes it true in production is the view declaring its own
        list, empty -- so that is what is asserted.
        """
        assert "throttle_classes" in vars(LogoutView)
        assert not LogoutView.throttle_classes
