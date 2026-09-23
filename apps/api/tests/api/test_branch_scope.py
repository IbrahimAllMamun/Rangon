"""Staff confined to one branch act on it and read it, and nothing else (D93, D94).

`docs/operations/security.md` claims "branch scoping on every branch-bearing
queryset". Checked a viewset at a time that claim had already been wrong for
shipments (D68-D71) and the audit log (D85). Measured all at once on
2026-09-23, with a manager bound to branch A and one of everything at branch B:

* **D94, write** -- `POST stock-transfers/` with B as the source: **201**, and
  B's shelf went 10 -> 8. The source branch was looked up bare, so anyone
  holding `inventory.transfer` at one branch could empty another's into their
  own, on paper.
* **D94, read** -- `GET stock-transfers/` listed a B -> C transfer to every
  role at A. It was the one list in the app with no scope at all.
* **D93** -- every report took `?branch=<B>` at its word: sales, dashboard,
  stock valuation, stock movement, expenses, business summary, returns. And an
  id matching nothing came back as `None`, which means *every* branch -- so a
  random UUID was enough, no need to know B's.

The last test in this file is the sweep that found them, kept: it walks every
parameter-free GET route, including ones added after it was written.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from django.utils import timezone

from accounts.models import RoleCode, Status
from core import audit
from finance import services as finance_services
from finance.models import AccountKind
from inventory import services as inventory_services
from inventory.models import Inventory, StockCount
from notifications.models import Notification, NotificationType
from orders.models import AbandonedCheckout, HeldSale, ReturnReason, ReturnRequest
from purchasing import services as purchasing_services
from tests import factories

pytestmark = pytest.mark.django_db

WINDOW = "date_from=2020-01-01&date_to=2030-12-31"


@pytest.fixture
def shops() -> dict[str, Any]:
    org = factories.organization()
    alpha = factories.branch(org, name="Alpha", code="ALPHA")
    bravo = factories.branch(org, name="Bravo", code="BRAVO")
    charlie = factories.branch(org, name="Charlie", code="CHARLIE")
    variant = factories.variant(price="1000.00")
    factories.stock(variant, alpha, 4, "100.00")
    factories.stock(variant, bravo, 10, "400.00")
    return {
        "org": org,
        "alpha": alpha,
        "bravo": bravo,
        "charlie": charlie,
        "variant": variant,
        "owner": factories.user(RoleCode.OWNER, branch_obj=alpha),
        "manager": factories.user(RoleCode.MANAGER, branch_obj=alpha),
    }


def _on_hand(branch: Any, variant: Any) -> int:
    return Inventory.objects.get(branch=branch, variant=variant).on_hand


def _transfer(client: Any, source: Any, target: Any, variant: Any, quantity: int = 2) -> Any:
    return client.post(
        "/api/v1/stock-transfers/",
        {
            "source_branch": str(source.pk),
            "target_branch": str(target.pk),
            "lines": [{"variant": str(variant.pk), "quantity": quantity}],
        },
        format="json",
    )


class TestStockTransfers:
    def test_staff_cannot_send_another_branchs_stock(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """Fails on `main`: 201, and Bravo's shelf drops by two."""
        for role in (RoleCode.MANAGER, RoleCode.INVENTORY_MANAGER):
            client = auth_client(factories.user(role, branch_obj=shops["alpha"]))

            response = _transfer(client, shops["bravo"], shops["alpha"], shops["variant"])

            assert response.status_code == 403, role
        assert _on_hand(shops["bravo"], shops["variant"]) == 10

    def test_staff_can_send_their_own_branchs_stock(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """The control: the target may be any branch -- that is a transfer."""
        response = _transfer(
            auth_client(shops["manager"]), shops["alpha"], shops["bravo"], shops["variant"]
        )

        assert response.status_code == 201, response.data
        assert _on_hand(shops["alpha"], shops["variant"]) == 2

    def test_an_owner_can_send_any_branchs_stock(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        response = _transfer(
            auth_client(shops["owner"]), shops["bravo"], shops["charlie"], shops["variant"]
        )

        assert response.status_code == 201, response.data
        assert _on_hand(shops["bravo"], shops["variant"]) == 8

    def test_a_closed_branch_cannot_receive(self, shops: dict[str, Any], auth_client: Any) -> None:
        shops["charlie"].status = Status.INACTIVE
        shops["charlie"].save(update_fields=["status"])

        response = _transfer(
            auth_client(shops["manager"]), shops["alpha"], shops["charlie"], shops["variant"]
        )

        assert response.status_code == 400
        assert "target_branch" in response.data["error"]["details"]
        assert _on_hand(shops["alpha"], shops["variant"]) == 4

    def test_the_list_shows_each_branch_its_own_transfers_from_either_end(
        self, shops: dict[str, Any], auth_client: Any
    ) -> None:
        """Fails on `main`: Alpha sees Bravo -> Charlie."""
        owner = shops["owner"]
        outgoing = inventory_services.transfer(
            source_branch=shops["alpha"],
            target_branch=shops["bravo"],
            lines=[(shops["variant"].pk, 1)],
            actor=owner,
        )
        incoming = inventory_services.transfer(
            source_branch=shops["bravo"],
            target_branch=shops["alpha"],
            lines=[(shops["variant"].pk, 1)],
            actor=owner,
        )
        elsewhere = inventory_services.transfer(
            source_branch=shops["bravo"],
            target_branch=shops["charlie"],
            lines=[(shops["variant"].pk, 1)],
            actor=owner,
        )

        listed = auth_client(shops["manager"]).get("/api/v1/stock-transfers/").data
        rows = listed["results"] if isinstance(listed, dict) else listed
        seen = {row["id"] for row in rows}

        assert seen == {str(outgoing.pk), str(incoming.pk)}
        assert str(elsewhere.pk) not in seen
        detail = auth_client(shops["manager"]).get(f"/api/v1/stock-transfers/{elsewhere.pk}/")
        assert detail.status_code == 404


class TestReports:
    @pytest.fixture
    def bravo_trades(self, shops: dict[str, Any]) -> None:
        factories.order(
            branch=shops["bravo"],
            status="DELIVERED",
            payment_status="PAID",
            placed_at=timezone.now(),
            subtotal=Decimal("7777.77"),
            grand_total=Decimal("7777.77"),
        )

    REPORTS = [
        "dashboard",
        "sales",
        "products/performance",
        "inventory/valuation",
        "inventory/movement",
        "purchases",
        "returns",
        "profit",
        "expenses",
        "business-summary",
        "vat",
    ]

    @pytest.mark.parametrize("report", REPORTS)
    def test_naming_another_branch_is_refused(
        self, shops: dict[str, Any], auth_client: Any, report: str
    ) -> None:
        """Fails on `main`: 200, with Bravo's figures in it."""
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shops["alpha"])
        for user in (shops["manager"], accountant):
            response = auth_client(user).get(
                f"/api/v1/reports/{report}/?{WINDOW}&branch={shops['bravo'].pk}"
            )

            assert response.status_code == 403, (report, user.role.code)

    def test_an_unknown_branch_is_not_every_branch(
        self, shops: dict[str, Any], auth_client: Any, bravo_trades: None
    ) -> None:
        """Fails on `main`: 200 with Bravo's ৳7,777.77 -- any UUID was all branches."""
        response = auth_client(shops["manager"]).get(
            f"/api/v1/reports/sales/?{WINDOW}&branch={uuid.uuid4()}"
        )

        assert response.status_code == 404
        assert "7777.77" not in response.content.decode()

    def test_naming_your_own_branch_is_fine(self, shops: dict[str, Any], auth_client: Any) -> None:
        response = auth_client(shops["manager"]).get(
            f"/api/v1/reports/sales/?{WINDOW}&branch={shops['alpha'].pk}"
        )

        assert response.status_code == 200

    def test_an_owner_may_report_on_any_branch(
        self, shops: dict[str, Any], auth_client: Any, bravo_trades: None
    ) -> None:
        """The control: the refusal is for staff confined to one branch."""
        response = auth_client(shops["owner"]).get(
            f"/api/v1/reports/sales/?{WINDOW}&branch={shops['bravo'].pk}"
        )

        assert response.status_code == 200
        assert "7777.77" in response.content.decode()

    def test_a_closed_branch_can_still_be_reported_on(
        self, shops: dict[str, Any], auth_client: Any, bravo_trades: None
    ) -> None:
        """Its history happened; closing it must not make it unreportable."""
        shops["bravo"].status = Status.INACTIVE
        shops["bravo"].save(update_fields=["status"])

        response = auth_client(shops["owner"]).get(
            f"/api/v1/reports/sales/?{WINDOW}&branch={shops['bravo'].pk}"
        )

        assert response.status_code == 200
        assert "7777.77" in response.content.decode()


# --------------------------------------------------------------------------- sweep


def _routes() -> list[str]:
    """Every parameter-free GET-able path under /api/v1/, from the URLconf itself."""

    def walk(patterns: Any, prefix: str = "") -> Any:
        for pattern in patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern.url_patterns, prefix + str(pattern.pattern))
            elif isinstance(pattern, URLPattern):
                yield prefix + str(pattern.pattern)

    found = set()
    for route in walk(get_resolver().url_patterns):
        if "<" in route or "(?P" in route:
            continue  # takes a parameter; its queryset is the list's, checked here
        path = route.replace("^", "").replace("$", "").replace("\\", "")
        if path.startswith("api/v1/"):
            found.add("/" + path)
    return sorted(found)


