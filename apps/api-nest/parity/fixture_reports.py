"""Taxed trade in early 2025, for the parity suite (phase 7 part 3).

Applied by `scripts/nest-parity.sh seed`, after fixture_notifications.py:

    docker compose -f docker-compose.nest.yml exec -T django \
        python manage.py shell < apps/api-nest/parity/fixture_reports.py

Idempotent: it does nothing when its first order is already there.

The demo seed charges no VAT, so nothing in it reaches the reports' tax
arithmetic. These documents do, dated January to March 2025 where a window
finds them and nothing else. They are written as rows -- frozen figures and
all -- and move no stock and no money: no ledger, no cash book, no customer
totals, so the shelves and accounts every other suite counts stay as they
were. Every order is paid and every purchase settled, so none is a debt.

Orders, at PAR3 unless said (by `Parity Reports Buyer`):

- PAR-RPT-0001  10 Jan, POS, EXCLUSIVE at 15%, two lines and an order
  discount whose shares do not terminate (150.00 over 3333.33).
- PAR-RPT-0002  20 Jan, ONLINE, INCLUSIVE at 15%, a line discount, a coupon
  and shipping.
- PAR-RPT-0003  the first half-hour of 1 Feb in Dhaka (still January in
  UTC), PHONE, INCLUSIVE at 7.5%, part refunded.
- PAR-RPT-0004  10 Feb, POS, zero-rated; a second payment still pending.
- PAR-RPT-0005  the same instant, SOCIAL, RETURNED, one free line: a
  subtotal of nothing.
- PAR-RPT-0006  CANCELLED, and PAR-RPT-0007 PENDING: not trade.
- PAR-RPT-0008  12 Jan, at DHK1.

Returns: one completed the month after its sale, a unit of three restocked
and a line written off (PAR-RRT-0001); one completed and quarantined (0002);
one only approved (0003); one at DHK1, restocked (0004); one asking for
nothing yet (0005).

Purchase orders: PAR-PO-R1 received in two posted deliveries, 15% and
zero-rated lines, shipping, two shirts sent back (PAR-PRT-R1); R2 at 7.5%
whose one delivery is not posted; R3 a draft; R4 cancelled; R5 at DHK1,
its delivery in March, one shirt sent back.

Expenses at PAR3: rent of 500.00, transport of 250.00 twice -- two
categories of one total -- and one voided.

And parity.reader@rangon.test at PAR3, whose role PARITY_READER reads the
reports, the financial ones too, and may not export them: every role the
shop ships that can read a report can also export it.
"""

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction

from accounts.models import Branch, Permission, Role, User
from accounts.services import get_organization
from catalog.models import ProductVariant
from customers.models import Customer
from finance.models import Account, Expense, ExpenseCategory
from orders.models import Order, OrderItem, Payment, ReturnItem, ReturnRequest
from purchasing.models import (
    PurchaseOrder,
    PurchaseOrderItem,
    PurchaseReceipt,
    PurchaseReturn,
    PurchaseReturnItem,
    Supplier,
)

MARKER = "PAR-RPT-0001"
PARITY_PASSWORD = "Parity-Pass-2026!"
DHAKA = ZoneInfo("Asia/Dhaka")
D = Decimal


def at(month, day, hour=12, minute=0):
    return datetime(2025, month, day, hour, minute, tzinfo=DHAKA)


