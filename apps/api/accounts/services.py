"""Account services: permission sync, role seeding, branch scoping helpers."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone

from accounts.models import (
    Branch,
    Organization,
    Permission,
    Role,
    RoleCode,
    Status,
    TaxMode,
    User,
)
from accounts.permissions import PERMISSIONS, ROLE_PERMISSIONS
from core import audit
from core.exceptions import Conflict, NotFound, PermissionDenied, ValidationError


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


# --------------------------------------------------------------------------- VAT


def tax_settings() -> tuple[str, Decimal]:
    """The organisation's VAT treatment: (mode, default rate).

    Falls back to the deployment default when no organisation row exists yet,
    so pricing never depends on the seed having run.
    """
    organization = get_organization()
    if organization is None:
        return TaxMode.EXCLUSIVE, Decimal(settings.RANGON["DEFAULT_TAX_RATE"])
    return organization.tax_mode, organization.default_tax_rate


def priced_order_count() -> int:
    """How many orders already carry a total computed under the current rules.

    Changing VAT never rewrites these — every order freezes its own `tax_mode`,
    `tax_rate` and `tax_total` — but it does mean a report spanning the change
    mixes two treatments, which the owner has to be told before they confirm.
    """
    from orders.models import Order

    return Order.objects.count()


@transaction.atomic
def update_tax_settings(
    *,
    tax_mode: str,
    default_tax_rate: Decimal,
    actor: User | None = None,
    confirm_historical: bool = False,
    reason: str = "",
) -> Organization:
    """Settle the VAT decision (docs/business-rules.md §3.4, decision D-C).

    Guarded rather than free-form: once orders exist, an accidental click here
    would silently change what every future total means, so the caller has to
    say it meant it.  The change is always audited with before and after.
    """
    organization = get_organization()
    if organization is None:
        raise NotFound("No organisation is configured.")

    if tax_mode not in TaxMode.values:
        raise ValidationError(
            f"Unknown VAT mode {tax_mode!r}.",
            details={"tax_mode": f"Choose one of {', '.join(TaxMode.values)}."},
        )

    rate = Decimal(default_tax_rate)
    if rate < 0 or rate > 1:
        raise ValidationError(
            "The VAT rate must be between 0 and 1 (0.15 is 15%).",
            details={"default_tax_rate": "Enter a fraction between 0 and 1."},
        )

    changing = tax_mode != organization.tax_mode or rate != organization.default_tax_rate
    if changing and not confirm_historical:
        existing = priced_order_count()
        if existing:
            raise Conflict(
                "Changing VAT after orders exist needs confirmation.",
                code="TAX_CHANGE_NEEDS_CONFIRMATION",
                details={
                    "order_count": existing,
                    "message": (
                        f"{existing} order(s) were priced under the current VAT treatment. "
                        "They keep the totals they were given; reports spanning the change "
                        "will mix both. Re-submit with confirm=true to proceed."
                    ),
                },
            )

    before = {
        "tax_mode": organization.tax_mode,
        "default_tax_rate": str(organization.default_tax_rate),
        "tax_settled_at": organization.tax_settled_at,
    }

    organization.tax_mode = tax_mode
    organization.default_tax_rate = rate
    organization.tax_settled_at = timezone.now()
    organization.tax_settled_by = actor if actor is not None and actor.is_authenticated else None
    organization.save(
        update_fields=[
            "tax_mode",
            "default_tax_rate",
            "tax_settled_at",
            "tax_settled_by",
            "updated_at",
        ]
    )

    audit.record(
        action=audit.AuditAction.SETTINGS_CHANGED,
        entity=organization,
        actor=actor,
        old_values=before,
        new_values={
            "tax_mode": organization.tax_mode,
            "default_tax_rate": str(organization.default_tax_rate),
            "tax_settled_at": organization.tax_settled_at,
        },
        reason=reason or "VAT treatment settled",
    )
    return organization
