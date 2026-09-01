"""Races that must never be allowed to happen (plan §35).

These use real threads against real PostgreSQL: the row locks under test do not
exist in SQLite, and an in-process mock would prove nothing.  Each worker closes
its own connection on the way out.
"""

from __future__ import annotations

import threading
from decimal import Decimal

import pytest
from django.db import connections

from core.exceptions import BusinessError, InsufficientFunds
from customers.models import Customer
from finance import services as finance_services
from finance.models import AccountKind
from inventory import services as inventory_services
from inventory.models import Inventory
from orders.models import Order, PaymentMethod, PaymentState
from orders.services import checkout as checkout_services
from orders.services import payments as payment_services
from orders.services import pos
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from promotions.models import Coupon, CouponRedemption, DiscountType
from tests import factories

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.slow, pytest.mark.concurrency]

ADDRESS = {"recipient_name": "A", "phone": "01700000000", "line1": "x", "city": "Dhaka"}


def run_together(target, count: int) -> tuple[list, list]:
    """Run `target(index)` in `count` threads released simultaneously."""
    results: list = []
    errors: list = []
    barrier = threading.Barrier(count)
    lock = threading.Lock()

    def worker(index: int) -> None:
        barrier.wait()
        try:
            outcome = target(index)
            with lock:
                results.append(outcome)
        except Exception as exc:
            with lock:
                errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    return results, errors


@pytest.fixture
def last_unit():
    """A shop with exactly one unit of one variant left."""
    branch = factories.branch(factories.organization())
    variant = factories.variant(price="1000.00")
    factories.stock(variant, branch, 1, "400.00")
    return {
        "branch": branch,
        "variant": variant,
        "cashier": factories.user("CASHIER", branch_obj=branch),
    }


def test_two_online_checkouts_cannot_both_buy_the_last_unit(last_unit):
    def checkout(index: int) -> str:
        cart = checkout_services.get_or_create_cart(
            token=f"cart-{index}", branch=last_unit["branch"]
        )
        checkout_services.add_item(cart=cart, variant_id=last_unit["variant"].pk, quantity=1)
        order = checkout_services.place_order(
            cart=cart,
            shipping_address=ADDRESS,
            payment_method=PaymentMethod.COD,
            contact_name=f"Shopper {index}",
            contact_phone=f"017000000{index:02d}",
            idempotency_key=f"race-{index}",
        )
        return order.number

    results, errors = run_together(checkout, 2)

    assert len(results) == 1, f"both checkouts succeeded: {results}"
    assert len(errors) == 1
    assert isinstance(errors[0], BusinessError)
    assert errors[0].code == "INSUFFICIENT_STOCK"

    inventory = Inventory.objects.get(variant=last_unit["variant"], branch=last_unit["branch"])
    assert inventory.on_hand == 1
    assert inventory.reserved == 1
    assert inventory.available == 0
    assert inventory_services.verify_integrity() == []


def test_pos_sale_and_online_checkout_cannot_both_take_the_last_unit(last_unit):
    def buy(index: int) -> str:
        if index == 0:
            order = pos.create_pos_sale(
                branch=last_unit["branch"],
                actor=last_unit["cashier"],
                data=SaleInput(
                    lines=[SaleLineInput(variant_id=last_unit["variant"].pk, quantity=1)],
                    payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
                    idempotency_key="race-pos",
                ),
            )
            return f"POS:{order.number}"

        cart = checkout_services.get_or_create_cart(token="race-web", branch=last_unit["branch"])
        checkout_services.add_item(cart=cart, variant_id=last_unit["variant"].pk, quantity=1)
        order = checkout_services.place_order(
            cart=cart,
            shipping_address=ADDRESS,
            payment_method=PaymentMethod.COD,
            contact_phone="01799999999",
            idempotency_key="race-web",
        )
        return f"WEB:{order.number}"

    results, errors = run_together(buy, 2)

    assert len(results) == 1, f"the same unit was sold twice: {results}"
    assert len(errors) == 1
    assert inventory_services.verify_integrity() == []


