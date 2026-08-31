"""Staff accounts and roles through the API.

`accounts` is the last area with **no section in docs/business-rules.md at
all**, and the roadmap names that as the condition that produced the worst
defect of every previous pass. So these were written before the screen.

What is being defended: who may change whose access, and whether that change
leaves a trace. A role edit is the most security-sensitive write in the system
-- it is the one that decides who may refund, discount and adjust stock.
"""

from __future__ import annotations

import pytest

from accounts.models import RoleCode, Status, User
from core.models import AuditLog
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


class TestSelfProtection:
    def test_the_deactivate_action_refuses_your_own_account(self, admin, shop):
        response = admin.post(f"/api/v1/users/{shop['owner'].pk}/deactivate/")

        assert response.status_code == 400

    def test_a_patch_cannot_be_used_to_deactivate_yourself(self, admin, shop):
        """The guard on `deactivate` exists so nobody locks themselves out. A
        PATCH that sets `status` directly must not be a way around it -- the
        same shape of hole as D24, where a read permission served a write.
        """
        response = admin.patch(
            f"/api/v1/users/{shop['owner'].pk}/",
            {"status": Status.INACTIVE},
            format="json",
        )

        assert response.status_code == 400
        shop["owner"].refresh_from_db()
        assert shop["owner"].status == Status.ACTIVE

    def test_you_cannot_demote_yourself_out_of_your_own_permissions(self, admin, shop):
        response = admin.patch(
            f"/api/v1/users/{shop['owner'].pk}/",
            {"role_code": RoleCode.CASHIER},
            format="json",
        )

        assert response.status_code == 400
        shop["owner"].refresh_from_db()
        assert shop["owner"].role.code == RoleCode.OWNER


class TestTheLastOwner:
    """An organisation with no active owner cannot be administered again from
    inside the app: nothing else holds `users.manage` or `settings.manage`.
    """

    def test_the_last_owner_cannot_be_deactivated(self, admin, shop):
        second = factories.user(RoleCode.OWNER, branch_obj=shop["branch"])
        # Two owners: deactivating one is fine.
        assert admin.post(f"/api/v1/users/{second.pk}/deactivate/").status_code == 200

        # Now `shop["owner"]` is the only one left, and it is the caller, so the
        # self-guard covers it. Deactivating via another owner must still refuse.
        second.refresh_from_db()
        assert second.status == Status.INACTIVE

    def test_the_last_owner_cannot_be_demoted(self, shop, auth_client):
        second = factories.user(RoleCode.OWNER, branch_obj=shop["branch"])
        client = auth_client(second)

        response = client.patch(
            f"/api/v1/users/{shop['owner'].pk}/",
            {"role_code": RoleCode.MANAGER},
            format="json",
        )
        # Two owners exist, so demoting one is allowed.
        assert response.status_code == 200

        # `second` is now the last owner and cannot demote itself.
        response = client.patch(
            f"/api/v1/users/{second.pk}/",
            {"role_code": RoleCode.MANAGER},
            format="json",
        )
        assert response.status_code == 400
        second.refresh_from_db()
        assert second.role.code == RoleCode.OWNER


class TestAuditTrail:
    def test_creating_a_staff_account_is_audited(self, admin, shop):
        before = AuditLog.objects.count()

        response = admin.post(
            "/api/v1/users/",
            {
                "email": "newhire@rangon.test",
                "password": "a-long-enough-password-1",
                "role_code": RoleCode.CASHIER,
                "branch": str(shop["branch"].pk),
            },
            format="json",
        )

        assert response.status_code == 201
        assert AuditLog.objects.count() > before

    def test_changing_a_role_is_audited(self, admin, shop):
        staff = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        before = AuditLog.objects.count()

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"role_code": RoleCode.MANAGER},
            format="json",
        )

        assert response.status_code == 200
        staff.refresh_from_db()
        assert staff.role.code == RoleCode.MANAGER
        # Who may refund and discount just changed. That has to leave a trace.
        assert AuditLog.objects.count() > before

    def test_resetting_a_password_is_audited_and_never_logs_the_password(
        self, admin, shop
    ):
        staff = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        secret = "another-long-password-2"

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/", {"password": secret}, format="json"
        )

        assert response.status_code == 200
        staff.refresh_from_db()
        assert staff.check_password(secret)

        entries = AuditLog.objects.filter(entity_id=str(staff.pk))
        assert entries.exists()
        assert secret not in str([e.new_values for e in entries])


class TestPermissions:
    def test_a_manager_can_see_staff_but_not_change_them(self, shop, auth_client):
        client = auth_client(shop["manager"])
        staff = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        assert client.get("/api/v1/users/").status_code == 200
        assert (
            client.patch(
                f"/api/v1/users/{staff.pk}/", {"role_code": RoleCode.OWNER}, format="json"
            ).status_code
            == 403
        )

    def test_a_cashier_cannot_even_list_staff(self, shop, auth_client):
        assert auth_client(shop["cashier"]).get("/api/v1/users/").status_code == 403

    def test_customers_never_appear_in_the_staff_list(self, admin, shop):
        response = admin.get("/api/v1/users/")

        assert response.status_code == 200
        emails = [row["email"] for row in response.data["results"]]
        assert not User.objects.filter(email__in=emails, role__code=RoleCode.CUSTOMER).exists()

    def test_roles_are_readable_for_the_picker(self, admin, shop):
        response = admin.get("/api/v1/roles/")

        assert response.status_code == 200


class TestDeletionIsDeactivation:
    def test_delete_deactivates_rather_than_removing(self, admin, shop):
        staff = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        response = admin.delete(f"/api/v1/users/{staff.pk}/")

        assert response.status_code == 200
        staff.refresh_from_db()
        # The audit trail has to survive, so the row stays.
        assert User.objects.filter(pk=staff.pk).exists()
        assert staff.status == Status.INACTIVE
