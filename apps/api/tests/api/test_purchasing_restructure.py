"""Goods enter through purchasing, and purchasing can now do the whole job.

The owner observed on 2026-09-17 that adding a product and raising a purchase
order did the same job twice. The product form's half is gone (D72); these are
the three things that let the purchase order do all of it:

* a product created on the order, variants and all, in one step;
* goods that have already arrived, received in the same step that records them;
* the supplier's own last price, derived from what was actually paid them.

See business-rules §4.0b.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from django.utils import timezone

from accounts.models import Permission, Role, RoleCode
from catalog.models import Product, ProductVariant, PublishStatus
from finance.selectors import payables
from inventory.models import Inventory, TransactionType
from purchasing import services as purchasing_services
from purchasing.models import PurchaseOrder, PurchaseOrderStatus, PurchaseReceipt
from purchasing.services import PurchaseLine
from tests import factories

pytestmark = pytest.mark.django_db


def _quick(client: Any, **payload: Any) -> Any:
    return client.post("/api/v1/products/quick-create/", payload, format="json")


@pytest.fixture
def axes() -> dict[str, Any]:
    size, _ = factories.attribute("size", name="Size", values=["S", "M", "L"])
    colour, _ = factories.attribute("color", name="Colour", values=["Black", "Navy"])
    material, _ = factories.attribute("material", name="Material", values=["Cotton"])
    material.is_variant_defining = False
    material.save(update_fields=["is_variant_defining"])
    return {"size": size, "color": colour, "material": material}


class TestQuickCreate:
    def test_makes_the_product_and_every_combination(
        self, owner: Any, auth_client: Any, axes: Any
    ) -> None:
        category = factories.category()
        response = _quick(
            auth_client(owner),
            name="Linen Panjabi",
            category=str(category.pk),
            selections={"size": ["S", "M"], "color": ["Black", "Navy"]},
            price="2450.00",
            cost="1100.00",
        )

        assert response.status_code == 201, response.data
        variants = response.data["variants"]
        assert len(variants) == 4
        # The shape `GET /variants/` answers with, so the order form adds these
        # as lines exactly as if they had been searched for.
        assert {v["product_name"] for v in variants} == {"Linen Panjabi"}
        assert {v["cost"] for v in variants} == {"1100.00"}
        assert {v["price"] for v in variants} == {"2450.00"}
        assert all(v["sku"] and v["barcode"] for v in variants)

        product = Product.objects.get(pk=response.data["product"]["id"])
        # Sellable at the counter once received; hidden online until someone
        # has photographed and described it.
        assert product.status == PublishStatus.ACTIVE
        assert product.published is False

    def test_no_options_makes_one_plain_variant(self, owner: Any, auth_client: Any) -> None:
        response = _quick(
            auth_client(owner),
            name="Oud Attar 12 ml",
            category=str(factories.category().pk),
            price="1800.00",
            cost="700.00",
        )

        assert response.status_code == 201, response.data
        assert len(response.data["variants"]) == 1
        assert response.data["variants"][0]["attributes"] == []

    def test_a_specification_cannot_build_variants(
        self, owner: Any, auth_client: Any, axes: Any
    ) -> None:
        """And nothing is left behind: the product is made in the same transaction."""
        response = _quick(
            auth_client(owner),
            name="Cotton Tee",
            category=str(factories.category().pk),
            selections={"size": ["M"], "material": ["Cotton"]},
            price="900.00",
            cost="300.00",
        )

        assert response.status_code == 400
        assert not Product.objects.filter(name="Cotton Tee").exists()

    def test_an_unknown_value_refuses_the_whole_request(
        self, owner: Any, auth_client: Any, axes: Any
    ) -> None:
        response = _quick(
            auth_client(owner),
            name="Cotton Tee",
            category=str(factories.category().pk),
            selections={"size": ["M", "XXXL"]},
            price="900.00",
            cost="300.00",
        )

        assert response.status_code == 400
        assert "XXXL" in response.data["error"]["message"]
        assert not Product.objects.filter(name="Cotton Tee").exists()

    def test_a_zero_selling_price_is_refused(self, owner: Any, auth_client: Any) -> None:
        """Received and on the counter within the minute -- a price nobody set sells free."""
        response = _quick(
            auth_client(owner),
            name="Scarf",
            category=str(factories.category().pk),
            price="0.00",
            cost="100.00",
        )

        assert response.status_code == 400
        assert "price" in response.data["error"]["details"]

    def test_needs_the_create_permission(self, cashier: Any, auth_client: Any) -> None:
        response = _quick(
            auth_client(cashier),
            name="Scarf",
            category=str(factories.category().pk),
            price="500.00",
            cost="100.00",
        )

        assert response.status_code == 403
        assert not Product.objects.filter(name="Scarf").exists()


class TestGenerateVariantsGuards:
    """D79: the product form's own endpoint had both holes the quick path would inherit."""

    def test_a_specification_is_refused(self, owner: Any, auth_client: Any, axes: Any) -> None:
        product = factories.product()
        response = auth_client(owner).post(
            f"/api/v1/products/{product.pk}/generate-variants/",
            {"selections": {"material": ["Cotton"]}, "price": "500.00"},
            format="json",
        )

        assert response.status_code == 400
        assert not product.variants.exists()

    def test_one_unknown_value_is_not_skipped_quietly(
        self, owner: Any, auth_client: Any, axes: Any
    ) -> None:
        product = factories.product()
        response = auth_client(owner).post(
            f"/api/v1/products/{product.pk}/generate-variants/",
            {"selections": {"size": ["S", "XXXL"]}, "price": "500.00"},
            format="json",
        )

        assert response.status_code == 400
        assert not product.variants.exists()


