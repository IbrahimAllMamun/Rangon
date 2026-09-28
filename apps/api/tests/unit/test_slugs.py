"""A slug for a name written in Bengali.

Django's `slugify` keeps ASCII only, so every Bengali name slugged to "" and
the catalogue fell back to `item`, `item-2`, `item-3`. Its `allow_unicode=True`
is no answer either: it strips Bengali vowel signs and the hasanta, which are
not `\\w`, so শাড়ি became শড and পাঞ্জাবি became পঞজব. `core.slugs`
transliterates Bengali to Latin letters first (business-rules.md § 7.2).
"""

from __future__ import annotations

import pytest

from core.slugs import slug_text


@pytest.mark.parametrize(
    ("name", "slug"),
    [
        # Clothing names a Bangladeshi shop actually uses.
        ("শাড়ি", "shari"),
        ("পাঞ্জাবি", "panjabi"),
        ("থ্রি-পিস", "thri-pis"),
        ("জামদানি", "jamdani"),
        ("লুঙ্গি", "lungi"),
        ("ফতুয়া", "fatuya"),
        # Loanwords written in Bengali letters.
        ("প্রিন্ট শার্ট", "print-shart"),
        ("জিন্স", "jins"),
        # The inherent vowel: kept where it is heard, dropped at a word's end
        # and between a vowel and a consonant that carries its own.
        ("কলম", "kalam"),
        ("সবুজ", "sabuj"),
        ("গয়না", "gayna"),
        ("বাংলা", "bangla"),
        ("উৎসব", "utsab"),
        ("ঈদ মোবারক", "id-mobarak"),
    ],
)
def test_bengali_is_transliterated(name: str, slug: str) -> None:
    assert slug_text(name) == slug


def test_bengali_digits_become_ascii_digits() -> None:
    assert slug_text("ঈদ ২০২৬") == "id-2026"


def test_mixed_scripts_keep_both_halves() -> None:
    assert slug_text("Eid 2026 শাড়ি") == "eid-2026-shari"
    assert slug_text("শাড়ি Collection") == "shari-collection"


def test_the_precomposed_and_decomposed_spellings_agree() -> None:
    """ড় is U+09DC typed directly, or ড + nukta after NFC; keyboards do both."""
    precomposed = "শাড়ি"
    decomposed = "শাড়ি"
    assert slug_text(precomposed) == slug_text(decomposed) == "shari"


def test_latin_names_are_untouched() -> None:
    assert slug_text("Classic Oxford Shirt") == "classic-oxford-shirt"
    assert slug_text("Café Crème") == "cafe-creme"


def test_a_script_it_does_not_know_gives_nothing() -> None:
    """The caller decides the fallback; guessing here would hide it."""
    assert slug_text("قميص") == ""
    assert slug_text("") == ""
