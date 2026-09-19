"""What the purchase-order endpoints accepted and should not have.

Found by auditing `purchase-orders/` on 2026-09-19 -- the habit that has found
defects every time it has been applied. Recorded as D80-D83 in the roadmap.
Each test here was run against the code as it stood and seen to fail before
the guard was written.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from finance.selectors import payables
from purchasing.models import PurchaseOrder, PurchaseOrderStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _create(client: Any, supplier: Any, lines: list[dict[str, Any]], **extra: Any) -> Any:
    return client.post(
        "/api/v1/purchase-orders/",
        {"supplier": str(supplier.pk), "lines": lines, **extra},
        format="json",
    )


def _line(variant: Any, quantity: int = 1, unit_cost: str = "100.00", **extra: Any) -> dict:
    return {"variant": str(variant.pk), "quantity": quantity, "unit_cost": unit_cost, **extra}


class TestMoneyOnTheOrder:
    def test_negative_shipping_is_refused(self, owner: Any, auth_client: Any) -> None:
        """A minus sign on shipping lowered what the business owes the supplier.

        `shipping_total` had no lower bound anywhere -- not on the serializer,
        not in the service -- and the only database check is `grand_total >= 0`,
        which a large enough order always passes. So 10,000 of goods with
        shipping `-500.00` was stored as a 9,500 liability.
        """
        response = _create(
            auth_client(owner),
            factories.supplier(),
            [_line(factories.variant(), 100, "100.00")],
            shipping_total="-500.00",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        assert not PurchaseOrder.objects.exists()

    def test_a_discount_larger_than_its_line_is_refused(self, owner: Any, auth_client: Any) -> None:
        """A line can be discounted to nothing, never below it.

        `discount` had a floor of zero and no ceiling, so 2 x 100 less 500 was
        stored as a line total of -300.00 and silently cancelled out 300 of
        the other lines on the order.
        """
        response = _create(
            auth_client(owner),
            factories.supplier(),
            [
                _line(factories.variant(), 2, "100.00", discount="500.00"),
                _line(factories.variant(), 10, "100.00"),
            ],
        )

        assert response.status_code == 400
        assert not PurchaseOrder.objects.exists()

    def test_a_discount_equal_to_its_line_is_allowed(self, owner: Any, auth_client: Any) -> None:
        """Free goods are real -- a supplier's sample, a replacement."""
        response = _create(
            auth_client(owner),
            factories.supplier(),
            [_line(factories.variant(), 2, "100.00", discount="200.00")],
        )

        assert response.status_code == 201
        assert Decimal(response.data["items"][0]["line_total"]) == Decimal("0.00")


class TestLines:
    def test_the_same_variant_twice_is_a_field_error_not_a_conflict(
        self, owner: Any, auth_client: Any
    ) -> None:
        """Used to reach `purchasing_poi_uniq` and come back as a bare 409.

        The data was safe, but the form had nothing to point at: the envelope
        said CONFLICT with no field, for a mistake made on one line.
        """
        variant = factories.variant()
        response = _create(
            auth_client(owner),
            factories.supplier(),
            [_line(variant, 2), _line(variant, 3)],
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        assert "lines" in response.data["error"]["details"]

    def test_an_unknown_supplier_is_a_field_error(self, owner: Any, auth_client: Any) -> None:
        response = auth_client(owner).post(
            "/api/v1/purchase-orders/",
            {
                "supplier": "00000000-0000-4000-8000-000000000000",
                "lines": [_line(factories.variant())],
            },
            format="json",
        )

        assert response.status_code == 400
        assert "supplier" in response.data["error"]["details"]


class TestReceiving:
    def test_one_line_named_twice_in_a_delivery_is_refused(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        """The second quantity used to replace the first, silently.

        The view folded the lines into a dict keyed by item, so
        `[{item, 3}, {item, 4}]` received 4 -- not 7, and not an error. The
        storekeeper counted seven units onto the shelf and the ledger said four.
        """
        client = auth_client(owner)
        variant = factories.variant()
        created = _create(client, factories.supplier(), [_line(variant, 10)])
        order_id, item_id = created.data["id"], created.data["items"][0]["id"]
        client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")

        response = client.post(
            f"/api/v1/purchase-orders/{order_id}/receive/",
            {"lines": [{"item": item_id, "quantity": 3}, {"item": item_id, "quantity": 4}]},
            format="json",
        )

        assert response.status_code == 400
        assert not variant.inventory.filter(branch=branch, on_hand__gt=0).exists()


class TestCancelling:
    def test_an_order_with_money_paid_against_it_cannot_be_cancelled(
        self, owner: Any, auth_client: Any
    ) -> None:
        """Cancelling made a paid advance vanish from the books.

        `cancel_purchase_order` checked for receipts and nothing else. The
        payables selector (business-rules §4.2) drops CANCELLED orders, and a
        recorded payment can be neither edited nor deleted (§6b.1b), so the
        400 already paid was no longer owed, no longer payable and no longer
        visible anywhere as money the supplier holds.
        """
        client = auth_client(owner)
        supplier = factories.supplier()
        created = _create(client, supplier, [_line(factories.variant(), 10, "100.00")])
        order_id = created.data["id"]
        client.post(f"/api/v1/purchase-orders/{order_id}/send/", {}, format="json")
        paid = client.post(
            "/api/v1/supplier-payments/",
            {
                "supplier": str(supplier.pk),
                "purchase_order": order_id,
                "amount": "400.00",
                "method": "BANK",
            },
            format="json",
        )
        assert paid.status_code == 201

        response = client.post(
            f"/api/v1/purchase-orders/{order_id}/cancel/", {"reason": "changed mind"}, format="json"
        )

        assert response.status_code == 409
        order = PurchaseOrder.objects.get(pk=order_id)
        assert order.status == PurchaseOrderStatus.SENT
        # Still on the payable list, with the payment still counted against it.
        owed = {row["party_id"] for row in payables()["parties"]}
        assert str(supplier.pk) in owed

    def test_cancelling_twice_is_refused(self, owner: Any, auth_client: Any) -> None:
        """A second cancel used to succeed and write a second audit entry."""
        client = auth_client(owner)
        created = _create(client, factories.supplier(), [_line(factories.variant())])
        order_id = created.data["id"]

        first = client.post(f"/api/v1/purchase-orders/{order_id}/cancel/", {}, format="json")
        second = client.post(f"/api/v1/purchase-orders/{order_id}/cancel/", {}, format="json")

        assert first.status_code == 200
        assert second.status_code == 409
