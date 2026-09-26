"""The storefront footer, social links and site pages (ADR-0012).

Migration 0003 seeds the footer every install starts with -- three columns,
six pages, eleven hidden social rows -- so these tests begin from exactly what
a fresh production database holds.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils.text import slugify

from accounts.models import RoleCode
from content.models import (
    NavigationItem,
    NavigationItemType,
    Placement,
    SitePage,
    SiteSettings,
    SocialLink,
    SocialPlatform,
)
from core.models import AuditLog
from tests import factories

pytestmark = pytest.mark.django_db

SITE_URL = "/api/v1/shop/site/"
SETTINGS_URL = "/api/v1/site-settings/"
SOCIAL_URL = "/api/v1/social-links/"
PAGES_URL = "/api/v1/site-pages/"
NAV_URL = "/api/v1/navigation-items/"

EMBED = "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3651.9"

#: Settings, organisation, social rows, footer rows, and the category list.
SITE_QUERY_BUDGET = 6


def _columns(payload: dict[str, Any]) -> dict[str, list[str]]:
    return {
        column["label"]: [link["label"] for link in column["links"]]
        for column in payload["columns"]
    }


def _column(label: str) -> NavigationItem:
    return NavigationItem.objects.get(
        placement=Placement.FOOTER, type=NavigationItemType.GROUP, label=label
    )


def _social(platform: str) -> SocialLink:
    return SocialLink.objects.get(platform=platform)


def _show(platform: str, url: str, **fields: Any) -> SocialLink:
    link = _social(platform)
    link.url = url
    link.is_visible = True
    for key, value in fields.items():
        setattr(link, key, value)
    link.save()
    return link


@pytest.fixture
def accountant() -> Any:
    """Holds `settings.view` but not `content.site_manage`."""
    return factories.user(RoleCode.ACCOUNTANT)


# --- what a fresh install shows -------------------------------------------------


class TestTheSeededFooter:
    def test_a_fresh_install_has_todays_three_columns(self, api: Any) -> None:
        columns = _columns(api.get(SITE_URL).data)

        # Shop's "Top categories" entry expands to nothing until there is a
        # catalogue, and the rest of the column still renders.
        assert columns == {
            "Shop": ["New arrivals", "All brands", "Shop all"],
            "Help": ["Track your order", "Shipping", "Returns & exchanges", "Contact us"],
            "Company": ["About us", "Privacy policy", "Terms of sale"],
        }

    def test_page_links_point_at_the_paths_the_storefront_serves(self, api: Any) -> None:
        links = {
            link["label"]: link["url"]
            for column in api.get(SITE_URL).data["columns"]
            for link in column["links"]
        }
        assert links["About us"] == "/about"
        assert links["Contact us"] == "/contact"
        assert links["Privacy policy"] == "/policies/privacy"
        assert links["Returns & exchanges"] == "/policies/returns"

    def test_no_social_profile_is_advertised_until_one_is_set_up(self, api: Any) -> None:
        payload = api.get(SITE_URL).data
        assert payload["social"] == []
        assert payload["whatsapp"] is None
        assert SocialLink.objects.count() == len(SocialPlatform.choices)

    def test_the_six_standard_pages_exist_and_are_published(self, api: Any) -> None:
        for slug in ("about", "contact", "shipping", "returns", "privacy", "terms"):
            response = api.get(f"/api/v1/shop/pages/{slug}/")
            assert response.status_code == 200, slug
            assert response.data["body"].startswith(("<p>", "<h2>"))

    def test_the_copyright_line_keeps_the_year_for_the_storefront(self, api: Any) -> None:
        factories.organization(name="Rangon Fashion")
        bottom = api.get(SITE_URL).data["bottom"]
        assert bottom["copyright"] == "© {year} Rangon Fashion. All rights reserved."
        assert bottom["note"] == "Cash on delivery available across Bangladesh."


class TestContactDetails:
    def test_blank_storefront_fields_fall_back_to_the_organisation(self, api: Any) -> None:
        factories.organization(
            name="Rangon Fashion",
            address="Level 3, Bashundhara City\nPanthapath, Dhaka 1215",
            phone="8801700000000",
            email="hello@rangonfashion.com",
        )
        brand = api.get(SITE_URL).data["brand"]
        assert brand["address"] == "Level 3, Bashundhara City\nPanthapath, Dhaka 1215"
        assert brand["phone"] == "8801700000000"
        assert brand["email"] == "hello@rangonfashion.com"

    def test_the_storefront_address_wins_over_the_registered_one(self, api: Any) -> None:
        factories.organization(address="Registered office, Motijheel")
        SiteSettings.objects.filter(key="default").update(address="Shop 12, Panthapath")

        assert api.get(SITE_URL).data["brand"]["address"] == "Shop 12, Panthapath"

    def test_the_address_can_be_hidden(self, api: Any) -> None:
        factories.organization(address="Level 3, Bashundhara City")
        SiteSettings.objects.filter(key="default").update(show_address=False)

        assert api.get(SITE_URL).data["brand"]["address"] == ""

    def test_directions_default_to_a_search_for_the_address(self, api: Any) -> None:
        factories.organization(address="Bashundhara City, Dhaka")
        link = api.get(SITE_URL).data["map"]["link_url"]
        assert link.startswith("https://www.google.com/maps/search/?api=1&query=Bashundhara")


# --- social links ------------------------------------------------------------------


class TestSocialLinks:
    def test_only_visible_links_with_a_url_are_published(self, api: Any) -> None:
        _show(SocialPlatform.FACEBOOK, "https://facebook.com/rangon")
        hidden = _social(SocialPlatform.INSTAGRAM)
        hidden.url = "https://instagram.com/rangon"
        hidden.save()  # filled in, not ticked

        social = api.get(SITE_URL).data["social"]
        assert [link["platform"] for link in social] == ["FACEBOOK"]

    def test_the_shops_order_is_the_published_order(self, api: Any) -> None:
        _show(SocialPlatform.FACEBOOK, "https://facebook.com/rangon", position=5)
        _show(SocialPlatform.TIKTOK, "https://tiktok.com/@rangon", position=1)

        social = api.get(SITE_URL).data["social"]
        assert [link["platform"] for link in social] == ["TIKTOK", "FACEBOOK"]

    def test_a_manager_fills_in_and_shows_a_profile(self, auth_client: Any, manager: Any) -> None:
        link = _social(SocialPlatform.INSTAGRAM)
        response = auth_client(manager).patch(
            f"{SOCIAL_URL}{link.pk}/",
            {"url": "instagram.com/rangonfashion", "is_visible": True},
            format="json",
        )
        assert response.status_code == 200, response.data
        assert response.data["url"] == "https://instagram.com/rangonfashion"
        assert response.data["is_visible"] is True

    def test_a_profile_on_another_domain_is_refused(self, auth_client: Any, manager: Any) -> None:
        link = _social(SocialPlatform.FACEBOOK)
        response = auth_client(manager).patch(
            f"{SOCIAL_URL}{link.pk}/", {"url": "https://evil.example/facebook"}, format="json"
        )
        assert response.status_code == 400
        assert "url" in response.data["error"]["details"]

    def test_showing_a_profile_with_no_address_is_refused(
        self, auth_client: Any, manager: Any
    ) -> None:
        link = _social(SocialPlatform.YOUTUBE)
        response = auth_client(manager).patch(
            f"{SOCIAL_URL}{link.pk}/", {"is_visible": True}, format="json"
        )
        assert response.status_code == 400
        assert "is_visible" in response.data["error"]["details"]

    def test_a_whatsapp_number_becomes_the_floating_chat_button(
        self, api: Any, auth_client: Any, manager: Any
    ) -> None:
        link = _social(SocialPlatform.WHATSAPP)
        auth_client(manager).patch(
            f"{SOCIAL_URL}{link.pk}/", {"url": "01712-345678", "is_visible": True}, format="json"
        )

        payload = api.get(SITE_URL).data
        assert payload["whatsapp"] == {"number": "8801712345678", "show_float": True}
        assert payload["social"][0]["url"] == "https://wa.me/8801712345678"

    def test_the_floating_button_can_be_turned_off(self, api: Any) -> None:
        """Explicitly off -- not `None`, which would let a build-time number show it."""
        _show(SocialPlatform.WHATSAPP, "https://wa.me/8801712345678")
        SiteSettings.objects.filter(key="default").update(whatsapp_float=False)

        payload = api.get(SITE_URL).data
        assert payload["whatsapp"] == {"number": "8801712345678", "show_float": False}
        assert [link["platform"] for link in payload["social"]] == ["WHATSAPP"]

    def test_move_reorders_the_run(self, auth_client: Any, manager: Any) -> None:
        tiktok = _social(SocialPlatform.TIKTOK)
        before = list(SocialLink.objects.values_list("platform", flat=True))

        response = auth_client(manager).post(
            f"{SOCIAL_URL}{tiktok.pk}/move/", {"direction": "up"}, format="json"
        )

        assert response.status_code == 200, response.data
        after = list(SocialLink.objects.values_list("platform", flat=True))
        index = before.index("TIKTOK")
        assert after[index - 1] == "TIKTOK"
        assert after[index] == before[index - 1]

    def test_there_is_no_create_or_delete(self, auth_client: Any, owner: Any) -> None:
        client = auth_client(owner)
        link = _social(SocialPlatform.X)
        assert client.post(SOCIAL_URL, {"platform": "X"}).status_code == 405
        assert client.delete(f"{SOCIAL_URL}{link.pk}/").status_code == 405

    def test_every_change_is_audited(self, auth_client: Any, manager: Any) -> None:
        link = _social(SocialPlatform.FACEBOOK)
        auth_client(manager).patch(
            f"{SOCIAL_URL}{link.pk}/", {"url": "facebook.com/rangon"}, format="json"
        )

        entry = AuditLog.objects.filter(entity_type="SocialLink", entity_id=str(link.pk)).get()
        assert entry.actor == manager
        assert entry.old_values == {"url": ""}
        assert entry.new_values == {"url": "https://facebook.com/rangon"}


# --- site settings ----------------------------------------------------------------


class TestSiteSettings:
    def test_anonymous_is_refused(self, api: Any) -> None:
        assert api.get(SETTINGS_URL).status_code == 401
        assert api.patch(SETTINGS_URL, {"tagline": "x"}, format="json").status_code == 401

    def test_a_cashier_may_not_read_or_write(self, auth_client: Any, cashier: Any) -> None:
        client = auth_client(cashier)
        assert client.get(SETTINGS_URL).status_code == 403
        assert client.patch(SETTINGS_URL, {"tagline": "x"}, format="json").status_code == 403

    def test_viewing_settings_does_not_allow_changing_them(
        self, auth_client: Any, accountant: Any
    ) -> None:
        client = auth_client(accountant)
        assert client.get(SETTINGS_URL).status_code == 200
        assert client.patch(SETTINGS_URL, {"tagline": "x"}, format="json").status_code == 403

    def test_a_manager_can_change_the_footer(self, auth_client: Any, manager: Any) -> None:
        response = auth_client(manager).patch(
            SETTINGS_URL,
            {
                "tagline": "  Dhaka's everyday wardrobe  ",
                "address": "Shop 12, Level 3\nBashundhara City",
                "opening_hours": [
                    {"days": "Sat–Thu", "hours": "10:00–20:00"},
                    {"days": "", "hours": ""},
                ],
                "copyright_text": "© {year} Rangon",
            },
            format="json",
        )

        assert response.status_code == 200, response.data
        assert response.data["tagline"] == "Dhaka's everyday wardrobe"
        assert response.data["opening_hours"] == [{"days": "Sat–Thu", "hours": "10:00–20:00"}]
        assert response.data["updated_by_name"] == manager.full_name

    def test_the_response_says_what_blank_fields_fall_back_to(
        self, auth_client: Any, manager: Any
    ) -> None:
        # `manager` comes from `full_shop`, which made the organisation.
        response = auth_client(manager).get(SETTINGS_URL)
        assert set(response.data["fallbacks"]) == {"name", "address", "phone", "email"}

    def test_googles_iframe_code_is_stored_as_its_url(self, auth_client: Any, manager: Any) -> None:
        pasted = f'<iframe src="{EMBED}" width="600" height="450" loading="lazy"></iframe>'
        response = auth_client(manager).patch(
            SETTINGS_URL, {"map_embed_url": pasted}, format="json"
        )
        assert response.status_code == 200, response.data
        assert response.data["map_embed_url"] == EMBED

    @pytest.mark.parametrize(
        "pasted",
        [
            '<iframe src="https://evil.example/maps/embed"></iframe>',
            "javascript:alert(1)",
            "https://www.google.com/search?q=x",
        ],
    )
    def test_a_map_that_is_not_googles_embed_is_refused(
        self, auth_client: Any, manager: Any, pasted: str
    ) -> None:
        response = auth_client(manager).patch(
            SETTINGS_URL, {"map_embed_url": pasted}, format="json"
        )
        assert response.status_code == 400
        assert "map_embed_url" in response.data["error"]["details"]

    def test_eight_rows_of_opening_hours_is_too_many(self, auth_client: Any, manager: Any) -> None:
        rows = [{"days": f"Day {n}", "hours": "10–8"} for n in range(8)]
        response = auth_client(manager).patch(SETTINGS_URL, {"opening_hours": rows}, format="json")
        assert response.status_code == 400

    def test_a_change_is_audited_with_before_and_after(
        self, auth_client: Any, manager: Any
    ) -> None:
        auth_client(manager).patch(SETTINGS_URL, {"bottom_note": "Free returns"}, format="json")

        entry = AuditLog.objects.filter(entity_type="SiteSettings").get()
        assert entry.old_values == {"bottom_note": "Cash on delivery available across Bangladesh."}
        assert entry.new_values == {"bottom_note": "Free returns"}

    def test_saving_nothing_new_writes_no_audit_entry(self, auth_client: Any, manager: Any) -> None:
        tagline = SiteSettings.objects.get().tagline
        auth_client(manager).patch(SETTINGS_URL, {"tagline": tagline}, format="json")
        assert not AuditLog.objects.filter(entity_type="SiteSettings").exists()


# --- pages ------------------------------------------------------------------------


class TestPages:
    def test_the_body_is_sanitised_before_it_is_stored(
        self, auth_client: Any, manager: Any
    ) -> None:
        response = auth_client(manager).patch(
            f"{PAGES_URL}about/",
            {
                "body": (
                    '<h2>Hi</h2><p onclick="steal()">Text<script>alert(1)</script></p>'
                    '<p><a href="javascript:alert(1)">bad</a> <a href="/shop">good</a></p>'
                    '<img src="x" onerror="alert(1)">'
                )
            },
            format="json",
        )

        assert response.status_code == 200, response.data
        stored = SitePage.objects.get(slug="about").body
        assert stored == (
            "<h2>Hi</h2><p>Text</p>"
            '<p><a rel="noopener noreferrer">bad</a> '
            '<a href="/shop" rel="noopener noreferrer">good</a></p>'
        )

    def test_the_public_page_serves_the_stored_body(
        self, api: Any, auth_client: Any, manager: Any
    ) -> None:
        auth_client(manager).patch(
            f"{PAGES_URL}terms/", {"body": "<p>New terms.</p>", "title": "Terms"}, format="json"
        )
        page = api.get("/api/v1/shop/pages/terms/").data
        assert page["body"] == "<p>New terms.</p>"
        assert page["path"] == "/policies/terms"

    def test_an_unpublished_page_is_gone_from_the_shop_and_the_footer(
        self, api: Any, auth_client: Any, manager: Any
    ) -> None:
        auth_client(manager).patch(f"{PAGES_URL}terms/", {"is_published": False}, format="json")

        assert api.get("/api/v1/shop/pages/terms/").status_code == 404
        assert "Terms of sale" not in _columns(api.get(SITE_URL).data)["Company"]
        assert "terms" not in [page["slug"] for page in api.get("/api/v1/shop/pages/").data]

    def test_a_standard_page_cannot_be_deleted(self, auth_client: Any, owner: Any) -> None:
        response = auth_client(owner).delete(f"{PAGES_URL}privacy/")
        assert response.status_code == 400
        assert SitePage.objects.filter(slug="privacy").exists()

    def test_a_page_needs_a_title(self, auth_client: Any, manager: Any) -> None:
        response = auth_client(manager).patch(f"{PAGES_URL}about/", {"title": "  "}, format="json")
        assert response.status_code == 400

    def test_a_custom_page_lives_under_pages(
        self, api: Any, auth_client: Any, manager: Any
    ) -> None:
        response = auth_client(manager).post(
            PAGES_URL,
            {"title": "Size guide", "body": "<p>Measure twice.</p>"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["slug"] == slugify("Size guide")
        assert response.data["path"] == "/pages/size-guide"
        assert response.data["is_system"] is False
        assert api.get("/api/v1/shop/pages/size-guide/").status_code == 200

    def test_a_custom_page_cannot_take_a_standard_slug(
        self, auth_client: Any, manager: Any
    ) -> None:
        response = auth_client(manager).post(
            PAGES_URL, {"title": "About", "slug": "about"}, format="json"
        )
        assert response.status_code == 400

    def test_a_duplicate_slug_is_a_conflict(self, auth_client: Any, manager: Any) -> None:
        client = auth_client(manager)
        client.post(PAGES_URL, {"title": "FAQ"}, format="json")
        response = client.post(PAGES_URL, {"title": "FAQ"}, format="json")
        assert response.status_code == 409

    def test_a_custom_page_can_be_deleted_and_its_footer_links_go_with_it(
        self, api: Any, auth_client: Any, manager: Any
    ) -> None:
        client = auth_client(manager)
        client.post(PAGES_URL, {"title": "FAQ"}, format="json")
        NavigationItem.objects.create(
            placement=Placement.FOOTER,
            type=NavigationItemType.PAGE,
            page=SitePage.objects.get(slug="faq"),
            parent=_column("Help"),
            position=9,
        )
        assert "FAQ" in _columns(api.get(SITE_URL).data)["Help"]

        assert client.delete(f"{PAGES_URL}faq/").status_code == 204
        assert "FAQ" not in _columns(api.get(SITE_URL).data)["Help"]

    def test_a_cashier_may_not_edit_a_page(self, auth_client: Any, cashier: Any) -> None:
        response = auth_client(cashier).patch(
            f"{PAGES_URL}privacy/", {"body": "<p>x</p>"}, format="json"
        )
        assert response.status_code == 403

    def test_an_edit_is_audited(self, auth_client: Any, manager: Any) -> None:
        auth_client(manager).patch(
            f"{PAGES_URL}privacy/", {"title": "Privacy notice"}, format="json"
        )

        entry = AuditLog.objects.filter(entity_type="SitePage").get()
        assert entry.old_values == {"title": "Privacy"}
        assert entry.new_values == {"title": "Privacy notice"}
        assert SitePage.objects.get(slug="privacy").updated_by == manager


# --- footer columns (navigation-items, placement=FOOTER) ---------------------------


class TestFooterColumns:
    def test_top_categories_follow_the_catalogue(self, api: Any) -> None:
        factories.category(name="Women", slug="women", position=0)
        factories.category(name="Men", slug="men", position=1)
        factories.category(name="Archive", slug="archive", is_active=False)
        factories.category(name="Hidden", slug="hidden", show_in_navigation=False)

        shop = api.get(SITE_URL).data["columns"][0]
        assert [link["label"] for link in shop["links"]][:2] == ["Women", "Men"]
        assert shop["links"][0]["url"] == "/category/women"
        assert "Archive" not in [link["label"] for link in shop["links"]]

    def test_a_hidden_link_or_column_is_not_published(self, api: Any) -> None:
        NavigationItem.objects.filter(label="Track your order").update(is_active=False)
        NavigationItem.objects.filter(pk=_column("Company").pk).update(is_active=False)

        columns = _columns(api.get(SITE_URL).data)
        assert "Company" not in columns
        assert "Track your order" not in columns["Help"]

    def test_an_external_link_is_flagged(self, api: Any) -> None:
        NavigationItem.objects.create(
            placement=Placement.FOOTER,
            type=NavigationItemType.LINK,
            label="Lookbook",
            url="https://lookbook.example",
            parent=_column("Shop"),
            position=9,
        )
        links = {link["label"]: link for link in api.get(SITE_URL).data["columns"][0]["links"]}
        assert links["Lookbook"]["external"] is True
        assert links["Shop all"]["external"] is False

    def test_a_manager_adds_a_page_link_to_a_column(self, auth_client: Any, manager: Any) -> None:
        response = auth_client(manager).post(
            NAV_URL,
            {
                "placement": "FOOTER",
                "type": "PAGE",
                "page": "privacy",
                "parent": str(_column("Help").pk),
            },
            format="json",
        )
        assert response.status_code == 201, response.data
        assert response.data["page_title"] == "Privacy"

    def test_a_footer_link_must_sit_in_a_column(self, auth_client: Any, manager: Any) -> None:
        response = auth_client(manager).post(
            NAV_URL,
            {"placement": "FOOTER", "type": "LINK", "label": "Loose", "url": "/shop"},
            format="json",
        )
        assert response.status_code == 400
        assert "parent" in response.data["error"]["details"]

    def test_a_column_belongs_in_the_footer(self, auth_client: Any, manager: Any) -> None:
        response = auth_client(manager).post(
            NAV_URL, {"placement": "HEADER", "type": "GROUP", "label": "Help"}, format="json"
        )
        assert response.status_code == 400

    def test_a_fifth_column_is_refused(self, auth_client: Any, manager: Any) -> None:
        client = auth_client(manager)
        fourth = client.post(
            NAV_URL, {"placement": "FOOTER", "type": "GROUP", "label": "Stores"}, format="json"
        )
        assert fourth.status_code == 201, fourth.data

        fifth = client.post(
            NAV_URL, {"placement": "FOOTER", "type": "GROUP", "label": "More"}, format="json"
        )
        assert fifth.status_code == 400

    def test_a_script_url_is_refused(self, auth_client: Any, manager: Any) -> None:
        response = auth_client(manager).post(
            NAV_URL,
            {
                "placement": "FOOTER",
                "type": "LINK",
                "label": "Click",
                "url": "javascript:alert(1)",
                "parent": str(_column("Help").pk),
            },
            format="json",
        )
        assert response.status_code == 400
        assert "url" in response.data["error"]["details"]

    def test_the_payload_does_not_grow_with_the_footer(self, api: Any) -> None:
        for index in range(3):
            factories.category(name=f"Root {index}")
        factories.organization()

        api.get(SITE_URL)  # warm
        with CaptureQueriesContext(connection) as first:
            api.get(SITE_URL)

        help_column = _column("Help")
        for index in range(10):
            NavigationItem.objects.create(
                placement=Placement.FOOTER,
                type=NavigationItemType.LINK,
                label=f"Link {index}",
                url=f"/shop?page={index}",
                parent=help_column,
                position=20 + index,
            )
            factories.category(name=f"More {index}")
        for platform in (SocialPlatform.FACEBOOK, SocialPlatform.TIKTOK):
            _show(platform, f"https://{platform.lower()}.com/rangon")

        with CaptureQueriesContext(connection) as second:
            api.get(SITE_URL)

        assert len(second) == len(
            first
        ), f"Queries grew from {len(first)} to {len(second)} as the footer grew."
        assert len(second) <= SITE_QUERY_BUDGET


# --- cache invalidation -------------------------------------------------------------


class TestRevalidation:
    def test_a_saved_page_asks_the_storefront_to_drop_it(
        self,
        auth_client: Any,
        manager: Any,
        monkeypatch: pytest.MonkeyPatch,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        sent: list[tuple[str, ...]] = []
        monkeypatch.setattr("content.signals.request_revalidation", lambda *tags: sent.append(tags))

        with django_capture_on_commit_callbacks(execute=True):
            auth_client(manager).patch(f"{PAGES_URL}terms/", {"title": "Terms"}, format="json")
            auth_client(manager).patch(
                f"{PAGES_URL}terms/", {"title": "Terms of sale"}, format="json"
            )

        assert ("site", "pages", "page:terms") in sent

    def test_saved_settings_ask_for_the_footer_to_be_rebuilt(
        self,
        auth_client: Any,
        manager: Any,
        monkeypatch: pytest.MonkeyPatch,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        sent: list[tuple[str, ...]] = []
        monkeypatch.setattr("content.signals.request_revalidation", lambda *tags: sent.append(tags))

        with django_capture_on_commit_callbacks(execute=True):
            auth_client(manager).patch(SETTINGS_URL, {"tagline": "New"}, format="json")

        assert ("site",) in sent
