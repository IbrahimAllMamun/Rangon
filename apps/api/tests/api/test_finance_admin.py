"""The finance app as the admin screens and the POS actually use it.

Two halves:

  * the endpoints behind /admin/finance -- accounts, the cash book, transfers
    and the manual entry form, including who is allowed to call each;
  * the wiring, which is the point of the phase: a sale, a refund and a
    supplier payment must each land in a named account, and must land there
    exactly once.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from finance.models import Account, AccountKind, AccountTransaction, AccountTransactionType
from orders.models import PaymentMethod, PaymentState
from orders.services import payments as payment_services
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from purchasing import services as purchasing_services
from tests import factories

pytestmark = pytest.mark.django_db


def _sale(shop, *, quantity=2, method=PaymentMethod.CASH, account=None, actor=None):
    variant = shop["variants"][0]
    total = variant.price * quantity
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=actor or shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)],
            payments=[
                PaymentInput(method=method, amount=total, tendered_amount=total, account=account)
            ],
        ),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class TestAccountEndpoints:
    def test_opening_an_account_posts_its_opening_balance(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        response = auth_client(owner).post(
            "/api/v1/accounts/",
            {
                "branch": str(branch.pk),
                "name": "Main Drawer",
                "kind": "CASH",
                "opening_balance": "5000.00",
                "is_default": True,
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        assert Decimal(response.data["balance"]) == Decimal("5000.00")
        account = Account.objects.get(pk=response.data["id"])
        entry = AccountTransaction.objects.get(account=account)
        assert entry.transaction_type == AccountTransactionType.OPENING

    def test_the_balance_field_is_read_only(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        account = factories.account(branch, opening_balance="100.00")

        response = auth_client(owner).patch(
            f"/api/v1/accounts/{account.pk}/", {"balance": "999999.00"}, format="json"
        )

        assert response.status_code == 200
        account.refresh_from_db()
        assert account.balance == Decimal("100.00")

    def test_an_account_cannot_be_deleted(self, owner: Any, branch: Any, auth_client: Any) -> None:
        account = factories.account(branch, opening_balance="100.00")

        response = auth_client(owner).delete(f"/api/v1/accounts/{account.pk}/")

        assert response.status_code == 405
        assert Account.objects.filter(pk=account.pk).exists()

    def test_the_cash_book_is_readable_per_account(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        account = factories.account(branch, opening_balance="1000.00")

        response = auth_client(owner).get(f"/api/v1/accounts/{account.pk}/transactions/")

        assert response.status_code == 200
        assert response.data["count"] == 1
        assert response.data["results"][0]["transaction_type"] == "OPENING"

    def test_cash_position_totals_the_branch(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        factories.account(branch, kind=AccountKind.CASH, opening_balance="1000.00")
        factories.account(branch, kind=AccountKind.BANK, opening_balance="4000.00")

        response = auth_client(owner).get("/api/v1/accounts/cash-position/")

        assert response.status_code == 200
        assert Decimal(str(response.data["total"])) == Decimal("5000.00")

    def test_a_manual_entry_moves_the_balance(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        account = factories.account(branch, opening_balance="1000.00")

        response = auth_client(owner).post(
            "/api/v1/accounts/record-movement/",
            {
                "account": str(account.pk),
                "transaction_type": "WITHDRAWAL",
                "amount": "250.00",
                "reason": "Owner drawing",
            },
            format="json",
        )

        assert response.status_code == 201
        account.refresh_from_db()
        assert account.balance == Decimal("750.00")

    def test_a_sale_payment_cannot_be_entered_by_hand(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        """Entering one manually would double-count money the sale already posted."""
        account = factories.account(branch, opening_balance="1000.00")

        response = auth_client(owner).post(
            "/api/v1/accounts/record-movement/",
            {
                "account": str(account.pk),
                "transaction_type": "SALE_PAYMENT",
                "amount": "250.00",
            },
            format="json",
        )

        assert response.status_code == 400
        account.refresh_from_db()
        assert account.balance == Decimal("1000.00")

    def test_overdrawing_a_drawer_returns_the_documented_envelope(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        account = factories.account(branch, opening_balance="100.00")

        response = auth_client(owner).post(
            "/api/v1/accounts/record-movement/",
            {
                "account": str(account.pk),
                "transaction_type": "WITHDRAWAL",
                "amount": "500.00",
                "reason": "Too much",
            },
            format="json",
        )

        assert response.status_code == 409
        assert response.data["error"]["code"] == "INSUFFICIENT_FUNDS"


class TestTransferEndpoint:
    def test_a_transfer_debits_one_account_and_credits_the_other(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        drawer = factories.account(branch, kind=AccountKind.CASH, opening_balance="5000.00")
        bank = factories.account(branch, kind=AccountKind.BANK, opening_balance="0.00")

        response = auth_client(owner).post(
            "/api/v1/account-transfers/",
            {
                "source_account": str(drawer.pk),
                "target_account": str(bank.pk),
                "amount": "3000.00",
                "notes": "Evening banking",
            },
            format="json",
        )

        assert response.status_code == 201
        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance == Decimal("2000.00")
        assert bank.balance == Decimal("3000.00")

    def test_a_transfer_to_the_same_account_is_refused(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        drawer = factories.account(branch, opening_balance="5000.00")

        response = auth_client(owner).post(
            "/api/v1/account-transfers/",
            {
                "source_account": str(drawer.pk),
                "target_account": str(drawer.pk),
                "amount": "100.00",
            },
            format="json",
        )

        assert response.status_code == 400


class TestFinancePermissions:
    """The backend refuses; the frontend merely hides (CLAUDE.md section 3.4)."""

    def test_a_cashier_may_read_accounts(self, cashier: Any, branch: Any, auth_client: Any) -> None:
        factories.account(branch, opening_balance="100.00")

        assert auth_client(cashier).get("/api/v1/accounts/").status_code == 200

    def test_a_cashier_may_not_open_an_account(
        self, cashier: Any, branch: Any, auth_client: Any
    ) -> None:
        response = auth_client(cashier).post(
            "/api/v1/accounts/",
            {"branch": str(branch.pk), "name": "Sneaky Drawer"},
            format="json",
        )

        assert response.status_code == 403

    def test_a_cashier_may_not_move_money_between_accounts(
        self, cashier: Any, branch: Any, auth_client: Any
    ) -> None:
        drawer = factories.account(branch, kind=AccountKind.CASH, opening_balance="5000.00")
        bank = factories.account(branch, kind=AccountKind.BANK, opening_balance="0.00")

        response = auth_client(cashier).post(
            "/api/v1/account-transfers/",
            {
                "source_account": str(drawer.pk),
                "target_account": str(bank.pk),
                "amount": "100.00",
            },
            format="json",
        )

        assert response.status_code == 403
        drawer.refresh_from_db()
        assert drawer.balance == Decimal("5000.00")

    def test_a_cashier_may_not_correct_a_balance(
        self, cashier: Any, branch: Any, auth_client: Any
    ) -> None:
        account = factories.account(branch, opening_balance="1000.00")

        response = auth_client(cashier).post(
            "/api/v1/accounts/record-movement/",
            {
                "account": str(account.pk),
                "transaction_type": "ADJUSTMENT",
                "amount": "-100.00",
                "reason": "nope",
            },
            format="json",
        )

        assert response.status_code == 403

    def test_an_anonymous_caller_sees_nothing(self, api: Any) -> None:
        assert api.get("/api/v1/accounts/").status_code == 401


# ---------------------------------------------------------------------------
# Wiring: the reason the phase exists
# ---------------------------------------------------------------------------


class TestSalesPostToAnAccount:
    def test_a_cash_sale_lands_in_the_cash_drawer(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")

        order = _sale(shop, quantity=2)

        drawer.refresh_from_db()
        assert drawer.balance == Decimal("2000.00")
        entry = AccountTransaction.objects.get(reference_type="payment")
        assert entry.transaction_type == AccountTransactionType.SALE_PAYMENT
        assert entry.account_id == drawer.pk
        # The payment row itself records where the money went.
        assert order.payments.first().account_id == drawer.pk

    def test_a_card_sale_lands_in_the_bank_not_the_drawer(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")

        _sale(shop, quantity=2, method=PaymentMethod.CARD)

        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance == Decimal("0.00")
        assert bank.balance == Decimal("2000.00")

    def test_an_explicitly_named_account_wins_over_the_default(self, shop: Any) -> None:
        factories.account(shop["branch"], kind=AccountKind.CASH, is_default=True)
        second = factories.account(
            shop["branch"], kind=AccountKind.CASH, name="Counter 2", is_default=False
        )

        _sale(shop, quantity=1, account=second)

        second.refresh_from_db()
        assert second.balance == Decimal("1000.00")

    def test_a_sale_still_completes_when_no_account_exists(self, shop: Any) -> None:
        """A shop that has not set its accounts up must still be able to sell."""
        Account.objects.all().delete()

        order = _sale(shop, quantity=1)

        assert order.payment_status == "PAID"
        assert order.payments.first().account_id is None
        assert not AccountTransaction.objects.exists()

    def test_an_uncaptured_payment_moves_no_money(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        order = _sale(shop, quantity=1)

        payment = payment_services.record_payment(
            order=order,
            method=PaymentMethod.CARD,
            amount=Decimal("100.00"),
            status=PaymentState.PENDING,
        )

        drawer.refresh_from_db()
        assert drawer.balance == Decimal("1000.00")  # the cash sale only
        assert not AccountTransaction.objects.filter(
            reference_type="payment", reference_id=str(payment.pk)
        ).exists()

    def test_capturing_a_pending_payment_is_what_moves_the_money(self, shop: Any) -> None:
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")
        factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        order = _sale(shop, quantity=1)

        payment = payment_services.record_payment(
            order=order,
            method=PaymentMethod.CARD,
            amount=Decimal("100.00"),
            status=PaymentState.PENDING,
        )
        payment_services.capture_payment(payment=payment)

        bank.refresh_from_db()
        assert bank.balance == Decimal("100.00")

    def test_capturing_twice_does_not_post_twice(self, shop: Any) -> None:
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")
        factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        order = _sale(shop, quantity=1)

        payment = payment_services.record_payment(
            order=order,
            method=PaymentMethod.CARD,
            amount=Decimal("100.00"),
            status=PaymentState.PENDING,
        )
        payment_services.capture_payment(payment=payment)
        payment_services.capture_payment(payment=payment)

        bank.refresh_from_db()
        assert bank.balance == Decimal("100.00")
        assert (
            AccountTransaction.objects.filter(
                reference_type="payment", reference_id=str(payment.pk)
            ).count()
            == 1
        )

    def test_a_split_payment_posts_each_tender_to_its_own_account(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")
        variant = shop["variants"][0]

        pos.create_pos_sale(
            branch=shop["branch"],
            actor=shop["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=2)],
                payments=[
                    PaymentInput(
                        method=PaymentMethod.CASH,
                        amount=Decimal("1200.00"),
                        tendered_amount=Decimal("1200.00"),
                    ),
                    PaymentInput(method=PaymentMethod.CARD, amount=Decimal("800.00")),
                ],
            ),
        )

        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance == Decimal("1200.00")
        assert bank.balance == Decimal("800.00")


class TestRefundsComeOutOfAnAccount:
    def test_a_refund_leaves_the_account_the_money_came_into(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        order = _sale(shop, quantity=2)

        payment_services.refund_order(
            order=order, amount=Decimal("500.00"), actor=shop["manager"], reason="Wrong size"
        )

        drawer.refresh_from_db()
        assert drawer.balance == Decimal("1500.00")
        entry = AccountTransaction.objects.get(reference_type="refund")
        assert entry.transaction_type == AccountTransactionType.REFUND
        assert entry.amount == Decimal("-500.00")

    def test_a_card_refund_goes_back_to_the_bank_not_the_drawer(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")
        order = _sale(shop, quantity=2, method=PaymentMethod.CARD)

        payment_services.refund_order(order=order, amount=Decimal("500.00"), actor=shop["manager"])

        drawer.refresh_from_db()
        bank.refresh_from_db()
        assert drawer.balance == Decimal("0.00")
        assert bank.balance == Decimal("1500.00")

    def test_an_idempotent_refund_posts_only_once(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        order = _sale(shop, quantity=2)

        for _ in range(2):
            payment_services.refund_order(
                order=order,
                amount=Decimal("500.00"),
                actor=shop["manager"],
                idempotency_key="refund-1",
            )

        drawer.refresh_from_db()
        assert drawer.balance == Decimal("1500.00")
        assert AccountTransaction.objects.filter(reference_type="refund").count() == 1


class TestSupplierPaymentsComeOutOfAnAccount:
    def test_paying_a_supplier_reduces_the_account(self, shop: Any) -> None:
        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        _sale(shop, quantity=2)  # put 2000 in the drawer
        supplier = factories.supplier()

        purchasing_services.record_supplier_payment(
            supplier=supplier,
            amount=Decimal("750.00"),
            method="CASH",
            branch=shop["branch"],
            actor=shop["manager"],
        )

        drawer.refresh_from_db()
        assert drawer.balance == Decimal("1250.00")
        entry = AccountTransaction.objects.get(reference_type="supplier_payment")
        assert entry.transaction_type == AccountTransactionType.SUPPLIER_PAYMENT
        assert entry.amount == Decimal("-750.00")

    def test_a_drawer_that_cannot_cover_the_payment_refuses_it(self, shop: Any) -> None:
        from core.exceptions import InsufficientFunds

        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="100.00")
        supplier = factories.supplier()

        with pytest.raises(InsufficientFunds):
            purchasing_services.record_supplier_payment(
                supplier=supplier,
                amount=Decimal("5000.00"),
                method="CASH",
                branch=shop["branch"],
                actor=shop["manager"],
            )

        drawer.refresh_from_db()
        assert drawer.balance == Decimal("100.00")
        # The whole service rolled back: no orphan payment row survives.
        from purchasing.models import SupplierPayment

        assert not SupplierPayment.objects.exists()


class TestLedgerStaysConsistent:
    def test_every_balance_still_matches_the_cash_book_after_mixed_activity(
        self, shop: Any
    ) -> None:
        from finance import services as finance_services

        drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="500.00")
        bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")

        order = _sale(shop, quantity=2)
        payment_services.refund_order(order=order, amount=Decimal("300.00"), actor=shop["manager"])
        finance_services.transfer(
            source_account=drawer, target_account=bank, amount=Decimal("1000.00")
        )
        purchasing_services.record_supplier_payment(
            supplier=factories.supplier(),
            amount=Decimal("200.00"),
            method="CASH",
            branch=shop["branch"],
            actor=shop["manager"],
        )

        assert finance_services.verify_integrity() == []

        drawer.refresh_from_db()
        # 500 opening + 2000 sale - 300 refund - 1000 banked - 200 supplier
        assert drawer.balance == Decimal("1000.00")
