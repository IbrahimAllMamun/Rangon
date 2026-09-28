"""`GET /products/?never_ordered=true`: drafts no purchase order names.

A product created from a purchase order is saved the moment it is created, so
an order abandoned afterwards leaves a draft behind that nothing points at.
The products list offers them as one tab, so they can be found and tidied.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from catalog.models import PublishStatus
from purchasing.services import PurchaseLine, create_purchase_order
from tests import factories

pytestmark = pytest.mark.django_db


def test_only_drafts_with_no_purchase_order_line_are_listed(
    shop: Any, owner: Any, auth_client: Any
) -> None:
    abandoned = factories.product(name="Abandoned Draft", status=PublishStatus.DRAFT)
    factories.variant(abandoned)
    factories.product(name="Draft With No Variants", status=PublishStatus.DRAFT)
    ordered = factories.product(name="Ordered Draft", status=PublishStatus.DRAFT)
    ordered_variant = factories.variant(ordered)
    live = factories.product(name="Live And Never Ordered")
    factories.variant(live)
    create_purchase_order(
        supplier=factories.supplier(),
        branch=shop["branch"],
        lines=[
            PurchaseLine(variant_id=ordered_variant.pk, quantity=5, unit_cost=Decimal("100.00"))
        ],
        actor=owner,
    )

    response = auth_client(owner).get("/api/v1/products/", {"never_ordered": "true"})

    assert response.status_code == 200
    names = {row["name"] for row in response.json()["results"]}
    assert names == {"Abandoned Draft", "Draft With No Variants"}
