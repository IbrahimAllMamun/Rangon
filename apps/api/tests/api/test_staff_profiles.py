"""A member of staff's personal details: addresses, ID, emergency contact.

The most personal data the system holds, so what is defended here is where it
goes: only `users.manage` reads or writes it, and the audit log records which
fields changed but never their values (business-rules §7.1b).
"""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from accounts.models import RoleCode, StaffProfile
from core.models import AuditLog
from tests import factories

pytestmark = pytest.mark.django_db

ADDRESS = "House 12, Road 5, Dhanmondi, Dhaka 1205"


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


@pytest.fixture
def staff(shop):
    return factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])


def audit_text(user) -> str:
    """Everything the audit log holds about one account, as one string."""
    entries = AuditLog.objects.filter(entity_id=str(user.pk))
    return json.dumps([[e.old_values, e.new_values, e.reason] for e in entries], default=str)


class TestRecording:
    def test_an_owner_creates_an_account_with_its_profile_in_one_request(self, admin, shop):
        response = admin.post(
            "/api/v1/users/",
            {
                "email": "newhire@rangon.test",
                "password": "a-long-enough-password-1",
                "role_code": RoleCode.CASHIER,
                "branch": str(shop["branch"].pk),
                "phone": "01712345678",
                "profile": {
                    "designation": "Cashier",
                    "joined_on": "2026-09-01",
                    "present_address": ADDRESS,
                    "permanent_address": "Village Char Bhadrasan, Faridpur",
                    "emergency_contact_name": "Rahima Begum",
                    "emergency_contact_relation": "Mother",
                    "emergency_contact_phone": "01811111111",
                },
            },
            format="json",
        )

        assert response.status_code == 201, response.json()
        profile = StaffProfile.objects.get(user__email="newhire@rangon.test")
        assert profile.present_address == ADDRESS
        assert profile.created_by == shop["owner"]
        # Stored canonically, like every other mobile number in the system.
        assert profile.emergency_contact_phone == "8801811111111"
        assert response.json()["profile"]["designation"] == "Cashier"

    def test_a_patch_changes_only_the_fields_it_names(self, admin, staff):
        StaffProfile.objects.create(user=staff, designation="Cashier", present_address=ADDRESS)

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"profile": {"designation": "Senior cashier"}},
            format="json",
        )

        assert response.status_code == 200, response.json()
        staff.staff_profile.refresh_from_db()
        assert staff.staff_profile.designation == "Senior cashier"
        assert staff.staff_profile.present_address == ADDRESS
        # The response reflects the save, not the row read before it.
        assert response.json()["profile"]["designation"] == "Senior cashier"

    def test_an_account_with_no_profile_reads_as_a_blank_one(self, admin, staff):
        response = admin.get(f"/api/v1/users/{staff.pk}/")

        assert response.status_code == 200
        assert response.json()["profile"]["present_address"] == ""
        assert response.json()["profile"]["date_of_birth"] is None
        assert not StaffProfile.objects.filter(user=staff).exists()

    def test_a_patch_that_changes_nothing_writes_nothing(self, admin, staff):
        before = AuditLog.objects.count()

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/", {"profile": {"notes": ""}}, format="json"
        )

        assert response.status_code == 200
        assert not StaffProfile.objects.filter(user=staff).exists()
        assert AuditLog.objects.count() == before


