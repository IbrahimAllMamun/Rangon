"""Review moderation as the admin screen uses it, checked against §6a.

Reviews are the one storefront-facing thing a staff decision makes public, so
this file asserts the two halves of that: who may decide, and that the decision
leaves a record. It also covers the eligibility rule §6a states and the code did
not implement — a second purchase earning a second review.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from accounts.permissions import RoleCode
from core.models import AuditLog
from engagement.models import Review, ReviewStatus
from orders.models import Channel, Order, OrderItem, OrderStatus
from tests import factories

pytestmark = pytest.mark.django_db


def _delivered_order(shop, *, variant=None) -> Order:
    """An order the review rule accepts: delivered, containing the product."""
    variant = variant or shop["variants"][0]
    order = Order.objects.create(
        number=f"RGN-REV-{factories.unique()}",
        channel=Channel.ONLINE,
        status=OrderStatus.DELIVERED,
        branch=shop["branch"],
        customer=shop["customer"],
    )
    OrderItem.objects.create(
        order=order,
        variant=variant,
        product_name=variant.product.name,
        variant_label=variant.label,
        sku=variant.sku,
        quantity=1,
        unit_price=Decimal("1000.00"),
        line_total=Decimal("1000.00"),
    )
    return order


def _as_customer(shop, auth_client):
    """Sign the shop's customer in, which is what the storefront form needs."""
    customer_user = factories.user(RoleCode.CUSTOMER)
    shop["customer"].user = customer_user
    shop["customer"].save()
    return auth_client(customer_user)


class TestWhoMayModerate:
    def test_a_manager_can_approve(self, shop, auth_client) -> None:
        review = Review.objects.create(product=shop["product"], customer=shop["customer"], rating=5)

        response = auth_client(shop["manager"]).post(f"/api/v1/reviews/{review.pk}/approve/")

        assert response.status_code == 200, response.data
        review.refresh_from_db()
        assert review.status == ReviewStatus.APPROVED
        assert review.moderated_by == shop["manager"]
        assert review.moderated_at is not None

    def test_a_cashier_cannot_moderate(self, shop, auth_client) -> None:
        review = Review.objects.create(product=shop["product"], customer=shop["customer"], rating=1)

        response = auth_client(shop["cashier"]).post(f"/api/v1/reviews/{review.pk}/reject/")

        assert response.status_code == 403
        review.refresh_from_db()
        assert review.status == ReviewStatus.PENDING

    def test_rejecting_records_the_note(self, shop, auth_client) -> None:
        review = Review.objects.create(product=shop["product"], customer=shop["customer"], rating=1)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/reviews/{review.pk}/reject/",
            {"note": "Abusive language"},
            format="json",
        )

        assert response.status_code == 200, response.data
        review.refresh_from_db()
        assert review.status == ReviewStatus.REJECTED
        assert review.moderation_note == "Abusive language"


class TestModerationIsAuditable:
    """A moderation decision is what makes a review public, so it is logged.

    The neighbouring `content` app writes an audit entry for every navigation
    change; deciding what customers see on a product page is at least as worth
    recording. The row's own `moderated_by`/`moderated_at` are overwritten by the
    next decision, so without a log the sequence is lost.
    """

    def test_approving_writes_an_audit_entry(self, shop, auth_client) -> None:
        review = Review.objects.create(product=shop["product"], customer=shop["customer"], rating=4)

        auth_client(shop["manager"]).post(f"/api/v1/reviews/{review.pk}/approve/")

        entry = AuditLog.objects.filter(entity_type="Review", entity_id=str(review.pk)).first()
        assert entry is not None
        assert entry.actor == shop["manager"]
        assert entry.old_values["status"] == ReviewStatus.PENDING
        assert entry.new_values["status"] == ReviewStatus.APPROVED

    def test_a_reversed_decision_keeps_both_entries(self, shop, auth_client) -> None:
        """A moderator changing their mind leaves two records, not one."""
        review = Review.objects.create(product=shop["product"], customer=shop["customer"], rating=4)
        client = auth_client(shop["manager"])

        client.post(f"/api/v1/reviews/{review.pk}/approve/")
        client.post(f"/api/v1/reviews/{review.pk}/reject/", {"note": "Second look"}, format="json")

        entries = AuditLog.objects.filter(entity_type="Review", entity_id=str(review.pk)).order_by(
            "created_at"
        )
        assert entries.count() == 2
        assert entries[1].new_values["status"] == ReviewStatus.REJECTED

    def test_re_moderating_without_a_note_keeps_the_old_one(self, shop, auth_client) -> None:
        """Omitting a note means "no new note", not "erase the previous one"."""
        review = Review.objects.create(
            product=shop["product"],
            customer=shop["customer"],
            rating=2,
            status=ReviewStatus.REJECTED,
            moderation_note="Abusive language",
        )

        auth_client(shop["manager"]).post(f"/api/v1/reviews/{review.pk}/approve/")

        review.refresh_from_db()
        assert review.status == ReviewStatus.APPROVED
        assert review.moderation_note == "Abusive language"


