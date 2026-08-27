"""Permission catalogue, role matrix and DRF enforcement.

Single source of truth for docs/architecture/permissions.md.  Changing a code
here changes the seeded database via accounts.services.sync_permissions().
"""

from __future__ import annotations

from typing import Any

from rest_framework.permissions import SAFE_METHODS, BasePermission

from accounts.models import RoleCode

# code -> (group, human name)
PERMISSIONS: dict[str, tuple[str, str]] = {
    "products.view": ("products", "View products"),
    "products.create": ("products", "Create products"),
    "products.update": ("products", "Update products"),
    "products.delete": ("products", "Delete products"),
    "inventory.view": ("inventory", "View inventory"),
    "inventory.adjust": ("inventory", "Adjust stock"),
    "inventory.transfer": ("inventory", "Transfer stock between branches"),
    "inventory.count": ("inventory", "Perform stock counts"),
    "sales.view": ("sales", "View sales"),
    "sales.create": ("sales", "Create sales"),
    "sales.discount": ("sales", "Apply discounts"),
    "sales.discount_override": ("sales", "Approve large discounts"),
    "sales.cancel": ("sales", "Cancel or void a sale"),
    "sales.refund": ("sales", "Refund a sale"),
    "sales.refund_override": ("sales", "Refund outside the return window"),
    "sales.payment_record": ("sales", "Record a payment"),
    "orders.view": ("orders", "View orders"),
    "orders.update_status": ("orders", "Change order status"),
    "orders.fulfil": ("orders", "Pack and ship orders"),
    "purchases.view": ("purchases", "View purchases"),
    "purchases.create": ("purchases", "Create purchase orders"),
    "purchases.receive": ("purchases", "Receive stock"),
    "purchases.pay": ("purchases", "Pay suppliers"),
    "finance.view": ("finance", "View accounts and the cash book"),
    "finance.manage": ("finance", "Open and edit accounts"),
    "finance.transfer": ("finance", "Move money between accounts"),
    "finance.adjust": ("finance", "Record a manual cash-book entry"),
    "finance.expense": ("finance", "Record and void expenses"),
    "customers.view": ("customers", "View customers"),
    "customers.create": ("customers", "Create customers"),
    "customers.update": ("customers", "Update customers"),
    "reports.view": ("reports", "View reports"),
    "reports.financial": ("reports", "View financial reports"),
    "reports.export": ("reports", "Export reports"),
    "users.view": ("users", "View users"),
    "users.manage": ("users", "Create and edit users"),
    "settings.view": ("settings", "View settings"),
    "settings.manage": ("settings", "Change settings"),
    "content.review_moderate": ("content", "Moderate reviews"),
    "content.coupons_manage": ("content", "Manage coupons"),
    "content.navigation_manage": ("content", "Manage navigation and banners"),
    "audit.view": ("audit", "View the audit log"),
}

# OWNER is omitted deliberately: it holds every permission implicitly.
ROLE_PERMISSIONS: dict[str, list[str]] = {
    RoleCode.ADMIN: list(PERMISSIONS),
    RoleCode.MANAGER: [
        "products.view",
        "products.create",
        "products.update",
        "inventory.view",
        "inventory.adjust",
        "inventory.transfer",
        "inventory.count",
        "sales.view",
        "sales.create",
        "sales.discount",
        "sales.discount_override",
        "sales.cancel",
        "sales.refund",
        "sales.payment_record",
        "orders.view",
        "orders.update_status",
        "orders.fulfil",
        "purchases.view",
        "purchases.create",
        "purchases.receive",
        # A manager runs the shop's money day to day: banks the takings and
        # corrects the drawer. Opening a new account is an owner/accountant
        # decision, so `finance.manage` is deliberately withheld.
        "finance.view",
        "finance.transfer",
        "finance.adjust",
        "finance.expense",
        "customers.view",
        "customers.create",
        "customers.update",
        "reports.view",
        "reports.financial",
        "reports.export",
        "users.view",
        "settings.view",
        "content.review_moderate",
        "content.coupons_manage",
        "content.navigation_manage",
    ],
    RoleCode.CASHIER: [
        "products.view",
        "inventory.view",
        "sales.view",
        "sales.create",
        "sales.discount",
        "sales.payment_record",
        # A cashier needs to see which account a sale's money is going into,
        # but may not move money between accounts or correct a balance.
        "finance.view",
        "orders.view",
        "customers.view",
        "customers.create",
        "customers.update",
    ],
    RoleCode.INVENTORY_MANAGER: [
        "products.view",
        "products.create",
        "products.update",
        "inventory.view",
        "inventory.adjust",
        "inventory.transfer",
        "inventory.count",
        "orders.view",
        "orders.update_status",
        "orders.fulfil",
        "purchases.view",
        "purchases.create",
        "purchases.receive",
        "reports.view",
        "reports.export",
    ],
    RoleCode.ACCOUNTANT: [
        "products.view",
        "inventory.view",
        "sales.view",
        "sales.payment_record",
        "orders.view",
        "purchases.view",
        "purchases.pay",
        # The cash book is the accountant's own instrument.
        "finance.view",
        "finance.manage",
        "finance.transfer",
        "finance.adjust",
        "finance.expense",
        "customers.view",
        "reports.view",
        "reports.financial",
        "reports.export",
        "settings.view",
        "audit.view",
    ],
    RoleCode.CUSTOMER: [],
}


class RolePermission(BasePermission):
    """Check the action's required permission codes against the user's role.

    Declare on the viewset::

        required_permissions = {"list": ["products.view"], "create": ["products.create"]}

    or a flat list applied to every action::

        required_permissions = ["inventory.view"]

    An action with no declared requirement is denied for staff endpoints — a
    missing entry must fail closed, not open.
    """

    message = "You do not have permission to perform this action."

    def has_permission(self, request: Any, view: Any) -> bool:
        user = request.user
        if not (user and user.is_authenticated):
            return False
        if user.is_owner or user.is_superuser:
            return True

        required = getattr(view, "required_permissions", None)
        if required is None:
            return False

        if isinstance(required, dict):
            action = getattr(view, "action", None) or request.method.lower()
            codes = required.get(action)
            if codes is None and request.method in SAFE_METHODS:
                codes = required.get("list") or required.get("retrieve")
            if codes is None:
                return False
        else:
            codes = list(required)

        return all(user.has_perm_code(code) for code in codes)


class IsCustomer(BasePermission):
    """Storefront account endpoints: the caller must be a customer account."""

    def has_permission(self, request: Any, view: Any) -> bool:
        user = request.user
        return bool(user and user.is_authenticated and user.is_customer)


class ReadOnly(BasePermission):
    def has_permission(self, request: Any, view: Any) -> bool:
        return request.method in SAFE_METHODS