def test_double_click_checkout_creates_one_order(last_unit):
    cart = checkout_services.get_or_create_cart(token="double", branch=last_unit["branch"])
    checkout_services.add_item(cart=cart, variant_id=last_unit["variant"].pk, quantity=1)

    def submit(_index: int) -> str:
        order = checkout_services.place_order(
            cart=cart,
            shipping_address=ADDRESS,
            payment_method=PaymentMethod.COD,
            contact_phone="01700000000",
            idempotency_key="double-click-key",
        )
        return order.number

    results, errors = run_together(submit, 2)

    assert Order.objects.count() == 1, f"duplicate orders created: {results} / {errors}"
    inventory = Inventory.objects.get(variant=last_unit["variant"], branch=last_unit["branch"])
    assert inventory.reserved == 1  # reserved once, not twice
    assert inventory_services.verify_integrity() == []


def test_duplicate_payment_webhook_captures_once(last_unit):
    cart = checkout_services.get_or_create_cart(token="webhook", branch=last_unit["branch"])
    checkout_services.add_item(cart=cart, variant_id=last_unit["variant"].pk, quantity=1)
    order = checkout_services.place_order(
        cart=cart,
        shipping_address=ADDRESS,
        payment_method=PaymentMethod.ONLINE_GATEWAY,
        contact_phone="01700000000",
        idempotency_key="webhook-order",
    )
    payment = order.payments.first()

    def deliver(_index: int) -> str:
        event = payment_services.handle_provider_event(
            provider="manual",
            provider_event_id="evt-123",
            event_type="payment.captured",
            payload={"amount": str(order.grand_total)},
            order=order,
            payment=payment,
        )
        return event.result

    run_together(deliver, 3)

    order.refresh_from_db()
    payment.refresh_from_db()
    assert payment.status == PaymentState.CAPTURED
    assert order.paid_total == order.grand_total  # captured once, not three times
    assert order.payment_events.count() == 1


def test_concurrent_sales_of_different_variants_do_not_block_each_other(last_unit):
    branch = last_unit["branch"]
    variants = [factories.variant(price="500.00") for _ in range(4)]
    for variant in variants:
        factories.stock(variant, branch, 5, "200.00")

    def sell(index: int) -> str:
        order = pos.create_pos_sale(
            branch=branch,
            actor=last_unit["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variants[index].pk, quantity=2)],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
                idempotency_key=f"parallel-{index}",
            ),
        )
        return order.number

    results, errors = run_together(sell, 4)

    assert not errors, errors
    assert len(results) == 4
    assert inventory_services.verify_integrity() == []


def test_multi_line_sales_in_opposite_order_do_not_deadlock(last_unit):
    """Locking rows in primary-key order is what prevents this deadlocking."""
    branch = last_unit["branch"]
    first, second = factories.variant(price="100.00"), factories.variant(price="100.00")
    factories.stock(first, branch, 20, "50.00")
    factories.stock(second, branch, 20, "50.00")

    def sell(index: int) -> str:
        lines = [first, second] if index % 2 == 0 else [second, first]
        order = pos.create_pos_sale(
            branch=branch,
            actor=last_unit["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=v.pk, quantity=1) for v in lines],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("200.00"))],
                idempotency_key=f"deadlock-{index}",
            ),
        )
        return order.number

    results, errors = run_together(sell, 6)

    assert not errors, f"deadlock or failure: {errors}"
    assert len(results) == 6
    assert Inventory.objects.get(variant=first, branch=branch).on_hand == 14
    assert inventory_services.verify_integrity() == []


def test_return_processed_twice_refunds_once(last_unit):
    order = pos.create_pos_sale(
        branch=last_unit["branch"],
        actor=last_unit["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=last_unit["variant"].pk, quantity=1)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
            idempotency_key="return-race",
        ),
    )
    manager = factories.user("MANAGER", branch_obj=last_unit["branch"])
    item = order.items.first()
    request = return_services.request_return(
        order=order, lines=[(item.pk, 1)], reason="WRONG_SIZE", actor=manager
    )
    return_services.approve(return_request=request, actor=manager)
    return_services.receive(return_request=request, actor=manager)

    def complete(_index: int) -> str:
        return_services.complete(return_request=request, actor=manager)
        return "done"

    run_together(complete, 3)

    order.refresh_from_db()
    assert order.refunds.count() == 1
    assert order.refunded_total == Decimal("1000.00")
    assert inventory_services.verify_integrity() == []


