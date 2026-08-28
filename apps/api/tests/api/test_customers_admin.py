"""The customer endpoints as the admin screens use them.

Before this file the customers API had no tests at all, and four things were
wrong with it.  Each has a class here:

  * an accountant holds `customers.view` and not `customers.update`, yet could
    write addresses and notes through the read endpoint's permission;
  * addresses could be created but never edited or deleted, so an admin edit
    screen could not exist;
  * nothing demoted the previous default address, so a customer could hold
    several and checkout's pre-filled address became arbitrary;
  * phone-first identity was enforced on create but not on update, so an edit
    could leave a customer with no way to be found again.
"""

from __future__ import annotations

import pytest

from accounts.permissions import RoleCode
from customers.models import CustomerAddress, CustomerNote
from tests import factories

pytestmark = pytest.mark.django_db


ADDRESS = {
    "recipient_name": "Nusrat Jahan",
    "phone": "01712345678",
    "line1": "House 12, Road 4",
    "city": "Dhaka",
}


def _address(customer, **kwargs):
    return CustomerAddress.objects.create(customer=customer, **{**ADDRESS, **kwargs})


class TestWhoMayWrite:
    """`customers.view` must not carry a write.

    The accountant role is the one that proves it: the permission matrix gives
    it `customers.view` deliberately without create or update.
    """

    def test_an_accountant_cannot_add_an_address(self, shop, auth_client) -> None:
        customer = factories.customer()
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])

        response = auth_client(accountant).post(
            f"/api/v1/customers/{customer.pk}/addresses/", ADDRESS, format="json"
        )

        assert response.status_code == 403
        assert not CustomerAddress.objects.filter(customer=customer).exists()

    def test_an_accountant_cannot_add_a_note(self, shop, auth_client) -> None:
        customer = factories.customer()
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])

        response = auth_client(accountant).post(
            f"/api/v1/customers/{customer.pk}/notes/", {"body": "Prefers a call"}, format="json"
        )

        assert response.status_code == 403
        assert not CustomerNote.objects.filter(customer=customer).exists()

    def test_an_accountant_can_still_read_them(self, shop, auth_client) -> None:
        customer = factories.customer()
        _address(customer)
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])

        response = auth_client(accountant).get(f"/api/v1/customers/{customer.pk}/addresses/")

        assert response.status_code == 200
        assert len(response.data) == 1

    def test_options_is_treated_as_a_read(self, shop, auth_client) -> None:
        """DRF routes HEAD to the GET handler and OPTIONS to the metadata probe.

        Both are reads, so they answer to GET's requirement rather than being
        denied for not appearing in the per-method mapping.
        """
        customer = factories.customer()
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])

        response = auth_client(accountant).options(f"/api/v1/customers/{customer.pk}/addresses/")

        assert response.status_code == 200

    def test_a_manager_can_write(self, shop, auth_client) -> None:
        customer = factories.customer()

        response = auth_client(shop["manager"]).post(
            f"/api/v1/customers/{customer.pk}/addresses/", ADDRESS, format="json"
        )

        assert response.status_code == 201, response.data
        assert response.data["recipient_name"] == "Nusrat Jahan"

    def test_an_address_cannot_be_written_onto_another_customer(self, shop, auth_client) -> None:
        """`customer` is read-only: the URL decides whose address this is."""
        customer = factories.customer()
        victim = factories.customer()

        response = auth_client(shop["manager"]).post(
            f"/api/v1/customers/{customer.pk}/addresses/",
            {**ADDRESS, "customer": str(victim.pk)},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert not CustomerAddress.objects.filter(customer=victim).exists()
        assert CustomerAddress.objects.filter(customer=customer).count() == 1


class TestEditingAnAddress:
    """The endpoints an edit screen needs, which did not exist."""

    def test_an_address_can_be_edited(self, shop, auth_client) -> None:
        customer = factories.customer()
        address = _address(customer)

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/addresses/{address.pk}/",
            {"city": "Chattogram", "area": "Agrabad"},
            format="json",
        )

        assert response.status_code == 200, response.data
        address.refresh_from_db()
        assert address.city == "Chattogram"
        assert address.area == "Agrabad"
        assert address.recipient_name == "Nusrat Jahan"  # untouched

    def test_an_address_can_be_deleted(self, shop, auth_client) -> None:
        customer = factories.customer()
        keep = _address(customer, is_default=True)
        spare = _address(customer, recipient_name="Spare")

        response = auth_client(shop["manager"]).delete(
            f"/api/v1/customers/{customer.pk}/addresses/{spare.pk}/"
        )

        assert response.status_code == 204
        assert list(CustomerAddress.objects.filter(customer=customer)) == [keep]

    def test_another_customers_address_is_not_reachable(self, shop, auth_client) -> None:
        customer = factories.customer()
        other = factories.customer()
        address = _address(other)

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/addresses/{address.pk}/",
            {"city": "Khulna"},
            format="json",
        )

        assert response.status_code == 404
        address.refresh_from_db()
        assert address.city == "Dhaka"

    def test_an_accountant_cannot_edit_or_delete(self, shop, auth_client) -> None:
        customer = factories.customer()
        address = _address(customer)
        accountant = factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"])
        client = auth_client(accountant)
        url = f"/api/v1/customers/{customer.pk}/addresses/{address.pk}/"

        assert client.patch(url, {"city": "Khulna"}, format="json").status_code == 403
        assert client.delete(url).status_code == 403
        assert CustomerAddress.objects.filter(pk=address.pk).exists()


