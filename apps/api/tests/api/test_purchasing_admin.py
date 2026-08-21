"""The sequence the admin purchasing screens perform.

Create a supplier, raise a purchase order, send it, receive it — in one or
several deliveries — and confirm the stock arrived through the ledger rather
than onto a column (CLAUDE.md §3.2, ADR-0008).

Also covers `unique_supplier_code`: `Supplier.code` is unique with no default,
so before this the admin form would have had to ask a buyer to invent an
identifier, and two people would eventually invent the same one.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from inventory.models import TransactionType
from purchasing.models import PurchaseOrderStatus, Supplier
from purchasing.services import unique_supplier_code
from tests import factories

pytestmark = pytest.mark.django_db


class TestSupplierCode:
    def test_code_is_derived_from_the_name(self, owner: Any, auth_client: Any) -> None:
        response = auth_client(owner).post(
            "/api/v1/suppliers/", {"name": "Dhaka Textile Mills"}, format="json"
        )

        assert response.status_code == 201
        assert response.data["code"] == "DHAKA-TEXTILE-MILLS"

    def test_a_supplied_code_is_kept(self, owner: Any, auth_client: Any) -> None:
        response = auth_client(owner).post(
            "/api/v1/suppliers/", {"name": "Dhaka Textile Mills", "code": "DTM-01"}, format="json"
        )

        assert response.status_code == 201
        assert response.data["code"] == "DTM-01"

    def test_two_suppliers_with_the_same_name_get_different_codes(
        self, owner: Any, auth_client: Any
    ) -> None:
        client = auth_client(owner)
        first = client.post("/api/v1/suppliers/", {"name": "Karim Traders"}, format="json")
        second = client.post("/api/v1/suppliers/", {"name": "Karim Traders"}, format="json")

        assert first.data["code"] != second.data["code"]
        assert second.data["code"] == "KARIM-TRADERS-2"

    def test_generated_code_fits_the_column(self) -> None:
        # max_length=32. A long name must not produce a value the database
        # truncates or refuses.
        code = unique_supplier_code("A Very Long Supplier Name That Exceeds The Column Width")
        assert len(code) <= 32

    def test_a_nameless_supplier_still_gets_a_code(self) -> None:
        assert unique_supplier_code("") == "SUPPLIER"
        assert unique_supplier_code("!!!") == "SUPPLIER"

    def test_editing_a_supplier_does_not_regenerate_its_code(
        self, owner: Any, auth_client: Any
    ) -> None:
        client = auth_client(owner)
        created = client.post("/api/v1/suppliers/", {"name": "Karim Traders"}, format="json")
        original = created.data["code"]

        updated = client.patch(
            f"/api/v1/suppliers/{created.data['id']}/", {"name": "Karim Brothers"}, format="json"
        )

        assert updated.status_code == 200
        assert updated.data["code"] == original

    def test_creating_a_supplier_needs_the_permission(self, cashier: Any, auth_client: Any) -> None:
        response = auth_client(cashier).post(
            "/api/v1/suppliers/", {"name": "Nope Traders"}, format="json"
        )

        assert response.status_code == 403
        assert not Supplier.objects.filter(name="Nope Traders").exists()


class TestPurchaseOrderFlow:
    def test_create_send_and_receive_in_full(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        client = auth_client(owner)
        supplier = factories.supplier()
        variant = factories.variant(price="1200.00", cost="0.00")

        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 10, "unit_cost": "450.00"}],
                "shipping_total": "120.00",
                "invoice_number": "INV-9001",
            },
            format="json",
        )
        assert created.status_code == 201
        assert created.data["status"] == PurchaseOrderStatus.DRAFT
        # 10 x 450 + 120 shipping
        assert Decimal(created.data["grand_total"]) == Decimal("4620.00")
        order_id = created.data["id"]
        item_id = created.data["items"][0]["id"]

        sent = client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")
        assert sent.status_code == 200
        assert sent.data["status"] == PurchaseOrderStatus.SENT

        received = client.post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 10}]},
            format="json",
        )
        assert received.status_code == 201
        assert received.data["purchase_order"]["status"] == PurchaseOrderStatus.RECEIVED

        # The goods arrived through the ledger, not onto a column.
        variant.refresh_from_db()
        assert variant.inventory.get(branch=branch).on_hand == 10
        assert (
            variant.inventory_transactions.filter(transaction_type=TransactionType.PURCHASE).count()
            == 1
        )

    def test_partial_receipt_leaves_the_order_open(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        client = auth_client(owner)
        supplier = factories.supplier()
        variant = factories.variant()

        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 10, "unit_cost": "450.00"}],
            },
            format="json",
        )
        order_id = created.data["id"]
        item_id = created.data["items"][0]["id"]
        client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")

        first = client.post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 4}]},
            format="json",
        )
        assert first.data["purchase_order"]["status"] == PurchaseOrderStatus.PARTIALLY_RECEIVED
        assert first.data["purchase_order"]["items"][0]["quantity_outstanding"] == 6

        second = client.post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 6}]},
            format="json",
        )
        assert second.data["purchase_order"]["status"] == PurchaseOrderStatus.RECEIVED
        assert variant.inventory.get(branch=branch).on_hand == 10

    def test_receiving_more_than_ordered_is_refused(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        """The screen guards this client-side; the API must refuse it anyway."""
        client = auth_client(owner)
        supplier = factories.supplier()
        variant = factories.variant()

        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 5, "unit_cost": "100.00"}],
            },
            format="json",
        )
        order_id = created.data["id"]
        item_id = created.data["items"][0]["id"]
        client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")

        response = client.post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 6}]},
            format="json",
        )

        assert response.status_code >= 400
        assert variant.inventory.filter(branch=branch, on_hand__gt=5).count() == 0

    def test_a_delivered_cost_moves_the_weighted_average(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        """The receive dialog may correct the cost; that figure drives ADR-0006."""
        client = auth_client(owner)
        supplier = factories.supplier()
        variant = factories.variant()
        factories.stock(variant, branch, 10, unit_cost="400.00")

        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 10, "unit_cost": "400.00"}],
            },
            format="json",
        )
        order_id = created.data["id"]
        item_id = created.data["items"][0]["id"]
        client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")

        # Goods actually arrived dearer than ordered.
        client.post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 10, "unit_cost": "500.00"}]},
            format="json",
        )

        inventory = variant.inventory.get(branch=branch)
        assert inventory.on_hand == 20
        # (10 @ 400 + 10 @ 500) / 20
        assert inventory.average_cost == Decimal("450.0000")

    def test_sending_twice_is_refused(self, owner: Any, auth_client: Any) -> None:
        client = auth_client(owner)
        supplier = factories.supplier()
        variant = factories.variant()

        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 1, "unit_cost": "10.00"}],
            },
            format="json",
        )
        order_id = created.data["id"]

        assert (
            client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json").status_code
            == 200
        )
        second = client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")

        assert second.status_code == 409
        assert second.data["error"]["code"] == "CONFLICT"

    def test_an_order_needs_at_least_one_line(self, owner: Any, auth_client: Any) -> None:
        supplier = factories.supplier()

        response = auth_client(owner).post(
            "/api/v1/purchase-orders/",
            {"supplier": str(supplier.pk), "lines": []},
            format="json",
        )

        assert response.status_code == 400

    def test_receiving_needs_the_receive_permission(
        self, cashier: Any, owner: Any, auth_client: Any
    ) -> None:
        owner_client = auth_client(owner)
        supplier = factories.supplier()
        variant = factories.variant()
        created = owner_client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 2, "unit_cost": "50.00"}],
            },
            format="json",
        )
        order_id = created.data["id"]
        item_id = created.data["items"][0]["id"]
        owner_client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")

        response = auth_client(cashier).post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 2}]},
            format="json",
        )

        assert response.status_code == 403


class TestPickerSearch:
    """The purchasing screens search for suppliers and variants.

    Both `?search=` filters were declared but inert until SearchFilter was named
    on the viewsets — it is not one of the global DEFAULT_FILTER_BACKENDS.
    """

    def test_suppliers_can_be_searched_by_name(self, owner: Any, auth_client: Any) -> None:
        factories.supplier(name="Dhaka Textile Mills")
        factories.supplier(name="Chittagong Leather")

        response = auth_client(owner).get("/api/v1/suppliers/?search=Dhaka")

        names = [row["name"] for row in response.data["results"]]
        assert names == ["Dhaka Textile Mills"]

    def test_variants_can_be_searched_by_sku_and_product_name(
        self, owner: Any, auth_client: Any
    ) -> None:
        product = factories.product(name="Oxford Shirt")
        wanted = factories.variant(product, sku="RGN-OXF-BLK-M")
        factories.variant(factories.product(name="Denim Jacket"), sku="RGN-DNM-BLU-L")
        client = auth_client(owner)

        by_sku = client.get("/api/v1/variants/?search=RGN-OXF")
        by_name = client.get("/api/v1/variants/?search=Oxford")

        assert [row["id"] for row in by_sku.data["results"]] == [str(wanted.pk)]
        assert [row["id"] for row in by_name.data["results"]] == [str(wanted.pk)]

    def test_variant_search_finds_a_draft_product(self, owner: Any, auth_client: Any) -> None:
        """A buyer orders stock for products that are not on sale yet.

        The POS grid search filters to ACTIVE products, which is why purchasing
        cannot reuse it.
        """
        draft = factories.product(name="Unreleased Coat", published=False, status="DRAFT")
        variant = factories.variant(draft, sku="RGN-COAT-1")

        response = auth_client(owner).get("/api/v1/variants/?search=Unreleased")

        assert [row["id"] for row in response.data["results"]] == [str(variant.pk)]
