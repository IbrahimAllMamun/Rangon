"""Authorization is enforced by the backend, not by hidden buttons (CLAUDE.md §3.4)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from accounts.models import RoleCode
from accounts.services import branch_queryset, resolve_branch
from core.exceptions import PermissionDenied
from orders.models import PaymentMethod
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from tests import factories

pytestmark = pytest.mark.django_db


def client_for(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


class TestRoleMatrix:
    """Each row: role, endpoint, method, expected status."""

    @pytest.mark.parametrize(
        ("role", "expected"),
        [
            (RoleCode.OWNER, 200),
            (RoleCode.ADMIN, 200),
            (RoleCode.MANAGER, 200),
            (RoleCode.CASHIER, 200),
            (RoleCode.INVENTORY_MANAGER, 200),
            (RoleCode.ACCOUNTANT, 200),
            (RoleCode.CUSTOMER, 403),
        ],
    )
    def test_product_list_visibility(self, shop, role, expected):
        user = factories.user(role, branch_obj=shop["branch"])
        assert client_for(user).get("/api/v1/products/").status_code == expected

    @pytest.mark.parametrize(
        ("role", "expected"),
        [
            (RoleCode.OWNER, 201),
            (RoleCode.MANAGER, 201),
            (RoleCode.CASHIER, 403),
            (RoleCode.ACCOUNTANT, 403),
            (RoleCode.CUSTOMER, 403),
        ],
    )
    def test_only_authorised_roles_can_create_a_product(self, shop, role, expected):
        user = factories.user(role, branch_obj=shop["branch"])
        response = client_for(user).post(
            "/api/v1/products/",
            {
                "name": f"New product {role}",
                "category": str(shop["product"].category_id),
                "status": "ACTIVE",
            },
            format="json",
        )
        assert response.status_code == expected, response.data

    @pytest.mark.parametrize(
        ("role", "expected"),
        [
            (RoleCode.OWNER, 200),
            (RoleCode.MANAGER, 200),
            (RoleCode.INVENTORY_MANAGER, 200),
            (RoleCode.CASHIER, 403),  # cashiers must never adjust stock
            (RoleCode.ACCOUNTANT, 403),
        ],
    )
    def test_stock_adjustment_is_restricted(self, shop, role, expected):
        user = factories.user(role, branch_obj=shop["branch"])
        response = client_for(user).post(
            "/api/v1/inventory/adjust/",
            {
                "variant": str(shop["variants"][0].pk),
                "branch": str(shop["branch"].pk),
                "new_on_hand": 7,
                "reason": "count",
            },
            format="json",
        )
        assert response.status_code in ({200, 201} if expected == 200 else {expected})

    @pytest.mark.parametrize(
        ("role", "allowed"),
        [
            (RoleCode.OWNER, True),
            (RoleCode.MANAGER, True),
            (RoleCode.CASHIER, False),  # refunds need a manager
            (RoleCode.INVENTORY_MANAGER, False),
        ],
    )
    def test_refund_permission(self, shop, role, allowed):
        order = pos.create_pos_sale(
            branch=shop["branch"],
            actor=shop["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=shop["variants"][0].pk, quantity=1)],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
            ),
        )
        user = factories.user(role, branch_obj=shop["branch"])
        response = client_for(user).post(
            f"/api/v1/orders/{order.pk}/refunds/",
            {"amount": "100.00", "reason": "test"},
            format="json",
        )
        assert (response.status_code == 201) is allowed, response.data

    @pytest.mark.parametrize(
        ("role", "expected"),
        [
            (RoleCode.OWNER, 200),
            (RoleCode.ACCOUNTANT, 200),
            (RoleCode.MANAGER, 403),
            (RoleCode.CASHIER, 403),
        ],
    )
    def test_audit_log_is_restricted(self, shop, role, expected):
        user = factories.user(role, branch_obj=shop["branch"])
        assert client_for(user).get("/api/v1/audit-logs/").status_code == expected

    @pytest.mark.parametrize(
        ("role", "expected"),
        [(RoleCode.OWNER, 200), (RoleCode.ADMIN, 200), (RoleCode.MANAGER, 403)],
    )
    def test_user_management_is_restricted(self, shop, role, expected):
        user = factories.user(role, branch_obj=shop["branch"])
        response = client_for(user).post(
            "/api/v1/users/",
            {
                "email": f"new-{role}@rangon.test",
                "password": "a-strong-password-1",
                "role_code": "CASHIER",
            },
            format="json",
        )
        assert (response.status_code == 201) is (expected == 200), response.data


class TestAuthentication:
    def test_anonymous_requests_are_rejected(self, api):
        response = api.get("/api/v1/products/")
        assert response.status_code == 401
        assert response.data["error"]["code"] == "AUTHENTICATION_REQUIRED"

    def test_the_public_shop_api_needs_no_login(self, api):
        assert api.get("/api/v1/shop/products/").status_code == 200

    def test_deactivated_users_cannot_log_in(self, shop, api):
        user = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        user.status = "INACTIVE"
        user.save()

        response = api.post(
            "/api/v1/auth/login/",
            {"email": user.email, "password": "test-password-123"},
            format="json",
        )
        assert response.status_code == 401

    def test_login_returns_the_users_permission_codes(self, shop, api):
        response = api.post(
            "/api/v1/auth/login/",
            {"email": shop["manager"].email, "password": "test-password-123"},
            format="json",
        )
        assert response.status_code == 200
        assert "sales.refund" in response.data["user"]["permissions"]
        assert "access" in response.data

    def test_registration_always_creates_a_customer(self, api):
        response = api.post(
            "/api/v1/auth/register/",
            {
                "email": "shopper@example.test",
                "password": "a-strong-password-1",
                "role_code": "OWNER",  # attacker's attempt to self-promote
            },
            format="json",
        )
        assert response.status_code == 201
        assert response.data["user"]["role"] == RoleCode.CUSTOMER
        assert response.data["user"]["permissions"] == []


class TestBranchScoping:
    def test_staff_only_see_their_own_branch(self, shop):
        other_branch = factories.branch(shop["organization"])
        from inventory.models import Inventory

        cashier = shop["cashier"]
        visible = branch_queryset(cashier, Inventory.objects.all())

        assert visible.filter(branch=other_branch).count() == 0
        assert visible.filter(branch=shop["branch"]).exists()

    def test_owner_sees_every_branch(self, shop):
        factories.branch(shop["organization"])
        from inventory.models import Inventory

        assert branch_queryset(shop["owner"], Inventory.objects.all()).count() == (
            Inventory.objects.count()
        )

    def test_staff_cannot_act_on_another_branch(self, shop):
        other_branch = factories.branch(shop["organization"])

        with pytest.raises(PermissionDenied):
            resolve_branch(shop["cashier"], other_branch.pk)


class TestElevation:
    def test_manager_override_requires_real_credentials(self, shop):
        with pytest.raises(PermissionDenied):
            pos.elevate(
                email=shop["manager"].email,
                password="wrong-password",
                permission="sales.refund",
                requested_by=shop["cashier"],
            )

    def test_manager_override_is_audit_logged_with_both_identities(self, shop):
        from core.models import AuditLog

        pos.elevate(
            email=shop["manager"].email,
            password="test-password-123",
            permission="sales.refund",
            requested_by=shop["cashier"],
        )

        entry = AuditLog.objects.filter(action="PERMISSION_ELEVATION").first()
        assert entry is not None
        assert entry.actor == shop["cashier"]
        assert entry.new_values["approved_by"] == shop["manager"].email

    def test_a_user_without_the_permission_cannot_approve(self, shop):
        other_cashier = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])

        with pytest.raises(PermissionDenied):
            pos.elevate(
                email=other_cashier.email,
                password="test-password-123",
                permission="sales.refund",
                requested_by=shop["cashier"],
            )
