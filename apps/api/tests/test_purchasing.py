"""Purchasing: receiving is the only step that touches stock (ADR-0008)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.exceptions import Conflict, ValidationError
from inventory.models import Inventory, InventoryTransaction, TransactionType
from purchasing.models import PurchaseOrderStatus
from purchasing.services import (
    PurchaseLine,
    cancel_purchase_order,
    create_purchase_order,
    receive_purchase,
    record_supplier_payment,
    send_purchase_order,
)
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def purchase_setup(shop):
    variant = factories.variant(price="1000.00", cost="0.00")
    return {
        "branch": shop["branch"],
        "supplier": factories.supplier(),
        "variant": variant,
        "actor": shop["manager"],
    }


def _order(setup, quantity=50, cost="400.00"):
    return create_purchase_order(
        supplier=setup["supplier"],
        branch=setup["branch"],
        lines=[
            PurchaseLine(variant_id=setup["variant"].pk, quantity=quantity, unit_cost=Decimal(cost))
        ],
        actor=setup["actor"],
    )


class TestPurchaseOrder:
    def test_creating_a_purchase_order_does_not_change_stock(self, purchase_setup):
        _order(purchase_setup)

        assert not Inventory.objects.filter(
            variant=purchase_setup["variant"], on_hand__gt=0
        ).exists()

    def test_totals_are_computed_server_side(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=10, cost="250.00")

        assert purchase_order.subtotal == Decimal("2500.00")
        assert purchase_order.grand_total == Decimal("2500.00")
        assert purchase_order.status == PurchaseOrderStatus.DRAFT

    def test_an_empty_purchase_order_is_refused(self, purchase_setup):
        with pytest.raises(ValidationError):
            create_purchase_order(
                supplier=purchase_setup["supplier"],
                branch=purchase_setup["branch"],
                lines=[],
                actor=purchase_setup["actor"],
            )


class TestReceiving:
    def test_receiving_adds_stock_through_the_ledger(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=50, cost="400.00")
        send_purchase_order(purchase_order=purchase_order, actor=purchase_setup["actor"])
        item = purchase_order.items.first()

        receive_purchase(
            purchase_order=purchase_order,
            lines={str(item.pk): 50},
            actor=purchase_setup["actor"],
        )

        inventory = Inventory.objects.get(
            variant=purchase_setup["variant"], branch=purchase_setup["branch"]
        )
        assert inventory.on_hand == 50
        assert inventory.average_cost == Decimal("400.00")
        assert InventoryTransaction.objects.filter(
            transaction_type=TransactionType.PURCHASE, quantity=50
        ).exists()

        purchase_order.refresh_from_db()
        assert purchase_order.status == PurchaseOrderStatus.RECEIVED

    def test_partial_delivery_leaves_the_order_open(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=50)
        send_purchase_order(purchase_order=purchase_order, actor=purchase_setup["actor"])
        item = purchase_order.items.first()

        receive_purchase(
            purchase_order=purchase_order,
            lines={str(item.pk): 20},
            actor=purchase_setup["actor"],
        )

        purchase_order.refresh_from_db()
        item.refresh_from_db()
        assert purchase_order.status == PurchaseOrderStatus.PARTIALLY_RECEIVED
        assert item.quantity_received == 20
        assert item.quantity_outstanding == 30

    def test_cannot_receive_more_than_ordered(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=10)
        item = purchase_order.items.first()

        with pytest.raises(ValidationError):
            receive_purchase(
                purchase_order=purchase_order,
                lines={str(item.pk): 11},
                actor=purchase_setup["actor"],
            )

    def test_second_receipt_blends_the_average_cost(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=20, cost="100.00")
        item = purchase_order.items.first()

        receive_purchase(
            purchase_order=purchase_order,
            lines={str(item.pk): 10},
            actor=purchase_setup["actor"],
        )
        receive_purchase(
            purchase_order=purchase_order,
            lines={str(item.pk): 10},
            unit_costs={str(item.pk): Decimal("300.00")},  # price went up
            actor=purchase_setup["actor"],
        )

        inventory = Inventory.objects.get(
            variant=purchase_setup["variant"], branch=purchase_setup["branch"]
        )
        assert inventory.on_hand == 20
        assert inventory.average_cost == Decimal("200.00")  # (10*100 + 10*300)/20

    def test_cancelling_after_receipt_is_refused(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=10)
        item = purchase_order.items.first()
        receive_purchase(
            purchase_order=purchase_order,
            lines={str(item.pk): 5},
            actor=purchase_setup["actor"],
        )

        with pytest.raises(Conflict):
            cancel_purchase_order(
                purchase_order=purchase_order, actor=purchase_setup["actor"], reason="mistake"
            )


class TestSupplierPayments:
    def test_payment_updates_the_purchase_order_status(self, purchase_setup):
        purchase_order = _order(purchase_setup, quantity=10, cost="100.00")  # 1000 total

        record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("400.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
        )
        purchase_order.refresh_from_db()
        assert purchase_order.payment_status == "PARTIALLY_PAID"
        assert purchase_order.outstanding == Decimal("600.00")

        record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("600.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
        )
        purchase_order.refresh_from_db()
        assert purchase_order.payment_status == "PAID"

    def test_a_zero_payment_is_refused(self, purchase_setup):
        with pytest.raises(ValidationError):
            record_supplier_payment(
                supplier=purchase_setup["supplier"],
                amount=Decimal("0.00"),
                method="CASH",
                actor=purchase_setup["actor"],
            )
