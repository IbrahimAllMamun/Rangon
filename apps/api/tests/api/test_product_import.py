"""Loading a catalogue from a spreadsheet.

The import is the one operation here that can create several hundred rows from
a single click, so most of these tests are about the ways it must refuse, and
about the two properties that make it safe to run twice: it is all-or-nothing,
and re-running the same file does not double anything.
"""

from __future__ import annotations

import io
from decimal import Decimal

import pytest

from catalog.models import Brand, Category, Product, ProductVariant
from core.models import AuditLog
from inventory.models import Inventory, InventoryTransaction
from tests import factories

pytestmark = pytest.mark.django_db

IMPORT = "/api/v1/products/import/"

HEADER = "product_name,category,brand,sku,size,color,price,cost,opening_stock"


def _file(body: str, name: str = "catalogue.csv"):
    upload = io.BytesIO(body.encode("utf-8"))
    upload.name = name
    return upload


def _post(client, body: str, **extra):
    payload = {"file": _file(body), **extra}
    return client.post(IMPORT, payload, format="multipart")


def _two_kurtis() -> str:
    return (
        f"{HEADER}\n"
        "Classic Kurti,Women > Ethnic,Rangon,KUR-M-MAR,M,Maroon,1290,600,12\n"
        "Classic Kurti,Women > Ethnic,Rangon,KUR-L-MAR,L,Maroon,1290,600,8\n"
    )


@pytest.fixture
def importer(shop, auth_client):
    """A user who may both create products and receive the stock they carry."""
    return auth_client(shop["manager"])


class TestThePreviewComesFirst:
    def test_a_request_without_the_flag_only_previews(self, importer) -> None:
        """The dangerous direction must be the one you have to ask for."""
        response = _post(importer, _two_kurtis())

        assert response.status_code == 200
        assert response.json()["dry_run"] is True
        assert Product.objects.filter(name="Classic Kurti").count() == 0

    def test_the_preview_names_what_it_would_create(self, importer) -> None:
        body = _post(importer, _two_kurtis()).json()

        assert body["products_created"] == ["Classic Kurti"]
        assert sorted(body["variants_created"]) == ["KUR-L-MAR", "KUR-M-MAR"]
        assert body["stock_receipts"] == 2

    def test_the_preview_names_the_categories_it_would_invent(self, importer) -> None:
        """A typo would otherwise quietly become a new category.

        Creating missing categories is what makes a first import possible at
        all; showing the operator the list beforehand is what makes it safe.
        """
        body = _post(importer, _two_kurtis()).json()

        assert body["categories_created"] == ["Women", "Women > Ethnic"]
        assert body["brands_created"] == ["Rangon"]

    def test_a_preview_of_an_existing_catalogue_shows_updates_not_creations(self, importer) -> None:
        _post(importer, _two_kurtis(), dry_run=False)

        body = _post(importer, _two_kurtis()).json()

        assert body["products_created"] == []
        assert body["products_updated"] == ["Classic Kurti"]
        assert sorted(body["variants_updated"]) == ["KUR-L-MAR", "KUR-M-MAR"]


