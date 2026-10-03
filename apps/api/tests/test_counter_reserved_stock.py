"""D115: whether the counter may sell stock reserved for online orders (business rules §1.4).

Off (the default): a counter sale takes only what no online order holds.
On (the owner's decision): the counter may take reserved units, and the online
orders left short are flagged for staff -- newest first, each unit once.
"""

from __future__ import annotations

import pytest

from core.audit import AuditAction
from core.exceptions import InsufficientStock
from core.models import AuditLog
from inventory import services as inventory_services
from inventory.models import Inventory
from notifications.models import Notification, NotificationType
from orders.models import OrderEvent, OrderEventType, PaymentMethod
from orders.services import checkout as checkout_services
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput

pytestmark = pytest.mark.django_db

ADDRESS = {"recipient_name": "A", "phone": "01712345678", "line1": "x", "city": "Dhaka"}


def _online(shop, quantity: int, key: str):
    """An online order holding `quantity` of the first variant (10 on the shelf)."""
    cart = checkout_services.get_or_create_cart(token=f"cart-{key}", branch=shop["branch"])
    checkout_services.add_item(cart=cart, variant_id=shop["variants"][0].pk, quantity=quantity)
    return checkout_services.place_order(
        cart=cart,
        shipping_address=ADDRESS,
        payment_method=PaymentMethod.COD,
        contact_phone="01712345678",
        idempotency_key=key,
    )


def _counter(shop, quantity: int, key: str):
    variant = shop["variants"][0]
    total = variant.price * quantity
    return pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=variant.pk, quantity=quantity)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=total, tendered_amount=total)],
            idempotency_key=key,
        ),
    )


def _inventory(shop) -> Inventory:
    return Inventory.objects.get(variant=shop["variants"][0], branch=shop["branch"])


def _allow(shop, allowed: bool = True) -> None:
    organization = shop["branch"].organization
    organization.counter_sells_reserved = allowed
    organization.save(update_fields=["counter_sells_reserved"])


def _short(order) -> list[int]:
    return [
        event.data["short"]
        for event in OrderEvent.objects.filter(order=order, event_type=OrderEventType.STOCK_SHORT)
    ]


class TestReservedStockIsNotForTheCounter:
    def test_the_counter_is_refused_units_held_for_online_orders(self, shop):
        _online(shop, 8, "web-1")

        with pytest.raises(InsufficientStock) as exc:
            _counter(shop, 3, "pos-1")

        assert exc.value.details["available"] == 2
        assert exc.value.details["reserved"] == 8
        assert "held for online orders" in exc.value.message
        inventory = _inventory(shop)
        assert (inventory.on_hand, inventory.reserved, inventory.available) == (10, 8, 2)

    def test_the_counter_sells_what_is_not_held(self, shop):
        _online(shop, 8, "web-1")

        _counter(shop, 2, "pos-1")

        inventory = _inventory(shop)
        assert (inventory.on_hand, inventory.reserved, inventory.available) == (8, 8, 0)
        assert inventory_services.verify_integrity() == []

    def test_a_shelf_too_small_for_the_sale_is_refused_for_that_first(self, shop):
        _online(shop, 8, "web-1")

        with pytest.raises(InsufficientStock) as exc:
            _counter(shop, 11, "pos-1")

        assert "in stock" in exc.value.message

    def test_a_write_off_still_answers_only_to_the_shelf(self, shop):
        """The rule is the counter's: damage and loss take what is physically there."""
        _online(shop, 8, "web-1")

        inventory_services.write_off(
            branch=shop["branch"],
            variant=shop["variants"][0],
            quantity=3,
            transaction_type="DAMAGE",
            reason="Torn",
        )

        inventory = _inventory(shop)
        assert (inventory.on_hand, inventory.reserved, inventory.available) == (7, 8, -1)

    def test_overselling_lets_the_counter_through(self, shop, settings):
        settings.RANGON = {**settings.RANGON, "ALLOW_OVERSELL": True}
        _online(shop, 8, "web-1")

        _counter(shop, 5, "pos-1")

        assert _inventory(shop).available == -3


