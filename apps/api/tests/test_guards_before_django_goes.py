"""The guards that lose money or stock, or give a right away, when they are missing.

ADR-0020 sorted the defects the NestJS port had copied from here, and put these
first: fixed in both APIs before Django stops being compared with, because for
a month more Django is the way back and a rollback must not bring them back.

    D149  one SKU on two lines of a sale oversells
    D158  the counter's refund method is not validated
    D166  the status route cancels without the right, and without a refund
    D167  recording a payment can record the money twice
    D204  a negative coupon cap raises the price
    D221  the last-owner guard takes no lock          (its race: test_concurrency.py)
    D233  the sweep cancels an order paid for meanwhile (its race: test_concurrency.py)
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest

from accounts.models import RoleCode, Status
from core.exceptions import CouponInvalid, InsufficientStock
from finance.models import AccountKind, AccountTransaction
from inventory import services as inventory_services
from inventory.models import Inventory, InventoryTransaction, TransactionType
from orders.models import (
    Order,
    OrderPaymentStatus,
    OrderStatus,
    Payment,
    PaymentMethod,
    PaymentState,
    Refund,
)
from orders.services import payments as payment_services
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from orders.tasks import release_expired_reservations
from promotions import services as promotion_services
from promotions.models import Coupon, DiscountType
from tests import factories

pytestmark = pytest.mark.django_db


def _on_hand(shop, variant) -> int:
    return Inventory.objects.get(branch=shop["branch"], variant=variant).on_hand


# --- D149 ------------------------------------------------------------------


class TestOneSkuOnTwoLines:
    """Each line was checked against the shelf as it stood, then both were taken."""

    def test_two_lines_together_past_the_shelf_are_refused(self, shop) -> None:
        medium = shop["variants"][1]  # 5 on the shelf

        with pytest.raises(InsufficientStock) as refused:
            inventory_services.sell(
                branch=shop["branch"], lines=[(medium.pk, 3), (medium.pk, 3)], reference_id="x"
            )

        assert refused.value.details["requested"] == 6
        assert _on_hand(shop, medium) == 5
        assert not InventoryTransaction.objects.filter(
            variant=medium, transaction_type=TransactionType.SALE
        ).exists()

    def test_two_lines_the_shelf_can_cover_are_two_ledger_rows(self, shop) -> None:
        medium = shop["variants"][1]

        entries = inventory_services.sell(
            branch=shop["branch"], lines=[(medium.pk, 2), (medium.pk, 3)], reference_id="x"
        )

        assert [entry.quantity for entry in entries] == [-2, -3]
        assert _on_hand(shop, medium) == 0

    def test_held_units_are_counted_once_for_both_lines(self, shop) -> None:
        """§1.4: 5 on the shelf, 4 held for online orders, so the counter has 1."""
        medium = shop["variants"][1]
        inventory_services.reserve(
            branch=shop["branch"], lines=[(medium.pk, 4)], reference_id="online"
        )

        with pytest.raises(InsufficientStock):
            inventory_services.sell(
                branch=shop["branch"], lines=[(medium.pk, 1), (medium.pk, 1)], reference_id="x"
            )

        assert _on_hand(shop, medium) == 5

    def test_a_reservation_of_one_sku_twice_is_checked_as_one(self, shop) -> None:
        medium = shop["variants"][1]

        with pytest.raises(InsufficientStock):
            inventory_services.reserve(
                branch=shop["branch"], lines=[(medium.pk, 3), (medium.pk, 3)], reference_id="o"
            )

        assert Inventory.objects.get(branch=shop["branch"], variant=medium).reserved == 0

    def test_a_counter_sale_with_the_sku_twice_sells_nothing(self, shop) -> None:
        medium = shop["variants"][1]
        price = medium.price

        with pytest.raises(InsufficientStock):
            pos.create_pos_sale(
                branch=shop["branch"],
                actor=shop["cashier"],
                data=SaleInput(
                    lines=[
                        SaleLineInput(variant_id=str(medium.pk), quantity=3),
                        SaleLineInput(variant_id=str(medium.pk), quantity=3),
                    ],
                    payments=[PaymentInput(method=PaymentMethod.CASH, amount=price * 6)],
                ),
            )

        assert _on_hand(shop, medium) == 5
        assert Order.objects.count() == 0


# --- D204 ------------------------------------------------------------------


class _Line:
    def __init__(self, variant, total: str) -> None:
        self.variant = variant
        self.line_total = Decimal(total)


class TestACouponNeverRaisesThePrice:
    def _coupon(self, **kwargs) -> Coupon:
        defaults = {
            "code": f"CAP{factories.unique()}",
            "discount_type": DiscountType.PERCENTAGE,
            "value": Decimal("10.00"),
        }
        return Coupon.objects.create(**{**defaults, **kwargs})

    def test_a_cap_below_zero_already_saved_discounts_nothing(self, shop) -> None:
        """The form refuses one now; a row saved before it did is still there."""
        coupon = self._coupon(maximum_discount=Decimal("-100.00"))

        result = promotion_services.validate_coupon(
            coupon=coupon,
            lines=[_Line(shop["variants"][0], "1000.00")],
            subtotal=Decimal("1000.00"),
        )

        assert result.discount == Decimal("0.00")

    def test_a_cap_still_caps(self, shop) -> None:
        coupon = self._coupon(maximum_discount=Decimal("50.00"))

        result = promotion_services.validate_coupon(
            coupon=coupon,
            lines=[_Line(shop["variants"][0], "1000.00")],
            subtotal=Decimal("1000.00"),
        )

        assert result.discount == Decimal("50.00")

    @pytest.mark.parametrize("field", ["maximum_discount", "minimum_order_value"])
    def test_the_form_refuses_an_amount_below_zero(self, shop, auth_client, field) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/",
            {"code": "NEG", "discount_type": "PERCENTAGE", "value": "10.00", field: "-0.01"},
            format="json",
        )

        assert response.status_code == 400, response.data
        assert field in response.data["error"]["details"]
        assert not Coupon.objects.filter(code="NEG").exists()

    def test_an_edit_cannot_set_one_either(self, shop, auth_client) -> None:
        coupon = self._coupon()

        response = auth_client(shop["manager"]).patch(
            f"/api/v1/coupons/{coupon.pk}/", {"maximum_discount": "-100.00"}, format="json"
        )

        assert response.status_code == 400
        coupon.refresh_from_db()
        assert coupon.maximum_discount is None

    def test_zero_is_allowed(self, shop, auth_client) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/coupons/",
            {
                "code": "ZERO",
                "discount_type": "PERCENTAGE",
                "value": "10.00",
                "maximum_discount": "0.00",
                "minimum_order_value": "0.00",
            },
            format="json",
        )

        assert response.status_code == 201, response.data

    def test_an_exhausted_check_is_still_the_first_refusal(self, shop) -> None:
        """The floor is the last step; it replaces no refusal before it."""
        coupon = self._coupon(is_active=False, maximum_discount=Decimal("-1.00"))

        with pytest.raises(CouponInvalid):
            promotion_services.validate_coupon(
                coupon=coupon,
                lines=[_Line(shop["variants"][0], "1000.00")],
                subtotal=Decimal("1000.00"),
            )


# --- D158 ------------------------------------------------------------------


@pytest.fixture
def sale(shop):
    """One unit sold at the counter for cash, into a drawer."""
    drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="5000.00")
    small = shop["variants"][0]
    order = pos.create_pos_sale(
        branch=shop["branch"],
        actor=shop["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=str(small.pk), quantity=1)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=small.price)],
        ),
    )
    return {"order": order, "item": order.items.get(), "drawer": drawer}


def _return_body(sale, **extra) -> dict:
    return {
        "order": str(sale["order"].pk),
        "reason": "DEFECTIVE",
        "lines": [{"order_item": str(sale["item"].pk), "quantity": 1}],
        **extra,
    }


class TestTheCounterRefundMethod:
    @pytest.mark.parametrize(
        "method", ["BITCOIN", "cash", 5, True, ["CASH"], {"a": 1}, "X" * 40, None]
    )
    def test_a_method_the_ledger_does_not_know_is_refused(
        self, shop, auth_client, sale, method
    ) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/pos/returns/", _return_body(sale, refund_method=method), format="json"
        )

        assert response.status_code == 400, response.data
        assert "refund_method" in response.data["error"]["details"]
        assert Refund.objects.count() == 0
        sale["drawer"].refresh_from_db()
        assert sale["drawer"].balance == Decimal("5000.00") + sale["order"].grand_total

    def test_omitted_it_is_cash_out_of_the_drawer(self, shop, auth_client, sale) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/pos/returns/", _return_body(sale), format="json"
        )

        assert response.status_code == 201, response.data
        refund = Refund.objects.get()
        assert refund.method == PaymentMethod.CASH
        assert refund.account == sale["drawer"]
        sale["drawer"].refresh_from_db()
        assert sale["drawer"].balance == Decimal("5000.00")

    def test_blank_is_the_way_the_money_came_in(self, shop, auth_client, sale) -> None:
        response = auth_client(shop["manager"]).post(
            "/api/v1/pos/returns/", _return_body(sale, refund_method=""), format="json"
        )

        assert response.status_code == 201, response.data
        assert Refund.objects.get().method == PaymentMethod.CASH


# --- D166 ------------------------------------------------------------------


@pytest.fixture
def paid_order(shop):
    """An online order, confirmed, paid in full by card into the bank."""
    bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")
    order = factories.order(shop, status=OrderStatus.CONFIRMED)
    payment_services.record_payment(
        order=order, method=PaymentMethod.CARD, amount=Decimal("1000.00"), account=bank
    )
    order.refresh_from_db()
    return {"order": order, "bank": bank}


class TestCancellingThroughTheStatusRoute:
    """§5.2: cancelling needs `sales.cancel`, and refunds what was captured."""

    def test_the_right_to_change_a_status_is_not_the_right_to_cancel(
        self, shop, auth_client, paid_order
    ) -> None:
        stock_keeper = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])
        assert stock_keeper.has_perm_code("orders.update_status")
        assert not stock_keeper.has_perm_code("sales.cancel")

        response = auth_client(stock_keeper).post(
            f"/api/v1/orders/{paid_order['order'].pk}/status/",
            {"to_status": "CANCELLED"},
            format="json",
        )

        assert response.status_code == 403
        paid_order["order"].refresh_from_db()
        assert paid_order["order"].status == OrderStatus.CONFIRMED

    def test_the_same_person_may_still_move_it_on(self, shop, auth_client, paid_order) -> None:
        stock_keeper = factories.user(RoleCode.INVENTORY_MANAGER, branch_obj=shop["branch"])

        response = auth_client(stock_keeper).post(
            f"/api/v1/orders/{paid_order['order'].pk}/status/",
            {"to_status": "PROCESSING"},
            format="json",
        )

        assert response.status_code == 200, response.data

    def test_a_paid_order_cancelled_there_is_refunded(self, shop, auth_client, paid_order) -> None:
        response = auth_client(shop["manager"]).post(
            f"/api/v1/orders/{paid_order['order'].pk}/status/",
            {"to_status": "CANCELLED", "reason": "Customer rang"},
            format="json",
        )

        assert response.status_code == 200, response.data
        order = Order.objects.get(pk=paid_order["order"].pk)
        assert order.status == OrderStatus.CANCELLED
        assert order.payment_status == OrderPaymentStatus.REFUNDED
        assert order.refunded_total == Decimal("1000.00")
        assert order.cancel_reason == "Customer rang"
        paid_order["bank"].refresh_from_db()
        assert paid_order["bank"].balance == Decimal("0.00")

    def test_an_order_past_processing_is_not_cancelled_there(self, shop, auth_client) -> None:
        order = factories.order(shop, status=OrderStatus.PACKED, stock_committed=True)

        response = auth_client(shop["manager"]).post(
            f"/api/v1/orders/{order.pk}/status/", {"to_status": "CANCELLED"}, format="json"
        )

        assert response.status_code == 409
        order.refresh_from_db()
        assert order.status == OrderStatus.PACKED


# --- D167 ------------------------------------------------------------------


@pytest.fixture
def cod_order(shop):
    """A delivered cash-on-delivery order: 1000.00 waiting on the courier."""
    drawer = factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
    bank = factories.account(shop["branch"], kind=AccountKind.BANK, opening_balance="0.00")
    order = factories.order(shop, status=OrderStatus.DELIVERED)
    pending = payment_services.record_payment(
        order=order,
        method=PaymentMethod.COD,
        amount=Decimal("1000.00"),
        status=PaymentState.PENDING,
    )
    return {"order": order, "pending": pending, "drawer": drawer, "bank": bank}


def _pay(client, order, key: str | None = None, **body):
    headers = {"HTTP_IDEMPOTENCY_KEY": key} if key else {}
    return client.post(f"/api/v1/orders/{order.pk}/payments/", body, format="json", **headers)


class TestRecordingAPayment:
    def test_the_remittance_recorded_twice_is_refused_the_second_time(
        self, shop, auth_client, cod_order
    ) -> None:
        client = auth_client(shop["manager"])
        order = cod_order["order"]

        first = _pay(client, order, method="COD", amount="1000.00")
        second = _pay(client, order, method="COD", amount="1000.00")

        assert first.status_code == 201, first.data
        assert second.status_code == 422
        assert second.data["error"]["code"] == "PAYMENT_EXCEEDS_OUTSTANDING"
        assert second.data["error"]["details"]["outstanding"] == "0.00"
        assert order.payments.count() == 1
        cod_order["drawer"].refresh_from_db()
        assert cod_order["drawer"].balance == Decimal("1000.00")

    def test_the_same_request_sent_again_is_the_same_payment(
        self, shop, auth_client, cod_order
    ) -> None:
        client = auth_client(shop["manager"])
        order = cod_order["order"]

        first = _pay(client, order, key="remit-1", method="COD", amount="1000.00")
        again = _pay(client, order, key="remit-1", method="COD", amount="1000.00")

        assert first.status_code == 201, first.data
        assert again.status_code == 201, again.data
        assert again.data["payments"] == first.data["payments"]
        assert order.payments.count() == 1
        assert Payment.objects.get().idempotency_key == "remit-1"
        assert AccountTransaction.objects.filter(reference_type="payment").count() == 1

    def test_a_new_payment_is_named_by_its_key_too(self, shop, auth_client) -> None:
        factories.account(shop["branch"], kind=AccountKind.CASH, opening_balance="0.00")
        order = factories.order(shop, status=OrderStatus.CONFIRMED)
        client = auth_client(shop["manager"])

        first = _pay(client, order, key="part-1", method="CASH", amount="400.00")
        again = _pay(client, order, key="part-1", method="CASH", amount="400.00")
        other = _pay(client, order, key="part-2", method="CASH", amount="400.00")

        assert [first.status_code, again.status_code, other.status_code] == [201, 201, 201]
        order.refresh_from_db()
        assert order.payments.count() == 2
        assert order.paid_total == Decimal("800.00")

    def test_a_key_used_on_another_order_is_refused(self, shop, auth_client) -> None:
        one = factories.order(shop, status=OrderStatus.CONFIRMED)
        two = factories.order(shop, status=OrderStatus.CONFIRMED)
        client = auth_client(shop["manager"])
        assert _pay(client, one, key="k", method="CASH", amount="10.00").status_code == 201

        response = _pay(client, two, key="k", method="CASH", amount="10.00")

        assert response.status_code == 409
        assert two.payments.count() == 0

    def test_a_payment_past_what_is_owed_is_refused(self, shop, auth_client) -> None:
        order = factories.order(shop, status=OrderStatus.CONFIRMED)

        response = _pay(auth_client(shop["manager"]), order, method="CASH", amount="1000.01")

        assert response.status_code == 422
        assert response.data["error"]["details"] == {
            "requested": "1000.01",
            "outstanding": "1000.00",
            "grand_total": "1000.00",
            "paid_total": "0.00",
        }
        assert order.payments.count() == 0

    def test_what_is_owed_exactly_is_taken(self, shop, auth_client) -> None:
        order = factories.order(shop, status=OrderStatus.CONFIRMED)

        response = _pay(auth_client(shop["manager"]), order, method="CASH", amount="1000.00")

        assert response.status_code == 201, response.data
        order.refresh_from_db()
        assert order.payment_status == OrderPaymentStatus.PAID

    @pytest.mark.parametrize(
        "status", [OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.REFUNDED]
    )
    def test_an_order_that_owes_nothing_takes_no_payment(self, shop, auth_client, status) -> None:
        order = factories.order(shop, status=status)

        response = _pay(auth_client(shop["manager"]), order, method="CASH", amount="10.00")

        assert response.status_code == 409
        assert order.payments.count() == 0

    def test_an_order_refunded_in_full_takes_no_payment(
        self, shop, auth_client, paid_order
    ) -> None:
        order = paid_order["order"]
        payment_services.refund_order(order=order, amount=Decimal("1000.00"))

        response = _pay(auth_client(shop["manager"]), order, method="CASH", amount="10.00")

        assert response.status_code == 422

    def test_an_account_the_money_cannot_land_in_leaves_the_payment_as_it_was(
        self, shop, auth_client, cod_order
    ) -> None:
        """Cash on delivery is cash: it does not land in the bank."""
        response = _pay(
            auth_client(shop["manager"]),
            cod_order["order"],
            method="COD",
            amount="1000.00",
            account=str(cod_order["bank"].pk),
        )

        assert response.status_code == 400, response.data
        pending = cod_order["pending"]
        pending.refresh_from_db()
        assert pending.status == PaymentState.PENDING
        assert pending.account is None
        assert pending.idempotency_key is None

    def test_a_refusal_does_not_use_the_key_up(self, shop, auth_client, cod_order) -> None:
        client = auth_client(shop["manager"])
        order = cod_order["order"]
        bank = str(cod_order["bank"].pk)
        assert _pay(client, order, key="k", method="COD", amount="1000.00", account=bank)

        response = _pay(client, order, key="k", method="COD", amount="1000.00")

        assert response.status_code == 201, response.data
        cod_order["drawer"].refresh_from_db()
        assert cod_order["drawer"].balance == Decimal("1000.00")


# --- D233, and the order that was paid before the sweep looked ---------------


class TestTheReservationSweep:
    def _stale(self, shop, **kwargs) -> Order:
        order = factories.order(shop, status=OrderStatus.PENDING, **kwargs)
        Order.objects.filter(pk=order.pk).update(placed_at=shop["now"] - timedelta(hours=3))
        order.refresh_from_db()
        return order

    def test_an_unpaid_order_past_the_window_is_cancelled(self, shop) -> None:
        order = self._stale(shop)

        assert release_expired_reservations() == "released:1"

        order.refresh_from_db()
        assert order.status == OrderStatus.CANCELLED
        assert order.cancel_reason.startswith("PAYMENT_TIMEOUT")

    def test_an_order_paid_and_refunded_in_full_holds_nothing_and_expires(self, shop) -> None:
        order = self._stale(shop)
        payment_services.record_payment(
            order=order, method=PaymentMethod.BANK, amount=Decimal("1000.00")
        )
        payment_services.refund_order(
            order=Order.objects.get(pk=order.pk), amount=Decimal("1000.00")
        )

        assert release_expired_reservations() == "released:1"

        order.refresh_from_db()
        assert order.status == OrderStatus.CANCELLED

    def test_an_order_that_holds_somebodys_money_is_left_for_staff(self, shop) -> None:
        """§1.5 is about an order *awaiting* prepayment (D246)."""
        order = self._stale(shop)
        payment_services.record_payment(
            order=order, method=PaymentMethod.BANK, amount=Decimal("1000.00")
        )

        assert release_expired_reservations() == "released:0"

        order.refresh_from_db()
        assert order.status == OrderStatus.PENDING

    def test_an_order_confirmed_since_it_was_listed_is_not_expired(self, shop) -> None:
        """What the sweep's own lock is for: the list is older than the row."""
        from orders.services.lifecycle import expire_reservation, transition

        listed = self._stale(shop)
        transition(order=listed, to_status=OrderStatus.CONFIRMED)

        assert expire_reservation(order=listed) is False

        listed.refresh_from_db()
        assert listed.status == OrderStatus.CONFIRMED

    def test_an_order_paid_since_it_was_listed_is_not_expired(self, shop) -> None:
        from orders.services.lifecycle import expire_reservation

        listed = self._stale(shop)
        payment_services.record_payment(
            order=Order.objects.get(pk=listed.pk),
            method=PaymentMethod.BANK,
            amount=Decimal("1.00"),
        )

        assert expire_reservation(order=listed) is False