class TestCommitting:
    def test_it_creates_the_product_its_variants_and_their_stock(self, shop, importer) -> None:
        response = _post(importer, _two_kurtis(), dry_run=False)

        assert response.status_code == 201, response.json()
        product = Product.objects.get(name="Classic Kurti")
        assert product.variants.count() == 2
        assert product.category.name == "Ethnic"
        assert product.category.parent.name == "Women"
        assert product.brand.name == "Rangon"

        variant = ProductVariant.objects.get(sku="KUR-M-MAR")
        assert variant.price == Decimal("1290.00")
        assert variant.cost == Decimal("600.00")
        assert Inventory.objects.get(branch=shop["branch"], variant=variant).on_hand == 12

    def test_opening_stock_goes_through_the_ledger(self, shop, importer) -> None:
        """Never a column write: the figure has to say where it came from."""
        _post(importer, _two_kurtis(), dry_run=False)

        variant = ProductVariant.objects.get(sku="KUR-M-MAR")
        entry = InventoryTransaction.objects.filter(variant=variant).latest("created_at")
        assert entry.quantity == 12
        assert entry.reference_type == "product_import"
        assert "line 2" in entry.notes

    def test_the_size_and_colour_become_attributes(self, importer) -> None:
        _post(importer, _two_kurtis(), dry_run=False)

        variant = ProductVariant.objects.get(sku="KUR-M-MAR")
        values = {
            link.attribute.kind: link.attribute_value.display
            for link in variant.attribute_values.all()
        }
        assert values == {"SIZE": "M", "COLOR": "Maroon"}

    def test_it_reuses_an_existing_category_rather_than_making_a_second(self, importer) -> None:
        parent = factories.category(name="Women")
        factories.category(name="Ethnic", parent=parent)
        before = Category.objects.count()

        _post(importer, _two_kurtis(), dry_run=False)

        assert Category.objects.count() == before

    def test_matching_ignores_case(self, importer) -> None:
        factories.brand(name="Rangon")
        before = Brand.objects.count()

        _post(
            importer,
            f"{HEADER}\nKurti,Women,RANGON,K-1,M,Red,900,400,0\n",
            dry_run=False,
        )

        assert Brand.objects.count() == before

    def test_it_writes_one_audit_entry_for_the_whole_import(self, importer) -> None:
        _post(importer, _two_kurtis(), dry_run=False)

        entry = AuditLog.objects.filter(action="PRODUCT_IMPORT").latest("created_at")
        assert entry.new_values["variants_created"] == 2
        assert entry.new_values["stock_receipts"] == 2


class TestRunningItTwice:
    """A shop re-prices by editing the same spreadsheet and importing it again."""

    def test_the_second_run_updates_rather_than_duplicating(self, importer) -> None:
        _post(importer, _two_kurtis(), dry_run=False)
        repriced = _two_kurtis().replace("1290", "1490")

        response = _post(importer, repriced, dry_run=False)

        assert response.status_code == 201
        assert ProductVariant.objects.filter(sku="KUR-M-MAR").count() == 1
        assert Product.objects.filter(name="Classic Kurti").count() == 1
        assert ProductVariant.objects.get(sku="KUR-M-MAR").price == Decimal("1490.00")

    def test_the_second_run_does_not_receive_the_stock_again(self, shop, importer) -> None:
        """The failure this prevents is silent: stock doubles and nothing says so.

        Stock is a ledger, not a column, so a figure is corrected by counting
        it on /admin/inventory — where it is attributed and given a reason —
        not by re-uploading a file.
        """
        _post(importer, _two_kurtis(), dry_run=False)
        _post(importer, _two_kurtis(), dry_run=False)

        variant = ProductVariant.objects.get(sku="KUR-M-MAR")
        assert Inventory.objects.get(branch=shop["branch"], variant=variant).on_hand == 12
        assert InventoryTransaction.objects.filter(variant=variant).count() == 1


