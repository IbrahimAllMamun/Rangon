"""The product feed Meta and Google poll.

The feed is the one part of this system whose mistakes are silent. A wrong
price does not raise; it runs an advert at the wrong figure. An unpublished
product that leaks in does not 500; it advertises something nobody can buy. So
these tests are mostly about what the feed must *not* say.

`cache.clear()` runs before each test on purpose. The endpoints are wrapped in
`cache_page`, and the test cache is a process-local dictionary, so without it
the second test in this file would assert against the first one's catalogue.
"""

from __future__ import annotations

import csv
import io
from decimal import Decimal
from xml.etree import ElementTree as ET

import pytest
from django.core.cache import cache

from catalog import feeds
from catalog.models import PublishStatus
from catalog.services import generate_barcode
from tests import factories

pytestmark = pytest.mark.django_db

XML = "/api/v1/shop/feed.xml"
CSV = "/api/v1/shop/feed.csv"

ORIGIN = "https://rangonfashion.test"

G = "{http://base.google.com/ns/1.0}"


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    cache.clear()


@pytest.fixture(autouse=True)
def _public_url(settings) -> None:
    """The origin the feed absolutises against.

    Set by item rather than with `override_settings(RANGON=...)`, which would
    replace the whole business-config dict and take the currency with it.
    """
    settings.RANGON = {**settings.RANGON, "PUBLIC_URL": ORIGIN + "/"}


def _rows(response) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(response.content.decode())))


def _items(response) -> list[ET.Element]:
    # S314 is suppressed below: the document being parsed is the response this
    # suite just generated, not input from anywhere. `defusedxml` guards
    # against a hostile document, and there is no adversary between
    # `render_xml` and this line.
    return ET.fromstring(  # noqa: S314
        response.content.decode()
    ).findall("./channel/item")


def _by_id(response) -> dict[str, dict[str, str]]:
    return {row["id"]: row for row in _rows(response)}


class TestWhatIsInIt:
    def test_a_row_is_a_variant_not_a_product(self, shop, api) -> None:
        """ "Kurti" is not buyable; "Kurti, M" is."""
        response = api.get(CSV)

        assert response.status_code == 200
        rows = _rows(response)
        assert len(rows) == 2  # the fixture's product has two sizes
        assert {row["id"] for row in rows} == {v.sku for v in shop["variants"]}

    def test_the_variants_of_one_product_share_an_item_group(self, shop, api) -> None:
        # Without this Meta advertises them as two unrelated products rather
        # than one product a customer can pick a size on.
        groups = {row["item_group_id"] for row in _rows(api.get(CSV))}
        assert groups == {shop["product"].slug}

    def test_the_title_carries_the_variant_not_just_the_product(self, shop, api) -> None:
        titles = [row["title"] for row in _rows(api.get(CSV))]
        assert all(title.startswith(shop["product"].name) for title in titles)
        assert sorted(titles) != [shop["product"].name] * 2, "every row has the same title"

    def test_the_shop_is_the_brand_when_the_product_has_none(self, shop, api) -> None:
        """Meta rejects a row with no brand, and a tailored kurti has no maker."""
        shop["product"].brand = None
        shop["product"].save(update_fields=["brand"])

        assert {row["brand"] for row in _rows(api.get(CSV))} == {shop["organization"].name}

    def test_the_category_path_is_the_full_ancestry(self, api) -> None:
        parent = factories.category(name="Women")
        child = factories.category(name="Kurti", parent=parent)
        product = factories.product(category=child)
        factories.variant(product)

        paths = {row["product_type"] for row in _rows(api.get(CSV))}
        assert "Women > Kurti" in paths


class TestWhatItMustNotSay:
    def test_an_unpublished_product_is_absent(self, shop, api) -> None:
        shop["product"].published = False
        shop["product"].save(update_fields=["published"])

        assert _rows(api.get(CSV)) == []

    def test_a_draft_product_is_absent(self, shop, api) -> None:
        shop["product"].status = PublishStatus.DRAFT
        shop["product"].save(update_fields=["status"])

        assert _rows(api.get(CSV)) == []

    def test_an_archived_variant_is_absent_while_its_siblings_remain(self, shop, api) -> None:
        retired, kept = shop["variants"]
        retired.status = PublishStatus.ARCHIVED
        retired.save(update_fields=["status"])

        assert {row["id"] for row in _rows(api.get(CSV))} == {kept.sku}

    def test_the_cost_price_never_appears(self, shop, api) -> None:
        """The one catalogue figure a competitor would actually want."""
        variant = shop["variants"][0]
        variant.cost = Decimal("377.77")
        variant.save(update_fields=["cost"])

        assert "377.77" not in api.get(CSV).content.decode()
        assert "377.77" not in api.get(XML).content.decode()


