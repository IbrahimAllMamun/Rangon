"""Deleting a product or a variant from the admin product form.

`OrderItem`, `Inventory` and `InventoryTransaction` all reference
`ProductVariant` with `on_delete=PROTECT`, because they are financial history
(CLAUDE.md §3.3). A hard delete of anything that has been stocked or sold
therefore raises `ProtectedError`, which the exception handler turns into a bare
409 telling the user nothing — and the row they wanted to retire stays sellable.

The rule under test: **archive what has history, delete only what is clean.**
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from catalog.models import Product, ProductVariant, PublishStatus
from core.models import AuditLog
from orders.models import Channel, Order, OrderItem, OrderStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _order_for(variant: ProductVariant, branch: Any) -> Order:
    """A sale that pins the variant down: order history must keep resolving."""
    order = Order.objects.create(
        number=f"RGN-TEST-{variant.sku[-6:]}",
        branch=branch,
        customer=factories.customer(),
        channel=Channel.POS,
        status=OrderStatus.DELIVERED,
        subtotal=Decimal("1000.00"),
        grand_total=Decimal("1000.00"),
    )
    OrderItem.objects.create(
        order=order,
        variant=variant,
        quantity=1,
        unit_price=Decimal("1000.00"),
        line_total=Decimal("1000.00"),
        product_name=variant.product.name,
        sku=variant.sku,
    )
    return order


class TestVariantDelete:
    def test_clean_variant_is_deleted(self, owner: Any, auth_client: Any) -> None:
        variant = factories.variant()
        client = auth_client(owner)

        response = client.delete(f"/api/v1/variants/{variant.pk}/")

        assert response.status_code == 204
        assert not ProductVariant.objects.filter(pk=variant.pk).exists()

    def test_variant_with_stock_is_archived_not_deleted(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        factories.stock(variant, branch, 5)
        client = auth_client(owner)

        response = client.delete(f"/api/v1/variants/{variant.pk}/")

        assert response.status_code == 204
        variant.refresh_from_db()
        assert variant.status == PublishStatus.ARCHIVED
        assert not variant.is_sellable
        # The ledger it was deducted from is still intact.
        assert variant.inventory_transactions.exists()

    def test_variant_with_sales_is_archived_not_deleted(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        _order_for(variant, branch)
        client = auth_client(owner)

        response = client.delete(f"/api/v1/variants/{variant.pk}/")

        assert response.status_code == 204
        variant.refresh_from_db()
        assert variant.status == PublishStatus.ARCHIVED
        assert OrderItem.objects.filter(variant=variant).exists()

    def test_archiving_a_variant_is_audited_with_a_reason(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        factories.stock(variant, branch, 3)

        auth_client(owner).delete(f"/api/v1/variants/{variant.pk}/")

        entry = AuditLog.objects.filter(entity_id=str(variant.pk)).order_by("-created_at").first()
        assert entry is not None
        assert "Archived instead of deleted" in entry.reason

    def test_delete_needs_the_permission(self, cashier: Any, auth_client: Any) -> None:
        variant = factories.variant()

        response = auth_client(cashier).delete(f"/api/v1/variants/{variant.pk}/")

        assert response.status_code == 403
        assert ProductVariant.objects.filter(pk=variant.pk).exists()


class TestProductDelete:
    def test_clean_product_is_deleted(self, owner: Any, auth_client: Any) -> None:
        product = factories.product()

        response = auth_client(owner).delete(f"/api/v1/products/{product.pk}/")

        assert response.status_code == 204
        assert not Product.objects.filter(pk=product.pk).exists()

    def test_product_with_stocked_variants_is_archived(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        product = factories.product()
        variant = factories.variant(product)
        factories.stock(variant, branch, 4)

        response = auth_client(owner).delete(f"/api/v1/products/{product.pk}/")

        assert response.status_code == 204
        product.refresh_from_db()
        assert product.status == PublishStatus.ARCHIVED
        assert product.published is False
        # Previously this raised ProtectedError from the Inventory row and came
        # back as an unexplained 409.
        assert variant.inventory.exists()


class TestProductFormFlow:
    """The sequence the admin form performs: create, generate, price, open stock."""

    def test_create_generate_price_and_publish(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        client = auth_client(owner)
        category = factories.category()
        _, sizes = factories.attribute("size", values=["S", "M"])

        created = client.post(
            "/api/v1/products/",
            {"name": "Form Test Shirt", "category": str(category.pk), "status": "ACTIVE"},
            format="json",
        )
        assert created.status_code == 201
        product_id = created.data["id"]

        generated = client.post(
            f"/api/v1/products/{product_id}/generate-variants/",
            {"selections": {"size": ["S", "M"]}, "price": "1500.00", "cost": "700.00"},
            format="json",
        )
        assert generated.status_code == 201
        assert generated.data["created"] == 2

        variant_id = generated.data["variants"][0]["id"]

        # Per-row price override, as the matrix applies it.
        priced = client.patch(
            f"/api/v1/variants/{variant_id}/", {"price": "1650.00"}, format="json"
        )
        assert priced.status_code == 200
        assert Decimal(priced.data["price"]) == Decimal("1650.00")

        # Opening stock goes through the ledger, never onto a column.
        opened = client.post(
            "/api/v1/inventory/adjust/",
            {"variant": variant_id, "new_on_hand": 12, "reason": "Opening stock (product form)"},
            format="json",
        )
        assert opened.status_code == 201

        published = client.post(f"/api/v1/products/{product_id}/publish/", {}, format="json")
        assert published.status_code == 200
        assert published.data["published"] is True

        stocked = ProductVariant.objects.get(pk=variant_id)
        assert stocked.inventory.get(branch=branch).on_hand == 12
        assert stocked.inventory_transactions.filter(transaction_type="ADJUSTMENT").exists()
        assert len(sizes) == 2

    def test_publishing_without_variants_is_refused(self, owner: Any, auth_client: Any) -> None:
        client = auth_client(owner)
        category = factories.category()

        created = client.post(
            "/api/v1/products/",
            {"name": "Empty Product", "category": str(category.pk), "status": "ACTIVE"},
            format="json",
        )
        response = client.post(f"/api/v1/products/{created.data['id']}/publish/", {}, format="json")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_generate_variants_is_idempotent(self, owner: Any, auth_client: Any) -> None:
        """Re-saving the form must not duplicate rows the product already has."""
        client = auth_client(owner)
        category = factories.category()
        factories.attribute("size", values=["S", "M"])

        created = client.post(
            "/api/v1/products/",
            {"name": "Rerun Product", "category": str(category.pk), "status": "ACTIVE"},
            format="json",
        )
        product_id = created.data["id"]
        payload = {"selections": {"size": ["S", "M"]}, "price": "900.00"}

        first = client.post(
            f"/api/v1/products/{product_id}/generate-variants/", payload, format="json"
        )
        second = client.post(
            f"/api/v1/products/{product_id}/generate-variants/", payload, format="json"
        )

        assert first.data["created"] == 2
        assert second.data["created"] == 0
        assert ProductVariant.objects.filter(product_id=product_id).count() == 2
