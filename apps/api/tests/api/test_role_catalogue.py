"""What the role matrix on /admin/staff reads, and what it may rely on.

The screen compares every staff role against every permission by name. It
reads two endpoints -- `roles/` for who holds what, `permissions/` for what
each code means -- and both have to agree with `accounts.permissions`, which
is what `RolePermission` actually enforces.
"""

from __future__ import annotations

from typing import Any

import pytest

from accounts.models import Role, RoleCode
from accounts.permissions import PERMISSIONS, ROLE_PERMISSIONS

pytestmark = pytest.mark.django_db


def _by_code(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {row["code"]: row for row in rows}


class TestTheCatalogue:
    def test_every_enforced_code_is_listed_with_its_name_and_group(
        self, shop: dict[str, Any], auth_client: Any
    ) -> None:
        response = auth_client(shop["manager"]).get("/api/v1/permissions/")

        assert response.status_code == 200
        listed = _by_code(response.data)
        assert set(listed) == set(PERMISSIONS)
        for code, (group, name) in PERMISSIONS.items():
            assert listed[code]["group"] == group
            assert listed[code]["name"] == name

    def test_every_code_a_role_holds_is_in_the_catalogue(
        self, shop: dict[str, Any], auth_client: Any
    ) -> None:
        """Otherwise the matrix has a row it cannot name."""
        catalogue = {
            row["code"] for row in auth_client(shop["manager"]).get("/api/v1/permissions/").data
        }
        roles = auth_client(shop["manager"]).get("/api/v1/roles/").data

        held = {code for role in roles for code in role["permissions"]}
        assert held <= catalogue

    def test_a_cashier_may_not_read_it(self, shop: dict[str, Any], auth_client: Any) -> None:
        """`users.view`, as for the staff list it sits beside."""
        assert auth_client(shop["cashier"]).get("/api/v1/permissions/").status_code == 403
        assert auth_client(shop["cashier"]).get("/api/v1/roles/").status_code == 403


class TestTheOwner:
    def test_only_the_owner_holds_every_permission(
        self, shop: dict[str, Any], auth_client: Any
    ) -> None:
        roles = _by_code(auth_client(shop["manager"]).get("/api/v1/roles/").data)

        assert roles[RoleCode.OWNER]["holds_every_permission"] is True
        others = {code for code, role in roles.items() if role["holds_every_permission"]}
        assert others == {RoleCode.OWNER}

    def test_it_is_true_even_when_the_owner_row_lists_nothing(
        self, shop: dict[str, Any], auth_client: Any
    ) -> None:
        """The case the flag exists for: rows edited in the Django admin.

        `User.permission_codes` answers `*` for an owner regardless, so the
        screen has to say "everything" whatever the rows say.
        """
        Role.objects.get(code=RoleCode.OWNER).permissions.clear()

        roles = _by_code(auth_client(shop["manager"]).get("/api/v1/roles/").data)

        assert roles[RoleCode.OWNER]["permissions"] == []
        assert roles[RoleCode.OWNER]["holds_every_permission"] is True
        assert shop["owner"].has_perm_code("users.manage")


class TestTheRows:
    @pytest.mark.parametrize(
        "code", [code for code in ROLE_PERMISSIONS if code != RoleCode.CUSTOMER]
    )
    def test_each_staff_role_lists_what_it_is_seeded_with(
        self, shop: dict[str, Any], auth_client: Any, code: str
    ) -> None:
        roles = _by_code(auth_client(shop["manager"]).get("/api/v1/roles/").data)

        assert set(roles[code]["permissions"]) == set(ROLE_PERMISSIONS[code])