class TestPhotography:
    def test_a_product_with_no_photograph_is_still_published(self, shop, api) -> None:
        """Deliberate: a rejection Meta reports is visible, an absence is not.

        Meta requires `image_link` and rejects a row without one, so an
        unphotographed product cannot be advertised either way. Publishing it
        blank means the shop learns which products need a photograph; dropping
        the row means the catalogue is quietly smaller and nothing says why.
        """
        rows = _rows(api.get(CSV))

        assert len(rows) == 2
        assert all(row["image_link"] == "" for row in rows)


class TestStock:
    def test_stock_on_the_shelf_reads_as_in_stock(self, shop, api) -> None:
        rows = _by_id(api.get(CSV))
        assert rows[shop["variants"][0].sku]["availability"] == "in stock"

    def test_a_variant_with_no_stock_reads_as_out_of_stock(self, shop, api) -> None:
        """The feed must not advertise what the storefront calls sold out."""
        product = factories.product()
        empty = factories.variant(product)  # never received

        rows = _by_id(api.get(CSV))
        assert rows[empty.sku]["availability"] == "out of stock"
        assert rows[empty.sku]["inventory"] == "0"

    def test_availability_follows_the_branch_the_storefront_sells_from(self, shop, api) -> None:
        other = factories.branch(shop["organization"], code="DHK9", name="Other branch")
        product = factories.product()
        elsewhere = factories.variant(product)
        factories.stock(elsewhere, other, 25)

        # Stocked, but not at the branch the storefront sells from.
        rows = _by_id(api.get(CSV))
        assert rows[elsewhere.sku]["availability"] == "out of stock"


class TestPrice:
    def test_the_price_carries_the_currency_the_format_requires(self, shop, api) -> None:
        rows = _by_id(api.get(CSV))
        assert rows[shop["variants"][0].sku]["price"] == "1000.00 BDT"

    def test_a_full_price_item_publishes_no_sale_price(self, shop, api) -> None:
        rows = _by_id(api.get(CSV))
        assert rows[shop["variants"][0].sku]["sale_price"] == ""

    def test_a_discount_publishes_the_old_price_as_price_and_the_new_as_sale_price(
        self, shop, api
    ) -> None:
        """The strikethrough in the advert is the difference between the two.

        Publishing the charged figure as `price` with no `sale_price` is not an
        error anyone would see — the shop just silently loses the discount
        badge it is paying for.
        """
        variant = shop["variants"][0]
        variant.compare_at_price = Decimal("1500.00")
        variant.save(update_fields=["compare_at_price"])

        row = _by_id(api.get(CSV))[variant.sku]
        assert row["price"] == "1500.00 BDT"
        assert row["sale_price"] == "1000.00 BDT"

    def test_a_compare_price_below_the_real_one_is_not_a_discount(self, shop, api) -> None:
        variant = shop["variants"][0]
        variant.compare_at_price = Decimal("900.00")
        variant.save(update_fields=["compare_at_price"])

        row = _by_id(api.get(CSV))[variant.sku]
        assert row["price"] == "1000.00 BDT"
        assert row["sale_price"] == ""


class TestLinks:
    def test_the_product_link_is_absolute_and_points_at_the_storefront(self, shop, api) -> None:
        row = _by_id(api.get(CSV))[shop["variants"][0].sku]
        assert row["link"] == f"{ORIGIN}/product/{shop['product'].slug}"

    def test_a_trailing_slash_on_the_configured_origin_does_not_double_up(
        self, shop, api, settings
    ) -> None:
        # The fixture deliberately configures "https://rangonfashion.test/".
        assert "//product/" not in api.get(CSV).content.decode()

    def test_the_feed_refuses_to_render_without_a_public_origin(self, shop, api, settings) -> None:
        """Relative links are worthless to Meta, so this is not a soft failure."""
        settings.RANGON = {**settings.RANGON, "PUBLIC_URL": ""}

        response = api.get(CSV)

        assert response.status_code == 503
        assert response.json()["error"]["code"] == "FEED_NOT_CONFIGURED"
        assert "RANGON_PUBLIC_URL" in response.json()["error"]["message"]


