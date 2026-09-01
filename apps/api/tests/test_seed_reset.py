"""`seed_demo --reset` must survive whatever the app can create.

This has broken three times, always the same way: a new model holding a PROTECT
reference is added, `_reset()` is not told about it, and the reset dies with
ProtectedError the first time anyone has that kind of row. Phase 36 added
`Expense`; phase 39 made stock counts and transfers reachable from the UI, so
the demo data started having them; V2 added `StockException`, which protects
the *ledger row* rather than the catalogue -- a new shape, and the reason this
test now asserts the reason as well as the outcome.

The PROTECT is right in every case. What is fragile is `_reset()` having to
know about it, which is why this test exists rather than a rule against
PROTECT.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from django.core.management import call_command

from catalog.models import Product
from finance.models import Expense
from inventory import services as inventory_services
from inventory.models import (
    Inventory,
    InventoryTransaction,
    StockCount,
    StockCountItem,
    StockException,
    StockTransfer,
    TransactionType,
)
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
    # An oversell exception PROTECTs the ledger row that caused it, so it is the
    # first thing to protect an InventoryTransaction rather than the catalogue.
    inventory_services.apply_transaction(
        branch=branch,
        variant=shop["variants"][1],
        transaction_type=TransactionType.SALE,
        quantity=99,
        allow_negative=True,
    )

    assert StockCount.objects.exists()
    assert StockTransfer.objects.exists()
    assert Expense.objects.exists()
    assert StockException.objects.exists()

    # The whole point: this must not raise ProtectedError.
    call_command("seed_demo", "--reset", "--orders", "1", verbosity=0)

    # The documents are gone with the data they referenced, and the seed rebuilt.
    assert not StockCount.objects.exists()
    assert not StockTransfer.objects.exists()
    assert not StockException.objects.exists()
    assert not InventoryTransaction.objects.filter(reference_type="test_setup").exists()
    assert Product.objects.exists()
    assert Inventory.objects.exists()
    # Expense categories are reference data from a migration, not demo data,
    # so they survive a reset — the picker must not come back empty.
    from finance.models import ExpenseCategory

    assert ExpenseCategory.objects.filter(code="RENT").exists()
