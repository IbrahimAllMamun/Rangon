"""An answer does not depend on how rows happen to lie in a table (D243 to D245).

PostgreSQL returns rows that an `ORDER BY` does not tell apart -- and rows with
no `ORDER BY` at all -- as they lie in the table, and where they lie changes
with every update. Three places let that reach a customer or a member of
staff: the order of a variant's attributes (and so its label), the dashboard's
top expense category when two tie, and every list ordered by a column that
ties, where a page could show a row twice or not at all.

Each test arranges the rows so that the table's order and the right order
differ: the row that should come second is inserted first.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from catalog.models import Attribute, ProductVariant
from core.ordering import unique_last
from core.pagination import StandardPagination
from finance.selectors import expense_totals
from inventory.models import Inventory
from orders.models import PaymentMethod
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from reports.services import DateRange, dashboard, product_performance
from tests import factories

pytestmark = pytest.mark.django_db

INVENTORY = "/api/v1/inventory/"


def _size_and_colour(*, size_at: int, colour_at: int):
    size, sizes = factories.attribute("size", values=["M"])
    colour, colours = factories.attribute("color", name="Colour", values=["White"])
    Attribute.objects.filter(pk=size.pk).update(position=size_at)
    Attribute.objects.filter(pk=colour.pk).update(position=colour_at)
    return sizes[0], colours[0]


class TestAVariantsAttributesAreInTheAttributesOrder:
    """D243: the label of a variant with no name of its own, and its attributes."""

    def test_the_label_follows_the_attributes_positions_not_the_rows(self) -> None:
        medium, white = _size_and_colour(size_at=0, colour_at=1)
        # Colour's row is written first; Size comes first all the same.
        variant = factories.variant(attribute_values=[white, medium])

        assert ProductVariant.objects.get(pk=variant.pk).label == "M / White"

    def test_moving_an_attribute_moves_it_in_the_label(self) -> None:
        medium, white = _size_and_colour(size_at=5, colour_at=1)
        variant = factories.variant(attribute_values=[medium, white])

        assert ProductVariant.objects.get(pk=variant.pk).label == "White / M"

    def test_two_attributes_at_one_position_go_by_name(self) -> None:
        medium, white = _size_and_colour(size_at=0, colour_at=0)
        variant = factories.variant(attribute_values=[medium, white])

        # "Colour" before "Size".
        assert ProductVariant.objects.get(pk=variant.pk).label == "White / M"

    def test_a_prefetched_label_is_the_same_label(self) -> None:
        medium, white = _size_and_colour(size_at=0, colour_at=1)
        variant = factories.variant(attribute_values=[white, medium])

        fetched = ProductVariant.objects.prefetch_related("attribute_values__attribute_value").get(
            pk=variant.pk
        )

        assert fetched.label == "M / White"

    def test_a_name_of_its_own_still_wins(self) -> None:
        medium, white = _size_and_colour(size_at=0, colour_at=1)
        variant = factories.variant(attribute_values=[white, medium], name="Display piece")

        assert ProductVariant.objects.get(pk=variant.pk).label == "Display piece"

    def test_the_api_lists_the_attributes_in_that_order(self, shop, auth_client) -> None:
        medium, white = _size_and_colour(size_at=0, colour_at=1)
        variant = factories.variant(shop["product"], attribute_values=[white, medium])

        response = auth_client(shop["owner"]).get(f"/api/v1/variants/{variant.pk}/")

        assert response.status_code == 200, response.content
        assert [row["attribute_code"] for row in response.json()["attributes"]] == [
            "size",
            "color",
        ]
        assert response.json()["label"] == "M / White"


class TestTheTopExpenseCategoryOnATie:
    """D244: the largest first, and by name where two come to the same."""

    def test_two_categories_that_spent_the_same_come_by_name(self, shop) -> None:
        account = factories.account(shop["branch"], opening_balance="10000.00")
        # The one that sorts last is made and spent on first.
        later = factories.expense_category(name="Zari thread")
        earlier = factories.expense_category(name="Awning repair")
        for category in (later, earlier):
            factories.expense(shop["branch"], account, category=category, amount=Decimal("400.00"))

        totals = expense_totals(branch=shop["branch"])

        assert [row["category"] for row in totals["by_category"]] == [
            "Awning repair",
            "Zari thread",
        ]

    def test_the_larger_still_comes_first(self, shop) -> None:
        account = factories.account(shop["branch"], opening_balance="10000.00")
        larger = factories.expense_category(name="Zari thread")
        smaller = factories.expense_category(name="Awning repair")
        factories.expense(shop["branch"], account, category=larger, amount=Decimal("900.00"))
        factories.expense(shop["branch"], account, category=smaller, amount=Decimal("400.00"))

        totals = expense_totals(branch=shop["branch"])

        assert [row["category"] for row in totals["by_category"]] == [
            "Zari thread",
            "Awning repair",
        ]


def _tied_shelves(shop, count: int = 6) -> list[Inventory]:
    """`count` more shelves at the shop's branch, all holding three."""
    return [
        factories.stock(factories.variant(shop["product"]), shop["branch"], 3) for _ in range(count)
    ]


def _in_id_order(ids: list[str]) -> list[str]:
    return [str(value) for value in sorted(UUID(value) for value in ids)]


