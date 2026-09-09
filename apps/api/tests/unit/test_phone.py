"""Phone numbers reduce to one spelling — pure logic, no database.

Identity is phone-first (business rules §6), and every duplicate customer this
codebase has produced came from storing what somebody typed.  These are the
rules that stop it, so they are tested against the spellings a Bangladeshi
customer, cashier or import file actually produces rather than a happy path.
"""

from __future__ import annotations

import pytest

from core import phone
from core.exceptions import ValidationError

#: Every spelling of one subscriber that somebody might actually type.
SPELLINGS = [
    "01712345678",
    "1712345678",
    "8801712345678",
    "+8801712345678",
    "008801712345678",
    "+880 1712-345678",
    "0171 234 5678",
    " (0171) 234-5678 ",
    # The country code with the local form pasted after it, which is what
    # somebody produces by typing `880` and then pasting their own number.
    "88001712345678",
    "+88001712345678",
]

#: Not Bangladeshi mobiles.  011 was Citycell and is withdrawn; 010 and 012
#: were never issued; the last two are a Dhaka landline and a short hotline.
NOT_MOBILES = [
    "01112345678",
    "01012345678",
    "0171234567",
    "017123456789",
    "029612345",
    "+8809610003030",
    "not a phone",
    "০১৭১২৩৪৫৬৭৮",
]


class TestSubscriberDigits:
    @pytest.mark.parametrize("spelling", SPELLINGS)
    def test_every_spelling_reduces_to_the_same_ten_digits(self, spelling: str) -> None:
        assert phone.subscriber_digits(spelling) == "1712345678"

    @pytest.mark.parametrize("operator", ["13", "14", "15", "16", "17", "18", "19"])
    def test_every_operator_prefix_in_use_is_accepted(self, operator: str) -> None:
        assert phone.subscriber_digits(f"0{operator}12345678") == f"{operator}12345678"

    @pytest.mark.parametrize("value", NOT_MOBILES)
    def test_anything_else_is_refused(self, value: str) -> None:
        assert phone.subscriber_digits(value) is None

    def test_nothing_is_not_a_number(self) -> None:
        assert phone.subscriber_digits(None) is None
        assert phone.subscriber_digits("") is None


class TestCanonical:
    def test_is_what_the_database_stores(self) -> None:
        assert phone.canonical("01712345678") == "8801712345678"

    def test_collapses_every_spelling_onto_one_string(self) -> None:
        # This single assertion is the defect (D48) in one line: two rows for
        # one person existed because these did not collapse.
        assert len({phone.canonical(value) for value in SPELLINGS}) == 1

    def test_is_none_rather_than_a_guess(self) -> None:
        assert phone.canonical("029612345") is None


class TestNormalize:
    def test_nothing_given_is_none_not_an_error(self) -> None:
        assert phone.normalize(None) is None
        assert phone.normalize("") is None
        assert phone.normalize("   ") is None

    def test_a_number_it_cannot_read_is_refused_rather_than_stored(self) -> None:
        with pytest.raises(ValidationError) as caught:
            phone.normalize("029612345")
        assert caught.value.details == {"phone": [phone.INVALID_MESSAGE]}

    def test_the_refusal_names_the_field_that_was_wrong(self) -> None:
        with pytest.raises(ValidationError) as caught:
            phone.normalize("029612345", field="contact_phone")
        assert "contact_phone" in caught.value.details

    def test_is_idempotent(self) -> None:
        once = phone.normalize("01712345678")
        assert phone.normalize(once) == once


class TestNormalizeIfMobile:
    """Contact numbers are not identities, and refusing them would be a new rule."""

    def test_a_mobile_is_canonicalised_like_any_other(self) -> None:
        assert phone.normalize_if_mobile("01712345678") == "8801712345678"

    @pytest.mark.parametrize("value", ["029612345", "+8809610003030", "16247"])
    def test_a_landline_or_hotline_is_kept_as_typed(self, value: str) -> None:
        assert phone.normalize_if_mobile(value) == value

    def test_blank_stays_blank_because_the_column_is_not_nullable(self) -> None:
        assert phone.normalize_if_mobile("") == ""
        assert phone.normalize_if_mobile(None) == ""


class TestSearchDigits:
    STORED = "8801712345678"

    @pytest.mark.parametrize(
        "typed", ["01712345678", "+8801712345678", "1712345678", "345678", "0171", "8801712"]
    )
    def test_what_a_cashier_types_is_a_substring_of_what_is_stored(self, typed: str) -> None:
        digits = phone.search_digits(typed)
        assert digits
        assert digits in self.STORED

    @pytest.mark.parametrize("typed", ["880", "0", "+880", "00880", "8800", "0880", ""])
    def test_a_bare_prefix_matches_nobody_rather_than_everybody(self, typed: str) -> None:
        # `phone__contains=""` is every row in the table, which on the counter
        # would put ten strangers' records on a screen the shop floor can see.
        assert phone.search_digits(typed) == ""
