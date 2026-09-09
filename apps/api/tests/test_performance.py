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

from decimal import Decimal
from typing import Any

import pytest
from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from orders.models import Order
from purchasing.services import (
    PurchaseLine,
    create_purchase_order,
    receive_purchase,
    send_purchase_order,
)
from tests import factories

pytestmark = pytest.mark.django_db

LISTING_URL = "/api/v1/shop/products/"
HOME_URL = "/api/v1/shop/home/"
FEED_URL = "/api/v1/shop/feed.csv"

# Generous on purpose: these catch gross regressions, while the growth tests
# catch N+1s. Raising either should require a reason in the PR.
LISTING_QUERY_BUDGET = 25
# Home renders three product rails plus categories and brands, so its floor is
# higher than the listing's. It was measured at 511 before the fix.
HOME_QUERY_BUDGET = 45
# The feed is the only endpoint with no page size: it walks the WHOLE
# catalogue, so an N+1 here is not a slow page, it is a fetch Meta times out on
# and a catalogue that silently stops updating.
FEED_QUERY_BUDGET = 12


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


class TestPurchaseOrderQueryBudget:
    """Purchase orders serialise their receipts, and each receipt line its SKU.

    That chain (`receipt -> item -> purchase_order_item -> variant`) ran one
    query per line: **156 queries for two orders**, before anyone had received
    stock at scale. It grows with receipts, not orders, which is why the check
    below adds receipts rather than orders.
    """

    def _order_with_receipt(self, shop: dict[str, Any], quantity: int = 10) -> None:
        variant = factories.variant(price="1000.00", cost="0.00")
        order = create_purchase_order(
            supplier=factories.supplier(),
            branch=shop["branch"],
            lines=[
                PurchaseLine(variant_id=variant.pk, quantity=quantity, unit_cost=Decimal("400.00"))
            ],
            actor=shop["manager"],
        )
        send_purchase_order(purchase_order=order, actor=shop["manager"])
        item = order.items.first()
        assert item is not None
        receive_purchase(
            purchase_order=order,
            lines={str(item.pk): quantity},
            actor=shop["manager"],
        )

    def test_query_count_does_not_grow_with_receipts(self, auth_client, shop):
        client = auth_client(shop["owner"])
        url = "/api/v1/purchase-orders/"

        self._order_with_receipt(shop)
        _count_queries(client, url)  # warm
        with_one = _count_queries(client, url)

        for _ in range(3):
            self._order_with_receipt(shop)
        with_four = _count_queries(client, url)

        assert with_four == with_one, (
            f"Queries grew from {with_one} to {with_four} as received orders grew: "
            f"the purchase-order list has an N+1. The receipt serialisers reach "
            f"`purchase_order_item.variant` and `received_by`; prefetch that far."
        )


# --------------------------------------------------------------------------
# The endpoints `docs/database/indexing.md` documented but never enforced.
#
# Seven rows of that table carried a budget, a measurement, or both, under a
# heading that reads "enforced in tests" — and the file admitted underneath
# that only the first two were. Writing these found one of them was not merely
# unenforced but wrong: `GET /pos/products/` was issuing **81 queries** for a
# search of eight products, roughly nine per row, on the counter's own screen.
#
# It was the trap that document describes, twice over in one loop. `label` is a
# property that joins the variant's attribute values, and `primary_image`
# *filtered* a related manager, which ignores `prefetch_related` and issues a
# fresh query per product. Neither reads like a query at the call site.
# --------------------------------------------------------------------------

DETAIL_QUERY_BUDGET = 18
POS_SEARCH_QUERY_BUDGET = 12
POS_SCAN_QUERY_BUDGET = 12
ADMIN_PRODUCTS_QUERY_BUDGET = 25
ORDERS_QUERY_BUDGET = 12
DASHBOARD_QUERY_BUDGET = 20
POS_SALE_QUERY_BUDGET = 75
#: Marginal cost of one more line on a counter sale. Measured at 10.
POS_SALE_PER_LINE_BUDGET = 13


