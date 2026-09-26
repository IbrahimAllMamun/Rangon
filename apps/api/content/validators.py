"""What a merchandiser may type into a link, a social profile or a map.

Every value here ends up in an `href` or an iframe `src` on the public
storefront, so each one is normalised to a small set of safe shapes and
anything else is refused.  None of them is ever rendered as HTML.

* a link is site-relative (`/shop`), `http(s)://`, `mailto:` or `tel:`
* a social profile is `https://` on that platform's own domain
* a map is Google's embed URL, pulled out of the iframe code Google hands out

Nothing here takes a request; services call these and raise
`core.exceptions.ValidationError`, which the API renders as the error envelope.
"""

from __future__ import annotations

import html
import re
from urllib.parse import SplitResult, parse_qs, urlencode, urlsplit, urlunsplit

from content.models import SocialPlatform
from core import phone as phone_utils
from core.exceptions import ValidationError

#: C0 controls, DEL and whitespace.  A browser strips some of these out of a
#: URL before parsing it (`java\tscript:`), so they are refused outright rather
#: than trusted to fail later.
_UNSAFE_CHARS = re.compile(r"[\x00-\x20\x7f\\]")

LINK_MESSAGE = (
    "Use a site path such as /shop, or a full address starting with https://, " "mailto: or tel:."
)


#: Column widths (content.models).  Normalising can lengthen a value -- a
#: scheme is added, an iframe is reduced to a long URL -- so the result is
#: checked again rather than left to fail as a database error.
SOCIAL_URL_MAX = 300
MAP_EMBED_MAX = 2000
MAP_LINK_MAX = 500


def _fail(field: str, message: str) -> ValidationError:
    return ValidationError(message, details={field: [message]})


def _bounded(value: str, limit: int, field: str) -> str:
    if len(value) > limit:
        raise _fail(field, f"That address is too long ({len(value)} characters; {limit} at most).")
    return value


def _web_address(value: str, *, field: str, message: str) -> SplitResult:
    """`value` split, if it is a plain `http(s)://host/…` address, else a refusal.

    No credentials (`https://facebook.com@evil.example` is a link to
    evil.example) and no port.  `urlsplit` raises `ValueError` on a malformed
    port or IPv6 literal, which has to become a validation error, not a 500.
    """
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as error:
        raise _fail(field, message) from error
    if (
        parts.scheme.lower() not in {"http", "https"}
        or not parts.hostname
        or "@" in parts.netloc
        or port is not None
    ):
        raise _fail(field, message)
    return parts


def validate_link_url(value: str, *, field: str = "url") -> str:
    """A link a shopper can follow, or a refusal.

    `//evil.example` and `/\\evil.example` are both protocol-relative to a
    browser even though they start with a slash, so a site path must start with
    exactly one `/` and contain no backslash.
    """
    value = (value or "").strip()
    if not value:
        return ""
    if _UNSAFE_CHARS.search(value):
        raise _fail(field, LINK_MESSAGE)
    if value.startswith("/"):
        if value.startswith("//"):
            raise _fail(field, LINK_MESSAGE)
        return value

    scheme = value.split(":", 1)[0].lower()
    if scheme in {"mailto", "tel"} and len(value) > len(scheme) + 1:
        return value
    _web_address(value, field=field, message=LINK_MESSAGE)
    return value


def is_external(url: str) -> bool:
    return url.startswith(("http://", "https://"))


# --- social profiles ---------------------------------------------------------

