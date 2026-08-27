"""The return flow as the admin screen drives it.

The services were covered in tests/test_orders.py; the four endpoints behind
`/admin/returns` were not covered anywhere, which is why it went unnoticed that
a restock decision could not be made at the moment the goods arrive — the very
point docs/business-rules.md §2.1 puts it.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from finance.models import AccountTransaction, AccountTransactionType
from inventory.models import Inventory
from orders.models import (
    PaymentMethod,
    RestockDecision,
    ReturnStatus,
)
from orders.services import pos
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from tests import factories

pytestmark = pytest.mark.django_db


def _sale(shop: Any, *, quantity: int = 2, account: Any = None) -> Any:
    variant = shop["variants"][0]
    total = variant.price * quantity
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)],
            payments=[
                PaymentInput(
                    method=PaymentMethod.CASH,
                    amount=total,
                    tendered_amount=total,
                    account=account,
                )
            ],
        ),
    )


def _requested(shop: Any, *, quantity: int = 2, account: Any = None) -> Any:
    order = _sale(shop, quantity=quantity, account=account)
    item = order.items.first()
    return order, return_services.request_return(
        order=order,
        lines=[(item.pk, quantity)],
        reason="WRONG_SIZE",
        actor=shop["manager"],
    )


def _stock(shop: Any) -> int:
    return Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"]).on_hand


class TestApproveAndReject:
    def test_a_manager_can_approve(self, shop, auth_client):
        _, request = _requested(shop)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/returns/{request.pk}/approve/", {"comment": "Looks fine"}, format="json"
        )

        assert response.status_code == 200, response.data
        assert response.data["status"] == ReturnStatus.APPROVED

    def test_rejecting_is_terminal_and_restocks_nothing(self, shop, auth_client):
        _, request = _requested(shop)
        before = _stock(shop)

        rejected = auth_client(shop["manager"]).post(
            f"/api/v1/returns/{request.pk}/reject/",
            {"comment": "Outside the window"},
            format="json",
        )

        assert rejected.status_code == 200
        assert rejected.data["status"] == ReturnStatus.REJECTED
        assert _stock(shop) == before
        # A rejected return cannot then be received.
        assert (
            auth_client(shop["manager"])
            .post(f"/api/v1/returns/{request.pk}/receive/", {}, format="json")
            .status_code
            == 409
        )

    def test_a_cashier_cannot_approve(self, shop, auth_client):
        _, request = _requested(shop)

        response = auth_client(shop["cashier"]).post(
            f"/api/v1/returns/{request.pk}/approve/", {}, format="json"
        )

        assert response.status_code == 403

    def test_receiving_before_approval_is_refused(self, shop, auth_client):
        _, request = _requested(shop)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/returns/{request.pk}/receive/", {}, format="json"
        )

        assert response.status_code == 409


class TestReceivingWithDecisions:
    def test_the_decision_can_be_made_when_the_goods_arrive(self, shop, auth_client):
        """§2.1 puts the restock decision at RECEIVED, not at request time."""
        _, request = _requested(shop, quantity=2)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        line = request.items.first()
        before = _stock(shop)

        response = client.post(
            f"/api/v1/returns/{request.pk}/receive/",
            {
                "items": [
                    {
                        "id": str(line.pk),
                        "restock_decision": "DAMAGED",
                        "condition_note": "Seam split on arrival",
                    }
                ]
            },
            format="json",
        )

        assert response.status_code == 200, response.data
        assert response.data["status"] == ReturnStatus.RECEIVED
        line.refresh_from_db()
        assert line.restock_decision == RestockDecision.DAMAGED
        assert line.condition_note == "Seam split on arrival"
        # Damaged goods never go back on the shelf (§2.3).
        assert _stock(shop) == before

    def test_restocking_puts_the_goods_back(self, shop, auth_client):
        _, request = _requested(shop, quantity=2)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        line = request.items.first()
        before = _stock(shop)

        client.post(
            f"/api/v1/returns/{request.pk}/receive/",
            {"items": [{"id": str(line.pk), "restock_decision": "RESTOCK"}]},
            format="json",
        )

        assert _stock(shop) == before + 2

    def test_quarantined_goods_are_not_sellable(self, shop, auth_client):
        _, request = _requested(shop, quantity=2)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        line = request.items.first()
        before = _stock(shop)

        client.post(
            f"/api/v1/returns/{request.pk}/receive/",
            {"items": [{"id": str(line.pk), "restock_decision": "QUARANTINE"}]},
            format="json",
        )

        assert _stock(shop) == before

    def test_a_line_left_out_keeps_the_decision_it_was_raised_with(self, shop, auth_client):
        _, request = _requested(shop, quantity=2)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        before = _stock(shop)

        client.post(f"/api/v1/returns/{request.pk}/receive/", {}, format="json")

        # RESTOCK is the default at request time, so it still applies.
        assert _stock(shop) == before + 2

    def test_an_unknown_line_is_refused(self, shop, auth_client):
        _, request = _requested(shop)
        other = _requested(shop)[1].items.first()
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")

        response = client.post(
            f"/api/v1/returns/{request.pk}/receive/",
            {"items": [{"id": str(other.pk), "restock_decision": "DAMAGED"}]},
            format="json",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_an_invalid_decision_is_refused(self, shop, auth_client):
        _, request = _requested(shop)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        line = request.items.first()

        response = client.post(
            f"/api/v1/returns/{request.pk}/receive/",
            {"items": [{"id": str(line.pk), "restock_decision": "BIN_IT"}]},
            format="json",
        )

        assert response.status_code == 400

    def test_the_same_line_twice_is_refused(self, shop, auth_client):
        _, request = _requested(shop)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        line = request.items.first()

        response = client.post(
            f"/api/v1/returns/{request.pk}/receive/",
            {
                "items": [
                    {"id": str(line.pk), "restock_decision": "RESTOCK"},
                    {"id": str(line.pk), "restock_decision": "DAMAGED"},
                ]
            },
            format="json",
        )

        assert response.status_code == 400


class TestCompletingTheRefund:
    def _received(self, shop, auth_client, *, account=None):
        order, request = _requested(shop, quantity=2, account=account)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")
        client.post(f"/api/v1/returns/{request.pk}/receive/", {}, format="json")
        return order, request, client

    def test_completing_refunds_the_order(self, shop, auth_client):
        order, request, client = self._received(shop, auth_client)

        response = client.post(f"/api/v1/returns/{request.pk}/complete/", {}, format="json")

        assert response.status_code == 200, response.data
        assert response.data["status"] == ReturnStatus.COMPLETED
        order.refresh_from_db()
        assert order.refunded_total == Decimal("2000.00")

    def test_the_refund_can_name_the_account_it_leaves_from(self, shop, auth_client):
        """An order refund could always name an account; a return refund could not."""
        drawer = factories.account(shop["branch"], opening_balance="50000.00")
        petty = factories.account(
            shop["branch"], kind="OTHER", opening_balance="9000.00", is_default=False
        )
        order, request, client = self._received(shop, auth_client, account=drawer)

        response = client.post(
            f"/api/v1/returns/{request.pk}/complete/",
            {"account": str(petty.pk)},
            format="json",
        )

        assert response.status_code == 200, response.data
        entry = AccountTransaction.objects.filter(
            account=petty, transaction_type=AccountTransactionType.REFUND
        ).latest("created_at")
        assert entry.amount == Decimal("-2000.00")
        petty.refresh_from_db()
        assert petty.balance == Decimal("7000.00")

    def test_completing_before_receipt_is_refused(self, shop, auth_client):
        _, request = _requested(shop)
        client = auth_client(shop["manager"])
        client.post(f"/api/v1/returns/{request.pk}/approve/", {}, format="json")

        response = client.post(f"/api/v1/returns/{request.pk}/complete/", {}, format="json")

        assert response.status_code == 409

    def test_completing_twice_refunds_once(self, shop, auth_client):
        order, request, client = self._received(shop, auth_client)

        client.post(f"/api/v1/returns/{request.pk}/complete/", {}, format="json")
        again = client.post(f"/api/v1/returns/{request.pk}/complete/", {}, format="json")

        assert again.status_code == 200
        order.refresh_from_db()
        # Idempotent: the customer is not paid twice.
        assert order.refunded_total == Decimal("2000.00")

    def test_a_partial_refund_can_be_named(self, shop, auth_client):
        order, request, client = self._received(shop, auth_client)

        response = client.post(
            f"/api/v1/returns/{request.pk}/complete/",
            {"refund_amount": "750.00"},
            format="json",
        )

        assert response.status_code == 200, response.data
        order.refresh_from_db()
        assert order.refunded_total == Decimal("750.00")

    def test_a_cashier_cannot_complete_a_refund(self, shop, auth_client):
        _, request, _ = self._received(shop, auth_client)

        response = auth_client(shop["cashier"]).post(
            f"/api/v1/returns/{request.pk}/complete/", {}, format="json"
        )

        assert response.status_code == 403


class TestListing:
    def test_the_list_carries_what_the_screen_renders(self, shop, auth_client):
        _, request = _requested(shop)

        response = auth_client(shop["manager"]).get("/api/v1/returns/")

        assert response.status_code == 200
        row = next(r for r in response.data["results"] if r["number"] == request.number)
        assert row["order_number"]
        assert row["status"] == ReturnStatus.REQUESTED
        assert row["items"][0]["sku"]
        assert row["items"][0]["restock_decision"] == RestockDecision.RESTOCK

    def test_an_anonymous_caller_sees_nothing(self, shop, api):
        _requested(shop)

        assert api.get("/api/v1/returns/").status_code == 401
