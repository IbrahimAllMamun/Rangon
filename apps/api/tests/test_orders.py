"""POS sales, online checkout, order lifecycle and returns."""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.exceptions import (
    Conflict,
    InvalidStatusTransition,
    PermissionDenied,
    PriceChanged,
    RefundExceedsCaptured,
    ValidationError,
)
from inventory import services as inventory_services
from inventory.models import Inventory, InventoryTransaction, TransactionType
from orders.models import (
    Channel,
    Order,
    OrderStatus,
    PaymentMethod,
    PaymentState,
    RestockDecision,
    ReturnStatus,
)
from orders.services import checkout as checkout_services
from orders.services import lifecycle, pos
from orders.services import payments as payment_services
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from tests import factories

pytestmark = pytest.mark.django_db


def _sale(shop, *, quantity=2, discount=Decimal("0.00"), actor=None, **kwargs):
    variant = shop["variants"][0]
    total = variant.price * quantity - discount
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=actor or shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity, line_discount=discount)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)],
            **kwargs,
        ),
    )


class TestPosSale:
    def test_a_sale_deducts_stock_and_completes_immediately(self, shop):
        order = _sale(shop, quantity=2)

        assert order.channel == Channel.POS
        assert order.status == OrderStatus.DELIVERED
        assert order.payment_status == "PAID"
        assert order.grand_total == Decimal("2000.00")
        assert (
            Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"]).on_hand == 8
        )

    def test_sale_freezes_the_cost_for_profit_reporting(self, shop):
        branch = shop["branch"]
        variant = factories.variant(price="1000.00", cost="0.00")
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=5, unit_cost=Decimal("300.00")
        )

        order = pos.create_pos_sale(
            branch=branch,
            actor=shop["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=1)],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
            ),
        )
        item = order.items.first()
        assert item.unit_cost == Decimal("300.00")

        # Receiving more expensive stock later must not rewrite history.
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=5, unit_cost=Decimal("900.00")
        )
        item.refresh_from_db()
        assert item.unit_cost == Decimal("300.00")
        assert order.gross_profit == Decimal("700.00")

    def test_sale_is_refused_when_payment_is_short(self, shop):
        variant = shop["variants"][0]
        with pytest.raises(ValidationError):
            pos.create_pos_sale(
                branch=shop["branch"],
                actor=shop["cashier"],
                data=SaleInput(
                    lines=[SaleLineInput(variant_id=variant.pk, quantity=2)],
                    payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("100.00"))],
                ),
            )

    def test_split_payment_records_two_rows_and_change(self, shop):
        variant = shop["variants"][0]
        order = pos.create_pos_sale(
            branch=shop["branch"],
            actor=shop["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=2)],
                payments=[
                    PaymentInput(method=PaymentMethod.CARD, amount=Decimal("1500.00")),
                    PaymentInput(
                        method=PaymentMethod.CASH,
                        amount=Decimal("500.00"),
                        tendered_amount=Decimal("1000.00"),
                    ),
                ],
            ),
        )

        assert order.payments.count() == 2
        assert order.payment_status == "PAID"
        assert order.payments.get(method=PaymentMethod.CASH).change_amount == Decimal("500.00")

    def test_idempotency_key_prevents_a_duplicate_sale(self, shop):
        first = _sale(shop, idempotency_key="pos-1")
        second = _sale(shop, idempotency_key="pos-1")

        assert first.pk == second.pk
        assert Order.objects.count() == 1

    def test_a_large_discount_needs_manager_approval(self, shop):
        # 50% off with only sales.discount → refused
        with pytest.raises(PermissionDenied):
            _sale(shop, quantity=2, discount=Decimal("1000.00"))

    def test_a_large_discount_is_allowed_with_manager_elevation(self, shop):
        variant = shop["variants"][0]
        order = pos.create_pos_sale(
            branch=shop["branch"],
            actor=shop["cashier"],
            data=SaleInput(
                lines=[
                    SaleLineInput(
                        variant_id=variant.pk, quantity=2, line_discount=Decimal("1000.00")
                    )
                ],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
                elevated_by=shop["manager"],
            ),
        )
        assert order.grand_total == Decimal("1000.00")

    def test_voiding_restocks_and_refunds_without_deleting_the_sale(self, shop):
        order = _sale(shop, quantity=2)

        voided = pos.void_sale(order=order, actor=shop["manager"], reason="Wrong item scanned")

        assert Order.objects.filter(pk=order.pk).exists()  # never deleted
        assert voided.status == OrderStatus.CANCELLED
        assert voided.refunded_total == Decimal("2000.00")
        assert (
            Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"]).on_hand == 10
        )

    def test_void_requires_a_reason(self, shop):
        order = _sale(shop)
        with pytest.raises(ValidationError):
            pos.void_sale(order=order, actor=shop["manager"], reason="")

    def test_barcode_lookup_is_exact(self, shop):
        variant = shop["variants"][0]
        assert pos.lookup_variant(code=variant.barcode) == variant
        assert pos.lookup_variant(code=variant.sku) == variant
        assert pos.lookup_variant(code="nonsense") is None


