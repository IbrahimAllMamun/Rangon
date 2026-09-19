"""Changing a password, and what it does to the sessions already open.

`auth/password/change/` existed with no screen and not one test. Audited
before the screen was built over it, as this project keeps recommending:

* A password change ended no session (D86). Every refresh token already
  issued kept working for up to fourteen days, so the one thing a person does
  when they suspect their account is in someone else's hands left that
  someone signed in. An owner's reset from /admin/staff did the same.
* The current-password check ran at the general 600-a-minute rate, and a
  wrong guess left no trace, while a wrong guess at the sign-in form is
  limited to ten a minute and recorded (D87).

Every test here was run against `main` first. The controls are marked.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import RoleCode
from core.models import AuditAction, AuditLog
from tests import factories

pytestmark = pytest.mark.django_db

LOGIN = "/api/v1/auth/login/"
REFRESH = "/api/v1/auth/refresh/"
CHANGE = "/api/v1/auth/password/change/"
ME = "/api/v1/auth/me/"
PASSWORD = "test-password-123"  # what tests.factories.user() sets
NEW = "a-fresh-long-password-7"


@pytest.fixture(autouse=True)
def _fresh_throttle_counts() -> None:
    # Throttle history lives in the cache, which outlives a test.
    cache.clear()


def _session(user: Any) -> dict[str, str]:
    """Sign in through the API, as a browser would: one session, two tokens."""
    response = APIClient().post(LOGIN, {"email": user.email, "password": PASSWORD}, format="json")
    assert response.status_code == 200, response.data
    return {"access": response.data["access"], "refresh": response.data["refresh"]}


def _bearer(access: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    return client


def _refresh(refresh: str) -> Any:
    return APIClient().post(REFRESH, {"refresh": refresh}, format="json")


def _change(access: str, current: str = PASSWORD, new: str = NEW) -> Any:
    return _bearer(access).post(
        CHANGE, {"current_password": current, "new_password": new}, format="json"
    )


class TestChangingYourOwnPassword:
    def test_it_changes_the_password(self, shop: Any) -> None:
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        response = _change(_session(user)["access"])

        assert response.status_code == 200, response.data
        user.refresh_from_db()
        assert user.check_password(NEW)

    def test_every_other_session_is_signed_out_at_once(self, shop: Any) -> None:
        """The defect (D86): a stolen session outlived the password it was stolen with."""
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        mine, theirs = _session(user), _session(user)

        # Any success will do here: `main` answered 204, and this test is about
        # the other session, not about what the change returns.
        assert _change(mine["access"]).status_code in (200, 204)

        # Not "within half an hour, when the access token expires": now.
        assert _bearer(theirs["access"]).get(ME).status_code == 401
        assert _refresh(theirs["refresh"]).status_code == 401

    def test_the_session_that_changed_it_carries_on(self, shop: Any) -> None:
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        mine = _session(user)

        response = _change(mine["access"])

        # Its own old tokens died with the rest; it is handed new ones.
        assert _bearer(mine["access"]).get(ME).status_code == 401
        assert _bearer(response.data["access"]).get(ME).status_code == 200
        assert _refresh(response.data["refresh"]).status_code == 200

    def test_a_wrong_current_password_is_refused_and_recorded(self, shop: Any) -> None:
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        response = _change(_session(user)["access"], current="not-my-password")

        assert response.status_code == 400
        assert "current_password" in response.data["error"]["details"]
        user.refresh_from_db()
        assert user.check_password(PASSWORD)
        # A wrong guess at the sign-in form is recorded; so is one here (D87).
        assert AuditLog.objects.filter(
            action=AuditAction.LOGIN_FAILED, entity_id=str(user.pk)
        ).exists()

    def test_a_blank_current_password_is_not_recorded_as_a_guess(self, shop: Any) -> None:
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        response = _change(_session(user)["access"], current="")

        assert response.status_code == 400
        assert not AuditLog.objects.filter(
            action=AuditAction.LOGIN_FAILED, entity_id=str(user.pk)
        ).exists()

    def test_guessing_the_current_password_is_rate_limited(self, shop: Any) -> None:
        """At the sign-in form's rate, ten a minute -- not the general 600 (D87)."""
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        access = _session(user)["access"]

        statuses = [_change(access, current=f"guess-{n}").status_code for n in range(11)]

        assert statuses[:10] == [400] * 10
        assert statuses[10] == 429

    def test_the_new_password_must_be_new(self, shop: Any) -> None:
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        response = _change(_session(user)["access"], new=PASSWORD)

        assert response.status_code == 400
        assert "new_password" in response.data["error"]["details"]

    def test_the_password_rules_apply(self, shop: Any) -> None:
        """A control: `validate_password` already ran on `main`."""
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        response = _change(_session(user)["access"], new="1234567890")

        assert response.status_code == 400
        assert "new_password" in response.data["error"]["details"]

    def test_the_password_never_reaches_the_log(self, shop: Any) -> None:
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        _change(_session(user)["access"])

        logged = str(list(AuditLog.objects.values_list("old_values", "new_values", "reason")))
        assert NEW not in logged
        assert PASSWORD not in logged


class TestAnOwnersReset:
    def test_a_reset_signs_the_account_out_everywhere(self, shop: Any, auth_client: Any) -> None:
        """The owner resets a cashier's password because it leaked. That has to end it (D86)."""
        staff = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        theirs = _session(staff)

        response = auth_client(shop["owner"]).patch(
            f"/api/v1/users/{staff.pk}/", {"password": NEW}, format="json"
        )

        assert response.status_code == 200
        assert _bearer(theirs["access"]).get(ME).status_code == 401
        assert _refresh(theirs["refresh"]).status_code == 401
        # And the new password works.
        fresh = APIClient().post(LOGIN, {"email": staff.email, "password": NEW}, format="json")
        assert fresh.status_code == 200

    def test_editing_anything_else_leaves_the_sessions_alone(
        self, shop: Any, auth_client: Any
    ) -> None:
        staff = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        theirs = _session(staff)

        auth_client(shop["owner"]).patch(
            f"/api/v1/users/{staff.pk}/", {"first_name": "Renamed"}, format="json"
        )

        assert _bearer(theirs["access"]).get(ME).status_code == 200
        assert _refresh(theirs["refresh"]).status_code == 200


class TestRefresh:
    def test_a_deactivated_account_cannot_refresh(self, shop: Any) -> None:
        """`main` minted fresh tokens for it -- dead while it stayed deactivated,
        and live again the moment it was reactivated."""
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        session = _session(user)
        user.status = "INACTIVE"
        user.save()

        assert _refresh(session["refresh"]).status_code == 401

    def test_a_token_from_before_the_change_still_refreshes(self, shop: Any) -> None:
        """A control, and the reason the rollout signs nobody out.

        Tokens issued before 2026-09-19 carry no password claim. A refresh
        token like that is still honoured -- a password change blacklists it
        like any other -- and what it is exchanged for carries the claim.
        """
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        legacy = RefreshToken.for_user(user)
        legacy.payload.pop(api_settings.REVOKE_TOKEN_CLAIM, None)

        response = _refresh(str(legacy))

        assert response.status_code == 200
        assert _bearer(response.data["access"]).get(ME).status_code == 200

    def test_a_refresh_token_is_spent_when_used(self, shop: Any) -> None:
        """A control: rotation already blacklisted the token it was given."""
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        session = _session(user)

        assert _refresh(session["refresh"]).status_code == 200
        assert _refresh(session["refresh"]).status_code == 401
