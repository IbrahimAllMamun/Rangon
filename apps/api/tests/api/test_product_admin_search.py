"""The admin product list's search box.

The endpoint reused the storefront's search, which answers a shopper: whole
words, ranked. Staff type fragments -- part of a name, the start of a SKU --
and it found nothing for either ("kurt" and "RGN-BLO" both came back empty on
the demo seed). Both now count, alongside everything the storefront search
still finds, and across every status: a buyer looks for drafts too.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from catalog.models import PublishStatus
from tests import factories

pytestmark = pytest.mark.django_db

URL = "/api/v1/products/"


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["manager"])


def names(response) -> list[str]:
    assert response.status_code == 200, response.json()
    return [row["name"] for row in response.json()["results"]]


def kurti(**kwargs):
    product = factories.product(name="Block Print Kurti", **kwargs)
    factories.variant(product, sku="RGN-BLO-L-BEI", barcode="2000000000017", price="1890.00")
    factories.variant(product, sku="RGN-BLO-M-BEI", barcode="2000000000024", price="1790.00")
    return product


class TestFragments:
    def test_part_of_a_name_finds_the_product(self, admin):
        kurti()
        factories.product(name="Classic Oxford Shirt")

        assert names(admin.get(URL, {"search": "kurt"})) == ["Block Print Kurti"]

    def test_the_start_of_a_sku_finds_the_product_once(self, admin):
        """Both variants match; the product is one row, not two."""
        kurti()

        assert names(admin.get(URL, {"search": "RGN-BLO"})) == ["Block Print Kurti"]

    def test_a_barcode_finds_the_product(self, admin):
        kurti()

        assert names(admin.get(URL, {"search": "2000000000024"})) == ["Block Print Kurti"]

    def test_the_price_range_is_the_products_not_the_matches(self, admin):
        """Matching one SKU must not narrow, or repeat into, the price figures."""
        kurti()

        [row] = admin.get(URL, {"search": "RGN-BLO-L"}).json()["results"]

        assert Decimal(row["min_price"]) == Decimal("1790.00")
        assert Decimal(row["max_price"]) == Decimal("1890.00")


class TestWhatItStillFinds:
    def test_whole_words_still_match_as_on_the_storefront(self, admin):
        kurti()

        assert names(admin.get(URL, {"search": "print kurti"})) == ["Block Print Kurti"]

    def test_drafts_and_archived_products_are_found(self, admin):
        kurti(status=PublishStatus.DRAFT, published=False)
        factories.product(name="Kurti Archive Piece", status=PublishStatus.ARCHIVED)

        assert sorted(names(admin.get(URL, {"search": "kurti"}))) == [
            "Block Print Kurti",
            "Kurti Archive Piece",
        ]

    def test_a_status_tab_narrows_the_search(self, admin):
        kurti(status=PublishStatus.DRAFT, published=False)
        factories.product(name="Kurti Live", status=PublishStatus.ACTIVE, published=True)

        found = names(admin.get(URL, {"search": "kurti", "status": PublishStatus.DRAFT}))

        assert found == ["Block Print Kurti"]

    def test_nothing_typed_is_no_search(self, admin, shop):
        kurti()

        everything = admin.get(URL).json()["count"]

        assert admin.get(URL, {"search": "   "}).json()["count"] == everything
