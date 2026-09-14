"""`seed_demo --reset` must survive whatever the app can create.

This has broken twice, both times the same way: a new model holding a PROTECT
reference to the catalogue is added, `_reset()` is not told about it, and the
reset dies with ProtectedError the first time anyone has that kind of row.
Phase 36 added `Expense`; phase 39 made stock counts and transfers reachable
from the UI, so the demo data started having them. `ProductAttributeValue`
(product specifications) is the third and PROTECTs `AttributeValue`, which
`_reset` deletes in its own right after the catalogue.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from django.core.management import call_command

from catalog.models import Attribute, AttributeValue, Product
from catalog.services import set_product_specs
from finance.models import Expense
from inventory import services as inventory_services
from inventory.models import Inventory, StockCount, StockCountItem, StockTransfer
from tests import factories

pytestmark = pytest.mark.django_db


def test_reset_survives_every_document_that_protects_the_catalogue(shop: Any) -> None:
    branch = shop["branch"]
    other = factories.branch(shop["organization"])
    variant = shop["variants"][0]

    # One of each thing that points at a variant or a product with PROTECT.
    count = StockCount.objects.create(number="SC-TEST-1", branch=branch, status="COUNTING")
    StockCountItem.objects.create(stock_count=count, variant=variant, expected_quantity=10)
    inventory_services.receive_stock(
        branch=branch, variant=variant, quantity=5, unit_cost=Decimal("100.00")
    )
    inventory_services.transfer(source_branch=branch, target_branch=other, lines=[(variant.pk, 2)])
    factories.expense(branch, amount=Decimal("50.00"))

    # A stated specification: PROTECTs the AttributeValue that `_reset` deletes
    # on the line after the catalogue, so the ordering has to be right.
    material, values = factories.attribute("material", name="Material", values=["Cotton"])
    material.is_variant_defining = False
    material.save(update_fields=["is_variant_defining"])
    set_product_specs(product=shop["product"], value_ids=[values[0].pk])

    assert StockCount.objects.exists()
    assert StockTransfer.objects.exists()
    assert Expense.objects.exists()
    assert shop["product"].spec_values.exists()

    # The whole point: this must not raise ProtectedError.
    call_command("seed_demo", "--reset", "--orders", "1", verbosity=0)

    # The documents are gone with the data they referenced, and the seed rebuilt.
    assert not StockCount.objects.exists()
    assert not StockTransfer.objects.exists()
    assert Product.objects.exists()
    assert Inventory.objects.exists()
    # And the rebuilt catalogue states its own: the seed wires Material,
    # Gender, Fit, Sole, Dimensions and Skin type to the categories that use
    # them, so a reseeded shop has spec lists rather than empty ones.
    assert Attribute.objects.filter(is_variant_defining=False).exists()
    assert AttributeValue.objects.filter(product_links__isnull=False).exists()
    # Expense categories are reference data from a migration, not demo data,
    # so they survive a reset — the picker must not come back empty.
    from finance.models import ExpenseCategory

    assert ExpenseCategory.objects.filter(code="RENT").exists()