class TestGtin:
    """A GTIN is a *global* identity. Publishing one the shop invented is worse
    than publishing none: the row is rejected at best, and matched to somebody
    else's product at worst.
    """

    @pytest.mark.parametrize(
        "barcode",
        [
            "4006381333931",  # EAN-13, a German manufacturer prefix
            "5901234123457",  # EAN-13, Polish
            "036000291452",  # UPC-A
            "96385074",  # EAN-8
        ],
    )
    def test_a_real_manufacturer_barcode_is_published(self, api, barcode) -> None:
        product = factories.product()
        variant = factories.variant(product, barcode=barcode)

        assert _by_id(api.get(CSV))[variant.sku]["gtin"] == barcode

    def test_a_barcode_this_shop_generated_is_never_published(self, api) -> None:
        """The case that was actually live, found by reading the served feed.

        `catalog.services.generate_barcode` mints EAN-13s under prefix 20-29
        *because* GS1 reserves that range for in-store use — its own docstring
        says so — and every seeded variant carries one. The first version of
        this feed published all of them as GTINs.
        """
        product = factories.product()
        variant = factories.variant(product, barcode=None)
        variant.barcode = generate_barcode(variant)
        variant.save(update_fields=["barcode"])

        assert variant.barcode.startswith("2")
        assert _by_id(api.get(CSV))[variant.sku]["gtin"] == ""

    @pytest.mark.parametrize(
        ("barcode", "why"),
        [
            ("4006381333930", "the check digit is wrong"),
            ("1234567890123", "thirteen digits, but not a barcode"),
            ("KURTI-M-01", "a SKU typed into the barcode column"),
            ("12345", "too short to be any GTIN"),
            ("", "no barcode at all"),
        ],
    )
    def test_anything_that_is_not_a_gtin_is_left_blank(self, api, barcode, why) -> None:
        product = factories.product()
        variant = factories.variant(product, barcode=barcode or None)

        assert _by_id(api.get(CSV))[variant.sku]["gtin"] == "", why


class TestTheTwoRenderings:
    def test_the_csv_has_a_header_row(self, shop, api) -> None:
        first = api.get(CSV).content.decode().splitlines()[0]
        assert first.split(",")[:3] == ["id", "item_group_id", "title"]

    def test_the_xml_is_rss_with_the_shopping_namespace(self, shop, api) -> None:
        root = ET.fromstring(api.get(XML).content.decode())  # noqa: S314 — our own output

        assert root.tag == "rss"
        assert root.get("version") == "2.0"
        assert root.find("./channel/item") is not None

    def test_the_two_renderings_describe_the_same_catalogue(self, shop, api) -> None:
        """One selector, two renderers — so this is the assertion that they are."""
        csv_ids = {row["id"] for row in _rows(api.get(CSV))}
        xml_ids = {item.findtext(f"{G}id") for item in _items(api.get(XML))}

        assert csv_ids == xml_ids

    def test_an_empty_optional_field_is_omitted_from_the_xml_not_sent_blank(
        self, shop, api
    ) -> None:
        item = _items(api.get(XML))[0]
        assert item.find(f"{G}sale_price") is None  # nothing is discounted
        assert item.findtext(f"{G}availability")  # but the required ones are there

    def test_the_readable_rss_fields_are_unprefixed(self, shop, api) -> None:
        """`title`, `link` and `description` are what a feed reader shows."""
        item = _items(api.get(XML))[0]
        assert item.findtext("title")
        assert item.findtext("link", "").startswith(ORIGIN)

    def test_each_rendering_declares_its_own_content_type(self, shop, api) -> None:
        assert api.get(CSV)["Content-Type"].startswith("text/csv")
        assert api.get(XML)["Content-Type"].startswith("application/xml")


def test_the_feed_is_public(shop, api) -> None:
    """Meta fetches on a schedule from its own infrastructure, with no login."""
    assert api.get(XML).status_code == 200
    assert api.get(CSV).status_code == 200


class TestTitleClipping:
    def test_a_long_title_is_trimmed_to_the_limit(self) -> None:
        clipped = feeds._clip("word " * 200, feeds.TITLE_LIMIT)
        assert len(clipped) <= feeds.TITLE_LIMIT + 1  # the ellipsis

    def test_a_short_title_is_left_exactly_as_it_is(self) -> None:
        assert feeds._clip("Maroon Kurti", 200) == "Maroon Kurti"

    def test_whitespace_is_collapsed_so_the_row_stays_one_line(self) -> None:
        """A newline inside a CSV field is legal and still ruins a hand check."""
        assert feeds._clip("Cotton\nkurti,\there", 200) == "Cotton kurti, here"
