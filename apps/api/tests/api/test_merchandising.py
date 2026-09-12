"""Price drops and "customers also bought".

Both answer from orders that happened rather than from a field someone
remembered to tick, so the tests build real baskets and then ask what the shop
would recommend.

The property that matters for co-occurrence is **ranking**: a product bought
alongside this one in three orders must come before one bought alongside it in
one. Returning the right *set* in the wrong order is the failure mode that
looks fine in a screenshot and is worthless on a shelf.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from catalog import merchandising
from orders.models import OrderStatus, PaymentMethod
from orders.services import checkout as checkout_services
from tests import factories

pytestmark = pytest.mark.django_db


def _stocked(shop, name: str, **kwargs):
    """A sellable variant: created *and* received, the way the business does it.

    `factories.variant` only makes the catalogue row; checkout refuses to sell
    something that was never put on a shelf, which is the point of the ledger.
    """
    product = factories.product(name=name, **kwargs)
    variant = factories.variant(product, price=Decimal("100.00"))
    factories.stock(variant, shop["branch"], quantity=20)
    return variant


def _sell(shop, variants, *, key: str, status: str = OrderStatus.DELIVERED):
    """One order containing every given variant."""
    cart = checkout_services.get_or_create_cart(branch=shop["branch"])
    for variant in variants:
        checkout_services.add_item(cart=cart, variant_id=variant.pk, quantity=1)
    order = checkout_services.place_order(
        cart=cart,
        shipping_address={
            "recipient_name": "Buyer",
            "phone": "01712000111",
            "line1": "1 Road",
            "city": "Dhaka",
        },
        payment_method=PaymentMethod.COD,
        contact_phone="01712000111",
        idempotency_key=key,
    )
    if status != order.status:
        order.status = status
        order.save(update_fields=["status"])
    return order


class TestPriceDrops:
    def test_only_a_real_reduction_counts(self, shop):
        """`compare_at` at or below the price is a leftover, not a discount."""
        reduced = factories.product(name="Reduced")
        factories.variant(reduced, price=Decimal("800.00"), compare_at_price=Decimal("1000.00"))

        stale = factories.product(name="Stale compare-at")
        factories.variant(stale, price=Decimal("900.00"), compare_at_price=Decimal("900.00"))

        plain = factories.product(name="No compare-at")
        factories.variant(plain, price=Decimal("500.00"))

        names = {item.name for item in merchandising.price_drops()}

        assert "Reduced" in names
        assert "Stale compare-at" not in names
        assert "No compare-at" not in names

    def test_the_deepest_percentage_leads(self, shop):
        """Not the biggest cash saving: a shopper reads 50% off, not ৳500 off."""
        half_off = factories.product(name="Half off")
        factories.variant(half_off, price=Decimal("500.00"), compare_at_price=Decimal("1000.00"))

        small_percent_big_cash = factories.product(name="Ten percent")
        factories.variant(
            small_percent_big_cash,
            price=Decimal("9000.00"),
            compare_at_price=Decimal("10000.00"),
        )

        ordered = [item.name for item in merchandising.price_drops()]

        assert ordered.index("Half off") < ordered.index("Ten percent")

    def test_a_product_appears_once_however_many_variants_are_reduced(self, shop):
        product = factories.product(name="Many reduced variants")
        for _ in range(3):
            factories.variant(product, price=Decimal("700.00"), compare_at_price=Decimal("1000.00"))

        names = [item.name for item in merchandising.price_drops()]

        assert names.count("Many reduced variants") == 1

    def test_the_payload_carries_the_deepest_drop_for_a_badge(self, shop):
        product = factories.product(name="Badged")
        factories.variant(product, price=Decimal("900.00"), compare_at_price=Decimal("1000.00"))
        factories.variant(product, price=Decimal("600.00"), compare_at_price=Decimal("1000.00"))

        assert merchandising.price_drop_payload(product) == {"drop_percent": 40}

    def test_a_product_with_no_reduction_reports_zero(self, shop):
        product = factories.product(name="Full price")
        factories.variant(product, price=Decimal("500.00"))

        assert merchandising.price_drop_payload(product) == {"drop_percent": 0}


class TestBoughtTogether:
    def test_it_ranks_by_how_many_orders_were_shared(self, shop):
        anchor = shop["variants"][0]
        often = _stocked(shop, "Often")
        once = _stocked(shop, "Once")

        _sell(shop, [anchor, often], key="together-1")
        _sell(shop, [anchor, often], key="together-2")
        _sell(shop, [anchor, once], key="together-3")

        names = [item.name for item in merchandising.bought_together(product=anchor.product)]

        assert names.index("Often") < names.index("Once")

    def test_the_product_itself_is_never_recommended(self, shop):
        anchor = shop["variants"][0]
        other = _stocked(shop, "Other")
        _sell(shop, [anchor, other], key="together-self")

        results = merchandising.bought_together(product=anchor.product)

        assert all(item.pk != anchor.product.pk for item in results)

    def test_a_cancelled_basket_is_not_a_recommendation(self, shop):
        """People change their minds; that is not a signal to promote something."""
        anchor = shop["variants"][0]
        abandoned = _stocked(shop, "Changed their mind")
        _sell(shop, [anchor, abandoned], key="together-cancelled", status=OrderStatus.CANCELLED)

        names = [item.name for item in merchandising.bought_together(product=anchor.product)]

        assert "Changed their mind" not in names

    def test_it_falls_back_to_the_category_rather_than_returning_nothing(self, shop):
        """A young catalogue has almost no co-occurrence.

        An empty row on every product page reads as a broken feature; a short
        row of neighbours reads as a quiet one.
        """
        anchor = shop["product"]
        sibling = factories.product(name="Same shelf", category=anchor.category)
        factories.variant(sibling, price=Decimal("100.00"))

        names = [item.name for item in merchandising.bought_together(product=anchor)]

        assert "Same shelf" in names

    def test_co_occurrence_outranks_the_category_filler(self, shop):
        anchor = shop["variants"][0]
        bought_with = _stocked(shop, "Actually bought with", category=anchor.product.category)
        _stocked(shop, "Merely nearby", category=anchor.product.category)
        _sell(shop, [anchor, bought_with], key="together-rank")

        names = [item.name for item in merchandising.bought_together(product=anchor.product)]

        assert names.index("Actually bought with") < names.index("Merely nearby")

    def test_it_never_returns_more_than_asked_for(self, shop):
        anchor = shop["product"]
        for index in range(12):
            factories.variant(
                factories.product(name=f"Filler {index}", category=anchor.category),
                price=Decimal("100.00"),
            )

        assert len(merchandising.bought_together(product=anchor, limit=8)) == 8


class TestThroughTheApi:
    def test_the_home_page_carries_a_price_drops_row(self, api, shop):
        product = factories.product(name="Reduced online")
        factories.variant(product, price=Decimal("700.00"), compare_at_price=Decimal("1000.00"))

        payload = api.get("/api/v1/shop/home/").json()

        assert "price_drops" in payload
        assert any(item["name"] == "Reduced online" for item in payload["price_drops"])

    def test_a_listed_product_carries_its_discount_percentage(self, api, shop):
        product = factories.product(name="Badged online")
        factories.variant(product, price=Decimal("750.00"), compare_at_price=Decimal("1000.00"))

        results = api.get("/api/v1/shop/products/?q=Badged").json()["results"]

        assert results
        assert results[0]["drop_percent"] == 25
