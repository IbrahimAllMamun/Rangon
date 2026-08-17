"""Money helpers.

One place decides how Rangon rounds, so a POS receipt and a web invoice can
never disagree.  Rule: half-up to 2 decimal places, applied once per figure
(docs/business-rules.md §3.2).
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.conf import settings

CENTS = Decimal("0.01")
ZERO = Decimal("0.00")


def to_decimal(value: object, default: Decimal | None = None) -> Decimal:
    """Coerce anything (str/int/float/Decimal) into a Decimal safely.

    Floats are routed through ``str`` so 0.1 does not become
    0.1000000000000000055511151231257827.
    """
    if isinstance(value, Decimal):
        return value
    if value is None or value == "":
        if default is not None:
            return default
        raise ValueError("Cannot convert an empty value to Decimal.")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        if default is not None:
            return default
        raise ValueError(f"{value!r} is not a valid monetary amount.") from exc


def quantize(value: object) -> Decimal:
    """Round to 2 decimal places, half-up (what a shopkeeper expects)."""
    return to_decimal(value).quantize(CENTS, rounding=ROUND_HALF_UP)


def money(value: object) -> Decimal:
    """Alias used at service boundaries to make intent obvious."""
    return quantize(value)


def percentage_of(amount: object, percent: object) -> Decimal:
    """`percent` is a human percentage (15 means 15%)."""
    return quantize(to_decimal(amount) * to_decimal(percent) / Decimal("100"))


def apply_rate(amount: object, rate: object) -> Decimal:
    """`rate` is a fraction (0.15 means 15%)."""
    return quantize(to_decimal(amount) * to_decimal(rate))


def clamp_non_negative(value: object) -> Decimal:
    amount = quantize(value)
    return amount if amount > ZERO else ZERO


def currency_code() -> str:
    return str(settings.RANGON["CURRENCY"])


def currency_symbol() -> str:
    return str(settings.RANGON["CURRENCY_SYMBOL"])


def format_money(value: object, *, with_symbol: bool = True) -> str:
    """Display helper for receipts, emails and exports.

    Formatting is configuration, never baked into business logic.
    """
    amount = quantize(value)
    formatted = f"{amount:,.2f}"
    return f"{currency_symbol()} {formatted}" if with_symbol else formatted
