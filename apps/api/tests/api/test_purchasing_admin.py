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


class TestSupplierPaymentApi:
    """Paying a supplier from the purchase-order screen (business-rules.md §6b.1b)."""

    def _sent_order(self, client: Any, supplier: Any, total: str = "1000.00") -> str:
        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [
                    {
                        "variant": str(factories.variant(cost="0.00").pk),
                        "quantity": 1,
                        "unit_cost": total,
                    }
                ],
            },
            format="json",
        )
        assert created.status_code == 201
        order_id = created.data["id"]
        client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")
        return str(order_id)

    def test_a_payment_advances_the_order(self, owner: Any, auth_client: Any) -> None:
        client = auth_client(owner)
        supplier = factories.supplier()
        order_id = self._sent_order(client, supplier)

        response = client.post(
            "/api/v1/supplier-payments/",
            {
                "supplier": str(supplier.pk),
                "purchase_order": order_id,
                "amount": "400.00",
                "method": "BANK",
            },
            format="json",
        )

        assert response.status_code == 201
        detail = client.get(f"/api/v1/purchase-orders/{order_id}/")
        assert Decimal(detail.data["paid_total"]) == Decimal("400.00")
        assert detail.data["payment_status"] == "PARTIALLY_PAID"

    def test_overpaying_is_refused_in_the_error_envelope(
        self, owner: Any, auth_client: Any
    ) -> None:
        client = auth_client(owner)
        supplier = factories.supplier()
        order_id = self._sent_order(client, supplier)

        response = client.post(
            "/api/v1/supplier-payments/",
            {
                "supplier": str(supplier.pk),
                "purchase_order": order_id,
                "amount": "1500.00",
                "method": "BANK",
            },
            format="json",
        )

        assert response.status_code == 422
        assert response.data["error"]["code"] == "PAYMENT_EXCEEDS_OUTSTANDING"
        assert response.data["error"]["details"]["outstanding"] == "1000.00"

    def test_the_same_idempotency_key_header_pays_once(self, owner: Any, auth_client: Any) -> None:
        client = auth_client(owner)
        supplier = factories.supplier()
        order_id = self._sent_order(client, supplier)
        body = {
            "supplier": str(supplier.pk),
            "purchase_order": order_id,
            "amount": "400.00",
            "method": "BANK",
        }

        first = client.post(
            "/api/v1/supplier-payments/", body, format="json", HTTP_IDEMPOTENCY_KEY="pay-once"
        )
        second = client.post(
            "/api/v1/supplier-payments/", body, format="json", HTTP_IDEMPOTENCY_KEY="pay-once"
        )

        assert first.status_code == 201
        assert second.data["id"] == first.data["id"]
        detail = client.get(f"/api/v1/purchase-orders/{order_id}/")
        assert Decimal(detail.data["paid_total"]) == Decimal("400.00")

    def test_paying_another_suppliers_order_is_refused(self, owner: Any, auth_client: Any) -> None:
        client = auth_client(owner)
        order_id = self._sent_order(client, factories.supplier())

        response = client.post(
            "/api/v1/supplier-payments/",
            {
                "supplier": str(factories.supplier().pk),
                "purchase_order": order_id,
                "amount": "100.00",
                "method": "CASH",
            },
            format="json",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        # Assert on the guard's own details, so this cannot pass because some
        # unrelated field failed validation.
        assert "payment_supplier" in response.data["error"]["details"]

    def test_paying_needs_the_pay_permission(
        self, cashier: Any, owner: Any, auth_client: Any
    ) -> None:
        supplier = factories.supplier()
        order_id = self._sent_order(auth_client(owner), supplier)

        response = auth_client(cashier).post(
            "/api/v1/supplier-payments/",
            {
                "supplier": str(supplier.pk),
                "purchase_order": order_id,
                "amount": "100.00",
                "method": "CASH",
            },
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


class TestSupplierProductEndpoint:
    """`/api/v1/supplier-products/` — the supplier price list.

    The endpoint the purchase order form asks "what does *this* supplier charge
    for these variants", instead of defaulting every line to the last price paid
    to anyone.
    """

    def _offer(self, supplier: Any, variant: Any, **kwargs: Any) -> Any:
        from purchasing.models import SupplierProduct

        return SupplierProduct.objects.create(
            supplier=supplier, variant=variant, **{"last_cost": Decimal("400.00"), **kwargs}
        )

    def test_a_buyer_can_record_a_quote_before_ordering(self, owner: Any, auth_client: Any) -> None:
        variant = factories.variant()
        supplier = factories.supplier()

        response = auth_client(owner).post(
            "/api/v1/supplier-products/",
            {
                "supplier": str(supplier.pk),
                "variant": str(variant.pk),
                "last_cost": "375.00",
                "supplier_sku": "MILL-88",
                "minimum_order_quantity": 12,
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["last_cost"] == "375.00"
        assert response.data["supplier_sku"] == "MILL-88"
        # Never promoted implicitly through the API — that is `set-preferred/`.
        assert response.data["is_preferred"] is False

    def test_the_same_supplier_cannot_be_priced_twice_for_one_variant(
        self, owner: Any, auth_client: Any
    ) -> None:
        variant, supplier = factories.variant(), factories.supplier()
        self._offer(supplier, variant)

        response = auth_client(owner).post(
            "/api/v1/supplier-products/",
            {"supplier": str(supplier.pk), "variant": str(variant.pk), "last_cost": "1.00"},
            format="json",
        )

        # A sentence, not an IntegrityError surfacing as a 500.
        assert response.status_code == 400, response.data
        assert "already" in str(response.data).lower()

    def test_is_preferred_cannot_be_set_by_patching_it(self, owner: Any, auth_client: Any) -> None:
        """Writable, it would hit the partial unique index as a 500."""
        variant = factories.variant()
        first = self._offer(factories.supplier(), variant, is_preferred=True)
        second = self._offer(factories.supplier(), variant, last_cost=Decimal("250.00"))

        response = auth_client(owner).patch(
            f"/api/v1/supplier-products/{second.pk}/", {"is_preferred": True}, format="json"
        )

        assert response.status_code == 200, response.data
        second.refresh_from_db()
        first.refresh_from_db()
        assert second.is_preferred is False
        assert first.is_preferred is True

    def test_set_preferred_moves_it_and_demotes_the_incumbent(
        self, owner: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        first = self._offer(factories.supplier(), variant, is_preferred=True)
        second = self._offer(factories.supplier(), variant, last_cost=Decimal("250.00"))

        response = auth_client(owner).post(
            f"/api/v1/supplier-products/{second.pk}/set-preferred/", {}, format="json"
        )

        assert response.status_code == 200, response.data
        assert response.data["is_preferred"] is True
        first.refresh_from_db()
        assert first.is_preferred is False

    def test_the_list_can_be_narrowed_to_one_supplier(self, owner: Any, auth_client: Any) -> None:
        """How the purchase order form loads one supplier's prices in one request."""
        variant_a, variant_b = factories.variant(), factories.variant()
        mine, theirs = factories.supplier(), factories.supplier()
        self._offer(mine, variant_a, last_cost=Decimal("100.00"))
        self._offer(mine, variant_b, last_cost=Decimal("200.00"))
        self._offer(theirs, variant_a, last_cost=Decimal("999.00"))

        response = auth_client(owner).get(f"/api/v1/supplier-products/?supplier={mine.pk}")

        assert response.status_code == 200
        costs = sorted(row["last_cost"] for row in response.data["results"])
        assert costs == ["100.00", "200.00"]

    def test_the_list_shows_every_supplier_of_one_variant_preferred_first(
        self, owner: Any, auth_client: Any
    ) -> None:
        """How the product screen answers "who sells us this"."""
        variant = factories.variant()
        self._offer(factories.supplier(), variant, last_cost=Decimal("250.00"))
        self._offer(factories.supplier(), variant, last_cost=Decimal("400.00"), is_preferred=True)

        response = auth_client(owner).get(f"/api/v1/supplier-products/?variant={variant.pk}")

        assert response.status_code == 200
        rows = response.data["results"]
        assert len(rows) == 2
        assert rows[0]["is_preferred"] is True

    def test_one_request_covers_every_variant_of_a_product(
        self, owner: Any, auth_client: Any
    ) -> None:
        """`?product=` — the product screen, without a request per variant."""
        product = factories.product()
        first = factories.variant(product)
        second = factories.variant(product)
        elsewhere = factories.variant()
        supplier = factories.supplier()
        self._offer(supplier, first)
        self._offer(supplier, second, last_cost=Decimal("500.00"))
        self._offer(supplier, elsewhere, last_cost=Decimal("999.00"))

        response = auth_client(owner).get(f"/api/v1/supplier-products/?product={product.pk}")

        assert response.status_code == 200
        skus = {row["sku"] for row in response.data["results"]}
        assert skus == {first.sku, second.sku}

    def test_a_cashier_cannot_read_or_change_supplier_prices(
        self, cashier: Any, auth_client: Any
    ) -> None:
        variant, supplier = factories.variant(), factories.supplier()
        offer = self._offer(supplier, variant)
        client = auth_client(cashier)

        assert client.get("/api/v1/supplier-products/").status_code == 403
        assert (
            client.post(
                f"/api/v1/supplier-products/{offer.pk}/set-preferred/", {}, format="json"
            ).status_code
            == 403
        )


class TestUnpublishedProductsOnAnOrder:
    """What the receipt screen reads to say "these arrived and nobody can buy them".

    A buyer can create a product from the order that is buying it, and those are
    `DRAFT` with the retail price deliberately deferred (business-rules.md
    § 7a.6). Nothing used to say so afterwards: the goods arrived, the draft sat
    there, and the only way to notice was to go looking.
    """

    def _order_with(self, owner: Any, auth_client: Any, variant: Any) -> Any:
        client = auth_client(owner)
        supplier = client.post("/api/v1/suppliers/", {"name": "Mills"}, format="json").data
        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": supplier["id"],
                "lines": [{"variant": str(variant.pk), "quantity": 5, "unit_cost": "100.00"}],
            },
            format="json",
        )
        assert created.status_code == 201, created.data
        return client, created.data["id"]

    def test_a_draft_product_on_the_order_is_reported(self, owner: Any, auth_client: Any) -> None:
        product = factories.product(published=False, status="DRAFT")
        variant = factories.variant(product, price="0.00")
        client, order_id = self._order_with(owner, auth_client, variant)

        response = client.get(f"/api/v1/purchase-orders/{order_id}/")

        rows = response.data["unpublished_products"]
        assert [row["name"] for row in rows] == [product.name]
        # Priced at zero, so publishing it would give the stock away (D75).
        assert rows[0]["can_publish"] is False
        assert rows[0]["priced_variant_count"] == 0

    def test_pricing_a_variant_makes_it_publishable(self, owner: Any, auth_client: Any) -> None:
        """`can_publish` must agree with what the endpoint would actually do."""
        product = factories.product(published=False, status="DRAFT")
        variant = factories.variant(product, price="1290.00")
        client, order_id = self._order_with(owner, auth_client, variant)

        rows = client.get(f"/api/v1/purchase-orders/{order_id}/").data["unpublished_products"]
        assert rows[0]["can_publish"] is True

        # The screen offers it; the API must honour that.
        published = client.post(f"/api/v1/products/{product.pk}/publish/", {}, format="json")
        assert published.status_code == 200, published.data

    def test_a_product_already_live_is_not_reported(self, owner: Any, auth_client: Any) -> None:
        product = factories.product(published=True, status="ACTIVE")
        variant = factories.variant(product, price="500.00")
        client, order_id = self._order_with(owner, auth_client, variant)

        response = client.get(f"/api/v1/purchase-orders/{order_id}/")

        assert response.data["unpublished_products"] == []

    def test_a_product_unpublished_long_ago_is_reported_too(
        self, owner: Any, auth_client: Any
    ) -> None:
        """Not only the ones created from this order.

        A product someone hid last month is equally invisible to a shopper, and
        equally worth flagging when its stock lands.
        """
        product = factories.product(published=False, status="ACTIVE")
        variant = factories.variant(product, price="500.00")
        client, order_id = self._order_with(owner, auth_client, variant)

        rows = client.get(f"/api/v1/purchase-orders/{order_id}/").data["unpublished_products"]
        assert [row["name"] for row in rows] == [product.name]
        assert rows[0]["can_publish"] is True

    def test_a_product_is_listed_once_however_many_of_its_variants_are_ordered(
        self, owner: Any, auth_client: Any
    ) -> None:
        """Twelve lines for a shirt in three colours and four sizes is one product."""
        product = factories.product(published=False, status="DRAFT")
        first = factories.variant(product, price="0.00")
        second = factories.variant(product, price="0.00")

        client = auth_client(owner)
        supplier = client.post("/api/v1/suppliers/", {"name": "Mills"}, format="json").data
        created = client.post(
            "/api/v1/purchase-orders/",
            {
                "supplier": supplier["id"],
                "lines": [
                    {"variant": str(first.pk), "quantity": 5, "unit_cost": "100.00"},
                    {"variant": str(second.pk), "quantity": 5, "unit_cost": "100.00"},
                ],
            },
            format="json",
        )
        rows = client.get(f"/api/v1/purchase-orders/{created.data['id']}/").data[
            "unpublished_products"
        ]

        assert len(rows) == 1
        assert rows[0]["variant_count"] == 2