def _named_products(count: int, *, branch: Any, values: list[Any], prefix: str) -> None:
    """Products a search term can actually match, all in stock."""
    for _ in range(count):
        product = factories.product(name=f"{prefix} {factories.unique()}")
        for value in values:
            factories.stock(factories.variant(product, attribute_values=[value]), branch, 5)


class TestProductDetailQueryBudget:
    """Flat at 13 whatever the variant count, so the cost is fixed, not an N+1.

    The document claimed a budget of 10 against a measured 13 and said outright
    that the budget "was never measured". Raised here to 18 deliberately: the
    figure now has headroom over what the endpoint actually does, and the growth
    check below is what would catch a real regression.
    """

    def _product_with_variants(self, shop: dict[str, Any], values: list[Any]) -> Any:
        product = factories.product(name=f"Detail {factories.unique()}")
        for value in values:
            factories.stock(factories.variant(product, attribute_values=[value]), shop["branch"], 5)
        return product

    def test_query_count_does_not_grow_with_the_variant_count(self, api, shop):
        _, values = factories.attribute("size", values=["S", "M", "L", "XL", "XXL", "XXXL"])
        product = self._product_with_variants(shop, values[:2])
        url = f"/api/v1/shop/products/{product.slug}/"

        _count_queries(api, url)  # warm
        with_few = _count_queries(api, url)

        for value in values[2:]:
            factories.stock(factories.variant(product, attribute_values=[value]), shop["branch"], 5)
        with_many = _count_queries(api, url)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as the product gained "
            f"variants: the detail payload has an N+1."
        )

    def test_detail_stays_within_its_documented_budget(self, api, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        product = self._product_with_variants(shop, values)
        url = f"/api/v1/shop/products/{product.slug}/"

        _count_queries(api, url)  # warm
        count = _count_queries(api, url)

        assert count <= DETAIL_QUERY_BUDGET, (
            f"Product detail used {count} queries, over its budget of "
            f"{DETAIL_QUERY_BUDGET} (docs/database/indexing.md)."
        )


class TestPosSearchQueryBudget:
    """The counter's grid, and the worst offender this sweep found.

    A cashier who prefers tapping to scanning types into this on every sale. At
    nine queries per matching row a search of twenty products cost 180, on the
    one screen in the product where latency is measured in customers waiting.
    """

    def test_query_count_does_not_grow_with_the_matches(self, auth_client, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        client = auth_client(shop["owner"])
        url = "/api/v1/pos/products/?q=Zephyr"

        _named_products(2, branch=shop["branch"], values=values, prefix="Zephyr")
        _count_queries(client, url)  # warm
        with_few = _count_queries(client, url)

        _named_products(6, branch=shop["branch"], values=values, prefix="Zephyr")
        with_many = _count_queries(client, url)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as the search matched "
            f"more products: the POS grid has an N+1. `label` and "
            f"`primary_image` are both properties that read relations — prefetch "
            f"`attribute_values__attribute_value` and `product__images`, and do "
            f"not `.filter()` a prefetched manager."
        )

    def test_pos_search_stays_within_budget(self, auth_client, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        client = auth_client(shop["owner"])
        _named_products(8, branch=shop["branch"], values=values, prefix="Zephyr")
        url = "/api/v1/pos/products/?q=Zephyr"

        _count_queries(client, url)  # warm
        count = _count_queries(client, url)

        assert count <= POS_SEARCH_QUERY_BUDGET, (
            f"The POS product grid used {count} queries, over its budget of "
            f"{POS_SEARCH_QUERY_BUDGET}."
        )


class TestPosScanQueryBudget:
    """One barcode, one variant. No growth axis, so a constant is the whole guard."""

    def test_a_scan_stays_within_budget(self, auth_client, shop):
        client = auth_client(shop["owner"])
        url = f"/api/v1/pos/lookup/?code={shop['variants'][0].sku}"

        _count_queries(client, url)  # warm
        count = _count_queries(client, url)

        assert count <= POS_SCAN_QUERY_BUDGET, (
            f"A barcode scan used {count} queries, over its budget of "
            f"{POS_SCAN_QUERY_BUDGET}. This runs once per item at the counter."
        )


class TestAdminProductListQueryBudget:
    def test_query_count_does_not_grow_with_the_catalogue(self, auth_client, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        client = auth_client(shop["owner"])
        url = "/api/v1/products/"

        _add_products(3, branch=shop["branch"], values=values)
        _count_queries(client, url)  # warm
        with_few = _count_queries(client, url)

        _add_products(9, branch=shop["branch"], values=values)
        with_many = _count_queries(client, url)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as the catalogue grew: "
            f"the admin product list has an N+1."
        )

    def test_admin_product_list_stays_within_budget(self, auth_client, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])
        client = auth_client(shop["owner"])
        _add_products(8, branch=shop["branch"], values=values)

        _count_queries(client, "/api/v1/products/")  # warm
        count = _count_queries(client, "/api/v1/products/")

        assert count <= ADMIN_PRODUCTS_QUERY_BUDGET, (
            f"The admin product list used {count} queries, over its budget of "
            f"{ADMIN_PRODUCTS_QUERY_BUDGET}."
        )


class TestOrderListQueryBudget:
    """The screen back-office staff keep open all day."""

    def _orders(self, shop: dict[str, Any], count: int) -> None:
        for _ in range(count):
            Order.objects.create(
                number=factories.unique("RGN-"),
                branch=shop["branch"],
                customer=shop["customer"],
                channel="ONLINE",
                status="CONFIRMED",
                payment_status="UNPAID",
                subtotal=Decimal("1000.00"),
                grand_total=Decimal("1000.00"),
                placed_at=timezone.now(),
            )

    def test_query_count_does_not_grow_with_the_order_count(self, auth_client, shop):
        client = auth_client(shop["owner"])
        url = "/api/v1/orders/"

        self._orders(shop, 3)
        _count_queries(client, url)  # warm
        with_few = _count_queries(client, url)

        self._orders(shop, 22)
        with_many = _count_queries(client, url)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as orders grew from 3 "
            f"to 25: the order list has an N+1."
        )

    def test_order_list_stays_within_budget(self, auth_client, shop):
        client = auth_client(shop["owner"])
        self._orders(shop, 25)

        _count_queries(client, "/api/v1/orders/")  # warm
        count = _count_queries(client, "/api/v1/orders/")

        assert count <= ORDERS_QUERY_BUDGET, (
            f"The order list used {count} queries for 25 orders, over its budget "
            f"of {ORDERS_QUERY_BUDGET}."
        )