class TestASecondPurchaseEarnsASecondReview:
    """§6a: "A second, later order of the same product earns a second review."

    The eligible order was resolved as simply the most recent one, so a repeat
    buyer's second attempt always landed on the order they had already reviewed
    and was refused. They got one review ever, however many times they bought.
    """

    def test_a_repeat_buyer_may_review_again(self, shop, auth_client) -> None:
        first = _delivered_order(shop)
        second = _delivered_order(shop)
        client = _as_customer(shop, auth_client)
        url = f"/api/v1/shop/products/{shop['product'].slug}/reviews/"

        one = client.post(url, {"rating": 5, "comment": "Bought it again"}, format="json")
        two = client.post(url, {"rating": 4, "comment": "Second one less good"}, format="json")

        assert one.status_code == 201, one.data
        assert two.status_code == 201, two.data
        assert Review.objects.filter(product=shop["product"]).count() == 2
        # One review per purchase, not two against the same order.
        assert set(Review.objects.values_list("order_id", flat=True)) == {first.pk, second.pk}

    def test_a_third_attempt_on_two_purchases_is_refused(self, shop, auth_client) -> None:
        _delivered_order(shop)
        _delivered_order(shop)
        client = _as_customer(shop, auth_client)
        url = f"/api/v1/shop/products/{shop['product'].slug}/reviews/"

        client.post(url, {"rating": 5}, format="json")
        client.post(url, {"rating": 4}, format="json")
        third = client.post(url, {"rating": 3}, format="json")

        assert third.status_code == 400
        assert Review.objects.count() == 2

    def test_one_purchase_still_earns_only_one_review(self, shop, auth_client) -> None:
        _delivered_order(shop)
        client = _as_customer(shop, auth_client)
        url = f"/api/v1/shop/products/{shop['product'].slug}/reviews/"

        client.post(url, {"rating": 5}, format="json")
        again = client.post(url, {"rating": 1}, format="json")

        assert again.status_code == 400
        assert Review.objects.count() == 1


class TestRatingInput:
    def test_a_non_numeric_rating_is_refused(self, shop, auth_client) -> None:
        """It reached `int()` and escaped as a 500 rather than a validation error."""
        _delivered_order(shop)
        client = _as_customer(shop, auth_client)

        response = client.post(
            f"/api/v1/shop/products/{shop['product'].slug}/reviews/",
            {"rating": "excellent"},
            format="json",
        )

        assert response.status_code == 400
        assert response.data["error"]["code"] == "VALIDATION_ERROR"
        assert not Review.objects.exists()

    def test_a_fractional_rating_is_refused(self, shop, auth_client) -> None:
        """§6a: ratings are whole numbers. 4.7 was silently truncated to 4."""
        _delivered_order(shop)
        client = _as_customer(shop, auth_client)

        response = client.post(
            f"/api/v1/shop/products/{shop['product'].slug}/reviews/",
            {"rating": 4.7},
            format="json",
        )

        assert response.status_code == 400
        assert not Review.objects.exists()

    def test_out_of_range_ratings_are_refused(self, shop, auth_client) -> None:
        _delivered_order(shop)
        client = _as_customer(shop, auth_client)
        url = f"/api/v1/shop/products/{shop['product'].slug}/reviews/"

        assert client.post(url, {"rating": 0}, format="json").status_code == 400
        assert client.post(url, {"rating": 6}, format="json").status_code == 400
        assert not Review.objects.exists()
