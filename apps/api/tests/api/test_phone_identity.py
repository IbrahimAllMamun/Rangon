"""One subscriber, one row — the end of D48.

Identity is phone-first (business rules §6) and nothing normalised the number,
so `01712345678` and `+8801712345678` were two customers.  Their order history
split, and lifetime spend, loyalty and the party ledger all under-reported.

These are the paths a number can enter by, and each one is tested with the
spellings a real customer actually types rather than with the canonical form
the database ends up holding:

  * the admin customer form
  * the counter's create-and-attach
  * guest checkout, which is where a returning customer is recognised or lost
  * self-registration, which links a login to a record that may already exist

The invariant is the same in all four: what is stored is `8801XXXXXXXXX`, and a
number already on file is found rather than filed again.
"""

from __future__ import annotations

import importlib
import uuid
from decimal import Decimal

import pytest
from django.apps import apps as django_apps
from django.utils import timezone

from customers.models import Customer, CustomerAddress, CustomerNote
from orders.models import Order, PaymentMethod
from purchasing.models import Supplier
from tests import factories

pytestmark = pytest.mark.django_db

CUSTOMERS = "/api/v1/customers/"

#: The same subscriber, as four different people would write it down.
SPELLINGS = ["01712345678", "+8801712345678", "8801712345678", "0171 234-5678"]
CANONICAL = "8801712345678"

ADDRESS = {
    "recipient_name": "Ayesha Rahman",
    "phone": "01711000000",
    "line1": "House 12, Road 5",
    "city": "Dhaka",
}


def _add_to_cart(api, variant, quantity=1, token=None):
    headers = {"HTTP_X_CART_TOKEN": token} if token else {}
    return api.post(
        "/api/v1/shop/cart/",
        {"variant": str(variant.pk), "quantity": quantity},
        format="json",
        **headers,
    )


