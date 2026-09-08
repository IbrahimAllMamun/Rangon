"""Assigning an in-store barcode, which is what a printed label carries.

`POST /variants/{id}/barcode/` existed with no tests. Building the label sheet
over it found two faults, and both matter more here than they would elsewhere,
because the number this endpoint returns gets printed and stuck onto physical
stock:

  * it read, generated and saved without a lock, so two concurrent requests
    both saw an empty barcode, both drew a *different* number from the
    sequence, and the second overwrote the first -- leaving a label on the
    shelf carrying a number the database no longer held;
  * it wrote a permanent product identifier with no audit row, while every
    neighbouring write in the same file records one.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import connections

from accounts.permissions import RoleCode
from catalog.models import ProductVariant
from core.models import AuditLog
from tests import factories

pytestmark = pytest.mark.django_db


def _url(variant: ProductVariant) -> str:
    return f"/api/v1/variants/{variant.pk}/barcode/"


class TestAssigningABarcode:
    def test_a_variant_without_one_is_given_a_valid_ean13(self, shop, auth_client) -> None:
        variant = factories.variant(shop["product"], barcode=None)

        response = auth_client(shop["owner"]).post(_url(variant))

        assert response.status_code == 200
        barcode = response.json()["barcode"]
        assert len(barcode) == 13 and barcode.isdigit()

        # The same weighting the renderer uses; a wrong check digit would draw
        # a symbol no scanner accepts.
        body = barcode[:12]
        total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(body))
        assert int(barcode[12]) == (10 - total % 10) % 10

    def test_it_uses_the_in_store_prefix(self, shop, auth_client) -> None:
        """20-29 is reserved for in-store use, so these never collide with a
        manufacturer's barcode on goods that arrive already labelled."""
        variant = factories.variant(shop["product"], barcode=None)

        barcode = auth_client(shop["owner"]).post(_url(variant)).json()["barcode"]

        assert barcode.startswith("2")

    def test_a_variant_that_has_one_keeps_it(self, shop, auth_client) -> None:
        """Re-issuing would strand every label already stuck on the shelf."""
        variant = factories.variant(shop["product"], barcode="2000000000015")

        response = auth_client(shop["owner"]).post(_url(variant))

        assert response.json() == {"barcode": "2000000000015", "created": False}
        variant.refresh_from_db()
        assert variant.barcode == "2000000000015"

    def test_the_reply_says_whether_it_minted_one(self, shop, auth_client) -> None:
        variant = factories.variant(shop["product"], barcode=None)
        client = auth_client(shop["owner"])

        assert client.post(_url(variant)).json()["created"] is True
        assert client.post(_url(variant)).json()["created"] is False

    def test_two_variants_never_share_a_barcode(self, shop, auth_client) -> None:
        client = auth_client(shop["owner"])
        codes = {
            client.post(_url(factories.variant(shop["product"], barcode=None))).json()["barcode"]
            for _ in range(5)
        }
        assert len(codes) == 5


class TestItIsAudited:
    def test_assigning_one_records_who_did_it(self, shop, auth_client) -> None:
        variant = factories.variant(shop["product"], barcode=None)

        barcode = auth_client(shop["owner"]).post(_url(variant)).json()["barcode"]

        entry = AuditLog.objects.filter(entity_id=str(variant.pk)).order_by("-created_at").first()
        assert entry is not None, "assigning a printed identifier left no trail"
        assert entry.actor == shop["owner"]
        assert entry.new_values["barcode"] == barcode

    def test_returning_an_existing_one_records_nothing(self, shop, auth_client) -> None:
        """Nothing changed, so there is nothing to record. An audit row per
        label reprint would bury the one entry that matters."""
        variant = factories.variant(shop["product"], barcode="2000000000015")

        auth_client(shop["owner"]).post(_url(variant))

        assert not AuditLog.objects.filter(entity_id=str(variant.pk)).exists()


class TestWhoMayAssignOne:
    def test_a_cashier_may_not(self, shop, auth_client) -> None:
        """`products.update`, not `products.view` — a barcode is a write."""
        variant = factories.variant(shop["product"], barcode=None)

        response = auth_client(shop["cashier"]).post(_url(variant))

        assert response.status_code == 403
        variant.refresh_from_db()
        assert variant.barcode is None

    def test_an_inventory_manager_may(self, shop, auth_client) -> None:
        """The role that receives and labels stock holds `products.update`."""
        staff = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])
        variant = factories.variant(shop["product"], barcode=None)

        assert auth_client(staff).post(_url(variant)).status_code == 200


@pytest.mark.django_db(transaction=True)
class TestConcurrentAssignment:
    def test_simultaneous_requests_agree_on_one_number(self, shop, auth_client) -> None:
        """The defect this endpoint was fixed for.

        Unlocked, both requests read an empty barcode, both drew a different
        number, and the second overwrote the first — so the first caller
        printed a label that scanned as nothing. Both must now be told the
        same number, and it must be the one in the database.
        """
        variant = factories.variant(shop["product"], barcode=None)
        client = auth_client(shop["owner"])

        def assign() -> str:
            try:
                return client.post(_url(variant)).json()["barcode"]
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=6) as pool:
            issued = [future.result() for future in [pool.submit(assign) for _ in range(6)]]

        variant.refresh_from_db()
        assert len(set(issued)) == 1, f"six requests handed out {len(set(issued))} numbers"
        assert issued[0] == variant.barcode, "a printed label would not match the database"
