"""What a footer link, a social profile, a map and a page body may contain.

Each of these ends up in an `href`, an iframe `src` or rendered HTML on the
public storefront, so the refusals matter as much as the acceptances.
"""

from __future__ import annotations

import pytest

from content import rich_text
from content.models import SocialPlatform
from content.validators import (
    map_embed_for_address,
    normalize_map_embed,
    normalize_map_link,
    normalize_social_url,
    validate_link_url,
    whatsapp_number,
)
from core.exceptions import ValidationError

EMBED = (
    "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3651.9!2d90.39!3d23.75"
    "!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1"
)


class TestLinks:
    @pytest.mark.parametrize(
        "url",
        [
            "/shop",
            "/shop?sort=newest",
            "/policies/terms#cancellation",
            "https://example.com/lookbook",
            "http://example.com",
            "mailto:hello@rangonfashion.com",
            "tel:+8801712345678",
        ],
    )
    def test_safe_links_are_kept(self, url: str) -> None:
        assert validate_link_url(url) == url

    @pytest.mark.parametrize(
        "url",
        [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "java\tscript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "//evil.example/path",
            "/\\evil.example",
            "https://user@evil.example",
            "shop",
            "https://",
        ],
    )
    def test_anything_else_is_refused(self, url: str) -> None:
        with pytest.raises(ValidationError):
            validate_link_url(url)

    def test_blank_is_blank(self) -> None:
        assert validate_link_url("   ") == ""


class TestSocialProfiles:
    def test_a_bare_domain_gets_https(self) -> None:
        assert (
            normalize_social_url(SocialPlatform.FACEBOOK, "facebook.com/rangonfashion")
            == "https://facebook.com/rangonfashion"
        )

    def test_http_is_upgraded(self) -> None:
        assert (
            normalize_social_url(SocialPlatform.INSTAGRAM, "http://www.instagram.com/rangon")
            == "https://www.instagram.com/rangon"
        )

    def test_a_subdomain_of_the_platform_is_accepted(self) -> None:
        assert normalize_social_url(SocialPlatform.FACEBOOK, "https://m.facebook.com/rangon")

    @pytest.mark.parametrize(
        ("platform", "url"),
        [
            (SocialPlatform.FACEBOOK, "https://instagram.com/rangon"),
            (SocialPlatform.FACEBOOK, "https://facebook.com.evil.example/rangon"),
            (SocialPlatform.FACEBOOK, "https://evilfacebook.com/rangon"),
            (SocialPlatform.INSTAGRAM, "javascript:alert(1)"),
            (SocialPlatform.YOUTUBE, "https://youtube.com@evil.example/"),
            (SocialPlatform.TIKTOK, "ftp://tiktok.com/@rangon"),
        ],
    )
    def test_a_link_off_the_platform_is_refused(self, platform: str, url: str) -> None:
        with pytest.raises(ValidationError) as error:
            normalize_social_url(platform, url)
        assert "url" in error.value.details

    @pytest.mark.parametrize(
        "typed", ["01712345678", "+880 1712-345678", "8801712345678", "(017) 1234 5678"]
    )
    def test_a_whatsapp_number_becomes_a_chat_link(self, typed: str) -> None:
        assert normalize_social_url(SocialPlatform.WHATSAPP, typed) == "https://wa.me/8801712345678"

    def test_a_foreign_whatsapp_number_keeps_its_digits(self) -> None:
        assert (
            normalize_social_url(SocialPlatform.WHATSAPP, "+44 7700 900123")
            == "https://wa.me/447700900123"
        )

    def test_a_short_whatsapp_number_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            normalize_social_url(SocialPlatform.WHATSAPP, "12345")

    def test_the_chat_number_is_read_back_from_either_link_form(self) -> None:
        assert whatsapp_number("https://wa.me/8801712345678") == "8801712345678"
        assert (
            whatsapp_number("https://api.whatsapp.com/send?phone=8801712345678") == "8801712345678"
        )
        assert whatsapp_number("https://whatsapp.com/channel/abc") == ""

    def test_a_url_that_grows_past_the_column_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            normalize_social_url(SocialPlatform.FACEBOOK, "facebook.com/" + "a" * 300)


