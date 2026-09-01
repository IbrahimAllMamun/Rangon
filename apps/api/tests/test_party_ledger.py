"""Phase 37: receivable and payable, derived rather than stored.

The design point being defended is the one the roadmap named: there is **no
balance column** on `Customer` or `Supplier`.  Every figure is the sum of the
documents behind it, computed on read, so a balance cannot drift away from the
orders it claims to summarise.

The other half is which documents count. An unconfirmed basket is not a debt, a
draft purchase order is not a liability, and a supplier on 30-day terms is not
overdue on day one.
"""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from finance import selectors
from orders.models import Order, OrderStatus, PaymentMethod
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from purchasing.models import PurchaseOrder, PurchaseOrderStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _unpaid_order(shop, *, total: str = "1000.00", status: str = OrderStatus.DELIVERED, **kwargs):
    """An order carrying a balance -- the COD case, before the cash arrives."""
    return Order.objects.create(
        number=factories.unique("RGN-"),
        branch=shop["branch"],
        customer=kwargs.pop("customer", shop["customer"]),
        channel="ONLINE",
        status=status,
        payment_status="UNPAID",
        subtotal=Decimal(total),
        grand_total=Decimal(total),
        paid_total=Decimal(kwargs.pop("paid", "0.00")),
        placed_at=kwargs.pop("placed_at", timezone.now()),
        **kwargs,
    )


def _purchase(shop, *, total: str = "5000.00", paid: str = "0.00", **kwargs):
    supplier = kwargs.pop("supplier", None) or factories.supplier(
        payment_terms_days=kwargs.pop("terms", 0)
    )
    return PurchaseOrder.objects.create(
        number=factories.unique("PO-"),
        supplier=supplier,
        branch=shop["branch"],
        status=kwargs.pop("status", PurchaseOrderStatus.RECEIVED),
        subtotal=Decimal(total),
        grand_total=Decimal(total),
        paid_total=Decimal(paid),
        ordered_at=kwargs.pop("ordered_at", timezone.now()),
        **kwargs,
    )


class TestReceivables:
    def test_an_unpaid_delivered_order_is_money_owed(self, shop):
        _unpaid_order(shop, total="1200.00")

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("1200.00")
        assert result["party_count"] == 1
        assert result["parties"][0]["outstanding"] == Decimal("1200.00")

    def test_a_part_paid_order_owes_only_the_remainder(self, shop):
        _unpaid_order(shop, total="1000.00", paid="400.00")

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("600.00")

    def test_a_fully_paid_order_owes_nothing(self, shop):
        _unpaid_order(shop, total="1000.00", paid="1000.00")

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("0.00")
        assert result["parties"] == []

    def test_a_pending_basket_is_not_a_debt(self, shop):
        _unpaid_order(shop, total="1000.00", status=OrderStatus.PENDING)

        result = selectors.receivables(branch=shop["branch"])

        # Nobody has agreed to buy anything yet.
        assert result["total"] == Decimal("0.00")

    def test_a_cancelled_order_is_not_a_debt(self, shop):
        _unpaid_order(shop, total="1000.00", status=OrderStatus.CANCELLED)

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("0.00")

    def test_a_refunded_order_is_not_a_debt(self, shop):
        _unpaid_order(shop, total="1000.00", status=OrderStatus.REFUNDED)

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("0.00")

    def test_a_paid_pos_sale_never_appears(self, shop):
        variant = shop["variants"][0]
        pos.create_pos_sale(
            branch=shop["branch"],
            actor=shop["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=1)],
                payments=[
                    PaymentInput(
                        method=PaymentMethod.CASH,
                        amount=variant.price,
                        tendered_amount=variant.price,
                    )
                ],
            ),
        )

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("0.00")

    def test_orders_group_under_one_customer(self, shop):
        _unpaid_order(shop, total="1000.00")
        _unpaid_order(shop, total="500.00")

        result = selectors.receivables(branch=shop["branch"])

        assert result["party_count"] == 1
        assert result["document_count"] == 2
        assert result["parties"][0]["outstanding"] == Decimal("1500.00")

    def test_parties_are_listed_largest_debt_first(self, shop):
        other = factories.customer()
        _unpaid_order(shop, total="500.00")
        _unpaid_order(shop, total="9000.00", customer=other)

        result = selectors.receivables(branch=shop["branch"])

        assert [row["outstanding"] for row in result["parties"]] == [
            Decimal("9000.00"),
            Decimal("500.00"),
        ]

    def test_a_counter_sale_owes_under_its_walk_in_customer(self, shop):
        """`Order.customer` is NOT NULL -- the POS creates a walk-in row."""
        walk_in = pos.walk_in_customer(shop["branch"])
        _unpaid_order(shop, total="750.00", customer=walk_in)

        result = selectors.receivables(branch=shop["branch"])

        assert result["total"] == Decimal("750.00")
        assert result["parties"][0]["party_id"] == str(walk_in.pk)