# --- D221 ------------------------------------------------------------------


class TestTheLastOwner:
    """The rule is unchanged; these hold it while the guard gains a lock.

    Since only an owner may switch an owner off, the last one is reached by
    somebody who holds every permission without being counted as an owner: a
    superuser made in the shell, whose role is something else.
    """

    def test_one_of_two_owners_can_be_switched_off(self, shop, auth_client) -> None:
        second = factories.user(RoleCode.OWNER, branch_obj=shop["branch"])

        response = auth_client(shop["owner"]).post(f"/api/v1/users/{second.pk}/deactivate/")

        assert response.status_code == 200, response.data
        second.refresh_from_db()
        assert second.status == Status.INACTIVE

    def test_the_only_owner_cannot(self, shop, auth_client) -> None:
        superuser = factories.user(RoleCode.ADMIN, branch_obj=shop["branch"], is_superuser=True)

        response = auth_client(superuser).post(f"/api/v1/users/{shop['owner'].pk}/deactivate/")

        assert response.status_code == 400, response.data
        assert "last owner" in response.data["error"]["message"]
        shop["owner"].refresh_from_db()
        assert shop["owner"].status == Status.ACTIVE

    def test_nor_by_the_system_itself(self, shop) -> None:
        from accounts.services import deactivate_user
        from core.exceptions import ValidationError

        with pytest.raises(ValidationError, match="last owner"):
            deactivate_user(user=shop["owner"], actor=None)

    def test_a_refused_deactivation_writes_nothing(self, shop, auth_client) -> None:
        from core.models import AuditLog

        superuser = factories.user(RoleCode.ADMIN, branch_obj=shop["branch"], is_superuser=True)
        before = AuditLog.objects.count()

        auth_client(superuser).post(f"/api/v1/users/{shop['owner'].pk}/deactivate/")

        assert AuditLog.objects.count() == before


