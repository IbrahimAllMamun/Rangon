"""Query budgets for the endpoints a shopper hits hardest.

`docs/database/indexing.md` documents these budgets; this file is where they are
actually enforced, and `docs/testing/strategy.md` has always listed it.

The storefront listing is the page that matters: `_product_payload` walks every
variant's attribute links and reads both the attribute and its value, which is
precisely the shape that silently degrades into an N+1. It did. One page of 12
products issued **363** queries and took 1.3 s, because the list path never
prefetched what the detail path already did.

The load-bearing assertion here is not the constant — it is that the query count
does **not grow with the size of the catalogue**. A budget can be quietly raised;
a growth check cannot be satisfied by an N+1 at all.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from tests import factories

pytestmark = pytest.mark.django_db

LISTING_URL = "/api/v1/shop/products/"
HOME_URL = "/api/v1/shop/home/"

# Generous on purpose: these catch gross regressions, while the growth tests
# catch N+1s. Raising either should require a reason in the PR.
LISTING_QUERY_BUDGET = 25
# Home renders three product rails plus categories and brands, so its floor is
# higher than the listing's. It was measured at 511 before the fix.
HOME_QUERY_BUDGET = 45


def _add_products(count: int, *, branch: Any, values: list[Any]) -> None:
    """`count` products, each with one variant per attribute value, all in stock."""
    for _ in range(count):
        product = factories.product()
        for value in values:
            variant = factories.variant(product, attribute_values=[value])
            factories.stock(variant, branch, 5)


def _count_queries(api: Any, url: str) -> int:
    with CaptureQueriesContext(connection) as captured:
        response = api.get(url)
        assert response.status_code == 200, response.data
    return len(captured)


class TestProductListingQueryBudget:
    def test_query_count_does_not_grow_with_the_catalogue(self, api, shop):
        """The N+1 regression test. Same page size, more rows, same query count."""
        _, values = factories.attribute("size", values=["S", "M", "L"])
        branch = shop["branch"]

        _add_products(3, branch=branch, values=values)
        _count_queries(api, LISTING_URL)  # warm one-off lookups (branch, settings)
        with_few = _count_queries(api, LISTING_URL)

        _add_products(9, branch=branch, values=values)
        with_many = _count_queries(api, LISTING_URL)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as the catalogue grew "
            f"from 4 to 13 products: the listing has an N+1. Whatever "
            f"`_product_payload` reads must be prefetched on the list path, the "
            f"way `retrieve` already does it."
        )

    def test_listing_stays_within_its_documented_budget(self, api, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        _add_products(8, branch=shop["branch"], values=values)

        _count_queries(api, LISTING_URL)  # warm
        count = _count_queries(api, LISTING_URL)

        assert count <= LISTING_QUERY_BUDGET, (
            f"The product listing used {count} queries, over its budget of "
            f"{LISTING_QUERY_BUDGET} (docs/database/indexing.md)."
        )


class TestHomeQueryBudget:
    """The home page is the most-visited page on the storefront.

    It serialises three product rails through `_product_payload`, so it shares
    the listing's failure mode — and had it worse: 511 queries, 2.4 s, because it
    prefetched `variants__attribute_values` but not the attribute and value one
    hop further down.
    """

    def test_query_count_does_not_grow_with_the_catalogue(self, api, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        branch = shop["branch"]

        _add_products(3, branch=branch, values=values)
        _count_queries(api, HOME_URL)  # warm
        with_few = _count_queries(api, HOME_URL)

        _add_products(9, branch=branch, values=values)
        with_many = _count_queries(api, HOME_URL)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as the catalogue grew: "
            f"a home-page rail has an N+1. Feed every rail through "
            f"`_payload_queryset` rather than prefetching by hand."
        )

    def test_home_stays_within_its_documented_budget(self, api, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        _add_products(8, branch=shop["branch"], values=values)

        _count_queries(api, HOME_URL)  # warm
        count = _count_queries(api, HOME_URL)

        assert count <= HOME_QUERY_BUDGET, (
            f"The home page used {count} queries, over its budget of "
            f"{HOME_QUERY_BUDGET} (docs/database/indexing.md)."
        )
