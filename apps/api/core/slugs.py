"""URL slugs, including for names written in Bengali.

A slug is ASCII: lower-case Latin letters, digits and hyphens. Django's
`slugify` gets there by throwing away every character that is not ASCII, which
for a shop naming its catalogue in Bengali means throwing away the whole name:
শাড়ি slugged to "", and the catalogue fell back to `item`, `item-2`, `item-3`.
Its `allow_unicode=True` does not help. It keeps only `\\w` characters, and
Bengali vowel signs and the hasanta are combining marks, not `\\w`, so শাড়ি
became শড and পাঞ্জাবি became পঞজব -- and `SlugField`'s own validator would
refuse the marks anyway.

So Bengali is transliterated to Latin letters first, and only then slugged:
শাড়ি → `shari`, পাঞ্জাবি → `panjabi`, থ্রি-পিস → `thri-pis`. The scheme is a
practical one for addresses, not a scholarly romanisation (business-rules.md
§ 7.2): one Latin spelling per letter, the inherent vowel written `a`, and
that vowel dropped where Bengali drops it in speech -- at the end of a word,
and between a vowel and a consonant that carries its own (জামদানি →
`jamdani`, not `jamadani`). It is deliberately a table here rather than a
dependency: this shop needs one script, and the common transliteration
libraries are GPL or bring every script in the world to spell one.

Any other script still slugs to "", and the caller supplies what the slug
falls back to.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Any

from django.utils.text import slugify

#: The vowel a Bengali consonant carries when nothing else is written.
INHERENT = "a"

HASANTA = "্"  # ্ -- silences a consonant's vowel, and joins conjuncts
NUKTA = "়"  # ় -- turns ড ঢ য into ড় ঢ় য়

CONSONANTS = {
    "ক": "k", "খ": "kh", "গ": "g", "ঘ": "gh", "ঙ": "ng",
    "চ": "ch", "ছ": "chh", "জ": "j", "ঝ": "jh", "ঞ": "n",
    "ট": "t", "ঠ": "th", "ড": "d", "ঢ": "dh", "ণ": "n",
    "ত": "t", "থ": "th", "দ": "d", "ধ": "dh", "ন": "n",
    "প": "p", "ফ": "f", "ব": "b", "ভ": "bh", "ম": "m",
    "য": "j", "র": "r", "ল": "l", "শ": "sh", "ষ": "sh",
    "স": "s", "হ": "h",
    # Precomposed nukta forms. NFC decomposes these (they are composition
    # exclusions), but text that was never normalised can still hold them.
    "ড়": "r", "ঢ়": "rh", "য়": "y",
}  # fmt: skip

#: ড + ় and friends, as NFC spells them.
NUKTA_FORMS = {"ড": "r", "ঢ": "rh", "য": "y"}

VOWELS = {
    "অ": "a", "আ": "a", "ই": "i", "ঈ": "i", "উ": "u", "ঊ": "u",
    "ঋ": "ri", "ঌ": "li", "এ": "e", "ঐ": "oi", "ও": "o", "ঔ": "ou",
}  # fmt: skip

VOWEL_SIGNS = {
    "া": "a", "ি": "i", "ী": "i", "ু": "u", "ূ": "u", "ৃ": "ri",
    "ৄ": "ri", "ে": "e", "ৈ": "oi", "ো": "o", "ৌ": "ou", "ৗ": "u",
}  # fmt: skip

#: Written after a syllable rather than as one; none carries a vowel.
SIGNS = {"ং": "ng", "ঃ": "h", "ঁ": "", "ৎ": "t"}

DIGITS = {chr(0x09E6 + n): str(n) for n in range(10)}

#: ঙ before a velar: the nasal is heard in the velar already (লুঙ্গি, lungi).
VELARS = frozenset("কখগঘ")

#: Zero-width joiner and non-joiner shape conjuncts on screen; they spell nothing.
JOINERS = frozenset("‌‍")


@dataclass
class _Unit:
    kind: str  # "consonant", "vowel" or "sign"
    text: str
    #: A consonant's vowel: written, "" when silenced, None for the inherent one.
    vowel: str | None = ""


def _is_bengali(char: str) -> bool:
    return "ঀ" <= char <= "৿" or char in JOINERS


def _units(word: str) -> list[_Unit]:
    """Split one run of Bengali into consonants, vowels and signs."""
    chars = [char for char in word if char not in JOINERS]
    units: list[_Unit] = []
    i = 0
    while i < len(chars):
        char = chars[i]
        i += 1
        if char in CONSONANTS:
            text = CONSONANTS[char]
            if i < len(chars) and chars[i] == NUKTA:
                text = NUKTA_FORMS.get(char, text)
                i += 1
            # য after a silenced consonant is a য-phala, heard as "y" (প্যান্ট).
            if char == "য" and units and units[-1].kind == "consonant" and units[-1].vowel == "":
                text = "y"
            if i < len(chars) and chars[i] in VOWEL_SIGNS:
                units.append(_Unit("consonant", text, VOWEL_SIGNS[chars[i]]))
                i += 1
            elif i < len(chars) and chars[i] == HASANTA:
                i += 1
                if char == "ঙ" and i < len(chars) and chars[i] in VELARS:
                    text = "n"
                units.append(_Unit("consonant", text, ""))
            else:
                units.append(_Unit("consonant", text, None))
        elif char in VOWELS:
            units.append(_Unit("vowel", VOWELS[char]))
        elif char in VOWEL_SIGNS:  # a sign with no consonant before it
            units.append(_Unit("vowel", VOWEL_SIGNS[char]))
        elif char in SIGNS:
            units.append(_Unit("sign", SIGNS[char]))
        elif char in DIGITS:
            units.append(_Unit("sign", DIGITS[char]))
        # Anything else -- a stray hasanta or nukta, the avagraha, ৳ -- spells nothing.
    return units


def _spell(units: list[_Unit]) -> str:
    """Write the units out, deciding where the inherent vowel is heard."""
    out: list[str] = []
    after_vowel = False
    for index, unit in enumerate(units):
        if unit.kind != "consonant":
            out.append(unit.text)
            after_vowel = unit.kind == "vowel"
            continue
        vowel = unit.vowel
        if vowel is None:
            following = units[index + 1] if index + 1 < len(units) else None
            last = following is None
            before_own_vowel = (
                following is not None and following.kind == "consonant" and bool(following.vowel)
            )
            vowel = "" if last or (after_vowel and before_own_vowel) else INHERENT
        out.append(unit.text + vowel)
        after_vowel = bool(vowel)
    return "".join(out)


def transliterate(value: str) -> str:
    """Bengali runs spelled in Latin letters; everything else left as it was."""
    text = unicodedata.normalize("NFC", str(value))
    out: list[str] = []
    run: list[str] = []
    for char in text:
        if _is_bengali(char):
            run.append(char)
            continue
        if run:
            out.append(_spell(_units("".join(run))))
            run = []
        out.append(char)
    if run:
        out.append(_spell(_units("".join(run))))
    return "".join(out)


def slug_text(value: str) -> str:
    """The slug a name spells, or "" when nothing in it can be spelled in ASCII."""
    return slugify(transliterate(value))


def unique_slug(model: Any, value: str, *, field: str = "slug", fallback: str = "") -> str:
    """A slug for `value` that no row of `model` has yet.

    Falls back to `fallback`, else to the model's own name (`category`,
    `brand`, `product`), when the name spells nothing -- a name in a script
    other than Latin or Bengali. Collisions take a numeric suffix. The result
    fits the column, suffix included.
    """
    max_length = model._meta.get_field(field).max_length or 50
    base = slug_text(value) or slugify(fallback) or model._meta.model_name
    # Room for "-999": the suffix must never be what overflows the column.
    base = base[: max_length - 4].rstrip("-")
    candidate, counter = base, 1
    while model.objects.filter(**{field: candidate}).exists():
        counter += 1
        candidate = f"{base}-{counter}"
    return candidate