class TestTheDefaultAddress:
    """At most one default per customer, and never none while addresses exist.

    `CustomerAddress.Meta.ordering` is `("-is_default", "-created_at")`, so
    `addresses.first()` — which is how checkout pre-fills — is only meaningful
    if exactly one row claims the default.
    """

    def test_the_first_address_becomes_the_default(self, shop, auth_client) -> None:
        customer = factories.customer()

        response = auth_client(shop["manager"]).post(
            f"/api/v1/customers/{customer.pk}/addresses/", ADDRESS, format="json"
        )

        assert response.status_code == 201
        assert response.data["is_default"] is True

    def test_a_new_default_demotes_the_previous_one(self, shop, auth_client) -> None:
        customer = factories.customer()
        first = _address(customer, is_default=True)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/customers/{customer.pk}/addresses/",
            {**ADDRESS, "recipient_name": "Second", "is_default": True},
            format="json",
        )

        assert response.status_code == 201
        first.refresh_from_db()
        assert first.is_default is False
        assert CustomerAddress.objects.filter(customer=customer, is_default=True).count() == 1

    def test_promoting_by_edit_demotes_the_previous_one(self, shop, auth_client) -> None:
        customer = factories.customer()
        first = _address(customer, is_default=True)
        second = _address(customer, recipient_name="Second")

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/addresses/{second.pk}/",
            {"is_default": True},
            format="json",
        )

        assert response.status_code == 200
        first.refresh_from_db()
        assert first.is_default is False
        assert CustomerAddress.objects.filter(customer=customer, is_default=True).count() == 1

    def test_deleting_the_default_promotes_a_replacement(self, shop, auth_client) -> None:
        customer = factories.customer()
        default = _address(customer, is_default=True)
        spare = _address(customer, recipient_name="Spare")

        response = auth_client(shop["manager"]).delete(
            f"/api/v1/customers/{customer.pk}/addresses/{default.pk}/"
        )

        assert response.status_code == 204
        spare.refresh_from_db()
        assert spare.is_default is True

    def test_the_only_address_cannot_be_un_defaulted(self, shop, auth_client) -> None:
        customer = factories.customer()
        only = _address(customer, is_default=True)

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/addresses/{only.pk}/",
            {"is_default": False},
            format="json",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        only.refresh_from_db()
        assert only.is_default is True


class TestPhoneFirstIdentity:
    """A customer with neither phone nor email cannot be found again."""

    def test_create_needs_a_contact_detail(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/customers/", {"name": "No Contact"}, format="json"
        )

        assert response.status_code == 400

    def test_an_edit_cannot_clear_both_contact_details(self, shop, auth_client) -> None:
        customer = factories.customer(phone="01798765432", email="")

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/", {"phone": ""}, format="json"
        )

        assert response.status_code == 400
        customer.refresh_from_db()
        assert customer.phone == "01798765432"

    def test_an_edit_may_swap_phone_for_email(self, shop, auth_client) -> None:
        customer = factories.customer(phone="01798765432")

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/",
            {"phone": "", "email": "nusrat@example.com"},
            format="json",
        )

        assert response.status_code == 200, response.data
        customer.refresh_from_db()
        assert customer.phone is None
        assert customer.email == "nusrat@example.com"

    def test_a_partial_edit_that_touches_neither_is_allowed(self, shop, auth_client) -> None:
        customer = factories.customer(phone="01798765432")

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/customers/{customer.pk}/", {"name": "Renamed"}, format="json"
        )

        assert response.status_code == 200, response.data
        customer.refresh_from_db()
        assert customer.name == "Renamed"


class TestNotes:
    def test_a_note_can_be_added_and_records_its_author(self, shop, auth_client) -> None:
        customer = factories.customer()

        response = auth_client(shop["manager"]).post(
            f"/api/v1/customers/{customer.pk}/notes/",
            {"body": "Asked for a call before delivery", "is_pinned": True},
            format="json",
        )

        assert response.status_code == 201, response.data
        assert response.data["created_by_email"] == shop["manager"].email
        assert response.data["is_pinned"] is True

    def test_an_empty_note_is_refused(self, shop, auth_client) -> None:
        customer = factories.customer()

        response = auth_client(shop["manager"]).post(
            f"/api/v1/customers/{customer.pk}/notes/", {"body": "   "}, format="json"
        )

        assert response.status_code == 400

    def test_a_note_can_be_deleted(self, shop, auth_client) -> None:
        customer = factories.customer()
        note = CustomerNote.objects.create(customer=customer, body="Temporary")

        response = auth_client(shop["manager"]).delete(
            f"/api/v1/customers/{customer.pk}/notes/{note.pk}/"
        )

        assert response.status_code == 204
        assert not CustomerNote.objects.filter(pk=note.pk).exists()


class TestDeactivation:
    def test_deleting_a_customer_deactivates_rather_than_removes(self, shop, auth_client) -> None:
        """Their orders must remain intact, so the row survives."""
        customer = factories.customer()

        response = auth_client(shop["manager"]).delete(f"/api/v1/customers/{customer.pk}/")

        assert response.status_code == 204
        customer.refresh_from_db()
        assert customer.is_active is False
