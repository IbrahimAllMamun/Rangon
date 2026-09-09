"""Bangladeshi mobile numbers, spelled one way.

Identity is phone-first (docs/business-rules.md §6), and that only works when
one subscriber has exactly one spelling.  `01712345678`, `+8801712345678`,
`8801712345678` and `+880 1712-345678` are the same person, so every one of
them is stored as the canonical `8801712345678`: country code, no `+`, no
separators, no trunk `0`.

Storing what was typed is what allowed one customer to be filed twice, which
splits their order history and makes lifetime spend, loyalty and the party
ledger under-report (D48).
"""

from __future__ import annotations

import re

from core.exceptions import ValidationError

#: Bangladesh, without the `+`.  Stored as part of the number so that every
#: row is unambiguous on its own, including in a CSV export or a receipt.
COUNTRY_CODE = "880"

#: A Bangladeshi mobile number is ten digits beginning `1`, and the operator
#: digit that follows is 3-9: 013/017 Grameenphone, 014/019 Banglalink,
#: 015 Teletalk, 016 Airtel, 018 Robi.  011 (Citycell) was withdrawn and
#: 010/012 were never issued, so anything outside `1[3-9]` is a typo rather
#: than an operator we have not heard of.
SUBSCRIBER_RE = re.compile(r"^1[3-9]\d{8}$")

INVALID_MESSAGE = "Enter a Bangladeshi mobile number, for example 01712345678."

#: Prefixes stripped from a typed number, longest first.  `00` is the
#: international access code, `880` the country code, `0` the national trunk
#: prefix.  Order matters: each spelling is the next one down with something in
#: front of it, and a bare `1XXXXXXXXX` carries none of them.
_PREFIXES = ("00" + COUNTRY_CODE, COUNTRY_CODE, "0")


def _strip_prefixes(raw: str | None) -> str:
    """The digits of `raw` with every leading country or trunk prefix removed.

    Repeated rather than stripped once, because the spellings stack: somebody
    who types the country code and then pastes the local form produces
    `88001712345678`, and `00880…` is `00` in front of the country code in
    front of the subscriber.  Nothing this can destroy is meaningful -- no
    Bangladeshi subscriber number begins `0` or `8`.
    """
    if raw is None:
        return ""
    digits = re.sub(r"\D", "", str(raw))
    previous = None
    while digits != previous:
        previous = digits
        for prefix in _PREFIXES:
            if digits.startswith(prefix):
                digits = digits[len(prefix) :]
                break
    return digits


def subscriber_digits(raw: str | None) -> str | None:
    """The ten-digit `1XXXXXXXXX` part of `raw`, or None if it is not one.

    Accepts every spelling a customer, a cashier or an import file produces:
    spaces, dashes, brackets, a leading `+`, `00` international access, the
    country code with or without it, and the national trunk `0`.
    """
    digits = _strip_prefixes(raw)
    return digits if SUBSCRIBER_RE.match(digits) else None


def canonical(raw: str | None) -> str | None:
    """`8801XXXXXXXXX` for anything that is a Bangladeshi mobile, else None.

    Returns None for a blank value too, so a caller cannot tell "nothing given"
    from "given and wrong" -- use `normalize` when that difference matters.
    """
    subscriber = subscriber_digits(raw)
    return f"{COUNTRY_CODE}{subscriber}" if subscriber else None


def normalize(raw: str | None, *, field: str = "phone") -> str | None:
    """Canonical form, None when nothing was given, and a refusal otherwise.

    There is deliberately no lenient path for an identity field.  Storing a
    number we could not read is exactly how one person ends up as two rows.
    """
    if raw is None or not str(raw).strip():
        return None
    number = canonical(raw)
    if number is None:
        raise ValidationError(INVALID_MESSAGE, details={field: [INVALID_MESSAGE]})
    return number


def normalize_if_mobile(raw: str | None) -> str:
    """Canonical form when `raw` is a mobile, otherwise `raw` stripped and kept.

    For the fields that hold a contact number rather than an identity.  A
    branch, a supplier or an organization may legitimately publish a landline
    (`02-9612345`) or a short hotline (`+8809610003030`), and refusing those
    would be a new business rule rather than a fix for D48.
    """
    if raw is None:
        return ""
    return canonical(raw) or str(raw).strip()


def search_digits(raw: str | None) -> str:
    """The digits of a *partial* number, with any prefix the caller may have typed.

    A cashier types what the customer says: the whole number, the local
    `0`-prefixed form, or only the last few digits.  Each of those is a
    substring of the stored canonical number once the prefixes a customer never
    says aloud are taken off, so one `contains` query serves all three.

    Returns "" when nothing identifying is left -- `880` alone is the country,
    not a customer, and must not be allowed to match every row in the table.
    """
    return _strip_prefixes(raw)
