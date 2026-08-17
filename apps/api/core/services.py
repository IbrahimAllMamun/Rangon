"""Core services: document numbering and settings access."""

from __future__ import annotations

from typing import Any

from django.db import transaction

from core.models import NumberSequence, Setting


@transaction.atomic
def next_number(key: str, *, prefix: str = "", padding: int = 6) -> str:
    """Allocate the next human-readable document number for `key`.

    Row-locked, so two simultaneous sales cannot receive the same number.
    Called inside the caller's transaction: if the sale rolls back, the number
    is released with it (a gap is acceptable; a duplicate is not).

        next_number("order:POS", prefix="RGN-POS")  ->  "RGN-POS-000042"
    """
    sequence, _ = NumberSequence.objects.get_or_create(
        key=key, defaults={"prefix": prefix, "padding": padding}
    )
    sequence = NumberSequence.objects.select_for_update().get(pk=sequence.pk)
    sequence.last_value += 1
    sequence.save(update_fields=["last_value", "updated_at"])

    effective_prefix = sequence.prefix or prefix
    number = str(sequence.last_value).zfill(sequence.padding or padding)
    return f"{effective_prefix}-{number}" if effective_prefix else number


def get_setting(key: str, default: Any = None) -> Any:
    try:
        return Setting.objects.get(key=key).value
    except Setting.DoesNotExist:
        return default


def set_setting(key: str, value: Any, *, actor: Any = None, description: str = "") -> Setting:
    setting, created = Setting.objects.update_or_create(
        key=key,
        defaults={"value": value, "updated_by": actor, "description": description},
    )
    return setting
