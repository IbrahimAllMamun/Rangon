"""The homepage carousel: the list a merchandiser keeps, and what shoppers see.

The list is `content.HomeCarouselItem`, kept at `/api/v1/home-carousel/` by
whoever may manage navigation and banners. The homepage shows the products in
it that a shopper could open, in the order chosen; the rest wait in the list.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from accounts.models import RoleCode
from catalog.models import Product, PublishStatus
from content import services
from content.models import HomeCarouselItem
from core.models import AuditLog
from tests import factories
from tests.test_performance import HOME_QUERY_BUDGET

pytestmark = pytest.mark.django_db

URL = "/api/v1/home-carousel/"
HOME_URL = "/api/v1/shop/home/"


def stocked(name: str, *, branch: Any, **kwargs: Any) -> Product:
    """A product a shopper could buy: one variant, in stock at the storefront branch."""
    product = factories.product(name=name, **kwargs)
    factories.stock(factories.variant(product), branch, 5)
    return product


def names(rows: list[dict[str, Any]]) -> list[str]:
    return [row["product"]["name"] for row in rows]


@pytest.fixture
def admin(shop: dict[str, Any], auth_client: Any) -> Any:
    return auth_client(shop["manager"])


class TestKeepingTheList:
    def test_products_are_added_at_the_end_and_listed_in_order(self, admin, shop):
        first = stocked("Linen Shirt", branch=shop["branch"])
        second = stocked("City Handbag", branch=shop["branch"])

        created = admin.post(URL, {"product": str(first.pk)}, format="json")
        admin.post(URL, {"product": str(second.pk)}, format="json")

        assert created.status_code == 201, created.data
        assert created.data["product"]["name"] == "Linen Shirt"
        assert created.data["shown"] is True
        assert names(admin.get(URL).data) == ["Linen Shirt", "City Handbag"]

    def test_moving_changes_the_order(self, admin, shop):
        rows = [
            services.add_carousel_product(
                product_id=stocked(name, branch=shop["branch"]).pk, actor=shop["manager"]
            )
            for name in ("A", "B", "C")
        ]

        response = admin.post(f"{URL}{rows[2].pk}/move/", {"direction": "up"}, format="json")

        assert response.status_code == 200, response.data
        assert names(admin.get(URL).data) == ["A", "C", "B"]

    def test_moving_past_either_end_changes_nothing(self, admin, shop):
        top = services.add_carousel_product(
            product_id=stocked("A", branch=shop["branch"]).pk, actor=shop["manager"]
        )
        services.add_carousel_product(
            product_id=stocked("B", branch=shop["branch"]).pk, actor=shop["manager"]
        )

        response = admin.post(f"{URL}{top.pk}/move/", {"direction": "up"}, format="json")

        assert response.status_code == 200
        assert names(admin.get(URL).data) == ["A", "B"]

    def test_a_direction_that_is_neither_up_nor_down_is_refused(self, admin, shop):
        row = services.add_carousel_product(
            product_id=stocked("A", branch=shop["branch"]).pk, actor=shop["manager"]
        )

        response = admin.post(f"{URL}{row.pk}/move/", {"direction": "left"}, format="json")

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"

    def test_removing_takes_it_out_of_the_list_and_leaves_the_product(self, admin, shop):
        product = stocked("Linen Shirt", branch=shop["branch"])
        row = services.add_carousel_product(product_id=product.pk, actor=shop["manager"])

        response = admin.delete(f"{URL}{row.pk}/")

        assert response.status_code == 204
        assert admin.get(URL).data == []
        assert Product.objects.filter(pk=product.pk).exists()
        assert admin.delete(f"{URL}{row.pk}/").status_code == 404

    def test_every_change_is_in_the_audit_log(self, admin, shop):
        product = stocked("Linen Shirt", branch=shop["branch"])
        stocked_b = stocked("City Handbag", branch=shop["branch"])
        row = admin.post(URL, {"product": str(product.pk)}, format="json").data
        admin.post(URL, {"product": str(stocked_b.pk)}, format="json")
        admin.post(f"{URL}{row['id']}/move/", {"direction": "down"}, format="json")
        admin.delete(f"{URL}{row['id']}/")

        entries = AuditLog.objects.filter(entity_type="HomeCarouselItem", entity_id=row["id"])

        assert entries.count() == 3
        assert all(entry.actor_id == shop["manager"].pk for entry in entries)


class TestWhatTheListRefuses:
    def test_a_product_already_in_it(self, admin, shop):
        product = stocked("Linen Shirt", branch=shop["branch"])
        admin.post(URL, {"product": str(product.pk)}, format="json")

        response = admin.post(URL, {"product": str(product.pk)}, format="json")

        assert response.status_code == 409
        assert response.data["error"]["code"] == "CONFLICT"
        assert HomeCarouselItem.objects.count() == 1

    def test_an_archived_product_which_would_never_show(self, admin, shop):
        product = stocked("Old Stock", branch=shop["branch"], status=PublishStatus.ARCHIVED)

        response = admin.post(URL, {"product": str(product.pk)}, format="json")

        assert response.status_code == 400
        assert "product" in response.data["error"]["details"]
        assert not HomeCarouselItem.objects.exists()

    def test_a_product_that_does_not_exist(self, admin):
        missing = admin.post(
            URL, {"product": "5b0e1b7e-8d0a-4c55-9d4a-4f0e7d3f2a11"}, format="json"
        )
        garbled = admin.post(URL, {"product": "not-a-product"}, format="json")

        assert missing.status_code == 400
        assert garbled.status_code == 400

    def test_more_than_it_holds(self, admin, shop):
        for index in range(services.MAX_CAROUSEL_PRODUCTS):
            HomeCarouselItem.objects.create(product=factories.product(), position=index)

        response = admin.post(URL, {"product": str(factories.product().pk)}, format="json")

        assert response.status_code == 400
        assert HomeCarouselItem.objects.count() == services.MAX_CAROUSEL_PRODUCTS

    def test_a_draft_may_wait_in_the_list_and_says_why_it_is_not_shown(self, admin, shop):
        product = stocked(
            "Next Season", branch=shop["branch"], status=PublishStatus.DRAFT, published=False
        )

        response = admin.post(URL, {"product": str(product.pk)}, format="json")

        assert response.status_code == 201
        assert response.data["shown"] is False
        assert "draft" in response.data["hidden_reason"].lower()


class TestWhoMayKeepIt:
    def test_a_cashier_may_neither_read_nor_change_it(self, auth_client, shop):
        cashier = auth_client(shop["cashier"])
        product = stocked("Linen Shirt", branch=shop["branch"])

        assert cashier.get(URL).status_code == 403
        assert cashier.post(URL, {"product": str(product.pk)}, format="json").status_code == 403

    def test_reading_the_settings_is_not_permission_to_change_it(self, auth_client, shop):
        accountant = auth_client(factories.user(RoleCode.ACCOUNTANT, branch_obj=shop["branch"]))
        product = stocked("Linen Shirt", branch=shop["branch"])
        row = services.add_carousel_product(product_id=product.pk, actor=shop["manager"])

        assert accountant.get(URL).status_code == 200
        assert accountant.post(URL, {"product": str(product.pk)}, format="json").status_code == 403
        assert accountant.delete(f"{URL}{row.pk}/").status_code == 403
        assert (
            accountant.post(f"{URL}{row.pk}/move/", {"direction": "up"}, format="json").status_code
            == 403
        )

    def test_a_shopper_cannot_reach_it(self, api):
        assert api.get(URL).status_code == 401


class TestTheHomepage:
    def test_shows_the_products_in_the_chosen_order(self, api, shop):
        for name in ("Linen Shirt", "City Handbag", "Street Runner"):
            services.add_carousel_product(
                product_id=stocked(name, branch=shop["branch"]).pk, actor=shop["manager"]
            )
        last = HomeCarouselItem.objects.order_by("position").last()
        services.move_carousel_product(item_id=last.pk, direction="up", actor=shop["manager"])

        carousel = api.get(HOME_URL).data["carousel"]

        assert [product["name"] for product in carousel] == [
            "Linen Shirt",
            "Street Runner",
            "City Handbag",
        ]
        assert carousel[0]["variants"][0]["in_stock"] is True

    def test_skips_what_a_shopper_could_not_open_and_keeps_it_in_the_list(self, api, shop):
        live = stocked("Linen Shirt", branch=shop["branch"])
        draft = stocked("Next Season", branch=shop["branch"], status=PublishStatus.DRAFT)
        counter = stocked("Counter Only", branch=shop["branch"], published=False)
        for product in (draft, live, counter):
            services.add_carousel_product(product_id=product.pk, actor=shop["manager"])
        # Archived after it was added: it leaves the homepage by itself.
        retired = stocked("Retired", branch=shop["branch"])
        services.add_carousel_product(product_id=retired.pk, actor=shop["manager"])
        Product.objects.filter(pk=retired.pk).update(status=PublishStatus.ARCHIVED)

        carousel = api.get(HOME_URL).data["carousel"]

        assert [product["name"] for product in carousel] == ["Linen Shirt"]
        assert HomeCarouselItem.objects.count() == 4

    def test_an_empty_list_is_an_empty_carousel(self, api, shop):
        assert api.get(HOME_URL).data["carousel"] == []

    def test_no_longer_carries_the_category_row(self, api, shop):
        assert "featured_categories" not in api.get(HOME_URL).data

    def test_queries_do_not_grow_with_the_carousel(self, api, shop):
        _, values = factories.attribute("size", values=["S", "M", "L"])

        def add(count: int) -> None:
            for _ in range(count):
                product = factories.product()
                for value in values:
                    factories.stock(
                        factories.variant(product, attribute_values=[value]), shop["branch"], 5
                    )
                services.add_carousel_product(product_id=product.pk, actor=shop["manager"])

        def count() -> int:
            with CaptureQueriesContext(connection) as captured:
                assert api.get(HOME_URL).status_code == 200
            return len(captured)

        add(2)
        count()  # warm
        with_few = count()
        add(8)
        with_many = count()

        assert with_many == with_few, f"{with_few} queries grew to {with_many}: an N+1"
        # The carousel is one more rail on a page with a documented budget.
        assert with_many <= HOME_QUERY_BUDGET, (
            f"The home page used {with_many} queries with a full carousel, over "
            f"{HOME_QUERY_BUDGET} (docs/database/indexing.md)."
        )


class TestTheStorefrontIsToldToRefresh:
    def test_adding_removing_and_moving_each_ask_for_the_homepage(
        self, admin, shop, monkeypatch, django_capture_on_commit_callbacks
    ):
        sent: list[tuple[str, ...]] = []
        monkeypatch.setattr("content.signals.request_revalidation", lambda *tags: sent.append(tags))
        monkeypatch.setattr(
            "content.api.views.request_revalidation", lambda *tags: sent.append(tags)
        )
        first = stocked("A", branch=shop["branch"])
        second = stocked("B", branch=shop["branch"])

        with django_capture_on_commit_callbacks(execute=True):
            row = admin.post(URL, {"product": str(first.pk)}, format="json").data
            admin.post(URL, {"product": str(second.pk)}, format="json")
        assert sent.count(("home",)) == 2

        with django_capture_on_commit_callbacks(execute=True):
            admin.post(f"{URL}{row['id']}/move/", {"direction": "down"}, format="json")
        assert sent.count(("home",)) == 3

        with django_capture_on_commit_callbacks(execute=True):
            admin.delete(f"{URL}{row['id']}/")
        assert sent.count(("home",)) == 4