class TestDashboardQueryBudget:
    """Every signed-in staff member loads this first."""

    def test_dashboard_stays_within_budget(self, auth_client, shop):
        client = auth_client(shop["owner"])
        url = "/api/v1/reports/dashboard/"

        _count_queries(client, url)  # warm
        count = _count_queries(client, url)

        assert count <= DASHBOARD_QUERY_BUDGET, (
            f"The dashboard used {count} queries, over its budget of " f"{DASHBOARD_QUERY_BUDGET}."
        )


class TestPosSaleQueryBudget:
    """The counter's write path.

    A sale is the most expensive thing the product does, and legitimately so:
    it locks an inventory row per line, writes a ledger row per line, an order,
    its items, the payments, a cash-book entry and an audit trail, all in one
    transaction. Measured at **53 queries for one line and 10 for each line
    after** — a fixed cost plus a constant, which is the shape it should have.

    The document budgeted 30 and had never measured it. The number below is the
    measurement plus headroom; the per-line check underneath is the one that
    would actually catch a regression, because a sale that starts reading the
    catalogue per line grows there and not in the constant.
    """

    def _sell(self, client: Any, variants: list[Any], key: str) -> int:
        total = sum((variant.price for variant in variants), Decimal("0.00"))
        payload = {
            "lines": [{"variant": str(variant.pk), "quantity": 1} for variant in variants],
            "payments": [{"method": "CASH", "amount": str(total), "tendered_amount": str(total)}],
            "register": "REG-01",
        }
        with CaptureQueriesContext(connection) as captured:
            response = client.post(
                "/api/v1/pos/sales/", payload, format="json", HTTP_IDEMPOTENCY_KEY=key
            )
            assert response.status_code == 201, response.data
        return len(captured)

    def _sellable(self, shop: dict[str, Any], count: int) -> list[Any]:
        _, values = factories.attribute("size", values=[f"S{i}" for i in range(count)])
        variants = []
        for value in values:
            variant = factories.variant(shop["product"], attribute_values=[value])
            factories.stock(variant, shop["branch"], 50)
            variants.append(variant)
        return variants

    def test_a_two_line_sale_stays_within_budget(self, auth_client, shop):
        client = auth_client(shop["cashier"])
        variants = self._sellable(shop, 2)

        self._sell(client, variants[:1], "perf-warm")  # warm the permission cache
        count = self._sell(client, variants, "perf-two-lines")

        assert count <= POS_SALE_QUERY_BUDGET, (
            f"A two-line counter sale used {count} queries, over its budget of "
            f"{POS_SALE_QUERY_BUDGET}. The cashier is waiting on this one."
        )

    def test_each_extra_line_costs_a_constant(self, auth_client, shop):
        """A basket of ten must not cost ten times a basket of one."""
        client = auth_client(shop["cashier"])
        variants = self._sellable(shop, 4)

        self._sell(client, variants[:1], "perf-growth-warm")
        one_line = self._sell(client, variants[:1], "perf-growth-one")
        four_lines = self._sell(client, variants, "perf-growth-four")
        per_line = (four_lines - one_line) / 3

        assert per_line <= POS_SALE_PER_LINE_BUDGET, (
            f"Each extra line on a sale cost {per_line:.1f} queries "
            f"({one_line} for one line, {four_lines} for four), over the "
            f"{POS_SALE_PER_LINE_BUDGET} budgeted. A sale that reads the "
            f"catalogue per line grows here first."
        )


