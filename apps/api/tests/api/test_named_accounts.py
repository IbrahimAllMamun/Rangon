"""An account the caller names is one this money can actually move through (D95).

Found by using the supplier payment screen, which offers an owner every
branch's accounts, and then asking the API what it would accept. Measured on
2026-09-24 with an accountant, a manager and a cashier all bound to branch A:

    supplier payment, A's order, from B's cash drawer ..... 201   B 5000 -> 4900
    supplier payment against B's order ..................... 201
    cheque paid out of a cash drawer ....................... 201
    POS sale at A, takings into B's drawer ................. 201   B 5000 -> 6000
    refund at A, out of B's drawer ......................... 201   B 6000 -> 5900
    GET supplier-payments/ ................................. every branch's payments

The POS row is the one that matters most: a cashier sends the sale to another
branch's drawer, pockets the notes, and their own drawer reconciles to the taka.

`resolve_account` already picked the right account when the caller said
nothing -- the branch's own, of the method's kind. Naming one skipped both
rules. `finance.services.check_named_account` now applies them where every
one of these paths posts money, so a path added later inherits the check.

Run against `main`, every refusal below fails with a 201 and the controls pass.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from accounts.models import RoleCode
from finance.models import Account, AccountKind
from orders.models import PaymentMethod
from purchasing import services as purchasing_services
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def shops() -> dict[str, Any]:
    org = factories.organization()
    alpha = factories.branch(org, name="Alpha", code="ALPHA")
    bravo = factories.branch(org, name="Bravo", code="BRAVO")
    variant = factories.variant(price="1000.00")
    factories.stock(variant, alpha, 20, "400.00")
    return {
        "alpha": alpha,
        "bravo": bravo,
        "variant": variant,
        "owner": factories.user(RoleCode.OWNER, branch_obj=alpha),
        "cash_a": factories.account(alpha, kind=AccountKind.CASH, opening_balance="5000.00"),
        "bank_a": factories.account(
            alpha, kind=AccountKind.BANK, opening_balance="5000.00", is_default=True
        ),
        "cash_b": factories.account(bravo, kind=AccountKind.CASH, opening_balance="5000.00"),
    }


def balance(account: Account) -> Decimal:
    return Account.objects.get(pk=account.pk).balance


def _sale(
    client: Any, shops: dict[str, Any], method: str, account: Account | None, key: str
) -> Any:
    payment: dict[str, Any] = {"method": method, "amount": "1000.00"}
    if method == PaymentMethod.CASH:
        payment["tendered_amount"] = "1000.00"
    if account is not None:
        payment["account"] = str(account.pk)
    return client.post(
        "/api/v1/pos/sales/",
        {
            "lines": [{"variant": str(shops["variant"].pk), "quantity": 1}],
            "payments": [payment],
            "register": "REG-01",
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )


class TestSales:
    def test_takings_cannot_go_into_another_branchs_drawer(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """Fails on `main`: 201, and Bravo's drawer is up by the sale."""
        cashier = factories.user(RoleCode.CASHIER, branch_obj=shops["alpha"])

        response = _sale(auth_client(cashier), shops, PaymentMethod.CASH, shops["cash_b"], "s-1")

        assert response.status_code == 400
        assert "account" in response.data["error"]["details"]
        assert balance(shops["cash_b"]) == Decimal("5000.00")
        assert balance(shops["cash_a"]) == Decimal("5000.00")

    def test_card_takings_cannot_go_into_the_cash_drawer(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """Fails on `main`: the drawer counts ৳1,000 of card money as cash."""
        cashier = factories.user(RoleCode.CASHIER, branch_obj=shops["alpha"])

        response = _sale(auth_client(cashier), shops, PaymentMethod.CARD, shops["cash_a"], "s-2")

        assert response.status_code == 400
        assert balance(shops["cash_a"]) == Decimal("5000.00")

    def test_naming_the_branchs_own_drawer_still_works(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """The control: choosing where a sale lands is a cashier's to do."""
        cashier = factories.user(RoleCode.CASHIER, branch_obj=shops["alpha"])

        response = _sale(auth_client(cashier), shops, PaymentMethod.CASH, shops["cash_a"], "s-3")

        assert response.status_code == 201, response.data
        assert balance(shops["cash_a"]) == Decimal("6000.00")


class TestRefunds:
    def _card_sale(self, shops: dict[str, Any], auth_client: Any) -> str:
        cashier = factories.user(RoleCode.CASHIER, branch_obj=shops["alpha"])
        response = _sale(auth_client(cashier), shops, PaymentMethod.CARD, None, "card-sale")
        assert response.status_code == 201, response.data
        assert balance(shops["bank_a"]) == Decimal("6000.00")
        return str(response.data["id"])

    def _refund(self, shops: dict[str, Any], auth_client: Any, order: str, **body: Any) -> Any:
        manager = factories.user(RoleCode.MANAGER, branch_obj=shops["alpha"])
        return auth_client(manager).post(
            f"/api/v1/orders/{order}/refunds/",
            {"amount": "100.00", "reason": "Changed mind", **body},
            format="json",
            HTTP_IDEMPOTENCY_KEY=f"r-{len(body)}-{body.get('method', '')}",
        )

    def test_a_refund_cannot_come_out_of_another_branchs_drawer(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """Fails on `main`: 201, and Bravo's drawer pays for Alpha's refund."""
        order = self._card_sale(shops, auth_client)

        response = self._refund(
            shops, auth_client, order, method="CASH", account=str(shops["cash_b"].pk)
        )

        assert response.status_code == 400
        assert balance(shops["cash_b"]) == Decimal("5000.00")

    def test_a_card_sale_refunded_in_cash_comes_out_of_the_drawer(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """Fails on `main`: the cash was taken out of the *bank* on paper.

        The payment's account is the default only when the refund goes back
        the way the money came. Notes handed over the counter leave the drawer.
        """
        order = self._card_sale(shops, auth_client)

        response = self._refund(shops, auth_client, order, method="CASH")

        assert response.status_code == 201, response.data
        assert balance(shops["cash_a"]) == Decimal("4900.00")
        assert balance(shops["bank_a"]) == Decimal("6000.00")

    def test_a_card_refund_still_goes_back_through_the_bank(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """The control: the same way back is still the default."""
        order = self._card_sale(shops, auth_client)

        response = self._refund(shops, auth_client, order)

        assert response.status_code == 201, response.data
        assert balance(shops["bank_a"]) == Decimal("5900.00")
        assert balance(shops["cash_a"]) == Decimal("5000.00")


def _received_order(shops: dict[str, Any], branch: Any) -> Any:
    owner = shops["owner"]
    order = purchasing_services.create_purchase_order(
        supplier=factories.supplier(),
        branch=branch,
        lines=[
            purchasing_services.PurchaseLine(
                variant_id=shops["variant"].pk, quantity=2, unit_cost=Decimal("500.00")
            )
        ],
        actor=owner,
    )
    purchasing_services.send_purchase_order(purchase_order=order, actor=owner)
    purchasing_services.receive_purchase(
        purchase_order=order, lines={order.items.first().pk: 2}, actor=owner
    )
    order.refresh_from_db()
    return order


class TestSupplierPayments:
    def _pay(
        self, client: Any, order: Any, account: Account | None = None, method: str = "CASH"
    ) -> Any:
        body: dict[str, Any] = {
            "supplier": str(order.supplier_id),
            "purchase_order": str(order.pk),
            "amount": "100.00",
            "method": method,
        }
        if account is not None:
            body["account"] = str(account.pk)
        return client.post("/api/v1/supplier-payments/", body, format="json")

    @pytest.fixture
    def accountant(self, shops: dict[str, Any], auth_client: Any) -> Any:
        return auth_client(factories.user(RoleCode.ACCOUNTANT, branch_obj=shops["alpha"]))

    def test_another_branchs_order_cannot_be_paid(
        self, shops: dict[str, Any], accountant: Any
    ) -> None:
        """Fails on `main`: 201."""
        order_b = _received_order(shops, shops["bravo"])

        response = self._pay(accountant, order_b)

        assert response.status_code == 403
        order_b.refresh_from_db()
        assert order_b.paid_total == Decimal("0.00")

    def test_an_order_cannot_be_paid_from_another_branchs_drawer(
        self, shops: dict[str, Any], accountant: Any
    ) -> None:
        """Fails on `main`: 201, and Bravo's drawer pays Alpha's supplier."""
        order_a = _received_order(shops, shops["alpha"])

        response = self._pay(accountant, order_a, shops["cash_b"])

        assert response.status_code == 400
        assert balance(shops["cash_b"]) == Decimal("5000.00")

    def test_a_cheque_cannot_come_out_of_a_cash_drawer(
        self, shops: dict[str, Any], accountant: Any
    ) -> None:
        """Fails on `main`: 201. The screen already refused it; the API now agrees."""
        order_a = _received_order(shops, shops["alpha"])

        response = self._pay(accountant, order_a, shops["cash_a"], method="CHEQUE")

        assert response.status_code == 400
        assert balance(shops["cash_a"]) == Decimal("5000.00")

    def test_the_branchs_own_accounts_and_its_default_still_work(
        self, shops: dict[str, Any], accountant: Any
    ) -> None:
        order_a = _received_order(shops, shops["alpha"])

        named = self._pay(accountant, order_a, shops["cash_a"])
        default = self._pay(accountant, order_a)

        assert named.status_code == 201, named.data
        assert default.status_code == 201, default.data
        assert balance(shops["cash_a"]) == Decimal("4800.00")

    def test_the_list_shows_each_branch_its_own_payments(
        self, shops: dict[str, Any], accountant: Any, auth_client: Any
    ) -> None:
        """Fails on `main`: Alpha's accountant read Bravo's payments too."""
        order_a = _received_order(shops, shops["alpha"])
        order_b = _received_order(shops, shops["bravo"])
        owner = auth_client(shops["owner"])
        assert self._pay(owner, order_a).status_code == 201
        assert self._pay(owner, order_b).status_code == 201

        listed = accountant.get("/api/v1/supplier-payments/").data
        rows = listed["results"] if isinstance(listed, dict) else listed

        assert {str(row["purchase_order"]) for row in rows} == {str(order_a.pk)}
        everything = owner.get("/api/v1/supplier-payments/").data
        everything = everything["results"] if isinstance(everything, dict) else everything
        assert len(everything) == 2


class TestTheCheck:
    """`check_named_account` itself, for callers that skip the serializers."""

    def test_a_method_the_ledger_does_not_know_is_refused(self, shops: dict[str, Any]) -> None:
        """No kind to hold the account to would mean any account passes."""
        from core.exceptions import ValidationError
        from finance import services as finance_services

        with pytest.raises(ValidationError) as caught:
            finance_services.check_named_account(
                shops["bank_a"], branch=shops["alpha"], method="BITCOIN"
            )
        assert "method" in caught.value.details

    def test_the_refusal_names_the_kind_wanted(self, shops: dict[str, Any]) -> None:
        from core.exceptions import ValidationError
        from finance import services as finance_services

        with pytest.raises(ValidationError) as caught:
            finance_services.check_named_account(
                shops["cash_a"], branch=shops["alpha"], method="CHEQUE"
            )
        assert caught.value.details == {"account": ["Choose a bank account."]}
        assert "Cheque money moves through a bank account" in str(caught.value)
