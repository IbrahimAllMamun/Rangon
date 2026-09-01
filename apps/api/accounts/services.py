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


def _active_owner_count(exclude: User | None = None) -> int:
    queryset = User.objects.filter(role__code=RoleCode.OWNER, status=Status.ACTIVE)
    if exclude is not None:
        queryset = queryset.exclude(pk=exclude.pk)
    return queryset.count()


def check_can_lose_access(*, user: User, actor: User | None, what: str) -> None:
    """Refuse a change that would lock somebody -- or everybody -- out.

    Two separate hazards, both of which leave the shop unable to administer
    itself from inside the app:

    * **Yourself.** The `deactivate` action already refuses your own account.
      A PATCH setting `status` or `role_code` has to refuse it too, or the
      guard is one request away from being bypassed.
    * **The last owner.** Nothing but OWNER holds `users.manage` or
      `settings.manage`, so an organisation with no active owner cannot grant
      anybody those again. There is no recovery path short of the shell.
    """
    if actor is not None and getattr(actor, "pk", None) == user.pk:
        raise ValidationError(
            f"You cannot {what} your own account.",
            details={"user": f"Ask another owner to {what} it."},
        )
    if user.role_id and user.role.code == RoleCode.OWNER and _active_owner_count(exclude=user) == 0:
        raise ValidationError(
            f"You cannot {what} the last owner.",
            details={"user": "Give another account the owner role first."},
        )


@transaction.atomic
def update_staff_user(
    *,
    user: User,
    actor: User | None = None,
    role_code: str | None = None,
    password: str | None = None,
    fields: dict[str, Any] | None = None,
) -> User:
    """Edit a staff account, with the two guards and the audit entry.

    A role change decides who may refund, discount and adjust stock, and a
    password reset hands somebody an account.  Both were previously written
    straight onto the model from the serializer, which left no `AuditLog` row
    at all -- the most security-sensitive writes in the system were the only
    ones with no trace (CLAUDE.md §5).
    """
    fields = dict(fields or {})
    before = {
        "role": user.role.code if user.role_id else None,
        "status": user.status,
        "email": user.email,
        "branch": str(user.branch) if user.branch_id else None,
    }

    new_status = fields.get("status")
    if new_status is not None and new_status != user.status and new_status != Status.ACTIVE:
        check_can_lose_access(user=user, actor=actor, what="deactivate")

    if role_code and (not user.role_id or role_code != user.role.code):
        if user.role_id and user.role.code == RoleCode.OWNER:
            check_can_lose_access(user=user, actor=actor, what="demote")
        user.role = Role.objects.get(code=role_code)

    for field, value in fields.items():
        setattr(user, field, value)
    if password:
        user.set_password(password)
    user.save()

    after = {
        "role": user.role.code if user.role_id else None,
        "status": user.status,
        "email": user.email,
        "branch": str(user.branch) if user.branch_id else None,
    }
    changed_before, changed_after = audit.diff(before, after)
    if password:
        # The value never goes near the log -- only the fact of the reset.
        changed_after["password_reset"] = True
    if changed_before or changed_after:
        audit.record(
            action=audit.AuditAction.USER_CHANGED,
            entity=user,
            actor=actor,
            old_values=changed_before,
            new_values=changed_after,
            reason="Staff account updated",
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