class TestMaps:
    def test_the_embed_url_is_kept(self) -> None:
        assert normalize_map_embed(EMBED) == EMBED

    def test_googles_iframe_code_is_reduced_to_its_url(self) -> None:
        pasted = (
            f'<iframe src="{EMBED.replace("&", "&amp;")}" width="600" height="450" '
            'style="border:0;" allowfullscreen="" loading="lazy" '
            'referrerpolicy="no-referrer-when-downgrade"></iframe>'
        )
        assert normalize_map_embed(pasted) == EMBED

    def test_the_keyless_address_form_is_accepted(self) -> None:
        url = map_embed_for_address("Bashundhara City, Panthapath, Dhaka")
        assert normalize_map_embed(url) == url
        assert url.startswith("https://www.google.com/maps?")

    @pytest.mark.parametrize(
        "pasted",
        [
            "https://evil.example/maps/embed?pb=1",
            "https://www.google.com.evil.example/maps/embed?pb=1",
            "http://www.google.com/maps/embed?pb=1",
            "https://www.google.com/search?q=dhaka",
            "https://www.google.com/maps/place/Dhaka",  # a page, not an embed
            "javascript:alert(1)",
            '<iframe src="https://evil.example/"></iframe>',
            '<script>alert(1)</script><iframe src="https://evil.example/"></iframe>',
            "<p>no iframe here</p>",
        ],
    )
    def test_anything_but_a_google_embed_is_refused(self, pasted: str) -> None:
        with pytest.raises(ValidationError):
            normalize_map_embed(pasted)

    def test_the_share_link_forms_are_accepted(self) -> None:
        assert normalize_map_link("https://maps.app.goo.gl/AbCdEf123")
        assert normalize_map_link("https://www.google.com/maps/place/Bashundhara+City")

    def test_a_non_maps_link_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            normalize_map_link("https://www.google.com/search?q=evil")
        with pytest.raises(ValidationError):
            normalize_map_link("https://evil.example/maps")


class TestRichText:
    def test_the_editors_own_markup_survives(self) -> None:
        body = (
            "<h2>Orders</h2><p>Some <strong>bold</strong>, <em>italic</em>, <u>under</u> "
            "and <s>struck</s> text.</p><ul><li>One</li></ul><ol><li>Two</li></ol>"
            "<blockquote><p>Quote</p></blockquote><hr>"
        )
        assert rich_text.sanitize(body) == body

    def test_links_keep_their_href_and_gain_a_safe_rel(self) -> None:
        cleaned = rich_text.sanitize('<p><a href="/contact" target="_blank">Contact</a></p>')
        assert cleaned == '<p><a href="/contact" rel="noopener noreferrer">Contact</a></p>'

    @pytest.mark.parametrize(
        ("dirty", "clean"),
        [
            ("<p>Hi<script>alert(1)</script></p>", "<p>Hi</p>"),
            ('<p onclick="alert(1)">Hi</p>', "<p>Hi</p>"),
            ('<img src=x onerror="alert(1)">', ""),
            (
                '<p><a href="javascript:alert(1)">x</a></p>',
                '<p><a rel="noopener noreferrer">x</a></p>',
            ),
            ('<iframe src="https://evil.example"></iframe><p>ok</p>', "<p>ok</p>"),
            ("<style>body{display:none}</style><p>ok</p>", "<p>ok</p>"),
            ('<p style="color:red">styled</p>', "<p>styled</p>"),
            ("<h1>Title</h1>", "Title"),
            ("<!-- note --><p>ok</p>", "<p>ok</p>"),
        ],
    )
    def test_everything_else_is_removed(self, dirty: str, clean: str) -> None:
        assert rich_text.sanitize(dirty) == clean

    def test_trailing_empty_paragraphs_are_trimmed(self) -> None:
        assert rich_text.sanitize("<p>Hi</p><p></p><p><br></p>") == "<p>Hi</p>"

    def test_cleaning_is_idempotent(self) -> None:
        once = rich_text.sanitize('<p><a href="https://x.example">x</a> & <b>y</b></p>')
        assert rich_text.sanitize(once) == once