# ---------------------------------------------------------------------------
# Money: the same races, one layer up
# ---------------------------------------------------------------------------


def test_simultaneous_sales_all_land_in_one_drawer(last_unit):
    """Six registers taking cash at once must sum exactly, with no lost update.

    Without SELECT ... FOR UPDATE on the account row, read-modify-write on
    `balance` loses increments here — the classic bug this app is shaped to
    prevent.
    """
    branch = last_unit["branch"]
    drawer = finance_services.create_account(
        branch=branch, name="Shared Drawer", kind=AccountKind.CASH, is_default=True
    )
    variant = factories.variant(price="100.00")
    factories.stock(variant, branch, 50, "40.00")

    def sell(index: int) -> str:
        order = pos.create_pos_sale(
            branch=branch,
            actor=last_unit["cashier"],
            data=SaleInput(
                lines=[SaleLineInput(variant_id=variant.pk, quantity=1)],
                payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("100.00"))],
                idempotency_key=f"drawer-{index}",
            ),
        )
        return order.number

    results, errors = run_together(sell, 6)

    assert not errors, f"failures: {errors}"
    assert len(results) == 6
    drawer.refresh_from_db()
    assert drawer.balance == Decimal("600.00")
    assert finance_services.verify_integrity() == []


def test_simultaneous_walk_in_lookups_resolve_to_one_customer(last_unit):
    """A branch has exactly one anonymous counter customer, however it is asked for.

    `pos.walk_in_customer()` uses get_or_create, which is only atomic because
    `customers_customer_walk_in_name_uniq` backs its lookup.  Without the
    constraint every thread misses the SELECT and inserts, and from then on
    *every* anonymous sale at that branch raises MultipleObjectsReturned until
    someone deletes a row by hand — the till stops, not just this test.
    """
    branch = last_unit["branch"]

    def resolve(index: int) -> str:
        return str(pos.walk_in_customer(branch).pk)

    results, errors = run_together(resolve, 8)

    assert not errors, f"failures: {errors}"
    assert len(results) == 8
    assert len(set(results)) == 1, f"expected one walk-in row, got {sorted(set(results))}"
    assert Customer.objects.filter(is_walk_in=True, name=f"Walk-in ({branch.code})").count() == 1


def test_concurrent_withdrawals_cannot_overdraw_a_drawer(last_unit):
    """Only as many withdrawals as the drawer can cover may succeed."""
    drawer = finance_services.create_account(
        branch=last_unit["branch"],
        name="Small Drawer",
        kind=AccountKind.CASH,
        opening_balance=Decimal("300.00"),
    )

    def withdraw(index: int) -> str:
        finance_services.record_movement(
            account=drawer,
            transaction_type="WITHDRAWAL",
            amount=Decimal("100.00"),
            reason=f"race-{index}",
        )
        return "withdrawn"

    results, errors = run_together(withdraw, 5)

    assert len(results) == 3, f"expected exactly 3 to succeed, got {len(results)}"
    assert len(errors) == 2
    assert all(isinstance(error, InsufficientFunds) for error in errors)
    drawer.refresh_from_db()
    assert drawer.balance == Decimal("0.00")
    assert finance_services.verify_integrity() == []


