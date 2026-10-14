"""An export's columns come in one order, whatever Django is installed.

A CSV export takes its header from the keys of the report's first row, and
the rows come from `QuerySet.values()`. Django 5.1 gave a row's keys as the
model's fields first and the annotations after, in whatever order `values()`
named them; Django 5.2 gives them in the order named. The stock valuation
named an annotation between two fields, so the upgrade moved three columns of
its export, and the NestJS API -- which serves production, and was ported
from the 5.1 order -- no longer agreed with it. Found by the parity harness.
"""

from __future__ import annotations

import pytest

from reports.services import inventory_report
from tests import factories

pytestmark = pytest.mark.django_db

VALUATION_COLUMNS = [
    "variant__sku",
    "variant__product__name",
    "variant__product__category__name",
    "branch__code",
    "on_hand",
    "reserved",
    "average_cost",
    "reorder_point",
    "available_qty",
    "stock_value",
    "retail_value",
]


class TestTheStockValuationsColumns:
    def test_a_row_names_what_is_stored_then_what_is_worked_out(self, shop) -> None:
        factories.stock(factories.variant(shop["product"]), shop["branch"], 3)

        rows = inventory_report(branch=shop["branch"])

        assert rows
        assert list(rows[0]) == VALUATION_COLUMNS

    def test_the_export_has_those_columns_in_that_order(self, shop, auth_client) -> None:
        factories.stock(factories.variant(shop["product"]), shop["branch"], 3)

        response = auth_client(shop["owner"]).get("/api/v1/reports/inventory/valuation/?format=csv")

        assert response.status_code == 200, response.content
        header = response.content.decode().splitlines()[0]
        assert header.split(",") == VALUATION_COLUMNS
