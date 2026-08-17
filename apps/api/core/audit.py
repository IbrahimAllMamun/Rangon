"""Audit logging service.

Usage from anywhere in a service:

    audit.record(
        action=AuditAction.STOCK_ADJUSTMENT,
        entity=inventory,
        actor=user,
        old_values={"on_hand": 10},
        new_values={"on_hand": 8},
        reason="Stock count 2026-08-17",
    )

Secrets are stripped before anything is written (docs/business-rules.md §8).
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from django.db import models

from core.middleware import get_audit_context
from core.models import AuditAction, AuditLog

REDACTED = "***"
SENSITIVE_KEYS = {
    "password",
    "password1",
    "password2",
    "new_password",
    "current_password",
    "token",
    "access",
    "refresh",
    "secret",
    "api_key",
    "authorization",
    "card_number",
    "cvv",
    "cvc",
    "pin",
    "signing_key",
}


def _scrub(value: Any) -> Any:
    """Recursively remove secrets and make values JSON-safe."""
    if isinstance(value, dict):
        return {
            key: (REDACTED if key.lower() in SENSITIVE_KEYS else _scrub(val))
            for key, val in value.items()
        }
    if isinstance(value, list | tuple | set):
        return [_scrub(item) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, models.Model):
        return str(value.pk)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def record(
    *,
    action: str,
    entity: models.Model | None = None,
    entity_type: str = "",
    entity_id: str = "",
    entity_label: str = "",
    actor: Any = None,
    old_values: dict[str, Any] | None = None,
    new_values: dict[str, Any] | None = None,
    reason: str = "",
    branch: Any = None,
) -> AuditLog:
    """Write one audit entry.  Never raises into the caller's transaction path."""
    context = get_audit_context()

    if entity is not None:
        entity_type = entity_type or type(entity).__name__
        entity_id = entity_id or str(entity.pk)
        entity_label = entity_label or str(entity)[:255]

    actor_label = ""
    if actor is not None and getattr(actor, "is_authenticated", False):
        actor_label = getattr(actor, "email", "") or str(actor)
    else:
        actor = None

    return AuditLog.objects.create(
        actor=actor,
        actor_label=actor_label[:255],
        action=action,
        entity_type=entity_type[:64],
        entity_id=str(entity_id)[:64],
        entity_label=entity_label[:255],
        old_values=_scrub(old_values or {}),
        new_values=_scrub(new_values or {}),
        reason=reason,
        ip_address=context.get("ip_address"),
        user_agent=context.get("user_agent", ""),
        request_id=context.get("request_id", ""),
        branch=branch,
    )


def diff(before: dict[str, Any], after: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return only the fields that actually changed, so entries stay readable."""
    changed_keys = [key for key in after if before.get(key) != after.get(key)]
    return (
        {key: before.get(key) for key in changed_keys},
        {key: after.get(key) for key in changed_keys},
    )


def snapshot(instance: models.Model, fields: list[str]) -> dict[str, Any]:
    return {field: getattr(instance, field, None) for field in fields}


__all__ = ["AuditAction", "diff", "record", "snapshot"]