class TestWhatItRefuses:
    def test_a_file_missing_a_required_column_is_rejected_whole(self, importer) -> None:
        response = _post(importer, "product_name,sku\nKurti,K-1\n")

        assert response.status_code == 400
        assert "price" in response.json()["error"]["message"]

    def test_every_bad_cell_is_reported_not_just_the_first(self, importer) -> None:
        """Twenty round trips versus one correction pass."""
        body = _post(
            importer,
            f"{HEADER}\n"
            "Kurti,Women,Rangon,K-1,M,Red,not-a-price,400,0\n"
            "Kurti,Women,Rangon,K-2,L,Red,900,also-bad,0\n"
            "Kurti,Women,Rangon,K-3,S,Red,900,400,many\n",
        ).json()

        assert body["ok"] is False
        assert {error["column"] for error in body["errors"]} == {
            "price",
            "cost",
            "opening_stock",
        }
        assert {error["line"] for error in body["errors"]} == {2, 3, 4}

    def test_a_duplicate_sku_in_one_file_names_both_lines(self, importer) -> None:
        body = _post(
            importer,
            f"{HEADER}\n"
            "Kurti,Women,Rangon,SAME,M,Red,900,400,0\n"
            "Kurti,Women,Rangon,SAME,L,Red,900,400,0\n",
        ).json()

        assert body["ok"] is False
        assert "line 2" in body["errors"][0]["message"]

    def test_a_rejected_file_writes_nothing_at_all(self, importer) -> None:
        """All or nothing. A half-loaded catalogue cannot be safely re-run."""
        body = (
            f"{HEADER}\n"
            "Good Kurti,Women,Rangon,GOOD-1,M,Red,900,400,5\n"
            "Bad Kurti,Women,Rangon,BAD-1,L,Red,not-a-price,400,5\n"
        )

        response = _post(importer, body, dry_run=False)

        assert response.status_code == 400
        assert Product.objects.filter(name="Good Kurti").count() == 0
        assert ProductVariant.objects.filter(sku="GOOD-1").count() == 0

    def test_a_negative_price_is_refused(self, importer) -> None:
        body = _post(importer, f"{HEADER}\nKurti,Women,Rangon,K-1,M,Red,-5,400,0\n").json()

        assert body["ok"] is False
        assert body["errors"][0]["column"] == "price"

    def test_a_file_that_is_not_text_is_refused_with_an_instruction(self, importer) -> None:
        upload = io.BytesIO(b"\xff\xfe\x00\x01binary rubbish")
        upload.name = "photo.png"

        response = importer.post(IMPORT, {"file": upload}, format="multipart")

        assert response.status_code == 400
        assert "UTF-8" in str(response.json())

    def test_an_empty_file_is_refused(self, importer) -> None:
        response = _post(importer, "")

        assert response.status_code == 400


class TestWhatItForgives:
    def test_a_price_typed_the_way_a_person_types_it(self, importer) -> None:
        _post(
            importer,
            f'{HEADER}\nKurti,Women,Rangon,K-1,M,Red,"1,290",৳600,0\n',
            dry_run=False,
        )

        variant = ProductVariant.objects.get(sku="K-1")
        assert variant.price == Decimal("1290")
        assert variant.cost == Decimal("600")

    def test_a_blank_line_between_sections_is_not_an_error(self, importer) -> None:
        body = _post(
            importer,
            f"{HEADER}\nKurti,Women,Rangon,K-1,M,Red,900,400,0\n,,,,,,,,\n",
        ).json()

        assert body["ok"] is True
        assert body["variants_created"] == ["K-1"]

    def test_a_column_it_does_not_know_is_reported_rather_than_ignored_silently(
        self, importer
    ) -> None:
        """A misspelled header is how a catalogue silently imports at zero."""
        body = _post(
            importer,
            f"{HEADER},pirce\nKurti,Women,Rangon,K-1,M,Red,900,400,0,1200\n",
        ).json()

        assert body["ignored_columns"] == ["pirce"]

    def test_a_byte_order_mark_from_excel_does_not_hide_the_first_column(self, importer) -> None:
        upload = io.BytesIO(("﻿" + _two_kurtis()).encode("utf-8"))
        upload.name = "excel.csv"

        response = importer.post(IMPORT, {"file": upload}, format="multipart")

        assert response.status_code == 200, response.json()
        assert response.json()["ok"] is True


class TestWhoMayDoIt:
    def test_a_cashier_may_not_import_a_catalogue(self, shop, auth_client) -> None:
        response = _post(auth_client(shop["cashier"]), _two_kurtis(), dry_run=False)

        assert response.status_code == 403
        assert Product.objects.filter(name="Classic Kurti").count() == 0

    def test_an_anonymous_request_is_refused(self, api) -> None:
        response = _post(api, _two_kurtis())

        assert response.status_code in (401, 403)

    def test_an_owner_may(self, shop, auth_client) -> None:
        response = _post(auth_client(shop["owner"]), _two_kurtis(), dry_run=False)

        assert response.status_code == 201, response.json()
