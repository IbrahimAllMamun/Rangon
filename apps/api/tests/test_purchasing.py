"""Purchasing: receiving is the only step that touches stock (ADR-0008)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.db import IntegrityError

from core.exceptions import Conflict, PaymentExceedsOutstanding, ValidationError
from finance.models import AccountTransaction
from inventory.models import Inventory, InventoryTransaction, TransactionType
from purchasing.models import PurchaseOrderStatus, SupplierPayment, SupplierProduct
from purchasing.services import (
    PurchaseLine,
    cancel_purchase_order,
    create_purchase_order,
    receive_purchase,
    record_supplier_payment,
    send_purchase_order,
    set_preferred_supplier,
    supplier_cost_for,
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


def _sent_order(setup, quantity=50, cost="400.00"):
    """A purchase order the supplier has actually been sent.

    Payment tests need this rather than `_order`: a DRAFT order has not been
    committed to the supplier, so nothing is owed on it and paying one is
    refused (business-rules.md §6b.1b).
    """
    purchase_order = _order(setup, quantity=quantity, cost=cost)
    return send_purchase_order(purchase_order=purchase_order, actor=setup["actor"])


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
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")  # 1000 total

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

    # -- Invariants ------------------------------------------------------

    def test_a_payment_cannot_exceed_the_outstanding_balance(self, purchase_setup):
        """paid_total may never pass grand_total.

        The mirror of the refund guard: `outstanding` going negative drops the
        order out of the payables selector (finance.selectors), so an overpaid
        order disappears from the payable list instead of showing as a problem.
        """
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")  # 1000 total

        record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("400.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
        )

        with pytest.raises(PaymentExceedsOutstanding):
            record_supplier_payment(
                supplier=purchase_setup["supplier"],
                amount=Decimal("700.00"),
                method="BANK",
                purchase_order=purchase_order,
                actor=purchase_setup["actor"],
            )

        purchase_order.refresh_from_db()
        assert purchase_order.paid_total == Decimal("400.00")
        assert purchase_order.payment_status == "PARTIALLY_PAID"
        assert purchase_order.outstanding == Decimal("600.00")
        # The refused attempt left no document behind either.
        assert purchase_order.payments.count() == 1

    def test_paying_to_the_penny_is_allowed(self, purchase_setup):
        """The guard refuses *more* than outstanding, never the exact figure."""
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")

        record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("1000.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
        )

        purchase_order.refresh_from_db()
        assert purchase_order.payment_status == "PAID"
        assert purchase_order.outstanding == Decimal("0.00")

    def test_the_cash_book_and_the_purchase_order_agree(self, purchase_setup):
        """Every taka the order says it paid left a named account."""
        account = factories.account(
            purchase_setup["branch"], kind="BANK", opening_balance=Decimal("5000.00")
        )
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")

        payment = record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("1000.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
            account=account,
        )

        purchase_order.refresh_from_db()
        posted = AccountTransaction.objects.filter(
            reference_type="supplier_payment", reference_id=payment.pk
        )
        assert posted.count() == 1
        # Money leaving is negative in the cash book; the order counts it positive.
        assert abs(posted.get().amount) == purchase_order.paid_total
        assert purchase_order.outstanding == Decimal("0.00")

    # -- Failure paths ---------------------------------------------------

    def test_a_payment_for_another_supplier_is_refused(self, purchase_setup):
        """Supplier and purchase order must agree.

        Both reach the service as separate arguments, so without this guard a
        payment to A credits A's ledger while reducing B's outstanding — two
        wrong balances from one row.
        """
        other_supplier = factories.supplier()
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")

        with pytest.raises(ValidationError):
            record_supplier_payment(
                supplier=other_supplier,
                amount=Decimal("100.00"),
                method="CASH",
                purchase_order=purchase_order,
                actor=purchase_setup["actor"],
            )

        purchase_order.refresh_from_db()
        assert purchase_order.paid_total == Decimal("0.00")
        assert SupplierPayment.objects.filter(supplier=other_supplier).count() == 0

    def test_the_same_idempotency_key_pays_once(self, purchase_setup):
        """A retried or double-clicked submit must not pay a supplier twice."""
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")

        first = record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("400.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
            idempotency_key="retry-me",
        )
        second = record_supplier_payment(
            supplier=purchase_setup["supplier"],
            amount=Decimal("400.00"),
            method="BANK",
            purchase_order=purchase_order,
            actor=purchase_setup["actor"],
            idempotency_key="retry-me",
        )

        assert first.pk == second.pk
        assert SupplierPayment.objects.filter(idempotency_key="retry-me").count() == 1
        purchase_order.refresh_from_db()
        assert purchase_order.paid_total == Decimal("400.00")

    def test_a_draft_purchase_order_cannot_be_paid(self, purchase_setup):
        """A draft has never been sent to the supplier; there is nothing owed."""
        purchase_order = _order(purchase_setup, quantity=10, cost="100.00")
        assert purchase_order.status == PurchaseOrderStatus.DRAFT

        with pytest.raises(Conflict):
            record_supplier_payment(
                supplier=purchase_setup["supplier"],
                amount=Decimal("100.00"),
                method="CASH",
                purchase_order=purchase_order,
                actor=purchase_setup["actor"],
            )

        purchase_order.refresh_from_db()
        assert purchase_order.paid_total == Decimal("0.00")

    def test_a_cancelled_purchase_order_cannot_be_paid(self, purchase_setup):
        """finance.selectors already excludes CANCELLED from payables, so paying
        one writes cash out against a liability the ledger says does not exist.
        """
        purchase_order = _sent_order(purchase_setup, quantity=10, cost="100.00")
        cancel_purchase_order(
            purchase_order=purchase_order, actor=purchase_setup["actor"], reason="not needed"
        )

        with pytest.raises(Conflict):
            record_supplier_payment(
                supplier=purchase_setup["supplier"],
                amount=Decimal("100.00"),
                method="CASH",
                purchase_order=purchase_order,
                actor=purchase_setup["actor"],
            )

        purchase_order.refresh_from_db()
        assert purchase_order.paid_total == Decimal("0.00")


class TestSupplierProduct:
    """Which supplier sells what, and at whose price (docs/business-rules.md § 7a).

    The catalogue had no link to a supplier at all, so the purchase order form
    defaulted a line to `ProductVariant.cost` — the last price paid to *anyone*.
    Ordering from the cheaper of two vendors pre-filled the dearer one's price.
    These tests are mostly about keeping two suppliers' prices apart.
    """

    def _receive_all(self, setup, *, cost, supplier=None):
        """Raise, send and fully receive one order, optionally from another supplier."""
        if supplier is not None:
            setup = {**setup, "supplier": supplier}
        order = _sent_order(setup, quantity=10, cost=cost)
        return receive_purchase(
            purchase_order=order,
            lines={str(item.pk): item.quantity_ordered for item in order.items.all()},
            actor=setup["actor"],
        )

    def test_receiving_records_who_supplied_it_and_for_how_much(self, purchase_setup):
        """The price list is a by-product of receiving, never a chore."""
        assert SupplierProduct.objects.count() == 0

        self._receive_all(purchase_setup, cost="400.00")

        offer = SupplierProduct.objects.get()
        assert offer.supplier == purchase_setup["supplier"]
        assert offer.variant == purchase_setup["variant"]
        assert offer.last_cost == Decimal("400.00")
        assert offer.last_purchased_at is not None

    def test_two_suppliers_keep_their_own_prices(self, purchase_setup):
        """The invariant the model exists for.

        `ProductVariant.cost` cannot hold this: `receive_stock` overwrites it
        with whichever supplier delivered last, so after the cheap delivery it
        reads 250 for both.
        """
        dear, cheap = purchase_setup["supplier"], factories.supplier(name="Cheaper Mills")

        self._receive_all(purchase_setup, cost="400.00", supplier=dear)
        self._receive_all(purchase_setup, cost="250.00", supplier=cheap)

        variant = purchase_setup["variant"]
        assert supplier_cost_for(supplier=dear, variant_id=variant.pk) == Decimal("400.00")
        assert supplier_cost_for(supplier=cheap, variant_id=variant.pk) == Decimal("250.00")

        variant.refresh_from_db()
        assert variant.cost == Decimal("250.00")  # the single column, now ambiguous

    def test_the_first_supplier_is_preferred_and_the_second_does_not_steal_it(self, purchase_setup):
        first, second = purchase_setup["supplier"], factories.supplier()

        self._receive_all(purchase_setup, cost="400.00", supplier=first)
        self._receive_all(purchase_setup, cost="250.00", supplier=second)

        preferred = SupplierProduct.objects.get(
            variant=purchase_setup["variant"], is_preferred=True
        )
        assert preferred.supplier == first

    def test_receiving_again_moves_only_that_suppliers_price(self, purchase_setup):
        dear, cheap = purchase_setup["supplier"], factories.supplier()
        self._receive_all(purchase_setup, cost="400.00", supplier=dear)
        self._receive_all(purchase_setup, cost="250.00", supplier=cheap)

        # The dear supplier puts their price up; the cheap one is unaffected.
        self._receive_all(purchase_setup, cost="450.00", supplier=dear)

        variant = purchase_setup["variant"]
        assert supplier_cost_for(supplier=dear, variant_id=variant.pk) == Decimal("450.00")
        assert supplier_cost_for(supplier=cheap, variant_id=variant.pk) == Decimal("250.00")
        assert SupplierProduct.objects.filter(variant=variant).count() == 2

    def test_a_supplier_with_no_history_reports_none_rather_than_a_price(self, purchase_setup):
        """None means "ask the buyer", not "charge what the last one charged"."""
        stranger = factories.supplier()
        self._receive_all(purchase_setup, cost="400.00")

        assert supplier_cost_for(supplier=stranger, variant_id=purchase_setup["variant"].pk) is None

    def test_promoting_a_supplier_demotes_the_incumbent(self, purchase_setup):
        first, second = purchase_setup["supplier"], factories.supplier()
        self._receive_all(purchase_setup, cost="400.00", supplier=first)
        self._receive_all(purchase_setup, cost="250.00", supplier=second)

        set_preferred_supplier(
            variant_id=purchase_setup["variant"].pk,
            supplier=second,
            actor=purchase_setup["actor"],
        )

        preferred = SupplierProduct.objects.filter(
            variant=purchase_setup["variant"], is_preferred=True
        )
        assert preferred.count() == 1
        assert preferred.get().supplier == second

    def test_promoting_a_supplier_that_does_not_supply_it_is_refused(self, purchase_setup):
        self._receive_all(purchase_setup, cost="400.00")
        with pytest.raises(ValidationError):
            set_preferred_supplier(
                variant_id=purchase_setup["variant"].pk,
                supplier=factories.supplier(),
                actor=purchase_setup["actor"],
            )

    def test_promoting_a_discontinued_offer_is_refused(self, purchase_setup):
        first, second = purchase_setup["supplier"], factories.supplier()
        self._receive_all(purchase_setup, cost="400.00", supplier=first)
        self._receive_all(purchase_setup, cost="250.00", supplier=second)

        offer = SupplierProduct.objects.get(supplier=second)
        offer.is_active = False
        offer.save(update_fields=["is_active"])

        with pytest.raises(ValidationError):
            set_preferred_supplier(
                variant_id=purchase_setup["variant"].pk,
                supplier=second,
                actor=purchase_setup["actor"],
            )

    def test_receiving_from_a_discontinued_supplier_reinstates_them(self, purchase_setup):
        """A delivery is the strongest possible evidence they still supply it."""
        self._receive_all(purchase_setup, cost="400.00")
        offer = SupplierProduct.objects.get()
        offer.is_active = False
        offer.save(update_fields=["is_active"])

        self._receive_all(purchase_setup, cost="410.00")

        offer.refresh_from_db()
        assert offer.is_active is True

    def test_one_supplier_cannot_have_two_prices_for_one_variant(self, purchase_setup):
        self._receive_all(purchase_setup, cost="400.00")
        with pytest.raises(IntegrityError):
            SupplierProduct.objects.create(
                supplier=purchase_setup["supplier"],
                variant=purchase_setup["variant"],
                last_cost=Decimal("1.00"),
            )

    def test_a_variant_cannot_have_two_preferred_suppliers(self, purchase_setup):
        """The database refuses it, not just the service."""
        self._receive_all(purchase_setup, cost="400.00")
        other = factories.supplier()
        with pytest.raises(IntegrityError):
            SupplierProduct.objects.create(
                supplier=other,
                variant=purchase_setup["variant"],
                last_cost=Decimal("250.00"),
                is_preferred=True,
            )

    def test_lead_time_falls_back_to_the_supplier(self, purchase_setup):
        slow = factories.supplier(lead_time_days=30)
        self._receive_all(purchase_setup, cost="400.00", supplier=slow)
        offer = SupplierProduct.objects.get(supplier=slow)

        assert offer.lead_time_days is None
        assert offer.effective_lead_time_days == 30

        offer.lead_time_days = 3  # this one item they keep in stock
        offer.save(update_fields=["lead_time_days"])
        assert offer.effective_lead_time_days == 3
