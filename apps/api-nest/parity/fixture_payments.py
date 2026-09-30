"""Orders awaiting a gateway's payment, for the webhook parity cases.

Run through Django after fixture_cart.py, like the other fixtures:

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_payments.py

All or nothing, and a second run finds the marker order and stops. Payments
are recorded with `record_payment`, as checkout records them, then given the
provider `paritypay` -- the stand-in gateway both APIs install in the parity
stack (gateway/, gateway.ts) -- or the account a case needs.

What each order is for (all a guest's, "Parity Webhook"):
- P01: a card payment waiting on the gateway, with a payload of its own that
  the event's is merged into. Most events are sent against this one.
- P02: an authorised mobile-wallet payment: captured into the wallet account.
- P03: cash on delivery (`manual`): a gateway's event must not capture it (D100).
- P04, P08, P09: a named account the money cannot land in -- the wrong kind,
  closed, another branch's.
- P05: two payments waiting on the gateway: the older is the one taken.
- P06: nothing left to take -- one failed, one already captured.
- P07: store credit, which no account at the branch holds: captured, nothing
  posted, as `resolve_account` answers None rather than guess.
- A second bank account, open but not the default, that sorts before the
  default by name: the fallback when the default is closed.
"""

from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, Status
from customers.models import Customer, CustomerType
from finance.models import Account, AccountKind
from orders.models import Channel, Order, Payment, PaymentState
from orders.services.payments import record_payment

MARKER = "RGN-PARITY-P01"


def apply() -> None:
    branch = Branch.objects.filter(is_default=True).first()
    customer = Customer.objects.create(name="Parity Webhook", customer_type=CustomerType.GUEST)
    # Closed and not fulfilling online orders, so nothing else reads it.
    elsewhere = Branch.objects.create(
        organization=branch.organization, name="Parity Uttara", code="PAR2",
        status=Status.INACTIVE, fulfils_online_orders=False,
    )
    cash = Account.objects.get(branch=branch, kind=AccountKind.CASH, is_default=True)
    closed = Account.objects.create(
        branch=branch, name="Parity Closed Bank", kind=AccountKind.BANK, is_active=False
    )
    foreign = Account.objects.create(
        branch=elsewhere, name="Parity Uttara Bank", kind=AccountKind.BANK, is_default=True
    )
    Account.objects.create(branch=branch, name="Agrani Parity Savings", kind=AccountKind.BANK)

    start = timezone.now() - timedelta(days=2)

    def order(number: str, total: str) -> Order:
        return Order.objects.create(
            number=number,
            channel=Channel.ONLINE,
            branch=branch,
            customer=customer,
            currency="BDT",
            subtotal=Decimal(total),
            grand_total=Decimal(total),
        )

    def pay(order_: Order, method: str, amount: str, minute: int, **fields) -> Payment:
        status = fields.pop("status", PaymentState.PENDING)
        payment = record_payment(
            order=order_, method=method, amount=Decimal(amount), status=status,
            provider=fields.pop("provider", "paritypay"),
        )
        # Distinct, known creation times: the oldest waiting payment is the one taken.
        Payment.objects.filter(pk=payment.pk).update(
            created_at=start + timedelta(minutes=minute), **fields
        )
        return payment

    pay(order("RGN-PARITY-P01", "1000.00"), "CARD", "1000.00", 1, payload={"session": "sess-p01"})
    pay(order("RGN-PARITY-P02", "500.00"), "MOBILE_MFS", "500.00", 2, status=PaymentState.AUTHORIZED)
    pay(order("RGN-PARITY-P03", "990.00"), "COD", "990.00", 3, provider="manual")
    pay(order("RGN-PARITY-P04", "800.00"), "CARD", "800.00", 4, account=cash)
    split = order("RGN-PARITY-P05", "1000.00")
    pay(split, "CARD", "300.00", 5)
    pay(split, "MOBILE_MFS", "700.00", 6)
    settled = order("RGN-PARITY-P06", "600.00")
    pay(settled, "CARD", "600.00", 7, status=PaymentState.FAILED)
    pay(settled, "CARD", "600.00", 8, status=PaymentState.CAPTURED)
    pay(order("RGN-PARITY-P07", "450.00"), "STORE_CREDIT", "450.00", 9)
    pay(order("RGN-PARITY-P08", "700.00"), "CARD", "700.00", 10, account=closed)
    pay(order("RGN-PARITY-P09", "650.00"), "CARD", "650.00", 11, account=foreign)


if Order.objects.filter(number=MARKER).exists():
    print("parity payments fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity payments fixture applied")
