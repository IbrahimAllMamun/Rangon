"""The two trails everything writes and nothing read back.

`audit-logs/` and `inventory-transactions/` were complete, registered APIs with
no screen in front of them (roadmap, "Still API-only"). They were audited
before the screens were built over them, as this project keeps recommending.
Every test here was run against `main` first: the audit log's branch scoping
(D85) failed there with the defect itself, the rest failed for want of the
filter or field the screens need, and the controls passed.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import audit
from core.models import AuditLog
from inventory import services as inventory_services
from inventory.models import InventoryTransaction, TransactionType
from purchasing.services import (
    PurchaseLine,
    create_purchase_order,
    receive_purchase,
    send_purchase_order,
)
from tests import factories

pytestmark = pytest.mark.django_db

LEDGER = "/api/v1/inventory-transactions/"
AUDIT = "/api/v1/audit-logs/"


def _received(*, supplier: Any, branch: Any, variant: Any, quantity: int, unit_cost: str) -> Any:
    """A purchase order raised, sent and received in full: one PURCHASE row."""
    order = create_purchase_order(
        supplier=supplier,
        branch=branch,
        lines=[
            PurchaseLine(variant_id=variant.pk, quantity=quantity, unit_cost=Decimal(unit_cost))
        ],
    )
    send_purchase_order(purchase_order=order)
    receive_purchase(purchase_order=order, lines={item.pk: quantity for item in order.items.all()})
    return order


def _queries(client: Any, url: str) -> int:
    with CaptureQueriesContext(connection) as captured:
        response = client.get(url)
        assert response.status_code == 200, response.data
    return len(captured)


# ------------------------------------------------------------------ ledger --


class TestLedgerDates:
    def test_an_unreadable_date_is_a_400_not_a_500(self, owner: Any, auth_client: Any) -> None:
        """A control: this was already a 400 on `main`, and has to stay one.

        The old `created_at__date__gte="yesterday"` raised Django's own
        ValidationError, which `core.handlers` happens to translate. It now goes
        through `core.dates.parse_window`, like the cash book, and says why.
        """
        response = auth_client(owner).get(f"{LEDGER}?date_from=yesterday")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_a_day_is_the_shops_day(self, owner: Any, branch: Any, auth_client: Any) -> None:
        variant = factories.variant()
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=3, unit_cost=Decimal("100.00")
        )
        today = timezone.localdate().isoformat()

        response = auth_client(owner).get(f"{LEDGER}?date_from={today}&date_to={today}")

        assert response.status_code == 200
        assert response.data["count"] >= 1


class TestLedgerReading:
    def test_types_filters_to_a_family_of_movements(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("100.00")
        )
        inventory_services.write_off(
            branch=branch,
            variant=variant,
            quantity=1,
            transaction_type=TransactionType.DAMAGE,
            reason="Torn seam",
        )

        response = auth_client(owner).get(f"{LEDGER}?variant={variant.pk}&types=DAMAGE,LOSS")

        assert response.status_code == 200
        assert [row["transaction_type"] for row in response.data["results"]] == ["DAMAGE"]

    def test_an_unknown_type_is_refused(self, owner: Any, auth_client: Any) -> None:
        response = auth_client(owner).get(f"{LEDGER}?types=PURCHASE,BANANA")
        assert response.status_code == 400

    def test_a_row_says_which_variant_and_names_its_document(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        """A receipt row links to its purchase order, not to a receipt id nobody can open."""
        _, values = factories.attribute("size", values=["M"])
        variant = factories.variant(attribute_values=values)
        order = _received(
            supplier=factories.supplier(),
            branch=branch,
            variant=variant,
            quantity=4,
            unit_cost="50",
        )

        response = auth_client(owner).get(f"{LEDGER}?variant={variant.pk}")
        row = response.data["results"][0]

        assert row["variant_label"] == "M"
        assert row["document"]["kind"] == "purchase_order"
        assert row["document"]["id"] == str(order.pk)
        assert row["document"]["label"].startswith(order.number)

    def test_a_sale_names_its_order_and_a_count_names_nothing_it_cannot_open(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=5, unit_cost=Decimal("10.00")
        )
        order = factories.order(branch=branch)
        inventory_services.sell(branch=branch, lines=[(variant, 1)], reference_id=order.pk)
        inventory_services.adjust(
            branch=branch, variant=variant, new_on_hand=2, reason="Recounted the shelf"
        )

        rows = auth_client(owner).get(f"{LEDGER}?variant={variant.pk}").data["results"]
        by_type = {row["transaction_type"]: row for row in rows}

        assert by_type["SALE"]["document"] == {
            "kind": "order",
            "id": str(order.pk),
            "label": order.number,
        }
        # A manual adjustment has no document; its reason is what explains it.
        assert by_type["ADJUSTMENT"]["document"] is None
        assert by_type["ADJUSTMENT"]["reason"] == "Recounted the shelf"
        # The direct receipt above names no receipt, so there is nothing to open.
        assert by_type["PURCHASE"]["document"] is None

    def test_one_row_resolves_its_own_document(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        order = _received(
            supplier=factories.supplier(), branch=branch, variant=variant, quantity=2, unit_cost="5"
        )
        row = InventoryTransaction.objects.get(variant=variant)

        response = auth_client(owner).get(f"{LEDGER}{row.pk}/")

        assert response.data["document"]["id"] == str(order.pk)

    def test_a_reference_that_is_not_a_uuid_has_no_link_rather_than_a_500(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        variant = factories.variant()
        inventory_services.receive_stock(
            branch=branch,
            variant=variant,
            quantity=1,
            unit_cost=Decimal("1.00"),
            reference_type="order",
            reference_id="legacy-42",
        )

        response = auth_client(owner).get(f"{LEDGER}?variant={variant.pk}")

        assert response.status_code == 200
        assert response.data["results"][0]["document"] is None

    def test_search_finds_a_product_by_sku_or_name(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        wanted = factories.variant(sku="RGN-FIND-ME")
        other = factories.variant()
        for variant in (wanted, other):
            inventory_services.receive_stock(
                branch=branch, variant=variant, quantity=1, unit_cost=Decimal("1.00")
            )
        client = auth_client(owner)

        by_sku = client.get(f"{LEDGER}?search=find-me").data["results"]
        by_name = client.get(f"{LEDGER}?search={wanted.product.name}").data["results"]

        assert [row["sku"] for row in by_sku] == ["RGN-FIND-ME"]
        assert "RGN-FIND-ME" in {row["sku"] for row in by_name}

    def test_a_branch_bound_reader_sees_only_their_branchs_movements(
        self, shop: Any, auth_client: Any
    ) -> None:
        here, there = shop["branch"], factories.branch(shop["organization"])
        cashier = factories.user("CASHIER", branch_obj=here)
        variant = factories.variant()
        for branch in (here, there):
            inventory_services.receive_stock(
                branch=branch, variant=variant, quantity=1, unit_cost=Decimal("1.00")
            )

        rows = auth_client(cashier).get(f"{LEDGER}?variant={variant.pk}").data["results"]

        assert {row["branch_code"] for row in rows} == {here.code}

    def test_query_count_does_not_grow_with_the_rows(
        self, owner: Any, branch: Any, auth_client: Any
    ) -> None:
        """Every row names a document and a variant label; neither may cost a query a row."""
        client = auth_client(owner)
        supplier = factories.supplier()

        def receive(count: int) -> None:
            for _ in range(count):
                _received(
                    supplier=supplier,
                    branch=branch,
                    variant=factories.variant(),
                    quantity=1,
                    unit_cost="9",
                )

        receive(2)
        _queries(client, LEDGER)  # warm
        few = _queries(client, LEDGER)
        receive(12)
        many = _queries(client, LEDGER)

        assert many == few, f"{few} queries for 2 receipts, {many} for 14: an N+1"


# ------------------------------------------------------------------- audit --


class TestAuditScope:
    def test_a_branch_bound_reader_does_not_see_another_branchs_trail(
        self, shop: Any, auth_client: Any
    ) -> None:
        """Every other staff list is branch-scoped; the audit log was not (D85).

        An accountant confined to one branch could read the other branch's
        trail -- refunds, stock adjustments, payments -- in full.
        """
        here, there = shop["branch"], factories.branch(shop["organization"])
        accountant = factories.user("ACCOUNTANT", branch_obj=here)
        audit.record(action=audit.AuditAction.UPDATE, entity_label="here", branch=here)
        audit.record(action=audit.AuditAction.UPDATE, entity_label="there", branch=there)
        # Organisation-wide changes carry no branch and belong to everyone's view.
        audit.record(action=audit.AuditAction.UPDATE, entity_label="everywhere")

        labels = {row["entity_label"] for row in auth_client(accountant).get(AUDIT).data["results"]}

        assert "here" in labels
        assert "everywhere" in labels
        assert "there" not in labels

    def test_the_owner_sees_every_branch(self, shop: Any, owner: Any, auth_client: Any) -> None:
        there = factories.branch(shop["organization"])
        audit.record(action=audit.AuditAction.UPDATE, entity_label="there", branch=there)

        labels = {row["entity_label"] for row in auth_client(owner).get(AUDIT).data["results"]}

        assert "there" in labels

    def test_needs_the_audit_permission(self, manager: Any, auth_client: Any) -> None:
        assert auth_client(manager).get(AUDIT).status_code == 403


class TestAuditReading:
    def test_one_objects_history(self, owner: Any, auth_client: Any) -> None:
        product = factories.product()
        other = factories.product()
        audit.record(action=audit.AuditAction.UPDATE, entity=product, new_values={"a": 1})
        audit.record(action=audit.AuditAction.UPDATE, entity=other, new_values={"b": 2})

        response = auth_client(owner).get(f"{AUDIT}?entity_id={product.pk}")

        assert [row["entity_id"] for row in response.data["results"]] == [str(product.pk)]

    def test_a_date_window_in_the_shops_days(self, owner: Any, auth_client: Any) -> None:
        old = audit.record(action=audit.AuditAction.UPDATE, entity_label="old")
        AuditLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=40))
        audit.record(action=audit.AuditAction.UPDATE, entity_label="new")
        since = (timezone.localdate() - timedelta(days=7)).isoformat()

        labels = {
            row["entity_label"]
            for row in auth_client(owner).get(f"{AUDIT}?date_from={since}").data["results"]
        }

        assert "new" in labels
        assert "old" not in labels

    def test_an_unreadable_date_is_a_400(self, owner: Any, auth_client: Any) -> None:
        assert auth_client(owner).get(f"{AUDIT}?date_to=soon").status_code == 400

    def test_search_finds_who_what_and_why(self, owner: Any, auth_client: Any) -> None:
        audit.record(action=audit.AuditAction.UPDATE, entity_label="RGN-WEB-000042", reason="x")
        audit.record(action=audit.AuditAction.UPDATE, entity_label="other", reason="damaged box")

        client = auth_client(owner)
        by_label = client.get(f"{AUDIT}?search=000042").data["results"]
        by_reason = client.get(f"{AUDIT}?search=damaged").data["results"]

        assert [row["entity_label"] for row in by_label] == ["RGN-WEB-000042"]
        assert [row["entity_label"] for row in by_reason] == ["other"]

    def test_query_count_does_not_grow_with_the_rows(self, owner: Any, auth_client: Any) -> None:
        client = auth_client(owner)
        for _ in range(3):
            audit.record(action=audit.AuditAction.UPDATE, entity_label="x", actor=owner)
        _queries(client, AUDIT)
        few = _queries(client, AUDIT)
        for _ in range(20):
            audit.record(action=audit.AuditAction.UPDATE, entity_label="x", actor=owner)
        many = _queries(client, AUDIT)

        assert many == few


def test_the_ledger_matches_what_it_says_it_is(owner: Any, branch: Any, auth_client: Any) -> None:
    """The screen is only honest if the rows it reads add up to the figure beside them."""
    variant = factories.variant()
    inventory_services.receive_stock(
        branch=branch, variant=variant, quantity=10, unit_cost=Decimal("100.00")
    )
    inventory_services.write_off(
        branch=branch,
        variant=variant,
        quantity=2,
        transaction_type=TransactionType.LOSS,
        reason="Missing at count",
    )

    rows = auth_client(owner).get(f"{LEDGER}?variant={variant.pk}").data["results"]

    assert sum(row["quantity"] for row in rows) == variant.inventory.get(branch=branch).on_hand
    assert rows[0]["on_hand_after"] == 8
    assert InventoryTransaction.objects.filter(variant=variant).count() == len(rows)
