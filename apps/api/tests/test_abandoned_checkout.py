"""Abandoned checkout leads: capture, recovery and the call-back list.

The feature is a phone call someone makes this afternoon, so the tests are
about whether the right person ends up on the list exactly once and leaves it
the moment they buy -- not about the shape of the JSON.

Two properties carry the whole thing:

  * **One open lead per person.** The list is a list of calls to make. A
    shopper who abandons three times before lunch is one call.
  * **Buying removes you.** By any route. A lead that stays on the list after
    the order lands gets rung up and asked to buy something they already own.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from orders.models import AbandonedCheckout, AbandonedCheckoutStatus, PaymentMethod
from orders.services import checkout as checkout_services
from orders.services import leads
from tests import factories

pytestmark = pytest.mark.django_db


LOCAL = "01712000111"
INTERNATIONAL = "+8801712000111"
CANONICAL = "8801712000111"


@pytest.fixture
def branch(shop):
    return shop["branch"]


def _cart(shop, quantity: int = 1):
    cart = checkout_services.get_or_create_cart(branch=shop["branch"])
    checkout_services.add_item(cart=cart, variant_id=shop["variants"][0].pk, quantity=quantity)
    return cart


class TestCaptureHoldsOneLeadPerPerson:
    def test_a_typed_number_becomes_an_open_lead(self, shop, branch):
        lead = leads.capture(
            phone=LOCAL, branch=branch, name="Rina", cart_total=Decimal("2450.00"), item_count=2
        )

        assert lead is not None
        assert lead.status == AbandonedCheckoutStatus.OPEN
        assert lead.name == "Rina"
        assert lead.cart_total == Decimal("2450.00")
        assert lead.item_count == 2

    def test_the_number_is_stored_canonically(self, shop, branch):
        """D48: one spelling, so the order that arrives can be matched to it."""
        lead = leads.capture(phone=LOCAL, branch=branch)
        assert lead.phone == CANONICAL

    @pytest.mark.parametrize("spelling", [LOCAL, INTERNATIONAL, CANONICAL, " 01712-000111 "])
    def test_every_spelling_of_one_number_is_one_lead(self, shop, branch, spelling):
        leads.capture(phone=LOCAL, branch=branch)
        leads.capture(phone=spelling, branch=branch)

        assert AbandonedCheckout.objects.filter(status=AbandonedCheckoutStatus.OPEN).count() == 1

    def test_coming_back_refreshes_the_lead_rather_than_adding_one(self, shop, branch):
        first = leads.capture(phone=LOCAL, branch=branch, cart_total=Decimal("100.00"))
        second = leads.capture(phone=LOCAL, branch=branch, cart_total=Decimal("900.00"))

        assert first.pk == second.pk
        second.refresh_from_db()
        assert second.cart_total == Decimal("900.00")

    def test_a_name_once_given_is_not_lost_on_a_later_pass(self, shop, branch):
        """A shopper who clears the name field should not empty the call list."""
        leads.capture(phone=LOCAL, branch=branch, name="Rina", email="rina@example.com")
        lead = leads.capture(phone=LOCAL, branch=branch, name="", email="")

        assert lead.name == "Rina"
        assert lead.email == "rina@example.com"

    @pytest.mark.parametrize("useless", ["", "   ", "12345", "0255512345", "not a phone", None])
    def test_something_we_cannot_ring_is_not_a_lead(self, shop, branch, useless):
        """The storefront sends this mid-typing; a partial number is 'not yet'."""
        assert leads.capture(phone=useless, branch=branch) is None
        assert not AbandonedCheckout.objects.exists()

    def test_a_recovered_lead_does_not_block_a_later_one(self, shop, branch):
        """The uniqueness is on *open* leads, so history survives."""
        first = leads.capture(phone=LOCAL, branch=branch)
        first.status = AbandonedCheckoutStatus.RECOVERED
        first.save(update_fields=["status"])

        second = leads.capture(phone=LOCAL, branch=branch)

        assert second is not None
        assert second.pk != first.pk
        assert AbandonedCheckout.objects.filter(phone=CANONICAL).count() == 2


class TestBuyingTakesYouOffTheList:
    def test_an_online_order_closes_the_lead(self, shop, branch):
        lead = leads.capture(phone=LOCAL, branch=branch)
        cart = _cart(shop)

        order = checkout_services.place_order(
            cart=cart,
            shipping_address={
                "recipient_name": "Rina",
                "phone": INTERNATIONAL,  # a different spelling on purpose
                "line1": "12 Panthapath",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            contact_name="Rina",
            contact_phone=INTERNATIONAL,
            idempotency_key="lead-recovery-1",
        )

        lead.refresh_from_db()
        assert lead.status == AbandonedCheckoutStatus.RECOVERED
        assert lead.recovered_order_id == order.pk
        assert lead.recovered_at is not None

    def test_a_counter_sale_closes_the_lead_too(self, shop, branch):
        """Staff ring a recovered lead up at the till, not through checkout.

        If only the storefront closed leads, every recovery the shop actually
        made would stay on the list and be called a second time.
        """
        customer = factories.customer(phone=LOCAL)
        lead = leads.capture(phone=LOCAL, branch=branch)

        from orders.services import pos
        from orders.services.pos import PaymentInput, SaleInput, SaleLineInput

        variant = shop["variants"][0]
        total = variant.price
        pos.create_pos_sale(
            branch=branch,
            actor=shop["owner"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=1)],
                payments=[
                    PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)
                ],
                customer_id=customer.pk,
            ),
        )

        lead.refresh_from_db()
        assert lead.status == AbandonedCheckoutStatus.RECOVERED

    def test_an_order_from_someone_else_leaves_the_lead_open(self, shop, branch):
        lead = leads.capture(phone=LOCAL, branch=branch)
        cart = _cart(shop)

        checkout_services.place_order(
            cart=cart,
            shipping_address={
                "recipient_name": "Someone Else",
                "phone": "01822000222",
                "line1": "9 Dhanmondi",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            contact_phone="01822000222",
            idempotency_key="lead-recovery-2",
        )

        lead.refresh_from_db()
        assert lead.status == AbandonedCheckoutStatus.OPEN

    def test_recovery_is_a_no_op_when_nobody_abandoned(self, shop):
        """Most orders answer no lead at all; that must cost nothing and raise nothing."""
        cart = _cart(shop)
        order = checkout_services.place_order(
            cart=cart,
            shipping_address={
                "recipient_name": "Walk Up",
                "phone": "01999000333",
                "line1": "1 Road",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            contact_phone="01999000333",
            idempotency_key="lead-recovery-3",
        )
        assert order.pk is not None
        assert not AbandonedCheckout.objects.exists()


class TestWritingALeadOff:
    def test_marking_it_lost_takes_it_off_the_list_without_deleting_it(self, shop, branch):
        lead = leads.capture(phone=LOCAL, branch=branch)

        leads.mark_lost(lead=lead, note="No answer twice, wrong number")

        lead.refresh_from_db()
        assert lead.status == AbandonedCheckoutStatus.LOST
        assert "wrong number" in lead.note
        # Still countable: the recovery rate is the point of the list.
        assert AbandonedCheckout.objects.filter(phone=CANONICAL).exists()


class TestTheApi:
    def test_the_storefront_can_hold_a_lead_without_an_account(self, api, shop):
        cart = _cart(shop)

        response = api.post(
            "/api/v1/shop/checkout/lead/",
            {"phone": LOCAL, "name": "Rina"},
            format="json",
            HTTP_X_CART_TOKEN=cart.token,
        )

        assert response.status_code == 204
        lead = AbandonedCheckout.objects.get(phone=CANONICAL)
        assert lead.item_count == 1

    def test_the_value_held_is_the_server_s_price_not_the_browser_s(self, api, shop):
        """A figure the browser sent is a figure a shopper can edit (CLAUDE.md §13)."""
        cart = _cart(shop, quantity=2)

        api.post(
            "/api/v1/shop/checkout/lead/",
            {"phone": LOCAL, "cart_total": "999999.00", "item_count": 99},
            format="json",
            HTTP_X_CART_TOKEN=cart.token,
        )

        lead = AbandonedCheckout.objects.get(phone=CANONICAL)
        assert lead.cart_total != Decimal("999999.00")
        assert lead.item_count == 2

    def test_a_half_typed_number_is_accepted_and_simply_held_nowhere(self, api, shop):
        """It is called while the shopper types; it must never show them an error."""
        cart = _cart(shop)

        response = api.post(
            "/api/v1/shop/checkout/lead/",
            {"phone": "0171"},
            format="json",
            HTTP_X_CART_TOKEN=cart.token,
        )

        assert response.status_code == 204
        assert not AbandonedCheckout.objects.exists()

    def test_the_call_back_list_needs_a_signed_in_user(self, api, shop):
        assert api.get("/api/v1/abandoned-checkouts/").status_code in {401, 403}

    def test_staff_can_read_and_annotate_a_lead(self, shop, auth_client, branch):
        admin = auth_client(shop["owner"])
        lead = leads.capture(phone=LOCAL, branch=branch, name="Rina")

        listing = admin.get("/api/v1/abandoned-checkouts/?status=OPEN")
        assert listing.status_code == 200

        annotated = admin.patch(
            f"/api/v1/abandoned-checkouts/{lead.pk}/",
            {"note": "Called at 4pm, will decide tonight"},
            format="json",
        )
        assert annotated.status_code == 200
        lead.refresh_from_db()
        assert "4pm" in lead.note

    def test_staff_cannot_declare_a_lead_recovered_by_hand(self, shop, auth_client, branch):
        """Recovery is a fact about an order, not an opinion. Only `note` is writable."""
        admin = auth_client(shop["owner"])
        lead = leads.capture(phone=LOCAL, branch=branch)

        admin.patch(
            f"/api/v1/abandoned-checkouts/{lead.pk}/",
            {"status": AbandonedCheckoutStatus.RECOVERED},
            format="json",
        )

        lead.refresh_from_db()
        assert lead.status == AbandonedCheckoutStatus.OPEN

    def test_staff_can_write_a_lead_off(self, shop, auth_client, branch):
        admin = auth_client(shop["owner"])
        lead = leads.capture(phone=LOCAL, branch=branch)

        response = admin.post(
            f"/api/v1/abandoned-checkouts/{lead.pk}/lost/",
            {"note": "Bought elsewhere"},
            format="json",
        )

        assert response.status_code == 200
        lead.refresh_from_db()
        assert lead.status == AbandonedCheckoutStatus.LOST
