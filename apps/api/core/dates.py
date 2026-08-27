"""Reading a date window off a query string.

One parser, because a screen and its CSV export disagreeing about where a
period starts is a reporting bug nobody notices until the totals are compared.

Accepts either a whole day (``2026-08-27``) or an exact moment
(``2026-08-27T14:30:00``).  A day is widened to cover all of itself, so
``date_to=2026-08-27`` includes what was spent that afternoon rather than
stopping at midnight -- the single most common off-by-one in period filters.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Any

from django.utils import timezone

from core.exceptions import ValidationError


def parse_moment(value: Any, *, end_of_day: bool = False) -> datetime | None:
    """Turn a query-string date into an aware datetime, or None if absent.

    Raises ``ValidationError`` on anything unreadable rather than returning
    None: silently dropping a filter the user asked for would show them more
    rows than they requested and call it an answer.
    """
    if value in (None, ""):
        return None

    text = str(value).strip()
    try:
        # Only a bare YYYY-MM-DD parses here; anything with a time falls through.
        day = date.fromisoformat(text)
    except ValueError:
        try:
            moment = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValidationError(
                f"“{text}” is not a date. Use YYYY-MM-DD, or a full timestamp.",
                details={"value": text},
            ) from exc
    else:
        moment = datetime.combine(day, time.max if end_of_day else time.min)

    if timezone.is_naive(moment):
        moment = timezone.make_aware(moment, timezone.get_current_timezone())
    return moment


def parse_window(params: Any) -> tuple[datetime | None, datetime | None]:
    """``date_from`` / ``date_to`` off a query dict, as an inclusive window."""
    return (
        parse_moment(params.get("date_from"), end_of_day=False),
        parse_moment(params.get("date_to"), end_of_day=True),
    )