class TestReceivableAgeing:
    def test_a_fresh_order_is_current(self, shop):
        _unpaid_order(shop, total="1000.00")

        result = selectors.receivables(branch=shop["branch"])

        assert result["ageing"]["current"] == Decimal("1000.00")
        assert result["ageing"]["over_90"] == Decimal("0.00")

    def test_an_old_order_falls_into_the_right_bucket(self, shop):
        _unpaid_order(shop, total="1000.00", placed_at=timezone.now() - timedelta(days=45))

        result = selectors.receivables(branch=shop["branch"])

        assert result["ageing"]["d31_60"] == Decimal("1000.00")
        assert result["ageing"]["current"] == Decimal("0.00")

    def test_a_very_old_order_lands_in_the_open_ended_bucket(self, shop):
        _unpaid_order(shop, total="1000.00", placed_at=timezone.now() - timedelta(days=400))

        result = selectors.receivables(branch=shop["branch"])

        assert result["ageing"]["over_90"] == Decimal("1000.00")
        assert result["parties"][0]["oldest_days"] >= 400

    def test_the_buckets_sum_to_the_total(self, shop):
        _unpaid_order(shop, total="100.00")
        _unpaid_order(shop, total="200.00", placed_at=timezone.now() - timedelta(days=40))
        _unpaid_order(shop, total="300.00", placed_at=timezone.now() - timedelta(days=75))
        _unpaid_order(shop, total="400.00", placed_at=timezone.now() - timedelta(days=200))

        result = selectors.receivables(branch=shop["branch"])

        assert sum(result["ageing"].values()) == result["total"] == Decimal("1000.00")

    def test_a_clock_that_steps_backwards_does_not_lose_a_day(self, shop):
        """Ageing counts calendar days, so sub-second skew cannot cost a day.

        `(now - placed).days` floors towards negative infinity, so reading the
        clock a microsecond *behind* the instant the order was written used to
        report 44 days instead of 45.  That is not hypothetical here: the
        container clock steps backwards by 0.1-80 ms several times a minute
        (roadmap D46).  `as_of` pins the skew so the invariant is asserted
        rather than waited for.
        """
        noon = timezone.localtime().replace(hour=12, minute=0, second=0, microsecond=0)
        _unpaid_order(shop, total="1000.00", placed_at=noon - timedelta(days=45))

        result = selectors.receivables(
            branch=shop["branch"], as_of=noon - timedelta(microseconds=1)
        )

        assert result["parties"][0]["oldest_days"] == 45
        assert result["ageing"]["d31_60"] == Decimal("1000.00")


class TestPayables:
    def test_an_unpaid_received_purchase_is_money_owed(self, shop):
        _purchase(shop, total="5000.00")

        result = selectors.payables(branch=shop["branch"])

        assert result["total"] == Decimal("5000.00")
        assert result["party_count"] == 1

    def test_a_part_paid_purchase_owes_only_the_remainder(self, shop):
        _purchase(shop, total="5000.00", paid="2000.00")

        result = selectors.payables(branch=shop["branch"])

        assert result["total"] == Decimal("3000.00")

    def test_a_draft_purchase_order_is_not_a_liability(self, shop):
        _purchase(shop, total="5000.00", status=PurchaseOrderStatus.DRAFT)

        result = selectors.payables(branch=shop["branch"])

        # Nothing has been committed to the supplier yet.
        assert result["total"] == Decimal("0.00")

    def test_a_cancelled_purchase_order_is_not_a_liability(self, shop):
        _purchase(shop, total="5000.00", status=PurchaseOrderStatus.CANCELLED)

        result = selectors.payables(branch=shop["branch"])

        assert result["total"] == Decimal("0.00")


