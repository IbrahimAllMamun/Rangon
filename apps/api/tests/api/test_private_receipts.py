"""Expense receipts are staff documents, not public media (D91).

Measured against `main` before this was written: a manager attached
`receipt.png` to an expense, it was stored as `expenses/2026/09/receipt.png`,
and an **anonymous** GET of `/media/expenses/2026/09/receipt.png` answered 200
with the image. The path was the year, the month and the uploader's own
filename -- `IMG_0412.jpg` off a phone -- and `/media/` has no rate limit, so
the folder could be walked. Under `USE_S3=1` the same held: storage URLs are
unsigned (`querystring_auth: False`).

Run against `main`, the first two tests here fail -- the anonymous fetch is a
200 and the stored name is the uploader's -- and the endpoint tests fail with a
404 on a route that did not exist.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image
from rest_framework.test import APIClient

from accounts.models import RoleCode
from finance.models import AccountKind, Expense
from tests import factories

pytestmark = pytest.mark.django_db


def _png(name: str = "receipt.png") -> SimpleUploadedFile:
    buffer = BytesIO()
    Image.new("RGB", (2, 2), (0, 128, 0)).save(buffer, format="PNG")
    return SimpleUploadedFile(name, buffer.getvalue(), content_type="image/png")


@pytest.fixture
def disk(settings: Any, tmp_path: Any) -> None:
    """Uploads on disk with DEBUG off -- what every non-S3 deployment runs."""
    settings.DEBUG = False
    settings.MEDIA_ROOT = tmp_path
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }


@pytest.fixture
def receipt(disk: None, auth_client: Any) -> dict[str, Any]:
    org = factories.organization()
    branch = factories.branch(org)
    manager = factories.user(RoleCode.MANAGER, branch_obj=branch)
    account = factories.account(branch, kind=AccountKind.CASH, opening_balance="5000.00")
    response = auth_client(manager).post(
        "/api/v1/expenses/",
        {
            "branch": str(branch.pk),
            "category": str(factories.expense_category().pk),
            "account": str(account.pk),
            "amount": "250.00",
            "attachment": _png(),
        },
        format="multipart",
    )
    assert response.status_code == 201, response.data
    return {
        "org": org,
        "branch": branch,
        "manager": manager,
        "payload": response.data,
        "expense": Expense.objects.get(pk=response.data["id"]),
    }


class TestTheMediaRouteRefusesReceipts:
    def test_an_anonymous_caller_cannot_fetch_a_receipt(self, receipt: dict[str, Any]) -> None:
        """Fails on `main`: 200 and the image."""
        stored = receipt["expense"].attachment.name

        response = APIClient().get(f"/media/{stored}")

        assert response.status_code == 404

    @pytest.mark.parametrize("spelling", ["./{}", "products/../{}", "/{}"])
    def test_no_spelling_of_the_path_gets_round_it(
        self, receipt: dict[str, Any], spelling: str
    ) -> None:
        stored = receipt["expense"].attachment.name

        response = APIClient().get("/media/" + spelling.format(stored))

        assert response.status_code == 404

    def test_the_stored_name_is_not_the_uploaders(self, receipt: dict[str, Any]) -> None:
        """Fails on `main`: `expenses/<y>/<m>/receipt.png`.

        The second lock, for a deployment where the first is misconfigured.
        """
        stored = receipt["expense"].attachment.name

        assert stored.startswith("expenses/")
        assert "receipt" not in stored
        assert stored.endswith(".png")

    def test_a_product_photograph_is_still_public(self, disk: None, auth_client: Any) -> None:
        """A control: the refusal is for receipts, not for `/media/`."""
        from catalog.models import Category

        category = Category.objects.create(name="Sarees", slug="sarees", image=_png("hero.png"))

        response = APIClient().get(category.image.url)

        assert response.status_code == 200


class TestTheReceiptEndpoint:
    def test_the_payload_points_at_the_endpoint_not_at_media(self, receipt: dict[str, Any]) -> None:
        expected = f"/api/v1/expenses/{receipt['expense'].pk}/attachment/"

        assert receipt["payload"]["attachment_url"] == expected
        assert receipt["payload"]["attachment"] == expected

    def test_staff_at_the_branch_get_the_file(
        self, receipt: dict[str, Any], auth_client: Any
    ) -> None:
        response = auth_client(receipt["manager"]).get(receipt["payload"]["attachment_url"])

        assert response.status_code == 200
        body = b"".join(response.streaming_content)
        assert body.startswith(b"\x89PNG")
        assert response["Content-Type"] == "image/png"
        assert response["Cache-Control"] == "private, no-store"
        assert response["X-Content-Type-Options"] == "nosniff"
        assert receipt["expense"].number in response["Content-Disposition"]

    def test_an_anonymous_caller_is_refused(self, receipt: dict[str, Any]) -> None:
        response = APIClient().get(receipt["payload"]["attachment_url"])

        assert response.status_code == 401

    def test_staff_at_another_branch_cannot_see_it(
        self, receipt: dict[str, Any], auth_client: Any
    ) -> None:
        elsewhere = factories.branch(receipt["org"])
        stranger = factories.user(RoleCode.MANAGER, branch_obj=elsewhere)

        response = auth_client(stranger).get(receipt["payload"]["attachment_url"])

        assert response.status_code == 404

    def test_a_role_without_finance_view_is_refused(
        self, receipt: dict[str, Any], auth_client: Any
    ) -> None:
        stock_keeper = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=receipt["branch"])

        response = auth_client(stock_keeper).get(receipt["payload"]["attachment_url"])

        assert response.status_code == 403

    def test_an_expense_without_a_receipt_answers_404(self, disk: None, auth_client: Any) -> None:
        branch = factories.branch()
        manager = factories.user(RoleCode.MANAGER, branch_obj=branch)
        expense = factories.expense(branch)

        response = auth_client(manager).get(f"/api/v1/expenses/{expense.pk}/attachment/")

        # The message, not only the status: on `main` the route did not exist,
        # so a bare 404 passed there for the wrong reason.
        assert response.status_code == 404
        assert response.data["error"]["message"] == "This expense has no receipt."