class TestAListHasOneOrder:
    """D245: whatever a list is ordered by, the primary key ends it."""

    def test_rows_that_tie_on_what_was_asked_for_come_in_one_order(self, shop, auth_client) -> None:
        tied = {str(row.pk) for row in _tied_shelves(shop)}

        response = auth_client(shop["owner"]).get(f"{INVENTORY}?ordering=on_hand&page_size=100")

        assert response.status_code == 200, response.content
        rows = response.json()["results"]
        assert [row["on_hand"] for row in rows] == sorted(row["on_hand"] for row in rows)
        threes = [row["id"] for row in rows if row["id"] in tied]
        assert len(threes) == 6
        # Six rows made one after another are in the order of their random
        # ids once in 720 times; the table's order is the order they were made.
        assert threes == _in_id_order(threes)

    def test_descending_keeps_what_was_asked_and_ends_the_same_way(self, shop, auth_client) -> None:
        tied = {str(row.pk) for row in _tied_shelves(shop)}

        response = auth_client(shop["owner"]).get(f"{INVENTORY}?ordering=-on_hand&page_size=100")

        rows = response.json()["results"]
        assert [row["on_hand"] for row in rows] == sorted(
            (row["on_hand"] for row in rows), reverse=True
        )
        threes = [row["id"] for row in rows if row["id"] in tied]
        assert threes == _in_id_order(threes)

    def test_pages_through_a_tie_show_every_row_once(self, shop, auth_client) -> None:
        tied = {str(row.pk) for row in _tied_shelves(shop)}
        client = auth_client(shop["owner"])

        seen: list[str] = []
        page = 1
        while True:
            body = client.get(f"{INVENTORY}?ordering=on_hand&page_size=2&page={page}").json()
            seen.extend(row["id"] for row in body["results"])
            if not body["next"]:
                break
            page += 1

        assert len(seen) == len(set(seen)) == Inventory.objects.count()
        threes = [value for value in seen if value in tied]
        assert threes == _in_id_order(threes)

    def test_a_list_with_no_ordering_asked_for_is_ended_the_same_way(
        self, shop, auth_client
    ) -> None:
        _tied_shelves(shop)

        response = auth_client(shop["owner"]).get(f"{INVENTORY}?page_size=100")

        assert response.status_code == 200, response.content
        assert len(response.json()["results"]) == Inventory.objects.count()


class TestTheLastKey:
    """`core.ordering.unique_last`, which the filter and the paginator both call."""

    def test_an_explicit_ordering_is_kept_and_ended(self) -> None:
        queryset = unique_last(Inventory.objects.order_by("-on_hand", "reserved"))

        assert queryset.query.order_by == ("-on_hand", "reserved", "pk")

    def test_a_models_own_ordering_is_kept_and_ended(self) -> None:
        queryset = unique_last(Attribute.objects.all())

        assert queryset.query.order_by == ("position", "name", "pk")

    def test_a_queryset_with_no_order_at_all_gets_one(self) -> None:
        queryset = unique_last(Inventory.objects.order_by())

        assert queryset.query.order_by == ("pk",)

    @pytest.mark.parametrize("term", ["pk", "-pk", "id", "-id"])
    def test_an_ordering_that_names_the_key_is_left_alone(self, term: str) -> None:
        queryset = unique_last(Inventory.objects.order_by("on_hand", term))

        assert queryset.query.order_by == ("on_hand", term)

    def test_what_is_not_a_list_of_model_rows_is_left_alone(self) -> None:
        grouped = Inventory.objects.values("branch").order_by("branch")
        sliced = Inventory.objects.order_by("on_hand")[:5]
        union = Inventory.objects.filter(on_hand=1).union(Inventory.objects.filter(on_hand=2))

        assert unique_last(grouped).query.order_by == ("branch",)
        assert unique_last(sliced) is sliced
        assert unique_last(union) is union
        assert unique_last([3, 1, 2]) == [3, 1, 2]

    def test_a_page_is_cut_through_one_order_whoever_made_the_queryset(self, shop) -> None:
        tied = {row.pk for row in _tied_shelves(shop)}
        request = Request(APIRequestFactory().get("/", {"page_size": 100}))

        # A view that never ran the ordering filter: the paginator ends the order.
        page = StandardPagination().paginate_queryset(
            Inventory.objects.order_by("on_hand"), request
        )

        threes = [row.pk for row in page if row.pk in tied]
        assert threes == sorted(threes)


def _sell(shop, *lines: tuple[ProductVariant, int]) -> None:
    pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[
                SaleLineInput(variant_id=variant.pk, quantity=quantity)
                for variant, quantity in lines
            ],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("99999.00"))],
        ),
    )


class TestAReportsRowsThatTie:
    """D245 in the reports, which order their own queries."""

    def _period(self) -> DateRange:
        now = timezone.now()
        return DateRange(now - timedelta(days=1), now + timedelta(days=1), "custom")

    def test_best_sellers_that_sold_the_same_come_by_sku(self, shop) -> None:
        later = factories.variant(shop["product"], sku="ZZ-LATER")
        earlier = factories.variant(shop["product"], sku="AA-EARLIER")
        for variant in (later, earlier):
            factories.stock(variant, shop["branch"], 5)
        # The one that sorts last is sold first.
        _sell(shop, (later, 2))
        _sell(shop, (earlier, 2))

        payload = dashboard(date_range=self._period(), branch=shop["branch"])

        assert [row["sku"] for row in payload["top_products"]] == ["AA-EARLIER", "ZZ-LATER"]

    def test_products_that_earned_the_same_come_by_sku(self, shop) -> None:
        later = factories.variant(shop["product"], sku="ZZ-LATER")
        earlier = factories.variant(shop["product"], sku="AA-EARLIER")
        for variant in (later, earlier):
            factories.stock(variant, shop["branch"], 5)
        _sell(shop, (later, 1))
        _sell(shop, (earlier, 1))

        rows = product_performance(date_range=self._period(), branch=shop["branch"])

        assert [row["sku"] for row in rows] == ["AA-EARLIER", "ZZ-LATER"]
