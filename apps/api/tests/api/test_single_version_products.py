"""Products in one version only, and a shop's first purchase order.

business-rules.md § 7a.6. `generate_variants` needs at least one attribute
value, so a product with no sizes or colours -- a lipstick in one shade, a
one-size bag -- could be created by the CSV import and nowhere else. The
purchase order's new-product form sent such a buyer to the full product form,
which could not make one either.

That is also what made a shop's **first** order impossible to raise from the
order itself: with no categories and no sizes or colours set up, there was
nothing to build a product from. `test_a_first_order_from_an_empty_catalogue`
walks it through the API the way the screen now does.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from accounts.permissions import RoleCode
from catalog.models import Attribute, Category, Product, ProductVariant, PublishStatus
from core.models import AuditLog
from inventory.models import Inventory, InventoryTransaction, TransactionType
from purchasing.models import PurchaseOrderStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _generate(client: Any, product: Any, body: dict[str, Any]) -> Any:
    return client.post(f"/api/v1/products/{product.pk}/generate-variants/", body, format="json")


class TestOneVersion:
    def test_it_builds_one_sku_with_no_options(self, owner: Any, auth_client: Any) -> None:
        product = factories.product(name="Velvet Matte Lipstick", status=PublishStatus.DRAFT)

        response = _generate(
            auth_client(owner), product, {"single": True, "price": "0.00", "cost": "380.00"}
        )

        assert response.status_code == 201, response.data
        assert response.data["created"] == 1
        variant = ProductVariant.objects.get(product=product)
        assert not variant.attribute_values.exists()
        # Derived like every generated SKU; nobody has to invent one.
        assert variant.sku.startswith("RGN-VEL")
        assert variant.barcode
        assert variant.cost == Decimal("380.00")
        assert response.data["variants"][0]["sku"] == variant.sku
        # Creating a SKU does not publish anything.
        product.refresh_from_db()
        assert product.status == PublishStatus.DRAFT
        assert AuditLog.objects.filter(
            entity_id=str(product.pk), reason="Single-version SKU created"
        ).exists()

    def test_a_retried_submit_makes_no_second_sku(self, owner: Any, auth_client: Any) -> None:
        product = factories.product()
        client = auth_client(owner)
        _generate(client, product, {"single": True, "price": "500.00"})

        again = _generate(client, product, {"single": True, "price": "500.00"})

        assert again.status_code == 201
        assert again.data["created"] == 0
        assert product.variants.count() == 1

    def test_a_product_with_sizes_cannot_also_have_a_single_version(
        self, owner: Any, auth_client: Any
    ) -> None:
        _, sizes = factories.attribute("size", values=["S", "M"])
        product = factories.product()
        factories.variant(product, attribute_values=[sizes[0]])

        response = _generate(auth_client(owner), product, {"single": True, "price": "500.00"})

        assert response.status_code == 409
        assert product.variants.count() == 1

    def test_a_single_version_cannot_sprout_sizes_until_it_is_archived(
        self, owner: Any, auth_client: Any
    ) -> None:
        factories.attribute("size", values=["S", "M"])
        product = factories.product()
        client = auth_client(owner)
        _generate(client, product, {"single": True, "price": "500.00"})

        refused = _generate(client, product, {"selections": {"size": ["S"]}, "price": "500.00"})
        assert refused.status_code == 409
        assert "Archive" in refused.json()["error"]["message"]
        assert product.variants.count() == 1

        product.variants.update(status=PublishStatus.ARCHIVED)
        allowed = _generate(client, product, {"selections": {"size": ["S"]}, "price": "500.00"})
        assert allowed.status_code == 201, allowed.data

    def test_single_and_selections_together_are_refused(self, owner: Any, auth_client: Any) -> None:
        factories.attribute("size", values=["S"])
        product = factories.product()

        response = _generate(
            auth_client(owner),
            product,
            {"single": True, "selections": {"size": ["S"]}, "price": "500.00"},
        )

        assert response.status_code == 400
        assert not product.variants.exists()

    def test_forgetting_the_ticks_is_still_an_error_not_a_single_sku(
        self, owner: Any, auth_client: Any
    ) -> None:
        """`single` is explicit so a form that lost its selections is told so."""
        product = factories.product()

        response = _generate(auth_client(owner), product, {"selections": {}, "price": "500.00"})

        assert response.status_code == 400
        assert not product.variants.exists()

    def test_it_needs_the_permission_to_create_products(
        self, cashier: Any, auth_client: Any
    ) -> None:
        product = factories.product()

        response = _generate(auth_client(cashier), product, {"single": True, "price": "500.00"})

        assert response.status_code == 403
        assert not product.variants.exists()


def test_a_first_order_from_an_empty_catalogue(auth_client: Any) -> None:
    """No categories, no sizes, no colours, no products: order, receive, stock.

    The sequence the purchase order screen performs when a buyer presses
    "New product" on a shop's first order and names a category inline.
    """
    organization = factories.organization()
    branch = factories.branch(organization)
    buyer = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=branch)
    supplier = factories.supplier()
    assert not Category.objects.exists()
    assert not Attribute.objects.exists()
    assert not Product.objects.exists()
    client = auth_client(buyer)

    category = client.post(
        "/api/v1/categories/", {"name": "Bags", "is_active": True}, format="json"
    )
    assert category.status_code == 201, category.data

    product = client.post(
        "/api/v1/products/",
        {"name": "Canvas Tote", "category": category.data["id"], "status": "DRAFT"},
        format="json",
    )
    assert product.status_code == 201, product.data
    generated = client.post(
        f"/api/v1/products/{product.data['id']}/generate-variants/",
        {"single": True, "price": "0.00", "cost": "650.00"},
        format="json",
    )
    assert generated.status_code == 201, generated.data
    variant_id = generated.data["variants"][0]["id"]

    order = client.post(
        "/api/v1/purchase-orders/",
        {
            "supplier": str(supplier.pk),
            "lines": [{"variant": variant_id, "quantity": 20, "unit_cost": "650.00"}],
        },
        format="json",
    )
    assert order.status_code == 201, order.data
    order_id = order.data["id"]
    assert client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}).status_code == 200
    received = client.post(
        f"/api/v1/purchase-orders/{order_id}/receive/",
        {"lines": [{"item": order.data["items"][0]["id"], "quantity": 20}]},
        format="json",
    )
    assert received.status_code == 201, received.data
    assert received.data["purchase_order"]["status"] == PurchaseOrderStatus.RECEIVED

    stock = Inventory.objects.get(branch=branch, variant_id=variant_id)
    assert stock.on_hand == 20
    assert stock.average_cost == Decimal("650.00")
    assert InventoryTransaction.objects.filter(
        variant_id=variant_id, transaction_type=TransactionType.PURCHASE
    ).exists()
    # Landed, and still invisible to shoppers until someone prices and publishes it.
    detail = client.get(f"/api/v1/purchase-orders/{order_id}/").json()
    assert [row["name"] for row in detail["unpublished_products"]] == ["Canvas Tote"]