#: Routes whose purpose is to name every branch or every member of staff, with
#: the markers they are allowed to show and why.
EXPECTED: dict[str, set[str]] = {
    # The branch directory. A transfer form has to offer the other branches.
    "/api/v1/branches/": {"branch"},
    "/api/v1/organization/": {"branch"},
    # DECISION REQUIRED (business-rules.md §7.1): the staff list spans branches,
    # the way organisation-wide audit entries do (D85). A row names its branch.
    "/api/v1/users/": {"branch", "staff"},
}


def test_no_route_shows_one_branch_anothers_rows(auth_client: Any) -> None:
    """Every GET route, asked by staff at Alpha, for anything that exists only at Bravo.

    Fails on `main` at `stock-transfers/` and at `reports/returns/?branch=`.
    Aggregate reports leak figures rather than ids, which this cannot see --
    `TestReports` covers those by status code.
    """
    org = factories.organization()
    alpha = factories.branch(org, name="Alpha", code="ALPHA")
    bravo = factories.branch(org, name="Bravo", code="BRAVO")
    charlie = factories.branch(org, name="Charlie", code="CHARLIE")
    owner = factories.user(RoleCode.OWNER, branch_obj=alpha)
    variant = factories.variant(price="1000.00")
    factories.stock(variant, alpha, 10, "400.00")
    factories.stock(variant, bravo, 10, "400.00")

    order = factories.order(branch=bravo)
    cash = factories.account(bravo, kind=AccountKind.CASH, opening_balance="5000.00")
    bank = factories.account(bravo, kind=AccountKind.BANK, opening_balance="0.00", is_default=False)
    purchase = purchasing_services.create_purchase_order(
        supplier=factories.supplier(),
        branch=bravo,
        lines=[
            purchasing_services.PurchaseLine(
                variant_id=variant.pk, quantity=1, unit_cost=Decimal("100.00")
            )
        ],
        actor=owner,
    )
    only_at_bravo: dict[str, str] = {
        "branch": str(bravo.pk),
        "order": str(order.pk),
        "order number": order.number,
        "account": str(cash.pk),
        "cash movement": str(
            finance_services.record_movement(
                account=cash, transaction_type="DEPOSIT", amount=Decimal("10.00"), actor=owner
            ).pk
        ),
        "account transfer": str(
            finance_services.transfer(
                source_account=cash, target_account=bank, amount=Decimal("5.00"), actor=owner
            ).pk
        ),
        "expense": str(factories.expense(bravo, cash).pk),
        "stock movement": str(
            inventory_services.write_off(
                branch=bravo,
                variant=variant,
                quantity=1,
                transaction_type="DAMAGE",
                reason="Dropped",
                actor=owner,
            ).pk
        ),
        "stock transfer": str(
            inventory_services.transfer(
                source_branch=bravo, target_branch=charlie, lines=[(variant.pk, 1)], actor=owner
            ).pk
        ),
        "stock count": str(StockCount.objects.create(number="SC-BRAVO-1", branch=bravo).pk),
        "purchase order": str(purchase.pk),
        "return": str(
            ReturnRequest.objects.create(
                number="RR-BRAVO-1", order=order, reason=ReturnReason.choices[0][0]
            ).pk
        ),
        "abandoned checkout": str(
            AbandonedCheckout.objects.create(phone="1712345678", branch=bravo).pk
        ),
        "held sale": str(HeldSale.objects.create(branch=bravo, payload={}).pk),
        "notification": str(
            Notification.objects.create(
                branch=bravo,
                permission_code="orders.view",
                notification_type=NotificationType.choices[0][0],
                title="For Bravo",
            ).pk
        ),
        "staff": str(factories.user(RoleCode.CASHIER, branch_obj=bravo).pk),
    }
    audit.record(action=audit.AuditAction.LOGIN, entity=bravo, actor=owner, branch=bravo)

    leaks = []
    # Between them these two hold every permission a branch-bound role can:
    # the accountant adds `audit.view`, `finance.manage` and `purchases.pay`.
    for role in (RoleCode.MANAGER, RoleCode.ACCOUNTANT):
        client = auth_client(factories.user(role, branch_obj=alpha))
        for route in _routes():
            allowed = EXPECTED.get(route, set())
            for query in ("", f"?{WINDOW}&branch={bravo.pk}"):
                response = client.get(route + query)
                if hasattr(response, "streaming_content"):
                    body = b"".join(response.streaming_content).decode(errors="ignore")
                else:
                    body = response.content.decode(errors="ignore")
                shown = {name for name, marker in only_at_bravo.items() if marker in body}
                if shown - allowed:
                    leaks.append((role, route + query, sorted(shown - allowed)))

    assert leaks == []