class TestWhatGetsStored:
    @pytest.mark.parametrize("typed", SPELLINGS)
    def test_every_spelling_is_stored_as_one(self, shop, auth_client, typed) -> None:
        response = auth_client(shop["manager"]).post(
            CUSTOMERS, {"name": "Nusrat Jahan", "phone": typed}, format="json"
        )

        assert response.status_code == 201, response.data
        assert response.data["phone"] == CANONICAL
        assert Customer.objects.get(name="Nusrat Jahan").phone == CANONICAL

    def test_an_edit_canonicalises_too(self, shop, auth_client) -> None:
        customer = factories.customer(phone="01798765432")

        response = auth_client(shop["manager"]).patch(
            f"{CUSTOMERS}{customer.pk}/", {"phone": "+8801712345678"}, format="json"
        )

        assert response.status_code == 200, response.data
        customer.refresh_from_db()
        assert customer.phone == CANONICAL

    def test_an_address_contact_number_is_canonicalised(self, shop, auth_client) -> None:
        customer = factories.customer()

        response = auth_client(shop["manager"]).post(
            f"{CUSTOMERS}{customer.pk}/addresses/",
            {**ADDRESS, "phone": "+880 1711-000000"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert CustomerAddress.objects.get(customer=customer).phone == "8801711000000"

    def test_the_model_refuses_an_unnormalised_number_as_a_last_resort(self) -> None:
        """The serializers are the first line; this is what makes the column true.

        A caller that goes round the API -- a management command, a shell, an
        importer -- must not be able to reintroduce a second spelling.
        """
        from core.exceptions import ValidationError

        with pytest.raises(ValidationError):
            Customer.objects.create(name="Bypass", phone="029612345")


class TestTheSamePersonIsNotFiledTwice:
    """The defect itself: two spellings, two rows, one person."""

    @pytest.mark.parametrize("second", ["+8801712345678", "8801712345678", "0171 234 5678"])
    def test_a_second_spelling_is_refused_as_a_field_error(self, shop, auth_client, second) -> None:
        factories.customer(name="Nusrat Jahan", phone="01712345678")

        response = auth_client(shop["manager"]).post(
            CUSTOMERS, {"name": "Nusrat Again", "phone": second}, format="json"
        )

        # A field error, not a 500: normalisation happens before the uniqueness
        # check, so this never reaches the database constraint.
        assert response.status_code == 400, response.data
        assert "phone" in response.data["error"]["details"]
        assert Customer.objects.filter(phone=CANONICAL).count() == 1

    def test_a_number_that_is_not_a_mobile_is_refused_not_stored(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            CUSTOMERS, {"name": "Landline Ltd", "phone": "029612345"}, format="json"
        )

        assert response.status_code == 400
        assert "phone" in response.data["error"]["details"]


class TestTheCounterFindsThem:
    @pytest.mark.parametrize("typed", [*SPELLINGS, "345678", "0171", "1712345678"])
    def test_whatever_the_cashier_types_finds_the_one_record(
        self, shop, auth_client, typed
    ) -> None:
        customer = factories.customer(name="Nusrat Jahan", phone="01712345678")

        response = auth_client(shop["cashier"]).get("/api/v1/customers/lookup/", {"phone": typed})

        assert response.status_code == 200
        assert [row["id"] for row in response.json()["results"]] == [str(customer.pk)]

    def test_the_admin_list_search_finds_them_by_the_international_form(
        self, shop, auth_client
    ) -> None:
        customer = factories.customer(name="Nusrat Jahan", phone="01712345678")

        response = auth_client(shop["manager"]).get(CUSTOMERS, {"search": "+8801712345678"})

        assert response.status_code == 200
        assert [row["id"] for row in response.data["results"]] == [str(customer.pk)]


class TestAReturningGuestIsRecognised:
    """What D48 actually cost: a repeat customer whose history split in two."""

    def test_a_second_order_in_another_spelling_lands_on_the_same_customer(self, api, shop) -> None:
        def buy(contact_phone: str) -> Order:
            # A fresh cart each time: this is the same shopper coming back, not
            # one checkout run twice.
            token = _add_to_cart(api, shop["variants"][0])["X-Cart-Token"]
            response = api.post(
                "/api/v1/shop/checkout/",
                {
                    "shipping_address": {**ADDRESS, "phone": contact_phone},
                    "payment_method": PaymentMethod.COD,
                    "contact_name": "Ayesha Rahman",
                    "contact_phone": contact_phone,
                },
                format="json",
                HTTP_X_CART_TOKEN=token,
                HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
            )
            assert response.status_code == 201, response.data
            return Order.objects.get(number=response.data["order"]["number"])

        first = buy("01711000000")
        second = buy("+8801711000000")

        assert first.customer_id == second.customer_id
        assert Customer.objects.filter(phone="8801711000000").count() == 1

    def test_a_registration_links_to_the_record_the_counter_already_made(self, api, shop) -> None:
        counter_record = factories.customer(name="Ayesha Rahman", phone="01711000000")

        response = api.post(
            "/api/v1/auth/register/",
            {
                "email": "ayesha@example.com",
                "password": "a-long-enough-password",
                "first_name": "Ayesha",
                "phone": "+8801711000000",
            },
            format="json",
        )

        assert response.status_code == 201, response.data
        counter_record.refresh_from_db()
        assert counter_record.user is not None
        assert Customer.objects.filter(phone="8801711000000").count() == 1


class TestContactNumbersStayLenient:
    """A supplier is not an identity, and a landline is not a mistake."""

    def test_a_supplier_mobile_is_canonicalised(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/suppliers/",
            {"name": "Dhaka Textiles", "phone": "01712345678"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert Supplier.objects.get(name="Dhaka Textiles").phone == CANONICAL

    def test_a_supplier_landline_is_kept_as_typed(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/suppliers/",
            {"name": "Chittagong Mills", "phone": "+8809610003030"},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert Supplier.objects.get(name="Chittagong Mills").phone == "+8809610003030"


class TestTheMigrationCleansUpWhatIsAlreadyThere:
    """The data left behind by the defect, not the rule that stops new data.

    Rows are written with `.update()` so they bypass `Customer.save()` — that is
    the only way to reproduce a database written before the rule existed.
    """

    @staticmethod
    def _run_migration() -> None:
        module = importlib.import_module("customers.migrations.0004_canonical_phone_numbers")
        module.canonicalise_phone_numbers(django_apps, None)

    @staticmethod
    def _with_raw_phone(customer: Customer, raw: str) -> None:
        Customer.objects.filter(pk=customer.pk).update(phone=raw)

    def test_two_spellings_become_one_customer(self, shop) -> None:
        older = factories.customer(name="Ayesha Rahman", phone="01712345678")
        newer = factories.customer(name="Ayesha R.", phone="01700000009")
        self._with_raw_phone(newer, "+8801712345678")

        self._run_migration()

        older.refresh_from_db()
        newer.refresh_from_db()
        assert older.phone == CANONICAL
        # Retired, never deleted: the row keeps its id and says where it went.
        assert newer.phone is None
        assert newer.is_active is False
        assert str(older.pk) in newer.notes

    def test_the_survivor_keeps_the_duplicate_s_orders(self, shop) -> None:
        older = factories.customer(name="Ayesha Rahman", phone="01712345678")
        newer = factories.customer(name="Ayesha R.", phone="01700000009")
        self._with_raw_phone(newer, "+8801712345678")
        order = Order.objects.create(
            number=factories.unique("RGN-"),
            branch=shop["branch"],
            customer=newer,
            channel="ONLINE",
            status="CONFIRMED",
            payment_status="UNPAID",
            subtotal=Decimal("1000.00"),
            grand_total=Decimal("1000.00"),
            placed_at=timezone.now(),
        )
        note = CustomerNote.objects.create(customer=newer, body="Prefers evening delivery")

        self._run_migration()

        order.refresh_from_db()
        note.refresh_from_db()
        # An order is never deleted or rewritten (CLAUDE.md §3); it is simply
        # filed against the customer that turned out to be the same person.
        assert order.customer_id == older.pk
        assert note.customer_id == older.pk

    def test_a_number_it_cannot_read_is_written_into_the_notes_not_dropped(self, shop) -> None:
        customer = factories.customer(name="Landline Ltd", phone="01700000009")
        self._with_raw_phone(customer, "029612345")

        self._run_migration()

        customer.refresh_from_db()
        assert customer.phone is None
        assert "029612345" in customer.notes

    def test_it_can_be_run_twice_without_changing_anything(self, shop) -> None:
        customer = factories.customer(name="Ayesha Rahman", phone="01712345678")

        self._run_migration()
        customer.refresh_from_db()
        first = (customer.phone, customer.notes, customer.is_active)

        self._run_migration()
        customer.refresh_from_db()
        assert (customer.phone, customer.notes, customer.is_active) == first