#: The domains each platform's profile links live on.  A subdomain matches
#: (`m.facebook.com`, `www.instagram.com`); a look-alike does not
#: (`facebook.com.evil.example`).
PLATFORM_HOSTS: dict[str, tuple[str, ...]] = {
    SocialPlatform.FACEBOOK: ("facebook.com", "fb.com", "fb.me"),
    SocialPlatform.INSTAGRAM: ("instagram.com",),
    SocialPlatform.TIKTOK: ("tiktok.com",),
    SocialPlatform.YOUTUBE: ("youtube.com", "youtu.be"),
    SocialPlatform.WHATSAPP: ("wa.me", "whatsapp.com"),
    SocialPlatform.MESSENGER: ("m.me", "messenger.com"),
    SocialPlatform.X: ("x.com", "twitter.com"),
    SocialPlatform.LINKEDIN: ("linkedin.com",),
    SocialPlatform.PINTEREST: ("pinterest.com", "pin.it"),
    SocialPlatform.THREADS: ("threads.net", "threads.com"),
    SocialPlatform.TELEGRAM: ("t.me", "telegram.me"),
}

#: What the admin shows as a placeholder, and what an error message suggests.
PLATFORM_EXAMPLES: dict[str, str] = {
    SocialPlatform.FACEBOOK: "https://www.facebook.com/rangonfashion",
    SocialPlatform.INSTAGRAM: "https://www.instagram.com/rangonfashion",
    SocialPlatform.TIKTOK: "https://www.tiktok.com/@rangonfashion",
    SocialPlatform.YOUTUBE: "https://www.youtube.com/@rangonfashion",
    SocialPlatform.WHATSAPP: "01712345678",
    SocialPlatform.MESSENGER: "https://m.me/rangonfashion",
    SocialPlatform.X: "https://x.com/rangonfashion",
    SocialPlatform.LINKEDIN: "https://www.linkedin.com/company/rangonfashion",
    SocialPlatform.PINTEREST: "https://www.pinterest.com/rangonfashion",
    SocialPlatform.THREADS: "https://www.threads.net/@rangonfashion",
    SocialPlatform.TELEGRAM: "https://t.me/rangonfashion",
}

#: International numbers are 8-15 digits (E.164 allows up to 15).
_PHONE_DIGITS = re.compile(r"^\d{8,15}$")


def _host_matches(host: str, allowed: tuple[str, ...]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in allowed)


def _whatsapp_url(value: str, *, field: str) -> str | None:
    """`https://wa.me/<digits>` for anything that is a phone number, else None.

    A Bangladeshi mobile in any spelling becomes its canonical `880…` form
    (`core.phone`); any other international number is accepted as its digits.
    """
    if re.search(r"[A-Za-z/]", value):
        return None
    digits = phone_utils.canonical(value) or re.sub(r"\D", "", value)
    if not _PHONE_DIGITS.match(digits):
        raise _fail(field, "Enter the WhatsApp number, for example 01712345678.")
    return f"https://wa.me/{digits}"


def normalize_social_url(platform: str, value: str, *, field: str = "url") -> str:
    """A profile URL on `platform`'s own domain, always `https://`.

    Forgiving about what people paste -- `facebook.com/shop`, `http://…`, a
    WhatsApp number -- and strict about where it may point.
    """
    value = (value or "").strip()
    if not value:
        return ""
    if platform == SocialPlatform.WHATSAPP:
        built = _whatsapp_url(value, field=field)
        if built is not None:
            return built

    label = SocialPlatform(platform).label
    message = f"Enter a {label} address, for example {PLATFORM_EXAMPLES.get(platform, '')}."
    if _UNSAFE_CHARS.search(value):
        raise _fail(field, message)
    if "://" not in value:
        value = f"https://{value}"
    parts = _web_address(value, field=field, message=message)
    hostname = parts.hostname or ""
    if not _host_matches(hostname, PLATFORM_HOSTS.get(platform, ())):
        raise _fail(field, message)
    url = urlunsplit(("https", hostname.lower(), parts.path, parts.query, parts.fragment))
    return _bounded(url, SOCIAL_URL_MAX, field)