def test_transfers_in_opposite_directions_do_not_deadlock(last_unit):
    """Locking accounts in primary-key order is what prevents this."""
    branch = last_unit["branch"]
    first = finance_services.create_account(
        branch=branch,
        name="Drawer A",
        kind=AccountKind.CASH,
        opening_balance=Decimal("1000.00"),
    )
    second = finance_services.create_account(
        branch=branch,
        name="Bank B",
        kind=AccountKind.BANK,
        opening_balance=Decimal("1000.00"),
    )

    def move(index: int) -> str:
        source, target = (first, second) if index % 2 == 0 else (second, first)
        finance_services.transfer(
            source_account=source, target_account=target, amount=Decimal("50.00")
        )
        return "moved"

    results, errors = run_together(move, 6)

    assert not errors, f"deadlock or failure: {errors}"
    assert len(results) == 6
    first.refresh_from_db()
    second.refresh_from_db()
    # Three each way: money is conserved whatever order they interleaved in.
    assert first.balance + second.balance == Decimal("2000.00")
    assert finance_services.verify_integrity() == []


def test_a_replayed_capture_webhook_banks_the_money_once(last_unit):
    """A gateway that retries its webhook must not credit the account twice."""
    branch = last_unit["branch"]
    bank = finance_services.create_account(
        branch=branch, name="Settlement", kind=AccountKind.BANK, is_default=True
    )
    finance_services.create_account(
        branch=branch, name="Drawer", kind=AccountKind.CASH, is_default=True
    )
    order = pos.create_pos_sale(
        branch=branch,
        actor=last_unit["cashier"],
        data=SaleInput(
            lines=[SaleLineInput(variant_id=last_unit["variant"].pk, quantity=1)],
            payments=[PaymentInput(method=PaymentMethod.CASH, amount=Decimal("1000.00"))],
            idempotency_key="webhook-race",
        ),
    )
    pending = payment_services.record_payment(
        order=order,
        method=PaymentMethod.CARD,
        amount=Decimal("250.00"),
        status=PaymentState.PENDING,
    )

    def capture(_index: int) -> str:
        payment_services.capture_payment(payment=pending)
        return "captured"

    run_together(capture, 4)

    bank.refresh_from_db()
    assert bank.balance == Decimal("250.00")
    assert finance_services.verify_integrity() == []


def test_one_customer_cannot_spend_a_one_per_customer_coupon_twice():
    """`usage_limit_per_customer` must hold under a race, not just sequentially.

    The limit defaults to 1, so this is the *default* configuration. Sequentially
    it works: the second order's validation counts the first redemption and
    refuses. Concurrently, both carts validate before either redeems, and the
    customer spends a once-per-customer coupon twice — real money, given away.

    `redeem()` already serialises on the coupon row to protect the total usage
    limit. The per-customer limit has to be re-checked inside that same lock.
    """
    branch = factories.branch(factories.organization())
    variant = factories.variant(price="1000.00")
    factories.stock(variant, branch, 10, "400.00")
    customer = factories.customer()
    coupon = Coupon.objects.create(
        code="ONCEPER",
        discount_type=DiscountType.PERCENTAGE,
        value=Decimal("50.00"),
        usage_limit_per_customer=1,
    )

    # Two separate carts — two genuinely different orders, as two browser tabs
    # or two rapid submissions would produce. Not a double-click on one cart:
    # that is the idempotency key's job and is already covered.
    carts = []
    for index in range(2):
        cart = checkout_services.get_or_create_cart(
            token=f"coupon-race-{index}", customer=customer, branch=branch
        )
        checkout_services.add_item(cart=cart, variant_id=variant.pk, quantity=1)
        checkout_services.apply_coupon(cart=cart, code="ONCEPER")
        carts.append(cart)

    def buy(index: int) -> str:
        order = checkout_services.place_order(
            cart=carts[index],
            shipping_address=ADDRESS,
            payment_method=PaymentMethod.COD,
            customer=customer,
            contact_phone=customer.phone,
            idempotency_key=f"coupon-race-{index}",
        )
        return order.number

    results, errors = run_together(buy, 2)

    redeemed = CouponRedemption.objects.filter(
        coupon=coupon, customer=customer, released_at__isnull=True
    ).count()
    assert redeemed == 1, (
        f"a one-per-customer coupon was redeemed {redeemed} times "
        f"(orders: {results}, refusals: {errors})"
    )
    coupon.refresh_from_db()
    assert coupon.used_count == 1