class TestWhoSeesIt:
    def test_a_manager_sees_the_staff_list_without_any_profile(self, shop, auth_client, staff):
        StaffProfile.objects.create(user=staff, present_address=ADDRESS, national_id="1234567890")
        client = auth_client(shop["manager"])

        listing = client.get("/api/v1/users/")
        detail = client.get(f"/api/v1/users/{staff.pk}/")

        assert listing.status_code == 200
        assert detail.status_code == 200
        assert all("profile" not in row for row in listing.json()["results"])
        assert "profile" not in detail.json()
        assert ADDRESS not in listing.content.decode() + detail.content.decode()

    def test_a_manager_cannot_write_a_profile(self, shop, auth_client, staff):
        response = auth_client(shop["manager"]).patch(
            f"/api/v1/users/{staff.pk}/",
            {"profile": {"present_address": ADDRESS}},
            format="json",
        )

        assert response.status_code == 403
        assert not StaffProfile.objects.filter(user=staff).exists()

    def test_activating_an_account_does_not_hand_back_its_profile(self, admin, staff):
        """The activate/deactivate actions build their own serializer; without
        a request in its context it must leave the profile out, not include it."""
        StaffProfile.objects.create(user=staff, present_address=ADDRESS)

        response = admin.post(f"/api/v1/users/{staff.pk}/deactivate/")

        assert response.status_code == 200
        assert "profile" not in response.json()


class TestTheAuditTrail:
    def test_names_the_fields_that_changed_but_never_their_values(self, admin, staff):
        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {
                "profile": {
                    "present_address": ADDRESS,
                    "national_id": "19901234567890123",
                    "date_of_birth": "1990-05-17",
                }
            },
            format="json",
        )

        assert response.status_code == 200
        entry = AuditLog.objects.filter(entity_id=str(staff.pk)).latest("created_at")
        assert entry.new_values["profile_updated"] == [
            "date_of_birth",
            "national_id",
            "present_address",
        ]
        logged = audit_text(staff)
        assert ADDRESS not in logged
        assert "19901234567890123" not in logged
        assert "1990-05-17" not in logged

    def test_creating_with_a_profile_records_which_fields_were_filled(self, admin, shop):
        admin.post(
            "/api/v1/users/",
            {
                "email": "second@rangon.test",
                "password": "a-long-enough-password-1",
                "role_code": RoleCode.CASHIER,
                "profile": {"present_address": ADDRESS},
            },
            format="json",
        )

        created = StaffProfile.objects.get(user__email="second@rangon.test").user
        entry = AuditLog.objects.get(entity_id=str(created.pk))
        assert entry.new_values["profile_recorded"] == ["present_address"]
        assert ADDRESS not in audit_text(created)


class TestValidation:
    def test_a_date_of_birth_in_the_future_is_refused(self, admin, staff):
        tomorrow = (timezone.localdate() + timedelta(days=1)).isoformat()

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"profile": {"date_of_birth": tomorrow}},
            format="json",
        )

        assert response.status_code == 400
        assert "date_of_birth" in response.json()["error"]["details"]["profile"]

    def test_joining_before_being_born_is_refused(self, admin, staff):
        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"profile": {"date_of_birth": "1995-01-01", "joined_on": "1990-01-01"}},
            format="json",
        )

        assert response.status_code == 400
        assert "joined_on" in response.json()["error"]["details"]["profile"]

    def test_one_id_number_cannot_belong_to_two_people(self, admin, shop, staff):
        other = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        StaffProfile.objects.create(user=other, national_id="1234567890")

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"profile": {"national_id": "1234567890"}},
            format="json",
        )

        assert response.status_code == 400
        assert "national_id" in response.json()["error"]["details"]["profile"]

    def test_a_refused_profile_leaves_the_account_unchanged_too(self, admin, shop, staff):
        """Account and profile are one save: a phone number must not be
        changed by a request whose profile half was refused."""
        other = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        StaffProfile.objects.create(user=other, national_id="1234567890")
        before = AuditLog.objects.count()

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"phone": "01999999999", "profile": {"national_id": "1234567890"}},
            format="json",
        )

        assert response.status_code == 400
        staff.refresh_from_db()
        assert staff.phone != "8801999999999"
        assert AuditLog.objects.count() == before

    def test_blank_id_numbers_do_not_collide(self, admin, shop, staff):
        other = factories.user(RoleCode.CASHIER, branch_obj=shop["branch"])
        StaffProfile.objects.create(user=other, designation="Stock keeper")

        response = admin.patch(
            f"/api/v1/users/{staff.pk}/",
            {"profile": {"designation": "Cashier"}},
            format="json",
        )

        assert response.status_code == 200
