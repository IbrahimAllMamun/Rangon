"""Attaching a customer to a counter sale.

The POS needs two things from the customers API and had tests for neither:
find the person by the number they give, and create them when the search comes
back empty.  Both endpoints existed -- `lookup` even carried the docstring
"Fast phone lookup for the POS counter" -- and nothing in the app had ever
called either, so nothing had ever exercised their edges.

Three of those edges were wrong, and each has a test here:

  * the reply was the full `CustomerSerializer`, so a search that matched ten
    strangers put ten sets of staff notes, tags, lifetime spend and home
    addresses on a screen the shop floor can see;
  * it nested `addresses` while bypassing the prefetch, costing a query per
    result on the counter's critical path;
  * a single character was a valid search, and `LIKE` on a bare substring is a
    sequential scan of the whole customer table.
"""

from __future__ import annotations

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from accounts.permissions import RoleCode
from customers.models import Customer
from tests import factories

pytestmark = pytest.mark.django_db

LOOKUP = "/api/v1/customers/lookup/"


class TestFindingACustomer:
    def test_a_full_phone_number_finds_them(self, shop, auth_client) -> None:
        customer = factories.customer(name="Nusrat Jahan", phone="01712345678")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "01712345678"})

        assert response.status_code == 200
        results = response.json()["results"]
        assert [row["id"] for row in results] == [str(customer.pk)]
        assert results[0]["name"] == "Nusrat Jahan"

    def test_a_partial_number_finds_them(self, shop, auth_client) -> None:
        """A customer reads out the last digits far more often than all eleven."""
        customer = factories.customer(name="Rahim Uddin", phone="01798765432")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "65432"})

        assert [row["id"] for row in response.json()["results"]] == [str(customer.pk)]

    def test_an_unknown_number_finds_nobody(self, shop, auth_client) -> None:
        factories.customer(phone="01712345678")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "01900000000"})

        assert response.status_code == 200
        assert response.json()["results"] == []

    def test_a_deactivated_customer_is_not_offered(self, shop, auth_client) -> None:
        """`destroy` deactivates rather than deletes, so these rows accumulate."""
        factories.customer(phone="01712345678", is_active=False)

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "01712345678"})

        assert response.json()["results"] == []

    def test_the_walk_in_row_is_never_offered(self, shop, auth_client) -> None:
        """Attaching it by hand would file the sale against the wrong branch's
        anonymous customer; `create_pos_sale` resolves the right one itself."""
        Customer.objects.create(
            name="Walk-in (MAIN)", is_walk_in=True, phone="01700000000", customer_type="WALK_IN"
        )

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "01700000000"})

        assert response.json()["results"] == []

    def test_at_most_ten_are_returned(self, shop, auth_client) -> None:
        for index in range(12):
            factories.customer(phone=f"0171000{index:04d}")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "0171000"})

        assert len(response.json()["results"]) == 10