class TestProductFeedQueryBudget:
    """The feed has no pagination to hide behind.

    Every other list endpoint on this storefront serves one page at a time, so
    an N+1 costs a page's worth of queries. The feed serialises every published
    variant in the shop, so the same mistake costs the whole catalogue's worth
    — and it fails in the least visible way there is, because nobody watches a
    feed fetch. It stops updating, and the adverts keep running at last month's
    prices.
    """

    def _fetch(self, api: Any) -> int:
        """Measure a real render, not the cached copy of one.

        The feed view is wrapped in `cache_page`, so without this clear the
        second fetch answers from the cache in **zero** queries and every
        assertion below passes no matter how bad the selector is. The first
        version of this test did exactly that. `cache.clear()` is what makes it
        a measurement.
        """
        cache.clear()
        with CaptureQueriesContext(connection) as captured:
            response = api.get(FEED_URL)
            assert response.status_code == 200, response.content[:400]
        return len(captured)

    def test_query_count_does_not_grow_with_the_catalogue(self, api, shop, settings):
        settings.RANGON = {**settings.RANGON, "PUBLIC_URL": "https://rangonfashion.test"}
        _, values = factories.attribute("size", values=["S", "M", "L"])
        branch = shop["branch"]

        _add_products(3, branch=branch, values=values)
        self._fetch(api)  # warm one-off lookups (organisation, branch)
        with_few = self._fetch(api)

        _add_products(9, branch=branch, values=values)
        with_many = self._fetch(api)

        assert with_many == with_few, (
            f"Queries grew from {with_few} to {with_many} as the catalogue grew "
            f"from 4 to 13 products: `feed_items()` has an N+1. It walks every "
            f"product's images, variants and attribute links, so all three have "
            f"to be prefetched — and `primary_image` must read `images.all()` "
            f"rather than filtering it, which ignores the prefetch."
        )

    def test_the_feed_stays_within_its_documented_budget(self, api, shop, settings):
        settings.RANGON = {**settings.RANGON, "PUBLIC_URL": "https://rangonfashion.test"}
        _, values = factories.attribute("size", values=["S", "M", "L"])
        _add_products(8, branch=shop["branch"], values=values)

        self._fetch(api)  # warm
        count = self._fetch(api)

        assert count <= FEED_QUERY_BUDGET, (
            f"The product feed used {count} queries for a whole catalogue, over "
            f"its budget of {FEED_QUERY_BUDGET} (docs/database/indexing.md)."
        )