class TestTheOwnerLetsTheCounterTakeThem:
    def test_the_sale_goes_through_and_the_order_is_flagged(self, shop):
        _allow(shop)
        order = _online(shop, 8, "web-1")

        sale = _counter(shop, 5, "pos-1")

        inventory = _inventory(shop)
        assert (inventory.on_hand, inventory.reserved, inventory.available) == (5, 8, -3)
        assert _short(order) == [3]
        event = OrderEvent.objects.get(order=order, event_type=OrderEventType.STOCK_SHORT)
        assert event.is_customer_visible is False
        assert sale.number in event.message
        notices = Notification.objects.filter(notification_type=NotificationType.ORDER_STOCK_SHORT)
        assert notices.exists()
        assert all(order.number in notice.title for notice in notices)
        assert inventory_services.verify_integrity() == []

    def test_no_flag_while_the_shelf_still_covers_every_order(self, shop):
        _allow(shop)
        order = _online(shop, 8, "web-1")

        _counter(shop, 2, "pos-1")

        assert _short(order) == []
        assert not Notification.objects.filter(
            notification_type=NotificationType.ORDER_STOCK_SHORT
        ).exists()

    def test_the_newest_order_is_short_first_and_each_unit_is_flagged_once(self, shop):
        _allow(shop)
        older = _online(shop, 4, "web-old")
        newer = _online(shop, 4, "web-new")

        _counter(shop, 5, "pos-1")  # 3 short: all on the newer order
        assert (_short(older), _short(newer)) == ([], [3])

        _counter(shop, 1, "pos-2")  # 4 short: one more on the newer order
        assert (_short(older), _short(newer)) == ([], [3, 1])

        _counter(shop, 2, "pos-3")  # 6 short: the newer is all gone, the older loses 2
        assert (_short(older), _short(newer)) == ([2], [3, 1])

    def test_a_cancelled_order_is_not_flagged(self, shop):
        from orders.services import lifecycle

        _allow(shop)
        cancelled = _online(shop, 4, "web-gone")
        lifecycle.cancel_order(order=cancelled, actor=shop["manager"], reason="Changed mind")
        kept = _online(shop, 8, "web-kept")

        _counter(shop, 4, "pos-1")

        assert (_short(cancelled), _short(kept)) == ([], [2])


class TestOnlyTheOwnerDecides:
    URL = "/api/v1/organization/"

    def test_the_switch_is_off_and_readable(self, shop, auth_client):
        response = auth_client(shop["manager"]).get(self.URL)

        assert response.status_code == 200
        assert response.data["counter_sells_reserved"] is False

    def test_the_owner_turns_it_on_and_it_is_audited(self, shop, auth_client):
        response = auth_client(shop["owner"]).patch(
            self.URL, {"counter_sells_reserved": True}, format="json"
        )

        assert response.status_code == 200
        assert response.data["counter_sells_reserved"] is True
        shop["branch"].organization.refresh_from_db()
        assert shop["branch"].organization.counter_sells_reserved is True
        entry = AuditLog.objects.filter(action=AuditAction.SETTINGS_CHANGED).latest("created_at")
        assert entry.new_values["counter_sells_reserved"] is True
        assert entry.old_values["counter_sells_reserved"] is False

    def test_an_administrator_cannot_change_it(self, shop, auth_client):
        from accounts.models import RoleCode
        from tests import factories

        admin = factories.user(RoleCode.ADMIN, branch_obj=shop["branch"])
        response = auth_client(admin).patch(
            self.URL, {"counter_sells_reserved": True}, format="json"
        )

        assert response.status_code == 403
        assert "owner" in response.data["error"]["message"]
        shop["branch"].organization.refresh_from_db()
        assert shop["branch"].organization.counter_sells_reserved is False

    def test_an_administrator_may_still_save_it_unchanged(self, shop, auth_client):
        from accounts.models import RoleCode
        from tests import factories

        admin = factories.user(RoleCode.ADMIN, branch_obj=shop["branch"])
        response = auth_client(admin).patch(
            self.URL,
            {"receipt_footer": "Thank you", "counter_sells_reserved": False},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["receipt_footer"] == "Thank you"