def whatsapp_number(url: str) -> str:
    """The number a WhatsApp chat link opens, or "" for a link that names none.

    `wa.me/<digits>` and `api.whatsapp.com/send?phone=<digits>` both name one; a
    catalogue or channel link does not, and gets no floating chat button.
    """
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    if host == "wa.me":
        digits = parts.path.strip("/")
    elif _host_matches(host, ("whatsapp.com",)):
        digits = parse_qs(parts.query).get("phone", [""])[0]
    else:
        return ""
    return digits if _PHONE_DIGITS.match(digits) else ""


# --- maps --------------------------------------------------------------------

#: The only origin a map may be framed from.  The storefront's CSP
#: `frame-src` names exactly this, so the two must change together
#: (apps/web/src/middleware.ts).
MAP_EMBED_ORIGIN = "https://www.google.com"
_GOOGLE_MAP_HOSTS = {"google.com", "www.google.com", "maps.google.com"}
_MAP_LINK_HOSTS = ("google.com", "maps.app.goo.gl", "goo.gl")
_IFRAME_SRC = re.compile(r"""<iframe\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1""", re.I | re.S)

MAP_MESSAGE = (
    "Paste the embed code from Google Maps (Share → Embed a map), "
    "or its https://www.google.com/maps/embed?… address."
)


def normalize_map_embed(value: str, *, field: str = "map_embed_url") -> str:
    """Google's embed URL, whether pasted bare or inside Google's `<iframe>` code.

    Only the URL is kept.  The pasted markup is discarded, so nothing an admin
    pastes is ever rendered -- the storefront builds its own iframe around a URL
    that has been checked to be Google's map embed and nothing else.
    """
    value = (value or "").strip()
    if not value:
        return ""
    if "<" in value:
        match = _IFRAME_SRC.search(value)
        if not match:
            raise _fail(field, MAP_MESSAGE)
        value = html.unescape(match.group(2)).strip()
    if _UNSAFE_CHARS.search(value):
        raise _fail(field, MAP_MESSAGE)

    parts = _web_address(value, field=field, message=MAP_MESSAGE)
    is_embed_path = parts.path.startswith("/maps/embed")
    # `/maps?q=…&output=embed` is the keyless form, built from an address.
    is_query_embed = parts.path == "/maps" and "output=embed" in parts.query
    if (
        parts.scheme.lower() != "https"
        or (parts.hostname or "").lower() not in _GOOGLE_MAP_HOSTS
        or not (is_embed_path or is_query_embed)
    ):
        raise _fail(field, MAP_MESSAGE)
    url = urlunsplit(("https", "www.google.com", parts.path, parts.query, ""))
    return _bounded(url, MAP_EMBED_MAX, field)


def map_embed_for_address(address: str) -> str:
    """The keyless embed URL for an address -- no API key, no account."""
    query = " ".join((address or "").split())
    if not query:
        return ""
    return f"{MAP_EMBED_ORIGIN}/maps?{urlencode({'q': query, 'output': 'embed'})}"


def normalize_map_link(value: str, *, field: str = "map_link_url") -> str:
    """A Google Maps page to open in a new tab (the short `maps.app.goo.gl` form too)."""
    value = (value or "").strip()
    if not value:
        return ""
    message = "Paste the Google Maps link to your shop (Share → Copy link)."
    if "://" not in value:
        value = f"https://{value}"
    if _UNSAFE_CHARS.search(value):
        raise _fail(field, message)
    parts = _web_address(value, field=field, message=message)
    host = (parts.hostname or "").lower()
    if (
        parts.scheme.lower() != "https"
        or not _host_matches(host, _MAP_LINK_HOSTS)
        or (_host_matches(host, ("google.com",)) and not parts.path.startswith("/maps"))
    ):
        raise _fail(field, message)
    return _bounded(value, MAP_LINK_MAX, field)


def map_link_for_address(address: str) -> str:
    query = " ".join((address or "").split())
    if not query:
        return ""
    return f"https://www.google.com/maps/search/?{urlencode({'api': 1, 'query': query})}"
