"""Serializer fields shared across apps."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from core import phone


class BangladeshiPhoneField(serializers.CharField):
    """A phone number as the database stores it: `8801XXXXXXXXX`.

    Normalising inside `to_internal_value`, rather than in a `validate_<field>`
    method, is the point of the class.  A field's validators run on whatever
    `to_internal_value` returns, so `UniqueValidator` gets the canonical number
    and two spellings of one subscriber collide the way they should.  Normalise
    any later and `+8801712345678` passes a uniqueness check against a stored
    `8801712345678`, then fails in the database as an IntegrityError, which
    reaches the caller as a 500 instead of a field error.
    """

    default_error_messages = {"invalid": phone.INVALID_MESSAGE}

    def to_internal_value(self, data: Any) -> str:
        value = super().to_internal_value(data)
        if not value.strip():
            return ""
        number = phone.canonical(value)
        if number is None:
            self.fail("invalid")
        return number


class ContactPhoneField(serializers.CharField):
    """A contact number that may not be a mobile at all.

    Branches, suppliers and the organization itself publish landlines and short
    hotlines.  A mobile is stored canonically so it matches everywhere else;
    anything else is kept as typed rather than refused.
    """

    def to_internal_value(self, data: Any) -> str:
        return phone.normalize_if_mobile(super().to_internal_value(data))