class TestReceiveOnArrival:
    def test_records_sends_and_receives_in_one_step(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        supplier = factories.supplier()
        variant = factories.variant(cost="0.00")

        response = auth_client(owner).post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(supplier.pk),
                "lines": [{"variant": str(variant.pk), "quantity": 12, "unit_cost": "650.00"}],
                "receive_now": True,
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["status"] == PurchaseOrderStatus.RECEIVED
        assert response.data["ordered_at"] is not None
        assert response.data["items"][0]["quantity_received"] == 12

        stock = Inventory.objects.get(branch=branch, variant=variant)
        assert stock.on_hand == 12
        # Through the ledger with the cost paid -- the whole point of D72.
        assert stock.average_cost == Decimal("650.0000")
        assert (
            variant.inventory_transactions.filter(transaction_type=TransactionType.PURCHASE).count()
            == 1
        )
        # And owed: a received order is a liability until it is paid.
        assert str(supplier.pk) in {row["party_id"] for row in payables()["parties"]}

    def test_needs_the_receive_permission_as_well(self, manager: Any, auth_client: Any) -> None:
        """Otherwise raising an order would be a way round `purchases.receive`."""
        role = Role.objects.get(code=RoleCode.MANAGER)
        role.permissions.remove(Permission.objects.get(code="purchases.receive"))
        variant = factories.variant()

        response = auth_client(manager).post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(factories.supplier().pk),
                "lines": [{"variant": str(variant.pk), "quantity": 1, "unit_cost": "10.00"}],
                "receive_now": True,
            },
            format="json",
        )

        assert response.status_code == 403
        assert not PurchaseOrder.objects.exists()
        assert not Inventory.objects.filter(variant=variant, on_hand__gt=0).exists()

    def test_without_the_flag_nothing_is_received(self, owner: Any, auth_client: Any) -> None:
        variant = factories.variant()
        response = auth_client(owner).post(
            "/api/v1/purchase-orders/",
            {
                "supplier": str(factories.supplier().pk),
                "lines": [{"variant": str(variant.pk), "quantity": 3, "unit_cost": "10.00"}],
            },
            format="json",
        )

        assert response.data["status"] == PurchaseOrderStatus.DRAFT
        assert not PurchaseReceipt.objects.exists()


class TestSupplierProducts:
    def _receive(self, supplier: Any, branch: Any, variant: Any, cost: str, when: Any) -> None:
        order = purchasing_services.create_purchase_order(
            supplier=supplier,
            branch=branch,
            lines=[PurchaseLine(variant_id=variant.pk, quantity=2, unit_cost=Decimal(cost))],
            receive_now=True,
        )
        PurchaseReceipt.objects.filter(purchase_order=order).update(received_at=when)

    def test_the_last_price_this_supplier_was_paid(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        supplier, other = factories.supplier(), factories.supplier()
        shirt, scarf, belt = factories.variant(), factories.variant(), factories.variant()
        now = timezone.now()
        self._receive(supplier, branch, shirt, "400.00", now - timedelta(days=30))
        self._receive(supplier, branch, shirt, "450.00", now - timedelta(days=2))
        self._receive(supplier, branch, scarf, "120.00", now - timedelta(days=10))
        # Another supplier's delivery is theirs, not this one's.
        self._receive(other, branch, belt, "90.00", now - timedelta(days=1))
        # Ordered and never delivered is a quote, not a price paid.
        purchasing_services.create_purchase_order(
            supplier=supplier,
            branch=branch,
            lines=[PurchaseLine(variant_id=belt.pk, quantity=1, unit_cost=Decimal("80.00"))],
        )

        response = auth_client(owner).get(f"/api/v1/suppliers/{supplier.pk}/products/")

        assert response.status_code == 200
        assert [row["id"] for row in response.data] == [str(shirt.pk), str(scarf.pk)]
        assert response.data[0]["last_cost"] == "450.00"
        assert response.data[1]["last_cost"] == "120.00"
        assert response.data[0]["product_name"] == shirt.product.name

    def test_needs_the_view_permission(self, cashier: Any, auth_client: Any) -> None:
        response = auth_client(cashier).get(
            f"/api/v1/suppliers/{factories.supplier().pk}/products/"
        )
        assert response.status_code == 403


def test_the_whole_journey(owner: Any, branch: Any, auth_client: Any, axes: Any) -> None:
    """A new line arrives with the supplier: made, received and on the counter in two calls."""
    client = auth_client(owner)
    made = _quick(
        client,
        name="Block-print Kurti",
        category=str(factories.category().pk),
        selections={"size": ["S", "M", "L"]},
        price="1950.00",
        cost="820.00",
    )
    assert made.status_code == 201, made.data

    order = client.post(
        "/api/v1/purchase-orders/",
        {
            "supplier": str(factories.supplier().pk),
            "lines": [
                {"variant": v["id"], "quantity": 4, "unit_cost": v["cost"]}
                for v in made.data["variants"]
            ],
            "receive_now": True,
        },
        format="json",
    )
    assert order.status_code == 201, order.data

    variants = ProductVariant.objects.filter(product_id=made.data["product"]["id"])
    stock = Inventory.objects.filter(branch=branch, variant__in=variants)
    assert sorted(stock.values_list("on_hand", flat=True)) == [4, 4, 4]
    assert {row.average_cost for row in stock} == {Decimal("820.0000")}
