"""The HTML a site page may contain.

Page bodies are written in the admin's rich-text editor and rendered on the
storefront as HTML, so this is the XSS boundary for them: **every** body is
cleaned here, server-side, before it is stored.  The browser's editor is a
convenience, not a control -- anyone holding a token can PATCH raw HTML.

`nh3` (Python bindings to the Rust `ammonia` sanitiser) does the parsing.  It is
an allow-list: a tag or attribute not named below is removed, the text inside
most removed tags is kept, and the content of `<script>`/`<style>` is dropped
entirely.  Hand-rolled regex sanitising is how XSS filters fail, which is why
this is a dependency rather than code (ADR-0012).

The allow-list is exactly what the editor toolbar can produce.  Headings start
at `h2` because the page title is the page's only `h1`.
"""

from __future__ import annotations

import re

import nh3

ALLOWED_TAGS = frozenset(
    {
        "p",
        "br",
        "h2",
        "h3",
        "strong",
        "em",
        "u",
        "s",
        "a",
        "ul",
        "ol",
        "li",
        "blockquote",
        "hr",
    }
)

#: `rel` is deliberately absent: `link_rel` below sets it on every link, and
#: ammonia refuses to run with both.
ALLOWED_ATTRIBUTES: dict[str, set[str]] = {"a": {"href"}}

#: Relative URLs (`/contact`) pass through; absolute ones must use one of these.
URL_SCHEMES = frozenset({"http", "https", "mailto", "tel"})

#: A page is prose, not a document store.  Generous for a privacy policy.
MAX_BODY_CHARS = 100_000

_EMPTY_PARAGRAPHS = re.compile(r"(?:<p>\s*(?:<br\s*/?>)?\s*</p>\s*)+$")


def sanitize(value: str) -> str:
    """Allow-listed HTML, with trailing empty paragraphs trimmed.

    Idempotent: cleaning an already-clean body returns it unchanged, which is
    what lets a test assert on the stored value.
    """
    cleaned = nh3.clean(
        value or "",
        tags=set(ALLOWED_TAGS),
        attributes=ALLOWED_ATTRIBUTES,
        url_schemes=set(URL_SCHEMES),
        link_rel="noopener noreferrer",
        strip_comments=True,
    )
    return _EMPTY_PARAGRAPHS.sub("", cleaned.strip())
