"""Organisation, branch, role, permission and user.

Multi-branch from day one (CLAUDE.md §3.6): Organization -> Branch -> everything
operational.  V1 runs a single branch but nothing here assumes it.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone

from core.models import BaseModel


class Status(models.TextChoices):
    ACTIVE = "ACTIVE", "Active"
    INACTIVE = "INACTIVE", "Inactive"
    SUSPENDED = "SUSPENDED", "Suspended"


class Organization(BaseModel):
    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=200, unique=True)
    legal_name = models.CharField(max_length=200, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=32, blank=True)
    address = models.TextField(blank=True)
    vat_registration = models.CharField(max_length=64, blank=True)
    currency = models.CharField(max_length=8, default="BDT")
    logo = models.ImageField(upload_to="organization/", blank=True, null=True)
    receipt_footer = models.TextField(blank=True)

    class Meta:
        db_table = "accounts_organization"
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name


class Branch(BaseModel):
    organization = models.ForeignKey(
        Organization, on_delete=models.PROTECT, related_name="branches"
    )
    name = models.CharField(max_length=120)
    code = models.CharField(max_length=16, help_text="Short code printed on receipts, e.g. DHK1")
    address = models.TextField(blank=True)
    phone = models.CharField(max_length=32, blank=True)
    email = models.EmailField(blank=True)
    is_default = models.BooleanField(default=False)
    fulfils_online_orders = models.BooleanField(
        default=True, help_text="Online orders are reserved and shipped from this branch."
    )
    register_count = models.PositiveSmallIntegerField(default=1)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)

    class Meta:
        db_table = "accounts_branch"
        ordering = ("name",)
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "code"], name="accounts_branch_org_code_uniq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.code})"


class Permission(BaseModel):
    """A permission code such as ``sales.refund``.

    Rangon's own permission table, separate from django.contrib.auth's, because
    these codes are business capabilities rather than per-model CRUD flags.
    Synced from accounts.permissions.PERMISSIONS.
    """

    code = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=120)
    group = models.CharField(max_length=32, db_index=True)
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "accounts_permission"
        ordering = ("group", "code")

    def __str__(self) -> str:
        return self.code


class RoleCode(models.TextChoices):
    OWNER = "OWNER", "Owner"
    ADMIN = "ADMIN", "Administrator"
    MANAGER = "MANAGER", "Manager"
    CASHIER = "CASHIER", "Cashier"
    INVENTORY_MANAGER = "INVENTORY_MANAGER", "Inventory manager"
    ACCOUNTANT = "ACCOUNTANT", "Accountant"
    CUSTOMER = "CUSTOMER", "Customer"


class Role(BaseModel):
    code = models.CharField(max_length=32, unique=True, choices=RoleCode.choices)
    name = models.CharField(max_length=64)
    description = models.CharField(max_length=255, blank=True)
    permissions = models.ManyToManyField(Permission, related_name="roles", blank=True)
    is_staff_role = models.BooleanField(default=True)
    is_system = models.BooleanField(
        default=True, help_text="System roles cannot be deleted, only edited."
    )

    class Meta:
        db_table = "accounts_role"
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name

    @property
    def is_owner(self) -> bool:
        return self.code == RoleCode.OWNER


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def _create_user(self, email: str, password: str | None, **extra: Any) -> User:
        if not email:
            raise ValueError("An email address is required.")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra: Any) -> User:
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email: str, password: str | None = None, **extra: Any) -> User:
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("status", Status.ACTIVE)
        if extra.get("is_staff") is not True or extra.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_staff=True and is_superuser=True.")
        user = self._create_user(email, password, **extra)
        owner = Role.objects.filter(code=RoleCode.OWNER).first()
        if owner and user.role_id is None:
            user.role = owner
            user.save(update_fields=["role"])
        return user


class User(AbstractBaseUser, PermissionsMixin, BaseModel):
    """Staff and customers share one user table; `role` separates them."""

    email = models.EmailField(unique=True)
    first_name = models.CharField(max_length=80, blank=True)
    last_name = models.CharField(max_length=80, blank=True)
    phone = models.CharField(max_length=32, blank=True, db_index=True)

    organization = models.ForeignKey(
        Organization, null=True, blank=True, on_delete=models.PROTECT, related_name="users"
    )
    branch = models.ForeignKey(
        Branch,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="users",
        help_text="Home branch. Staff are scoped to it unless they are OWNER/ADMIN.",
    )
    role = models.ForeignKey(
        Role, null=True, blank=True, on_delete=models.PROTECT, related_name="users"
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)

    # django.contrib.auth expectations
    is_staff = models.BooleanField(default=False, help_text="Access to the Django admin site.")
    is_active = models.BooleanField(default=True)
    date_joined = models.DateTimeField(default=timezone.now)
    last_login_ip = models.GenericIPAddressField(null=True, blank=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        db_table = "accounts_user"
        ordering = ("email",)
        indexes = [models.Index(fields=["role", "status"])]

    def __str__(self) -> str:
        return self.email

    def save(self, *args: Any, **kwargs: Any) -> None:
        self.email = self.email.lower().strip()
        # `is_active` is what Django checks on login; `status` is what staff see.
        self.is_active = self.status == Status.ACTIVE
        super().save(*args, **kwargs)

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip() or self.email

    def get_full_name(self) -> str:
        return self.full_name

    def get_short_name(self) -> str:
        return self.first_name or self.email

    @property
    def is_owner(self) -> bool:
        return bool(self.role and self.role.code == RoleCode.OWNER)

    @property
    def is_customer(self) -> bool:
        return bool(self.role and self.role.code == RoleCode.CUSTOMER)

    @property
    def can_cross_branch(self) -> bool:
        return bool(self.role and self.role.code in {RoleCode.OWNER, RoleCode.ADMIN})

    def permission_codes(self) -> set[str]:
        """Resolved permission codes, cached for the life of the instance."""
        cached = getattr(self, "_permission_codes", None)
        if cached is not None:
            return cached
        if self.is_owner or self.is_superuser:
            codes = {"*"}
        elif self.role_id:
            codes = set(self.role.permissions.values_list("code", flat=True))
        else:
            codes = set()
        self._permission_codes = codes  # type: ignore[attr-defined]
        return codes

    def has_perm_code(self, code: str) -> bool:
        codes = self.permission_codes()
        return "*" in codes or code in codes
