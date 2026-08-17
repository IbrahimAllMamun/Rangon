"""Base models shared by every app.

Rules encoded here (CLAUDE.md §6):
  * UUID primary keys everywhere
  * created_at / updated_at everywhere
  * money is Decimal(14, 2) — never float
  * financial history is append-only at the ORM level, not just by convention
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from django.db import models

ZERO = Decimal("0.00")


def money_field(**kwargs: Any) -> models.DecimalField:
    """A monetary column.  14 digits is ~999 billion — ample for BDT."""
    kwargs.setdefault("max_digits", 14)
    kwargs.setdefault("decimal_places", 2)
    kwargs.setdefault("default", ZERO)
    return models.DecimalField(**kwargs)


def rate_field(**kwargs: Any) -> models.DecimalField:
    """A rate/percentage column (e.g. 0.1500 for 15%)."""
    kwargs.setdefault("max_digits", 6)
    kwargs.setdefault("decimal_places", 4)
    kwargs.setdefault("default", Decimal("0.0000"))
    return models.DecimalField(**kwargs)


class UUIDModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class BaseModel(UUIDModel, TimeStampedModel):
    """What every domain table inherits."""

    class Meta:
        abstract = True


class AppendOnlyError(RuntimeError):
    """Raised when code tries to rewrite history."""


class AppendOnlyModel(BaseModel):
    """A row that may be created and then never changed or deleted.

    Used by the inventory ledger, order timeline, payment events and audit log.
    This is enforced here rather than only in review, because a single
    ``.save()`` on a ledger row silently destroys the audit trail.
    """

    class Meta:
        abstract = True

    def save(self, *args: Any, **kwargs: Any) -> None:
        if self._state.adding is False:
            raise AppendOnlyError(
                f"{type(self).__name__} is append-only; create a compensating record instead "
                f"of modifying {self.pk}."
            )
        super().save(*args, **kwargs)

    def delete(self, *args: Any, **kwargs: Any) -> None:
        raise AppendOnlyError(
            f"{type(self).__name__} is append-only and cannot be deleted "
            f"(attempted on {self.pk})."
        )


class NumberSequence(models.Model):
    """Row-locked counter behind human-readable document numbers.

    ``count() + 1`` double-issues under concurrency; this does not.
    See core.services.next_number().
    """

    key = models.CharField(max_length=64, primary_key=True)
    prefix = models.CharField(max_length=16, blank=True)
    last_value = models.BigIntegerField(default=0)
    padding = models.PositiveSmallIntegerField(default=6)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "core_numbersequence"
        verbose_name = "number sequence"

    def __str__(self) -> str:
        return f"{self.key}={self.last_value}"


class AuditAction(models.TextChoices):
    CREATE = "CREATE", "Create"
    UPDATE = "UPDATE", "Update"
    DELETE = "DELETE", "Delete"
    LOGIN = "LOGIN", "Login"
    LOGIN_FAILED = "LOGIN_FAILED", "Login failed"
    LOGOUT = "LOGOUT", "Logout"
    PERMISSION_ELEVATION = "PERMISSION_ELEVATION", "Permission elevation"
    STOCK_ADJUSTMENT = "STOCK_ADJUSTMENT", "Stock adjustment"
    STOCK_TRANSFER = "STOCK_TRANSFER", "Stock transfer"
    PURCHASE_RECEIVED = "PURCHASE_RECEIVED", "Purchase received"
    SALE_CREATED = "SALE_CREATED", "Sale created"
    ORDER_STATUS_CHANGED = "ORDER_STATUS_CHANGED", "Order status changed"
    ORDER_CANCELLED = "ORDER_CANCELLED", "Order cancelled"
    PAYMENT_RECORDED = "PAYMENT_RECORDED", "Payment recorded"
    REFUND_ISSUED = "REFUND_ISSUED", "Refund issued"
    DISCOUNT_OVERRIDE = "DISCOUNT_OVERRIDE", "Discount override"
    PRICE_OVERRIDE = "PRICE_OVERRIDE", "Price override"
    SETTINGS_CHANGED = "SETTINGS_CHANGED", "Settings changed"
    USER_CHANGED = "USER_CHANGED", "User changed"


class AuditLog(AppendOnlyModel):
    """Who did what, when, to which record, with what before/after values.

    Never contains passwords, tokens or card data (redacted by core.audit).
    """

    actor = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="audit_entries",
    )
    actor_label = models.CharField(max_length=255, blank=True)  # survives user deletion
    action = models.CharField(max_length=32, choices=AuditAction.choices)
    entity_type = models.CharField(max_length=64)
    entity_id = models.CharField(max_length=64, blank=True)
    entity_label = models.CharField(max_length=255, blank=True)
    old_values = models.JSONField(default=dict, blank=True)
    new_values = models.JSONField(default=dict, blank=True)
    reason = models.TextField(blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True)
    request_id = models.CharField(max_length=64, blank=True)
    branch = models.ForeignKey("accounts.Branch", null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        db_table = "core_auditlog"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["entity_type", "entity_id", "-created_at"]),
            models.Index(fields=["actor", "-created_at"]),
            models.Index(fields=["action", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.action} {self.entity_type}:{self.entity_id} by {self.actor_label}"


class Setting(BaseModel):
    """Organisation-level configuration a manager may change without a deploy.

    Business *rules* live in code and docs; this holds values (receipt footer,
    low-stock threshold override, contact details), never behaviour.
    """

    key = models.CharField(max_length=64, unique=True)
    value = models.JSONField(default=dict, blank=True)
    description = models.CharField(max_length=255, blank=True)
    updated_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL
    )

    class Meta:
        db_table = "core_setting"
        ordering = ("key",)

    def __str__(self) -> str:
        return self.key