class TestCheckout:
    def _cart(self, shop, quantity=2):
        cart = checkout_services.get_or_create_cart(
            customer=shop["customer"], branch=shop["branch"]
        )
        checkout_services.add_item(cart=cart, variant_id=shop["variants"][0].pk, quantity=quantity)
        return cart

    def test_placing_an_order_reserves_stock_without_deducting_it(self, shop):
        order = checkout_services.place_order(
            cart=self._cart(shop),
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key="web-1",
        )

        inventory = Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"])
        assert order.status == OrderStatus.CONFIRMED  # COD confirms immediately
        assert inventory.on_hand == 10
        assert inventory.reserved == 2
        assert inventory.available == 8

    def test_stock_is_deducted_when_the_order_is_packed(self, shop):
        order = checkout_services.place_order(
            cart=self._cart(shop),
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key="web-2",
        )

        lifecycle.transition(order=order, to_status=OrderStatus.PROCESSING, notify=False)
        order = lifecycle.transition(order=order, to_status=OrderStatus.PACKED, notify=False)

        inventory = Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"])
        assert inventory.on_hand == 8
        assert inventory.reserved == 0
        assert order.stock_committed is True

    def test_cancelling_before_dispatch_releases_the_reservation(self, shop):
        order = checkout_services.place_order(
            cart=self._cart(shop),
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key="web-3",
        )

        lifecycle.cancel_order(order=order, actor=shop["manager"], reason="Customer changed mind")

        inventory = Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"])
        assert inventory.reserved == 0
        assert inventory.on_hand == 10

    def test_cannot_cancel_after_stock_has_left_the_shelf(self, shop):
        order = checkout_services.place_order(
            cart=self._cart(shop),
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key="web-4",
        )
        lifecycle.transition(order=order, to_status=OrderStatus.PROCESSING, notify=False)
        lifecycle.transition(order=order, to_status=OrderStatus.PACKED, notify=False)

        # Refused twice over: the status machine has no PACKED -> CANCELLED edge,
        # and the stock guard would refuse it even if it did.  A packed order is
        # returned, not cancelled.
        with pytest.raises(InvalidStatusTransition):
            lifecycle.transition(order=order, to_status=OrderStatus.CANCELLED, notify=False)

    def test_the_server_ignores_a_client_supplied_total(self, shop):
        with pytest.raises(PriceChanged):
            checkout_services.place_order(
                cart=self._cart(shop),
                shipping_address={
                    "recipient_name": "A",
                    "phone": "01712345678",
                    "line1": "x",
                    "city": "Dhaka",
                },
                payment_method=PaymentMethod.COD,
                customer=shop["customer"],
                idempotency_key="web-5",
                expected_total=Decimal("1.00"),  # attacker's price
            )
        assert Order.objects.count() == 0

    def test_checkout_refuses_when_stock_ran_out_after_the_cart_was_filled(self, shop):
        cart = self._cart(shop, quantity=2)
        # Someone buys the rest at the counter first.
        inventory_services.sell(
            branch=shop["branch"], lines=[(shop["variants"][0].pk, 9)], reference_id="pos"
        )

        with pytest.raises(Conflict):
            checkout_services.place_order(
                cart=cart,
                shipping_address={
                    "recipient_name": "A",
                    "phone": "01712345678",
                    "line1": "x",
                    "city": "Dhaka",
                },
                payment_method=PaymentMethod.COD,
                customer=shop["customer"],
                idempotency_key="web-6",
            )

    def test_repeat_checkout_with_the_same_key_returns_the_first_order(self, shop):
        kwargs = {
            "shipping_address": {
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            "payment_method": PaymentMethod.COD,
            "customer": shop["customer"],
            "idempotency_key": "web-same",
        }
        first = checkout_services.place_order(cart=self._cart(shop), **kwargs)
        second = checkout_services.place_order(cart=self._cart(shop), **kwargs)

        assert first.pk == second.pk
        assert Order.objects.count() == 1


class TestLifecycle:
    def test_illegal_transitions_are_refused(self, shop):
        order = _sale(shop)  # DELIVERED

        with pytest.raises(InvalidStatusTransition):
            lifecycle.transition(order=order, to_status=OrderStatus.PENDING, notify=False)

    def test_every_transition_is_recorded_on_the_timeline(self, shop):
        order = checkout_services.place_order(
            cart=(
                lambda c: (
                    checkout_services.add_item(
                        cart=c, variant_id=shop["variants"][0].pk, quantity=1
                    ),
                    c,
                )[1]
            )(
                checkout_services.get_or_create_cart(
                    customer=shop["customer"], branch=shop["branch"]
                )
            ),
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key="web-timeline",
        )
        lifecycle.transition(order=order, to_status=OrderStatus.PROCESSING, notify=False)

        types = list(order.events.values_list("event_type", flat=True))
        assert "CREATED" in types
        assert "STATUS_CHANGED" in types
        assert "STOCK_RESERVED" in types


class TestReturns:
    def test_full_return_restocks_and_refunds(self, shop):
        order = _sale(shop, quantity=2)
        item = order.items.first()

        request = return_services.request_return(
            order=order,
            lines=[(item.pk, 2)],
            reason="WRONG_SIZE",
            actor=shop["manager"],
        )
        return_services.approve(return_request=request, actor=shop["manager"])
        return_services.receive(return_request=request, actor=shop["manager"])
        completed = return_services.complete(return_request=request, actor=shop["manager"])

        order.refresh_from_db()
        assert completed.status == ReturnStatus.COMPLETED
        assert order.refunded_total == Decimal("2000.00")
        assert (
            Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"]).on_hand == 10
        )

    def test_damaged_returns_are_not_restocked(self, shop):
        order = _sale(shop, quantity=2)
        item = order.items.first()

        request = return_services.request_return(
            order=order,
            lines=[(item.pk, 2)],
            reason="DEFECTIVE",
            actor=shop["manager"],
            restock_decisions={str(item.pk): RestockDecision.DAMAGED},
        )
        return_services.approve(return_request=request, actor=shop["manager"])
        return_services.receive(return_request=request, actor=shop["manager"])
        return_services.complete(return_request=request, actor=shop["manager"])

        # Money back, but the goods do not return to sellable stock.
        assert (
            Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"]).on_hand == 8
        )
        assert not InventoryTransaction.objects.filter(
            transaction_type=TransactionType.RETURN
        ).exists()

    def test_cannot_return_more_than_was_bought(self, shop):
        order = _sale(shop, quantity=2)
        item = order.items.first()

        with pytest.raises(ValidationError):
            return_services.request_return(
                order=order, lines=[(item.pk, 3)], reason="OTHER", actor=shop["manager"]
            )

    def test_returning_twice_cannot_exceed_the_quantity_sold(self, shop):
        order = _sale(shop, quantity=2)
        item = order.items.first()

        first = return_services.request_return(
            order=order, lines=[(item.pk, 1)], reason="WRONG_SIZE", actor=shop["manager"]
        )
        return_services.approve(return_request=first, actor=shop["manager"])
        return_services.receive(return_request=first, actor=shop["manager"])
        return_services.complete(return_request=first, actor=shop["manager"])

        second = return_services.request_return(
            order=order, lines=[(item.pk, 1)], reason="WRONG_SIZE", actor=shop["manager"]
        )
        return_services.approve(return_request=second, actor=shop["manager"])
        return_services.receive(return_request=second, actor=shop["manager"])
        return_services.complete(return_request=second, actor=shop["manager"])

        # Everything has now been returned, so the order is REFUNDED and a third
        # attempt is refused outright.
        with pytest.raises((ValidationError, Conflict)):
            return_services.request_return(
                order=order, lines=[(item.pk, 1)], reason="WRONG_SIZE", actor=shop["manager"]
            )

    def test_completing_a_return_twice_refunds_once(self, shop):
        order = _sale(shop, quantity=2)
        item = order.items.first()
        request = return_services.request_return(
            order=order, lines=[(item.pk, 2)], reason="WRONG_SIZE", actor=shop["manager"]
        )
        return_services.approve(return_request=request, actor=shop["manager"])
        return_services.receive(return_request=request, actor=shop["manager"])

        return_services.complete(return_request=request, actor=shop["manager"])
        return_services.complete(return_request=request, actor=shop["manager"])

        order.refresh_from_db()
        assert order.refunds.count() == 1
        assert order.refunded_total == Decimal("2000.00")

    def test_pos_return_is_a_single_step(self, shop):
        order = _sale(shop, quantity=2)
        item = order.items.first()

        result = pos.pos_return(
            order=order,
            actor=shop["manager"],
            lines=[(item.pk, 1, RestockDecision.RESTOCK)],
            reason="WRONG_SIZE",
        )

        order.refresh_from_db()
        assert result.status == ReturnStatus.COMPLETED
        assert order.refunded_total == Decimal("1000.00")
        assert (
            Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"]).on_hand == 9
        )


class TestPayments:
    def test_refund_cannot_exceed_what_was_captured(self, shop):
        order = _sale(shop, quantity=1)

        with pytest.raises(RefundExceedsCaptured):
            payment_services.refund_order(
                order=order, amount=Decimal("5000.00"), actor=shop["manager"]
            )

    def test_refunds_are_idempotent_on_their_key(self, shop):
        order = _sale(shop, quantity=2)

        first = payment_services.refund_order(
            order=order, amount=Decimal("500.00"), actor=shop["manager"], idempotency_key="r-1"
        )
        second = payment_services.refund_order(
            order=order, amount=Decimal("500.00"), actor=shop["manager"], idempotency_key="r-1"
        )

        assert first.pk == second.pk
        order.refresh_from_db()
        assert order.refunded_total == Decimal("500.00")

    def test_payment_status_reflects_partial_payment(self, shop):
        variant = shop["variants"][0]
        order = checkout_services.place_order(
            cart=(
                lambda c: (
                    checkout_services.add_item(cart=c, variant_id=variant.pk, quantity=2),
                    c,
                )[1]
            )(
                checkout_services.get_or_create_cart(
                    customer=shop["customer"], branch=shop["branch"]
                )
            ),
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.BANK,
            customer=shop["customer"],
            idempotency_key="web-partial",
        )

        payment_services.record_payment(
            order=order,
            method=PaymentMethod.BANK,
            amount=Decimal("500.00"),
            status=PaymentState.CAPTURED,
        )
        order.refresh_from_db()
        assert order.payment_status == "PARTIALLY_PAID"


class TestCostOfGoodsSold:
    """What gets frozen onto a sale line as `unit_cost` (docs/business-rules.md §4).

    Both of these were live bugs. D73: online checkout never passed a cost map,
    so it fell back to `ProductVariant.cost` while the counter used the branch's
    weighted average — the same variant sold twice in one minute booked two
    different costs depending on the channel. D72: stock opened outside a
    purchase receipt left `average_cost` at its `0.00` column default, so the
    counter froze a zero and the sale reported 100% margin.
    """

    ADDRESS = {
        "recipient_name": "A",
        "phone": "01712345678",
        "line1": "x",
        "city": "Dhaka",
    }

    def _sell_online(self, shop, variant, *, key):
        cart = checkout_services.get_or_create_cart(
            customer=shop["customer"], branch=shop["branch"]
        )
        checkout_services.add_item(cart=cart, variant_id=variant.pk, quantity=1)
        order = checkout_services.place_order(
            cart=cart,
            shipping_address=self.ADDRESS,
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key=key,
        )
        return order.items.get(variant=variant)

    def _sell_at_the_counter(self, shop, variant):
        order = pos.create_pos_sale(
            branch=shop["branch"],
            actor=shop["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=1)],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=variant.price)],
            ),
        )
        return order.items.get(variant=variant)

    def test_both_channels_freeze_the_same_cost(self, shop):
        """The invariant: channel must not change COGS.

        Two receipts at different prices are what makes this test discriminate.
        `receive_stock` keeps `ProductVariant.cost` in step with the *last* cost
        paid, so after a single receipt both sources agree by coincidence and a
        channel reading the wrong one still looks right. Blend 100 and 200 and
        they part company: the weighted average is 150, `cost` is 200.
        """
        branch = shop["branch"]
        variant = factories.variant(price="1000.00", cost="250.00")
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("100.00")
        )
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("200.00")
        )
        variant.refresh_from_db()
        assert variant.cost == Decimal("200.00")  # the trap the old code fell into

        online = self._sell_online(shop, variant, key="cogs-parity")
        counter = self._sell_at_the_counter(shop, variant)

        assert online.unit_cost == Decimal("150.00")
        assert counter.unit_cost == online.unit_cost

    def test_an_online_sale_uses_the_branch_average_not_the_typed_cost(self, shop):
        """Receiving is what makes a cost authoritative, not what an admin typed.

        This is D73 on its own: online checkout had the availability snapshot in
        hand the whole time and simply never passed it to `price_lines`.
        """
        branch = shop["branch"]
        variant = factories.variant(price="1000.00", cost="250.00")
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("100.00")
        )
        inventory_services.receive_stock(
            branch=branch, variant=variant, quantity=10, unit_cost=Decimal("200.00")
        )

        assert self._sell_online(shop, variant, key="cogs-wac").unit_cost == Decimal("150.00")

    def test_a_never_received_variant_does_not_sell_at_zero_cost(self, shop):
        """The failure path: no weighted average is 'unknown', never 'free'.

        `average_cost` is `0.00` on a variant nothing has been received against —
        a column default, not a measurement. Freezing it would report the whole
        selling price as profit, so the variant's own cost stands in.
        """
        branch = shop["branch"]
        variant = factories.variant(price="1000.00", cost="250.00")
        # Stock without a receipt behind it, which is what an adjustment leaves.
        inventory_services.adjust(
            branch=branch,
            variant=variant,
            new_on_hand=5,
            reason="Counted onto the shelf with no purchase behind it",
        )
        inventory = Inventory.objects.get(variant=variant, branch=branch)
        assert inventory.on_hand == 5
        assert inventory.average_cost == Decimal("0.00")

        online = self._sell_online(shop, variant, key="cogs-no-receipt")
        counter = self._sell_at_the_counter(shop, variant)

        assert online.unit_cost == Decimal("250.00")
        assert counter.unit_cost == Decimal("250.00")

    def test_profit_is_not_the_whole_selling_price(self, shop):
        """The bug as the owner would have seen it, on the report."""
        variant = factories.variant(price="1000.00", cost="250.00")
        inventory_services.adjust(
            branch=shop["branch"],
            variant=variant,
            new_on_hand=5,
            reason="Opening stock, no receipt",
        )
        order = self._sell_at_the_counter(shop, variant).order
        assert order.gross_profit == Decimal("750.00")
