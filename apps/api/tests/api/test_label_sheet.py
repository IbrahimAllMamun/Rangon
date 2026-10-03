"""The barcode label sheet: every variant of a product, its stock, and its tick.

`GET /products/{id}/labels/` answers the question the label screen asks when a
variant is scanned: which *other* sizes and colours of this product are there,
how many of each does this branch hold (the hint for how many stickers to
print), and which have already been printed. `POST` ticks variants off.

The marks are the part that must not be lost, so most of what is pinned here is
about that: an un-mark is a new row rather than a deletion, the rows refuse to
be edited, and a variant with marks is archived rather than deleted.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from accounts.permissions import RoleCode
from catalog.models import ProductVariant, PublishStatus
from core.models import AppendOnlyError
from inventory import services as inventory_services
from inventory.labels import LabelMark, mark_labels
from inventory.models import LabelPrint
from tests import factories

pytestmark = pytest.mark.django_db


def _url(product: Any) -> str:
    return f"/api/v1/products/{product.pk}/labels/"


def _by_sku(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row["sku"]: row for row in payload["variants"]}


def _mark(client: Any, product: Any, *marks: dict[str, Any], **body: Any) -> Any:
    return client.post(_url(product), {"marks": list(marks), **body}, format="json")


class TestTheSheetListsEveryVariant:
    def test_it_lists_the_whole_product_with_stock_at_the_branch(self, shop, auth_client) -> None:
        small, medium = shop["variants"]
        unstocked = factories.variant(shop["product"], barcode=None)

        response = auth_client(shop["owner"]).get(_url(shop["product"]))

        assert response.status_code == 200
        body = response.json()
        assert body["product"]["id"] == str(shop["product"].pk)
        assert body["branch"]["id"] == str(shop["branch"].pk)
        rows = _by_sku(body)
        assert set(rows) == {small.sku, medium.sku, unstocked.sku}
        assert rows[small.sku]["stock"]["on_hand"] == 10
        assert rows[medium.sku]["stock"]["on_hand"] == 5
        # Never stocked reads as zero, not as missing.
        assert rows[unstocked.sku]["stock"]["on_hand"] == 0
        # The attributes come down, for the "Size M" lines on the sticker.
        assert rows[small.sku]["attributes"][0]["label"] == "S"

    def test_unmarked_variants_suggest_one_label_per_unit(self, shop, auth_client) -> None:
        small, medium = shop["variants"]

        rows = _by_sku(auth_client(shop["owner"]).get(_url(shop["product"])).json())

        assert rows[small.sku]["label_status"] is None
        assert rows[small.sku]["suggested_labels"] == 10
        assert rows[medium.sku]["suggested_labels"] == 5

    def test_another_products_variants_are_not_on_it(self, shop, auth_client) -> None:
        stranger = factories.variant(factories.product())

        rows = _by_sku(auth_client(shop["owner"]).get(_url(shop["product"])).json())

        assert stranger.sku not in rows

    def test_the_query_count_does_not_grow_with_the_variants(
        self, shop, auth_client, django_assert_max_num_queries
    ) -> None:
        """A product with a large size x colour matrix is the normal case."""
        client = auth_client(shop["owner"])
        for variant in shop["variants"]:
            mark_labels(
                branch=shop["branch"],
                product=shop["product"],
                marks=[LabelMark(variant_id=variant.pk, printed=True, quantity=3)],
                actor=shop["owner"],
            )
        for _ in range(12):
            factories.stock(factories.variant(shop["product"]), shop["branch"], 2)

        with django_assert_max_num_queries(12):
            response = client.get(_url(shop["product"]))

        assert len(response.json()["variants"]) == 14


class TestMarkingAVariantPrinted:
    def test_marking_records_who_how_many_and_the_stock_then(self, shop, auth_client) -> None:
        small, _ = shop["variants"]

        response = _mark(
            auth_client(shop["owner"]),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 10},
        )

        assert response.status_code == 200
        row = _by_sku(response.json())[small.sku]
        status = row["label_status"]
        assert status["printed"] is True
        assert status["quantity"] == 10
        assert status["on_hand"] == 10
        assert status["marked_by"] == shop["owner"].full_name
        assert status["received_since"] == 0
        # Done, so nothing more to print until more stock arrives.
        assert row["suggested_labels"] == 0

    def test_the_stock_figure_is_the_servers_not_the_browsers(self, shop, auth_client) -> None:
        """CLAUDE.md section 3.4: a stock level sent by the client is ignored."""
        small, _ = shop["variants"]

        _mark(
            auth_client(shop["owner"]),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 1, "on_hand": 999},
        )

        assert LabelPrint.objects.get(variant=small).on_hand == 10

    def test_a_whole_sheet_can_be_marked_in_one_request(self, shop, auth_client) -> None:
        small, medium = shop["variants"]

        response = _mark(
            auth_client(shop["owner"]),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 10},
            {"variant": str(medium.pk), "printed": True, "quantity": 5},
        )

        rows = _by_sku(response.json())
        assert rows[small.sku]["label_status"]["printed"] is True
        assert rows[medium.sku]["label_status"]["printed"] is True

    def test_more_stock_arriving_reopens_a_printed_variant(self, shop, auth_client) -> None:
        """Twelve labelled, then a delivery: the delivery has no stickers."""
        small, _ = shop["variants"]
        client = auth_client(shop["owner"])
        _mark(client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 10})

        factories.stock(small, shop["branch"], 7)

        row = _by_sku(client.get(_url(shop["product"])).json())[small.sku]
        assert row["label_status"]["printed"] is True
        assert row["label_status"]["received_since"] == 7
        assert row["suggested_labels"] == 7

    def test_what_sold_since_needs_no_sticker(self, shop, auth_client) -> None:
        small, _ = shop["variants"]
        client = auth_client(shop["owner"])
        _mark(client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 10})
        factories.stock(small, shop["branch"], 4)
        # Thirteen of the fourteen sell: one left, so one sticker at most.
        inventory_services.sell(branch=shop["branch"], lines=[(small.pk, 13)])

        row = _by_sku(client.get(_url(shop["product"])).json())[small.sku]
        assert row["label_status"]["received_since"] == 4
        assert row["suggested_labels"] == 1

    def test_a_transfer_in_arrives_already_labelled(self, shop, auth_client) -> None:
        small, _ = shop["variants"]
        other = factories.branch(shop["organization"])
        factories.stock(small, other, 6)
        client = auth_client(shop["owner"])
        _mark(client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 10})

        inventory_services.transfer(
            source_branch=other, target_branch=shop["branch"], lines=[(small.pk, 6)]
        )

        row = _by_sku(client.get(_url(shop["product"])).json())[small.sku]
        assert row["stock"]["on_hand"] == 16
        assert row["label_status"]["received_since"] == 0
        assert row["suggested_labels"] == 0

    def test_marking_again_after_a_delivery_closes_it(self, shop, auth_client) -> None:
        small, _ = shop["variants"]
        client = auth_client(shop["owner"])
        _mark(client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 10})
        factories.stock(small, shop["branch"], 7)

        response = _mark(
            client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 7}
        )

        row = _by_sku(response.json())[small.sku]
        assert row["label_status"]["received_since"] == 0
        assert row["label_status"]["on_hand"] == 17
        assert row["suggested_labels"] == 0


class TestNothingMarkedIsLost:
    def test_unmarking_appends_a_row_and_deletes_none(self, shop, auth_client) -> None:
        small, _ = shop["variants"]
        client = auth_client(shop["owner"])
        _mark(client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 10})

        response = _mark(
            client, shop["product"], {"variant": str(small.pk), "printed": False, "quantity": 10}
        )

        row = _by_sku(response.json())[small.sku]
        assert row["label_status"]["printed"] is False
        # An un-mark printed nothing, whatever the request said.
        assert row["label_status"]["quantity"] == 0
        assert row["suggested_labels"] == 10
        history = list(LabelPrint.objects.filter(variant=small).order_by("created_at"))
        assert [entry.printed for entry in history] == [True, False]
        assert history[0].quantity == 10

    def test_a_mark_cannot_be_edited(self, shop) -> None:
        small, _ = shop["variants"]
        (mark,) = mark_labels(
            branch=shop["branch"],
            product=shop["product"],
            marks=[LabelMark(variant_id=small.pk, printed=True, quantity=10)],
        )

        mark.quantity = 3
        with pytest.raises(AppendOnlyError):
            mark.save()

    def test_a_mark_cannot_be_deleted(self, shop) -> None:
        small, _ = shop["variants"]
        (mark,) = mark_labels(
            branch=shop["branch"],
            product=shop["product"],
            marks=[LabelMark(variant_id=small.pk, printed=True, quantity=10)],
        )

        with pytest.raises(AppendOnlyError):
            mark.delete()
        assert LabelPrint.objects.filter(pk=mark.pk).exists()

    def test_a_labelled_variant_is_archived_not_deleted(self, shop, auth_client) -> None:
        """No stock and no sales, so it would otherwise be hard-deleted --
        and the stickers already on the rail would scan as nothing."""
        clean = factories.variant(shop["product"])
        mark_labels(
            branch=shop["branch"],
            product=shop["product"],
            marks=[LabelMark(variant_id=clean.pk, printed=True, quantity=2)],
        )

        response = auth_client(shop["owner"]).delete(f"/api/v1/variants/{clean.pk}/")

        assert response.status_code == 204
        clean.refresh_from_db()
        assert clean.status == PublishStatus.ARCHIVED
        assert LabelPrint.objects.filter(variant=clean).exists()

    def test_a_product_with_labelled_variants_is_archived_not_deleted(
        self, shop, auth_client
    ) -> None:
        product = factories.product()
        variant = factories.variant(product)
        mark_labels(
            branch=shop["branch"],
            product=product,
            marks=[LabelMark(variant_id=variant.pk, printed=True, quantity=2)],
        )

        response = auth_client(shop["owner"]).delete(f"/api/v1/products/{product.pk}/")

        assert response.status_code == 204
        product.refresh_from_db()
        assert product.status == PublishStatus.ARCHIVED
        assert ProductVariant.objects.filter(pk=variant.pk).exists()
        assert LabelPrint.objects.filter(variant=variant).exists()


class TestRefusals:
    def test_a_variant_of_another_product_writes_nothing(self, shop, auth_client) -> None:
        """All or nothing: the good mark beside the stray one is not kept."""
        small, _ = shop["variants"]
        stranger = factories.variant(factories.product())

        response = _mark(
            auth_client(shop["owner"]),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 1},
            {"variant": str(stranger.pk), "printed": True, "quantity": 1},
        )

        assert response.status_code == 400
        assert response.json()["error"]["details"]["variants"] == [str(stranger.pk)]
        assert not LabelPrint.objects.exists()

    def test_the_same_variant_twice_in_one_request(self, shop, auth_client) -> None:
        small, _ = shop["variants"]
        mark = {"variant": str(small.pk), "printed": True, "quantity": 1}

        response = _mark(auth_client(shop["owner"]), shop["product"], mark, mark)

        assert response.status_code == 400
        assert not LabelPrint.objects.exists()

    def test_an_empty_request(self, shop, auth_client) -> None:
        response = _mark(auth_client(shop["owner"]), shop["product"])

        assert response.status_code == 400

    @pytest.mark.parametrize("quantity", [-1, 501])
    def test_a_quantity_out_of_range(self, shop, auth_client, quantity: int) -> None:
        small, _ = shop["variants"]

        response = _mark(
            auth_client(shop["owner"]),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": quantity},
        )

        assert response.status_code == 400
        assert not LabelPrint.objects.exists()


class TestWhoMay:
    def test_a_cashier_may_read_the_sheet(self, shop, auth_client) -> None:
        """`products.view`, the same as reaching the label screen at all."""
        response = auth_client(shop["cashier"]).get(_url(shop["product"]))

        assert response.status_code == 200

    def test_a_cashier_may_not_mark(self, shop, auth_client) -> None:
        small, _ = shop["variants"]

        response = _mark(
            auth_client(shop["cashier"]),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 1},
        )

        assert response.status_code == 403
        assert not LabelPrint.objects.exists()

    def test_an_inventory_manager_may_mark(self, shop, auth_client) -> None:
        """The role that receives and labels stock."""
        small, _ = shop["variants"]
        staff = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])

        response = _mark(
            auth_client(staff),
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 1},
        )

        assert response.status_code == 200
        assert LabelPrint.objects.get().created_by == staff


class TestBranches:
    def test_a_mark_belongs_to_the_branch_that_printed(self, shop, auth_client) -> None:
        """One shop's twelve stickers say nothing about the other shop's five."""
        small, _ = shop["variants"]
        other = factories.branch(shop["organization"])
        factories.stock(small, other, 5, unit_cost=Decimal("400.00"))
        client = auth_client(shop["owner"])
        _mark(client, shop["product"], {"variant": str(small.pk), "printed": True, "quantity": 10})

        elsewhere = client.get(_url(shop["product"]), {"branch": str(other.pk)}).json()

        assert elsewhere["branch"]["id"] == str(other.pk)
        row = _by_sku(elsewhere)[small.sku]
        assert row["label_status"] is None
        assert row["stock"]["on_hand"] == 5
        assert row["suggested_labels"] == 5

    def test_staff_cannot_read_or_mark_another_branch(self, shop, auth_client) -> None:
        small, _ = shop["variants"]
        other = factories.branch(shop["organization"])
        staff = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])
        client = auth_client(staff)

        read = client.get(_url(shop["product"]), {"branch": str(other.pk)})
        write = _mark(
            client,
            shop["product"],
            {"variant": str(small.pk), "printed": True, "quantity": 1},
            branch=str(other.pk),
        )

        assert read.status_code == 403
        assert write.status_code == 403
        assert not LabelPrint.objects.exists()
