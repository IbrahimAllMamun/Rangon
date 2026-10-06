"""Reviews waiting on a moderator, for the parity suite (phase 6 part 9).

Applied by `scripts/nest-parity.sh seed`, after fixture_shipping.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_reviews.py

Idempotent: it does nothing when its first review is already there.

Beside the reviews fixture.py and fixture_orders.py wrote, by title:

- "Parity mod five": PENDING, five stars, a verified purchase on a delivered order.
- "Parity mod one": PENDING, one star, from a guest, with a long comment.
- "Parity mod three": PENDING, three stars, no comment.
- "Parity mod refused": REJECTED by the manager, with the reason noted.
- "Parity mod passed": APPROVED by the manager, with a note.

They belong to a demo-seed customer and to the parity guest, neither of whom
signs in: orders-cases.ts deletes, before each of its cases, every review of
the customers who do.
"""

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from accounts.models import User
from catalog.models import ProductVariant
from customers.models import Customer
from engagement.models import Review, ReviewStatus
from orders.models import Order, OrderStatus

MARKER = "Parity mod five"


def apply() -> None:
    manager = User.objects.get(email="manager@rangon.test")
    buyer = Customer.objects.get(phone="8801716000005", user__isnull=True)
    guest = Customer.objects.get(email="parity.guest@rangon.test")
    shirt = ProductVariant.objects.get(sku="RGN-CLA-M-WHI").product
    tee = ProductVariant.objects.get(sku="RGN-ESS-M-OLI").product
    delivered = (
        Order.objects.filter(customer=buyer, status=OrderStatus.DELIVERED)
        .order_by("number")
        .first()
    )
    bought = delivered.items.order_by("created_at", "sku").first().variant.product
    now = timezone.now()

    def review(title, rating, status=ReviewStatus.PENDING, minutes=0, **fields):
        made = Review.objects.create(title=title, rating=rating, status=status, **fields)
        # In a known order, whatever the clock did while they were written.
        Review.objects.filter(pk=made.pk).update(created_at=now - timedelta(minutes=minutes))
        return made

    review(
        MARKER,
        5,
        minutes=50,
        product=bought,
        customer=buyer,
        order=delivered,
        verified_purchase=True,
        comment="Fits well.",
    )
    review(
        "Parity mod one",
        1,
        minutes=40,
        product=tee,
        customer=guest,
        comment="রং উঠে গেছে।\nShrank after one wash — not what the photo shows. " * 4,
    )
    review("Parity mod three", 3, minutes=30, product=shirt, customer=guest)
    review(
        "Parity mod refused",
        2,
        ReviewStatus.REJECTED,
        minutes=20,
        product=tee,
        customer=buyer,
        comment="Call me on 01700000000",
        moderated_by=manager,
        moderated_at=now - timedelta(minutes=15),
        moderation_note="Carries a phone number",
    )
    review(
        "Parity mod passed",
        4,
        ReviewStatus.APPROVED,
        minutes=10,
        product=shirt,
        customer=buyer,
        moderated_by=manager,
        moderated_at=now - timedelta(minutes=5),
        moderation_note="Fine",
    )
    print("parity reviews fixture applied")


if Review.objects.filter(title=MARKER).exists():
    print("parity reviews fixture already applied")
else:
    with transaction.atomic():
        apply()