class TestOnlyAnOwnerManagesOwners:
    """Decided by the owner on 2026-10-14 (business rule 7.1, the rest of D221).

    An administrator runs the staff list. An owner's account is out of their
    reach in both directions: they may not touch one, and they may not make
    one -- of somebody else, or of themselves.
    """

    PASSWORD = "a-strong-password-1"

    @pytest.fixture
    def admin(self, shop):
        return factories.user(RoleCode.ADMIN, branch_obj=shop["branch"])

    @pytest.fixture
    def second_owner(self, shop):
        return factories.user(RoleCode.OWNER, branch_obj=shop["branch"], first_name="Second")

    def _refused(self, response) -> None:
        assert response.status_code == 403, response.data
        assert response.data["error"]["code"] == "PERMISSION_DENIED"

    # --- an owner's account, as it stands ---------------------------------

    @pytest.mark.parametrize(
        "change",
        [
            {"first_name": "Renamed"},
            {"role_code": "MANAGER"},
            {"status": "INACTIVE"},
            {"password": PASSWORD},
            {"profile": {"designation": "Demoted on paper"}},
        ],
        ids=["a name", "the role", "the status", "the password", "the profile"],
    )
    def test_an_administrator_cannot_edit_an_owner(
        self, admin, second_owner, auth_client, change
    ) -> None:
        from core.models import AuditLog

        before = AuditLog.objects.count()

        response = auth_client(admin).patch(
            f"/api/v1/users/{second_owner.pk}/", change, format="json"
        )

        self._refused(response)
        assert "owner's account" in response.data["error"]["message"]
        second_owner.refresh_from_db()
        assert second_owner.first_name == "Second"
        assert second_owner.role.code == RoleCode.OWNER
        assert second_owner.status == Status.ACTIVE
        assert second_owner.check_password("test-password-123")
        assert AuditLog.objects.count() == before

    @pytest.mark.parametrize("route", ["deactivate", "delete"])
    def test_an_administrator_cannot_switch_an_owner_off(
        self, admin, second_owner, auth_client, route
    ) -> None:
        client = auth_client(admin)

        response = (
            client.post(f"/api/v1/users/{second_owner.pk}/deactivate/")
            if route == "deactivate"
            else client.delete(f"/api/v1/users/{second_owner.pk}/")
        )

        self._refused(response)
        second_owner.refresh_from_db()
        assert second_owner.status == Status.ACTIVE

    def test_an_administrator_cannot_switch_an_owner_back_on(
        self, admin, second_owner, auth_client
    ) -> None:
        second_owner.status = Status.INACTIVE
        second_owner.save()

        response = auth_client(admin).post(f"/api/v1/users/{second_owner.pk}/activate/")

        self._refused(response)
        second_owner.refresh_from_db()
        assert second_owner.status == Status.INACTIVE

    # --- making an owner ---------------------------------------------------

    def test_an_administrator_cannot_create_an_owner(self, admin, auth_client) -> None:
        from accounts.models import User

        response = auth_client(admin).post(
            "/api/v1/users/",
            {"email": "made-owner@rangon.test", "password": self.PASSWORD, "role_code": "OWNER"},
            format="json",
        )

        self._refused(response)
        assert "give the owner role" in response.data["error"]["message"]
        assert not User.objects.filter(email="made-owner@rangon.test").exists()

    def test_an_administrator_cannot_give_the_owner_role(self, shop, admin, auth_client) -> None:
        response = auth_client(admin).patch(
            f"/api/v1/users/{shop['manager'].pk}/", {"role_code": "OWNER"}, format="json"
        )

        self._refused(response)
        shop["manager"].refresh_from_db()
        assert shop["manager"].role.code == RoleCode.MANAGER

    def test_nor_take_it_for_themselves(self, admin, auth_client) -> None:
        response = auth_client(admin).patch(
            f"/api/v1/users/{admin.pk}/", {"role_code": "OWNER"}, format="json"
        )

        self._refused(response)
        admin.refresh_from_db()
        assert admin.role.code == RoleCode.ADMIN

    # --- what an administrator still does ----------------------------------

    def test_an_administrator_still_runs_the_rest_of_the_staff(
        self, shop, admin, auth_client
    ) -> None:
        client = auth_client(admin)

        made = client.post(
            "/api/v1/users/",
            {"email": "new-admin@rangon.test", "password": self.PASSWORD, "role_code": "ADMIN"},
            format="json",
        )
        assert made.status_code == 201, made.data

        promoted = client.patch(
            f"/api/v1/users/{shop['cashier'].pk}/", {"role_code": "MANAGER"}, format="json"
        )
        assert promoted.status_code == 200, promoted.data

        reset = client.patch(
            f"/api/v1/users/{shop['manager'].pk}/", {"password": self.PASSWORD}, format="json"
        )
        assert reset.status_code == 200, reset.data

        off = client.post(f"/api/v1/users/{shop['cashier'].pk}/deactivate/")
        assert off.status_code == 200, off.data
        on = client.post(f"/api/v1/users/{shop['cashier'].pk}/activate/")
        assert on.status_code == 200, on.data

    def test_an_administrator_still_sees_the_owners(self, admin, second_owner, auth_client) -> None:
        response = auth_client(admin).get(f"/api/v1/users/{second_owner.pk}/")

        assert response.status_code == 200, response.data

    # --- what an owner does --------------------------------------------------

    def test_an_owner_does_all_of_it(self, shop, second_owner, auth_client) -> None:
        client = auth_client(shop["owner"])

        made = client.post(
            "/api/v1/users/",
            {"email": "third-owner@rangon.test", "password": self.PASSWORD, "role_code": "OWNER"},
            format="json",
        )
        assert made.status_code == 201, made.data

        given = client.patch(
            f"/api/v1/users/{shop['manager'].pk}/", {"role_code": "OWNER"}, format="json"
        )
        assert given.status_code == 200, given.data

        edited = client.patch(
            f"/api/v1/users/{second_owner.pk}/",
            {"first_name": "Renamed", "password": self.PASSWORD},
            format="json",
        )
        assert edited.status_code == 200, edited.data

        demoted = client.patch(
            f"/api/v1/users/{second_owner.pk}/", {"role_code": "MANAGER"}, format="json"
        )
        assert demoted.status_code == 200, demoted.data

    def test_a_superuser_counts_as_one(self, shop, second_owner, auth_client) -> None:
        superuser = factories.user(RoleCode.ADMIN, branch_obj=shop["branch"], is_superuser=True)

        response = auth_client(superuser).patch(
            f"/api/v1/users/{second_owner.pk}/", {"first_name": "Renamed"}, format="json"
        )

        assert response.status_code == 200, response.data

    def test_and_a_superusers_account_is_an_owners(self, shop, admin, auth_client) -> None:
        superuser = factories.user(RoleCode.MANAGER, branch_obj=shop["branch"], is_superuser=True)

        response = auth_client(admin).patch(
            f"/api/v1/users/{superuser.pk}/", {"password": self.PASSWORD}, format="json"
        )

        self._refused(response)

    # --- your own role -------------------------------------------------------

    def test_an_administrator_cannot_demote_themselves(self, admin, auth_client) -> None:
        """Rule 7.1 always said so; the guard only ran for an owner."""
        response = auth_client(admin).patch(
            f"/api/v1/users/{admin.pk}/", {"role_code": "MANAGER"}, format="json"
        )

        assert response.status_code == 400, response.data
        assert "your own account" in response.data["error"]["message"]
        admin.refresh_from_db()
        assert admin.role.code == RoleCode.ADMIN

    def test_but_may_still_edit_the_rest_of_their_own_account(self, admin, auth_client) -> None:
        response = auth_client(admin).patch(
            f"/api/v1/users/{admin.pk}/", {"first_name": "Renamed"}, format="json"
        )

        assert response.status_code == 200, response.data