class TestWhatTheCounterIsTold:
    """A lookup answers "is this the person standing here?" and nothing else.

    It returns up to ten people who are *not* the customer at the counter, so
    every field it carries is a stranger's detail shown to whoever can see the
    screen.
    """

    def test_staff_notes_and_lifetime_figures_are_withheld(self, shop, auth_client) -> None:
        factories.customer(
            name="Nusrat Jahan",
            phone="01712345678",
            notes="Argued about a refund in March",
            tags=["difficult"],
        )

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "01712345678"})

        row = response.json()["results"][0]
        for withheld in ("notes", "tags", "addresses", "total_spent", "loyalty_points"):
            assert withheld not in row, f"{withheld} must not reach the counter"

    def test_enough_is_sent_to_tell_two_people_apart(self, shop, auth_client) -> None:
        factories.customer(name="Nusrat Jahan", phone="01712345678")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "01712345678"})

        row = response.json()["results"][0]
        assert set(row) == {
            "id",
            "name",
            "phone",
            "email",
            "customer_type",
            "total_orders",
            "last_order_at",
        }

    def test_ten_matches_cost_no_more_queries_than_one(self, shop, auth_client) -> None:
        """The old reply nested `addresses` on a queryset that cannot prefetch,
        so each extra match cost another query (the D10 shape).

        Asserted as "the same count", not as a literal number, because the
        floor is not stable: `User.permission_codes()` caches for the life of
        the instance, so whether the role lookup is counted depends on whether
        this user object has authorised a request before. The property that
        matters is the one the defect broke -- that the count does not track
        the number of results.
        """
        client = auth_client(shop["cashier"])
        factories.customer(phone="01710000000")

        def count_queries() -> int:
            with CaptureQueriesContext(connection) as captured:
                response = client.get(LOOKUP, {"phone": "0171000"})
            assert response.status_code == 200
            return len(captured)

        count_queries()  # warm the per-instance permission cache
        for_one = count_queries()

        for index in range(1, 10):
            factories.customer(phone=f"0171000000{index}")
        for_ten = count_queries()

        assert len(client.get(LOOKUP, {"phone": "0171000"}).json()["results"]) == 10
        assert for_ten == for_one, (
            f"{for_one} queries for one match but {for_ten} for ten: "
            "the lookup is rendering something per row again"
        )


class TestTheMinimumSearch:
    @pytest.mark.parametrize("typed", ["", "0", "01"])
    def test_too_short_a_search_asks_the_server_for_nothing(self, shop, auth_client, typed) -> None:
        factories.customer(phone="01712345678")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": typed})

        assert response.status_code == 200
        body = response.json()
        assert body["results"] == []
        assert body["min_length"] == 3

    def test_three_characters_is_enough(self, shop, auth_client) -> None:
        customer = factories.customer(phone="01712345678")

        response = auth_client(shop["cashier"]).get(LOOKUP, {"phone": "678"})

        assert [row["id"] for row in response.json()["results"]] == [str(customer.pk)]


class TestWhoMayLookUpAndCreate:
    def test_a_cashier_may_look_up(self, shop, auth_client) -> None:
        assert auth_client(shop["cashier"]).get(LOOKUP, {"phone": "017"}).status_code == 200

    def test_a_cashier_may_create_a_customer_at_the_counter(self, shop, auth_client) -> None:
        response = auth_client(shop["cashier"]).post(
            "/api/v1/customers/",
            {"name": "Nusrat Jahan", "phone": "01712345678"},
            format="json",
        )

        assert response.status_code == 201
        assert Customer.objects.filter(phone="01712345678").exists()

    def test_a_counter_creation_records_who_made_it(self, shop, auth_client) -> None:
        auth_client(shop["cashier"]).post(
            "/api/v1/customers/",
            {"name": "Nusrat Jahan", "phone": "01712345678"},
            format="json",
        )

        assert Customer.objects.get(phone="01712345678").created_by == shop["cashier"]

    def test_a_customer_needs_a_way_to_be_found_again(self, shop, auth_client) -> None:
        """Phone-first identity: a record with neither contact detail cannot be
        looked up, which is the whole point of creating it (business rules 6)."""
        response = auth_client(shop["cashier"]).post(
            "/api/v1/customers/", {"name": "Nusrat Jahan"}, format="json"
        )

        assert response.status_code == 400

    def test_a_duplicate_phone_is_refused(self, shop, auth_client) -> None:
        """The counter's reason to search first: `phone` is unique, so a second
        record for the same number is refused rather than silently created."""
        factories.customer(phone="01712345678")

        response = auth_client(shop["cashier"]).post(
            "/api/v1/customers/",
            {"name": "Someone Else", "phone": "01712345678"},
            format="json",
        )

        assert response.status_code == 400
        assert Customer.objects.filter(phone="01712345678").count() == 1

    def test_an_inventory_manager_may_not_look_up_customers(self, shop, auth_client) -> None:
        """`customers.view` is not on that role; the counter is not their screen."""
        staff = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])

        response = auth_client(staff).get(LOOKUP, {"phone": "01712345678"})

        assert response.status_code == 403
