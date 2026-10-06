"""Counter sales and the returns raised on them, for returns and refunds (phase 5).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_returns.py

All or nothing, and a second run finds the first sale and stops. Test data for
the parity database only. Every sale is made by `create_pos_sale` and every
return by `orders.services.returns`, so the rows are the ones the API writes.
Each sale is told by its note:

- "Parity return me": two shirts and a tee for a named customer, 20.00 off the
  whole sale, paid in cash and by card. Nothing returned yet: the cases open
  returns on it.
- "Parity return thirds": one tee on each of three lines with 20.00 off, so
  each line's share of the discount is 6.67 and the last carries the odd
  paisa -- and one SKU sits on three lines of one return.
- "Parity return card": a tee paid by card only, so a cash refund comes out
  of a different account from the one the money went into.
- "Parity return open": a return REQUESTED for one of two shirts.
- "Parity return approved": a return APPROVED over both of the sale's lines,
  one to restock and one written off.
- "Parity return received": a return RECEIVED, its refund not yet paid.
- "Parity return done": a return COMPLETED at the counter, refunded in cash.
- "Parity return rejected": a return REJECTED.
- "Parity return twice": two returns for the sale's one unit -- the first
  RECEIVED, the second (its comment "second") APPROVED and never receivable.
- "Parity return mirpur": a sale at PAR3 with a return REQUESTED, which a
  manager bound to DHK1 cannot see.
"""

from decimal import Decimal

from django.db import transaction

from accounts.models import Branch, User
from catalog.models import ProductVariant
from customers.models import Customer
from orders.models import Order
from orders.services import pos
from orders.services import returns as return_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput

MARKER = "Parity return me"
SHIRT = "RGN-CLA-M-NAV"  # 2450.00
TEE = "RGN-ESS-L-WHI"  # 890.00


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    manager = User.objects.get(email="manager@rangon.test")
    cashier = User.objects.get(email="cashier@rangon.test")
    mirpur_manager = User.objects.get(email="parity.mirpur@rangon.test")

    def sku(code: str) -> ProductVariant:
        return ProductVariant.objects.get(sku=code)

    def sale(note, lines, payments, branch=home, actor=cashier, **fields) -> Order:
        return pos.create_pos_sale(
            branch=branch,
            actor=actor,
            data=SaleInput(
                lines=[SaleLineInput(variant_id=sku(code).pk, quantity=qty) for code, qty in lines],
                payments=[
                    PaymentInput(method=method, amount=Decimal(amount))
                    for method, amount in payments
                ],
                note=note,
                **fields,
            ),
        )

    def ask(order, quantities, reason, actor=manager, **fields):
        items = list(order.items.order_by("created_at"))
        return return_services.request_return(
            order=order,
            lines=[(items[index].pk, quantity) for index, quantity in quantities],
            reason=reason,
            actor=actor,
            **fields,
        )

    sale(
        MARKER,
        [(SHIRT, 2), (TEE, 1)],
        [("CASH", "2000.00"), ("CARD", "3770.00")],
        actor=manager,
        customer_id=Customer.objects.get(email="parity.many@rangon.test").pk,
        manual_discount=Decimal("20.00"),
        register="R1",
    )
    sale(
        "Parity return thirds",
        [(TEE, 1), (TEE, 1), (TEE, 1)],
        [("CASH", "2650.00")],
        actor=manager,
        manual_discount=Decimal("20.00"),
    )
    sale("Parity return card", [(TEE, 1)], [("CARD", "890.00")])

    opened = sale("Parity return open", [(SHIRT, 2)], [("CASH", "4900.00")])
    ask(opened, [(0, 1)], "WRONG_SIZE", customer_comment="Too tight across the shoulders")

    approved = sale("Parity return approved", [(SHIRT, 1), (TEE, 2)], [("CASH", "4230.00")])
    request = ask(approved, [(0, 1), (1, 2)], "DEFECTIVE")
    tee_line = approved.items.order_by("created_at")[1]
    request.items.filter(order_item=tee_line).update(restock_decision="DAMAGED")
    return_services.approve(return_request=request, actor=manager, comment="Bring it in")

    received = sale("Parity return received", [(TEE, 2)], [("CASH", "1000.00"), ("CARD", "780.00")])
    request = ask(received, [(0, 2)], "CUSTOMER_CHANGED_MIND")
    return_services.approve(return_request=request, actor=manager)
    return_services.receive(return_request=request, actor=manager)

    done = sale("Parity return done", [(TEE, 1)], [("CASH", "890.00")])
    pos.pos_return(
        order=done,
        actor=manager,
        lines=[(done.items.get().pk, 1, "RESTOCK")],
        reason="WRONG_SIZE",
    )

    rejected = sale("Parity return rejected", [(TEE, 1)], [("CASH", "890.00")])
    request = ask(rejected, [(0, 1)], "OTHER")
    return_services.reject(return_request=request, actor=manager, comment="Worn")

    twice = sale("Parity return twice", [(TEE, 1)], [("CASH", "890.00")])
    first = ask(twice, [(0, 1)], "WRONG_SIZE")
    second = ask(twice, [(0, 1)], "WRONG_SIZE", customer_comment="second")
    for request in (first, second):
        return_services.approve(return_request=request, actor=manager)
    return_services.receive(return_request=first, actor=manager)

    away = sale(
        "Parity return mirpur",
        [("PAR-TEE-S-WHT", 1)],
        [("CASH", "1100.00")],
        branch=mirpur,
        actor=mirpur_manager,
        # Named: PAR3 keeps no walk-in record.
        customer_id=Customer.objects.get(email="parity.guest@rangon.test").pk,
    )
    ask(away, [(0, 1)], "DAMAGED", actor=mirpur_manager)
    print("parity returns fixture applied")


if Order.objects.filter(customer_note=MARKER).exists():
    print("parity returns fixture already applied")
else:
    with transaction.atomic():
        apply()
