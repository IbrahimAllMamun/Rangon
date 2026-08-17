"""Account services: permission sync, role seeding, branch scoping helpers."""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import QuerySet

from accounts.models import Branch, Organization, Permission, Role, RoleCode, Status, User
from accounts.permissions import PERMISSIONS, ROLE_PERMISSIONS
from core import audit
from core.exceptions import PermissionDenied


@transaction.atomic
def sync_permissions() -> tuple[int, int]:
    """Make the database match accounts.permissions.

    Idempotent: safe to run on every deploy.  Returns (permissions, roles).
    """
    for code, (group, name) in PERMISSIONS.items():
        Permission.objects.update_or_create(code=code, defaults={"group": group, "name": name})
    # Codes that no longer exist in the catalogue are removed so a revoked
    # capability cannot linger on a role.
    Permission.objects.exclude(code__in=PERMISSIONS.keys()).delete()

    permissions_by_code = {p.code: p for p in Permission.objects.all()}

    for role_code, label in RoleCode.choices:
        role, _ = Role.objects.update_or_create(
            code=role_code,
            defaults={
                "name": label,
                "is_staff_role": role_code != RoleCode.CUSTOMER,
                "is_system": True,
            },
        )
        if role_code == RoleCode.OWNER:
            # OWNER bypasses checks; granting every row as well keeps the admin
            # UI honest about what the role can do.
            role.permissions.set(permissions_by_code.values())
            continue
        codes = ROLE_PERMISSIONS.get(role_code, [])
        role.permissions.set([permissions_by_code[c] for c in codes if c in permissions_by_code])

    return len(PERMISSIONS), len(RoleCode.choices)


def get_organization() -> Organization | None:
    """V1 is single-tenant; this is the one seam that would change for SaaS."""
    return Organization.objects.filter(status=Status.ACTIVE).order_by("created_at").first()


def default_branch() -> Branch | None:
    return Branch.objects.filter(status=Status.ACTIVE).order_by("-is_default", "created_at").first()


def resolve_branch(user: User, branch_id: Any = None) -> Branch:
    """Which branch is this request acting on?

    Staff act on their own branch unless they may cross branches and asked for
    another one explicitly.
    """
    if branch_id:
        branch = Branch.objects.filter(pk=branch_id, status=Status.ACTIVE).first()
        if branch is None:
            raise PermissionDenied("That branch is not available.")
        if not user.can_cross_branch and user.branch_id and str(user.branch_id) != str(branch.pk):
            raise PermissionDenied("You may only act on your own branch.")
        return branch

    if user.branch_id:
        return user.branch
    branch = default_branch()
    if branch is None:
        raise PermissionDenied("No active branch is configured.")
    return branch


def branch_queryset(user: User, queryset: QuerySet, field: str = "branch") -> QuerySet:
    """Narrow any branch-bearing queryset to what the user may see."""
    if user.is_superuser or user.can_cross_branch or not user.branch_id:
        return queryset
    return queryset.filter(**{field: user.branch_id})


@transaction.atomic
def create_staff_user(
    *,
    email: str,
    password: str,
    role_code: str,
    branch: Branch | None = None,
    first_name: str = "",
    last_name: str = "",
    phone: str = "",
    actor: User | None = None,
) -> User:
    role = Role.objects.get(code=role_code)
    organization = get_organization()
    user = User.objects.create_user(
        email=email,
        password=password,
        first_name=first_name,
        last_name=last_name,
        phone=phone,
        role=role,
        branch=branch,
        organization=organization,
        status=Status.ACTIVE,
    )
    audit.record(
        action=audit.AuditAction.USER_CHANGED,
        entity=user,
        actor=actor,
        new_values={"email": email, "role": role_code, "branch": str(branch) if branch else None},
        reason="User created",
    )
    return user


@transaction.atomic
def set_user_status(
    *, user: User, status: str, actor: User | None = None, reason: str = ""
) -> User:
    old = user.status
    user.status = status
    user.save(update_fields=["status", "is_active", "updated_at"])
    audit.record(
        action=audit.AuditAction.USER_CHANGED,
        entity=user,
        actor=actor,
        old_values={"status": old},
        new_values={"status": status},
        reason=reason or f"Status changed to {status}",
    )
    return user