def apply() -> None:
    owner = User.objects.get(email="owner@rangon.test")
    mirpur = Branch.objects.get(code="PAR3")
    dhaka = Branch.objects.get(code="DHK1")
    shirt = ProductVariant.objects.select_related("product").get(sku="RGN-CLA-M-WHI")
    tee = ProductVariant.objects.select_related("product").get(sku="RGN-ESS-M-OLI")
    supplier = Supplier.objects.order_by("name").first()
    buyer = Customer.objects.create(name="Parity Reports Buyer", phone="8801911000777")

    reader = Role.objects.create(
        code="PARITY_READER", name="Parity reports reader", is_system=False
    )
    reader.permissions.set(
        Permission.objects.filter(code__in=["reports.view", "reports.financial"])
    )
    User.objects.create_user(
        email="parity.reader@rangon.test",
        password=PARITY_PASSWORD,
        role=reader,
        organization=get_organization(),
        branch=mirpur,
        first_name="Parity",
        last_name="Reader",
    )

    def order(number, placed, channel, status, lines, branch=mirpur, **totals):
        made = Order.objects.create(
            number=number,
            channel=channel,
            branch=branch,
            customer=buyer,
            status=status,
            payment_status=totals.pop("payment_status", "PAID"),
            placed_at=placed,
            created_by=owner,
            **totals,
        )
        Order.objects.filter(pk=made.pk).update(created_at=placed, updated_at=placed)
        items = []
        for (
            variant,
            quantity,
            unit_price,
            unit_cost,
            line_discount,
            tax,
            line_total,
            returned,
        ) in lines:
            items.append(
                OrderItem.objects.create(
                    order=made,
                    variant=variant,
                    sku=variant.sku,
                    product_name=variant.product.name,
                    variant_label=variant.label,
                    quantity=quantity,
                    unit_price=D(unit_price),
                    unit_cost=D(unit_cost),
                    line_discount=D(line_discount),
                    tax_amount=D(tax),
                    line_total=D(line_total),
                    fulfilled_quantity=quantity,
                    returned_quantity=returned,
                )
            )
        return made, items

    def paid(made, method, amount, status="CAPTURED", **fields):
        Payment.objects.create(
            order=made, method=method, amount=D(amount), status=status, created_by=owner, **fields
        )

    first, first_lines = order(
        MARKER,
        at(1, 10, 11),
        "POS",
        "DELIVERED",
        [
            (shirt, 3, "1000.00", "400.50", "0.00", "429.75", "3000.00", 1),
            (tee, 1, "333.33", "100.00", "0.00", "47.75", "333.33", 1),
        ],
        subtotal=D("3333.33"),
        manual_discount=D("150.00"),
        discount_total=D("150.00"),
        tax_total=D("477.50"),
        tax_rate=D("0.15"),
        tax_mode="EXCLUSIVE",
        grand_total=D("3660.83"),
        paid_total=D("3660.83"),
    )
    paid(first, "CASH", "3660.83")

    second, second_lines = order(
        "PAR-RPT-0002",
        at(1, 20, 15, 30),
        "ONLINE",
        "SHIPPED",
        [
            (tee, 2, "1150.00", "480.00", "0.00", "296.27", "2300.00", 1),
            (shirt, 1, "575.00", "210.25", "75.00", "55.90", "500.00", 0),
        ],
        subtotal=D("2800.00"),
        coupon_discount=D("100.00"),
        discount_total=D("100.00"),
        tax_total=D("352.17"),
        tax_rate=D("0.15"),
        tax_mode="INCLUSIVE",
        shipping_total=D("60.00"),
        grand_total=D("2760.00"),
        paid_total=D("2760.00"),
    )
    paid(second, "BKASH", "2760.00")

    third, third_lines = order(
        "PAR-RPT-0003",
        at(2, 1, 0, 30),
        "PHONE",
        "CONFIRMED",
        [(shirt, 4, "1075.00", "400.00", "0.00", "300.00", "4300.00", 0)],
        subtotal=D("4300.00"),
        tax_total=D("300.00"),
        tax_rate=D("0.075"),
        tax_mode="INCLUSIVE",
        grand_total=D("4300.00"),
        paid_total=D("4300.00"),
        refunded_total=D("1075.00"),
        payment_status="PARTIALLY_REFUNDED",
    )
    paid(third, "CARD", "4300.00", status="PARTIALLY_REFUNDED", refunded_total=D("1075.00"))

    fourth, _ = order(
        "PAR-RPT-0004",
        at(2, 10, 10),
        "POS",
        "DELIVERED",
        [(tee, 5, "200.00", "100.00", "0.00", "0.00", "1000.00", 0)],
        subtotal=D("1000.00"),
        tax_rate=D("0"),
        tax_mode="EXCLUSIVE",
        grand_total=D("1000.00"),
        paid_total=D("1000.00"),
    )
    paid(fourth, "CASH", "1000.00")
    paid(fourth, "BKASH", "1000.00", status="PENDING")

    order(
        "PAR-RPT-0005",
        at(2, 10, 10),
        "SOCIAL",
        "RETURNED",
        [(shirt, 1, "0.00", "400.00", "0.00", "0.00", "0.00", 0)],
        tax_rate=D("0.15"),
        tax_mode="EXCLUSIVE",
    )
    cancelled, _ = order(
        "PAR-RPT-0006",
        at(2, 15),
        "ONLINE",
        "CANCELLED",
        [(tee, 1, "1150.00", "480.00", "0.00", "150.00", "1150.00", 0)],
        subtotal=D("1150.00"),
        tax_total=D("150.00"),
        tax_rate=D("0.15"),
        tax_mode="INCLUSIVE",
        grand_total=D("1150.00"),
        payment_status="UNPAID",
    )
    paid(cancelled, "COD", "1150.00", status="FAILED")
    order(
        "PAR-RPT-0007",
        at(2, 20),
        "ONLINE",
        "PENDING",
        [(tee, 1, "1150.00", "480.00", "0.00", "150.00", "1150.00", 0)],
        subtotal=D("1150.00"),
        tax_total=D("150.00"),
        tax_rate=D("0.15"),
        tax_mode="INCLUSIVE",
        grand_total=D("1150.00"),
        paid_total=D("1150.00"),
    )
    eighth, eighth_lines = order(
        "PAR-RPT-0008",
        at(1, 12),
        "POS",
        "DELIVERED",
        [(shirt, 1, "1000.00", "400.00", "0.00", "150.00", "1000.00", 1)],
        branch=dhaka,
        subtotal=D("1000.00"),
        tax_total=D("150.00"),
        tax_rate=D("0.15"),
        tax_mode="EXCLUSIVE",
        grand_total=D("1150.00"),
        paid_total=D("1150.00"),
        refunded_total=D("1150.00"),
        payment_status="REFUNDED",
    )
    paid(eighth, "CASH", "1150.00")

    def returned(number, made, opened, status, refund, items, completed=None):
        request = ReturnRequest.objects.create(
            number=number,
            order=made,
            reason="WRONG_SIZE",
            status=status,
            refund_amount=D(refund),
            requested_by=owner,
            completed_at=completed,
        )
        ReturnRequest.objects.filter(pk=request.pk).update(created_at=opened, updated_at=opened)
        for line, quantity, decision in items:
            ReturnItem.objects.create(
                return_request=request,
                order_item=line,
                quantity=quantity,
                restock_decision=decision,
            )

    returned(
        "PAR-RRT-0001",
        first,
        at(1, 15),
        "COMPLETED",
        "1553.61",
        [(first_lines[0], 1, "RESTOCK"), (first_lines[1], 1, "DAMAGED")],
        completed=at(2, 5),
    )
    returned(
        "PAR-RRT-0002",
        second,
        at(1, 22),
        "COMPLETED",
        "1105.00",
        [(second_lines[0], 1, "QUARANTINE")],
        completed=at(1, 25),
    )
    returned(
        "PAR-RRT-0003", third, at(2, 2), "APPROVED", "2150.00", [(third_lines[0], 2, "RESTOCK")]
    )
    returned(
        "PAR-RRT-0004",
        eighth,
        at(1, 13),
        "COMPLETED",
        "1150.00",
        [(eighth_lines[0], 1, "RESTOCK")],
        completed=at(1, 14),
    )
    returned("PAR-RRT-0005", fourth, at(2, 11), "REQUESTED", "0.00", [])

    def purchase(number, raised, status, lines, branch=mirpur, **totals):
        made = PurchaseOrder.objects.create(
            number=number,
            supplier=supplier,
            branch=branch,
            status=status,
            created_by=owner,
            **{key: D(value) for key, value in totals.items()},
        )
        PurchaseOrder.objects.filter(pk=made.pk).update(
            created_at=raised,
            updated_at=raised,
            payment_status="PAID" if status in ("RECEIVED", "CLOSED") else "UNPAID",
        )
        items = []
        for variant, ordered, received, sent_back, unit_cost, tax_rate, line_total in lines:
            items.append(
                PurchaseOrderItem.objects.create(
                    purchase_order=made,
                    variant=variant,
                    quantity_ordered=ordered,
                    quantity_received=received,
                    quantity_returned=sent_back,
                    unit_cost=D(unit_cost),
                    tax_rate=D(tax_rate),
                    line_total=D(line_total),
                )
            )
        return made, items

    def delivery(number, made, received, posted=True):
        PurchaseReceipt.objects.create(
            number=number,
            purchase_order=made,
            received_at=received,
            received_by=owner,
            is_posted=posted,
        )

    def sent_back(number, made, when, line, quantity, unit_cost):
        back = PurchaseReturn.objects.create(
            number=number,
            purchase_order=made,
            reason="DEFECTIVE",
            returned_at=when,
            returned_by=owner,
            credit_total=D(unit_cost) * quantity,
        )
        PurchaseReturnItem.objects.create(
            purchase_return=back,
            purchase_order_item=line,
            quantity=quantity,
            unit_cost=D(unit_cost),
        )

    one, one_lines = purchase(
        "PAR-PO-R1",
        at(1, 8),
        "RECEIVED",
        [
            (shirt, 10, 10, 2, "400.00", "0.15", "4000.00"),
            (tee, 20, 20, 0, "100.00", "0", "2000.00"),
        ],
        subtotal="6000.00",
        tax_total="600.00",
        shipping_total="250.00",
        grand_total="6850.00",
        paid_total="6050.00",
        credited_total="800.00",
    )
    delivery("PAR-GRN-R1", one, at(1, 18))
    delivery("PAR-GRN-R2", one, at(2, 3))
    sent_back("PAR-PRT-R1", one, at(2, 6), one_lines[0], 2, "400.00")

    two, _ = purchase(
        "PAR-PO-R2",
        at(2, 12),
        "RECEIVED",
        [(tee, 10, 10, 0, "100.00", "0.075", "1000.00")],
        subtotal="1000.00",
        tax_total="75.00",
        shipping_total="90.00",
        grand_total="1165.00",
        paid_total="1165.00",
    )
    delivery("PAR-GRN-R3", two, at(2, 14), posted=False)
    for number, day, status in (("PAR-PO-R3", 13, "DRAFT"), ("PAR-PO-R4", 14, "CANCELLED")):
        purchase(
            number,
            at(2, day),
            status,
            [(shirt, 5, 0, 0, "400.00", "0.15", "2000.00")],
            subtotal="2000.00",
            tax_total="300.00",
            shipping_total="40.00",
            grand_total="2340.00",
            # Neither is a debt: a draft and a cancelled order owe nothing.
            paid_total="2340.00",
        )
    five, five_lines = purchase(
        "PAR-PO-R5",
        at(1, 9),
        "RECEIVED",
        [(shirt, 3, 3, 1, "400.00", "0.15", "1200.00")],
        branch=dhaka,
        subtotal="1200.00",
        tax_total="180.00",
        shipping_total="30.00",
        grand_total="1410.00",
        paid_total="1010.00",
        credited_total="400.00",
    )
    delivery("PAR-GRN-R5", five, at(3, 1))
    sent_back("PAR-PRT-R5", five, at(1, 20), five_lines[0], 1, "400.00")

    account = (
        Account.objects.filter(branch=mirpur).order_by("name").first()
        or Account.objects.order_by("name").first()
    )

    def spent(number, code, when, amount, status="RECORDED"):
        Expense.objects.create(
            number=number,
            branch=mirpur,
            category=ExpenseCategory.objects.get(code=code),
            account=account,
            spent_at=when,
            amount=D(amount),
            status=status,
            note="Parity: for the reports",
            created_by=owner,
        )

    spent("PAR-EXP-R1", "RENT", at(1, 5), "500.00")
    spent("PAR-EXP-R2", "TRANSPORT", at(2, 7), "250.00")
    spent("PAR-EXP-R3", "TRANSPORT", at(2, 8), "250.00")
    spent("PAR-EXP-R4", "UTILITIES", at(2, 9), "999.00", status="VOID")
    print("parity reports fixture applied")


if Order.objects.filter(number=MARKER).exists():
    print("parity reports fixture already applied")
else:
    with transaction.atomic():
        apply()