class TestPayableAgeingUsesTerms:
    def test_a_supplier_on_terms_is_not_overdue_on_day_one(self, shop):
        supplier = factories.supplier(payment_terms_days=30)
        _purchase(shop, total="5000.00", supplier=supplier)

        result = selectors.payables(branch=shop["branch"])

        assert result["parties"][0]["oldest_days"] == 0
        assert result["ageing"]["current"] == Decimal("5000.00")

    def test_ageing_runs_from_the_due_date_not_the_order_date(self, shop):
        supplier = factories.supplier(payment_terms_days=30)
        _purchase(
            shop,
            total="5000.00",
            supplier=supplier,
            ordered_at=timezone.now() - timedelta(days=40),
        )

        result = selectors.payables(branch=shop["branch"])

        # 40 days old, 30 days of terms -> 10 days overdue, not 40.
        assert result["parties"][0]["oldest_days"] == 10
        assert result["ageing"]["current"] == Decimal("5000.00")

    def test_due_on_receipt_ages_from_the_order_date(self, shop):
        supplier = factories.supplier(payment_terms_days=0)
        _purchase(
            shop,
            total="5000.00",
            supplier=supplier,
            ordered_at=timezone.now() - timedelta(days=45),
        )

        result = selectors.payables(branch=shop["branch"])

        assert result["parties"][0]["oldest_days"] == 45
        assert result["ageing"]["d31_60"] == Decimal("5000.00")

    def test_a_clock_that_steps_backwards_does_not_lose_a_day(self, shop):
        """The same invariant on the payable side, where it actually bit.

        `test_ageing_runs_from_the_due_date_not_the_order_date` above failed
        intermittently in a full-suite run -- `assert 9 == 10` -- because the
        wall clock stepped back between writing the purchase and reading the
        report, and a floored `timedelta.days` turns any backward step into a
        whole missing day.  Roadmap D46.
        """
        noon = timezone.localtime().replace(hour=12, minute=0, second=0, microsecond=0)
        supplier = factories.supplier(payment_terms_days=30)
        _purchase(
            shop,
            total="5000.00",
            supplier=supplier,
            ordered_at=noon - timedelta(days=40),
        )

        # A microsecond *behind* the instant the purchase was written.
        result = selectors.payables(branch=shop["branch"], as_of=noon - timedelta(microseconds=1))

        assert result["parties"][0]["oldest_days"] == 10


class TestNetPosition:
    def test_it_is_what_is_owed_in_minus_what_is_owed_out(self, shop):
        _unpaid_order(shop, total="3000.00")
        _purchase(shop, total="5000.00")

        ledger = selectors.party_ledger(branch=shop["branch"])

        assert ledger["receivable"]["total"] == Decimal("3000.00")
        assert ledger["payable"]["total"] == Decimal("5000.00")
        assert ledger["net_position"] == Decimal("-2000.00")

    def test_an_empty_ledger_is_zero_not_a_crash(self, shop):
        ledger = selectors.party_ledger(branch=shop["branch"])

        assert ledger["net_position"] == Decimal("0.00")
        assert ledger["receivable"]["parties"] == []
        assert ledger["payable"]["parties"] == []


class TestNoStoredBalance:
    def test_paying_an_order_changes_the_figure_with_no_column_to_update(self, shop):
        order = _unpaid_order(shop, total="1000.00")
        assert selectors.receivables(branch=shop["branch"])["total"] == Decimal("1000.00")

        order.paid_total = Decimal("1000.00")
        order.save(update_fields=["paid_total"])

        # Nothing was recalculated or cached: the sum is the documents.
        assert selectors.receivables(branch=shop["branch"])["total"] == Decimal("0.00")

    def test_customer_carries_no_balance_field(self):
        from customers.models import Customer

        fields = {field.name for field in Customer._meta.get_fields()}
        assert "balance" not in fields
        assert "outstanding" not in fields


class TestEndpoint:
    def test_the_owner_can_read_it(self, shop, owner, auth_client):
        _unpaid_order(shop, total="1000.00")

        response = auth_client(owner).get("/api/v1/party-ledger/")

        assert response.status_code == 200
        assert response.data["receivable"]["party_count"] == 1

    def test_money_leaves_as_strings(self, shop, owner, auth_client):
        _unpaid_order(shop, total="1000.00")
        _purchase(shop, total="5000.00")

        payload = json.loads(auth_client(owner).get("/api/v1/party-ledger/").content)

        assert payload["receivable"]["total"] == "1000.00"
        assert payload["payable"]["total"] == "5000.00"
        assert payload["net_position"] == "-4000.00"
        assert isinstance(payload["receivable"]["ageing"]["current"], str)

    def test_a_cashier_cannot_read_it(self, shop, cashier, auth_client):
        """A cashier holds `finance.view` so they can pick an account for a
        sale. That must not also hand them every customer's debt and every
        supplier's balance -- this screen is gated on `reports.financial`.
        """
        response = auth_client(cashier).get("/api/v1/party-ledger/")

        assert response.status_code == 403

    def test_a_manager_can_read_it(self, shop, manager, auth_client):
        _unpaid_order(shop, total="1000.00")

        response = auth_client(manager).get("/api/v1/party-ledger/")

        assert response.status_code == 200

    def test_an_anonymous_request_is_refused(self, shop, api):
        response = api.get("/api/v1/party-ledger/")

        assert response.status_code in {401, 403}
