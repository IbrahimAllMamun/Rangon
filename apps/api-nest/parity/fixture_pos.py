"""Held sales and a till at the second branch, for the POS (phase 5).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_pos.py

All or nothing, and a second run finds the till and stops. Test data for the
parity database only. What each row is for:
- "Parity Mirpur Till": an active cash account at PAR3, so the register there
  opens with one and a sale there has somewhere to put its takings.
- At DHK1: twenty-two holds, a minute apart, so the session shows the newest
  twenty and the list shows them all. Among them a hold for a named customer
  parked by the manager, one whose cashier is gone (`created_by` empty), one
  with a register and no label, and payloads that are not a cart: a list, a
  string, an integer past 2^53, floats and Bengali text.
- At PAR3: two holds parked by its manager -- a hold at another branch is
  not found, and an owner reads them with `?branch=`.

For the quote and the manager's approval (its own marker, `parity.till`):
- `parity.till`: a role that may ring up a sale and nothing else -- no
  `sales.discount`, so any discount of its own is refused.
- `parity.approver`: a MANAGER at DHK1 whose approvals the cases mint, so a
  case that deactivates or moves the approver touches no other case.
- `parity.gone`: a MANAGER at DHK1 who is no longer active.
- PARITY-TWICE and PARITY-THRICE: coupons good twice and three times per
  customer, for the counter's "needs the customer on the sale" refusal.
- PARITY-STR: a coupon whose `channels` is a string, not a list -- Python's
  `in` is then a substring test.

For the sale (its own marker, the key `parity-pos-replayed`):
- Five PAR-TWA received at DHK1 and three online orders holding four of them
  -- one, then two, then one, the newest last -- so a counter sale that is
  let into reserved stock leaves the newest orders short first.
- "Parity Caller": a customer whose number has an open call-back lead, which
  a counter sale to them closes.
- Four counter sales, made by `create_pos_sale` itself: one whose
  `Idempotency-Key` is replayed, one whose key is the empty string (D143),
  one at PAR3 by its manager (for a named customer: PAR3 keeps no walk-in
  record until a case makes one), and one by the DHK1 manager for a named
  customer with a coupon, a discount past the threshold, and cash and a card.
"""

from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, Permission, Role, RoleCode, Status, User
from accounts.services import get_organization
from catalog.models import ProductVariant
from customers.models import Customer
from finance.models import Account, AccountKind
from inventory import services as stock
from orders.models import Channel, HeldSale, Order, OrderStatus
from orders.services import pos
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from promotions.models import Coupon, DiscountType

PARITY_PASSWORD = "Parity-Pass-2026!"
MARKER = "Parity Mirpur Till"
COUNTER_MARKER = "parity.till@rangon.test"
SALES_MARKER = "parity-pos-replayed"


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    cashier = User.objects.get(email="cashier@rangon.test")
    manager = User.objects.get(email="manager@rangon.test")
    mirpur_manager = User.objects.get(email="parity.mirpur@rangon.test")
    customer = Customer.objects.get(email="parity.customer@rangon.test")
    variant = ProductVariant.objects.get(sku="RGN-CLA-L-WHI")

    Account.objects.create(branch=mirpur, name=MARKER, kind=AccountKind.CASH, is_default=True)

    start = timezone.now() - timedelta(hours=3)
    cart = {
        "lines": [{"variant": str(variant.pk), "sku": variant.sku, "quantity": 2}],
        "manual_discount": "50.00",
        "note": "Back in ten minutes",
    }
    special = {
        5: {"created_by": manager, "customer": customer, "label": "Parvin, fitting room"},
        7: {"created_by": None, "label": "Cashier gone"},
        10: {"payload": [1, 2.5, "x", None, True]},
        11: {"payload": "just a note"},
        12: {"payload": 12345678901234567890},
        13: {"payload": {"a": 1.0, "b": 1000.0, "c": -0.5, "ব": "৳ 1,290"}},
        14: {"label": "", "register": "R2"},
        15: {"payload": {}},
    }
    for index in range(1, 23):
        fields = {
            "branch": home,
            "register": "R1",
            "label": f"H{index:02d}",
            "payload": cart,
            "created_by": cashier,
            **special.get(index, {}),
        }
        hold = HeldSale.objects.create(**fields)
        HeldSale.objects.filter(pk=hold.pk).update(created_at=start + timedelta(minutes=index))
    for index in range(1, 3):
        hold = HeldSale.objects.create(
            branch=mirpur,
            register="M1",
            label=f"Mirpur {index}",
            payload=cart,
            created_by=mirpur_manager,
        )
        HeldSale.objects.filter(pk=hold.pk).update(created_at=start + timedelta(minutes=index))
    print("parity POS fixture applied")


def apply_counter() -> None:
    home = Branch.objects.get(code="DHK1")
    till = Role.objects.create(code="PARITY_TILL", name="Parity till only", is_system=False)
    till.permissions.set(Permission.objects.filter(code__in=["sales.create", "sales.view"]))

    def account(email: str, role: Role, **extra) -> User:
        return User.objects.create_user(
            email=email,
            password=PARITY_PASSWORD,
            role=role,
            organization=get_organization(),
            branch=home,
            **extra,
        )

    manager = Role.objects.get(code=RoleCode.MANAGER)
    account(COUNTER_MARKER, till, first_name="Parity", last_name="Till")
    account("parity.approver@rangon.test", manager, first_name="Parity", last_name="Approver")
    # `User.save()` reads `is_active` off the status.
    account("parity.gone@rangon.test", manager, status=Status.INACTIVE)

    Coupon.objects.create(
        code="PARITY-TWICE",
        description="Thirty off, twice each",
        discount_type=DiscountType.FIXED,
        value=30,
        usage_limit_per_customer=2,
        channels=["POS", "ONLINE"],
    )
    Coupon.objects.create(
        code="PARITY-THRICE",
        description="A tenth off, three times each",
        discount_type=DiscountType.PERCENTAGE,
        value=10,
        usage_limit_per_customer=3,
    )
    Coupon.objects.create(
        code="PARITY-STR",
        description="Channels as a string",
        discount_type=DiscountType.FIXED,
        value=5,
        usage_limit_per_customer=None,
        channels="POSTAL",
    )
    print("parity counter fixture applied")


if Account.objects.filter(name=MARKER).exists():
    print("parity POS fixture already applied")
else:
    with transaction.atomic():
        apply()

if User.objects.filter(email=COUNTER_MARKER).exists():
    print("parity counter fixture already applied")
else:
    with transaction.atomic():
        apply_counter()


def apply_sales() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    cashier = User.objects.get(email="cashier@rangon.test")
    manager = User.objects.get(email="manager@rangon.test")
    mirpur_manager = User.objects.get(email="parity.mirpur@rangon.test")
    shopper = Customer.objects.get(email="parity.customer@rangon.test")

    def sku(code: str) -> ProductVariant:
        return ProductVariant.objects.get(sku=code)

    twa = sku("PAR-TWA")
    stock.receive_stock(
        branch=home, variant=twa, quantity=5, unit_cost=Decimal("400.00"), actor=manager
    )
    now = timezone.now()
    for index, (units, hours) in enumerate([(1, 3), (2, 2), (1, 1)], start=1):
        held = Order.objects.create(
            number=f"RGN-WEB-PARPOS{index}",
            channel=Channel.ONLINE,
            status=OrderStatus.CONFIRMED,
            branch=home,
            customer=shopper,
            currency="BDT",
            placed_at=now - timedelta(hours=hours),
        )
        stock.reserve(branch=home, lines=[(twa, units)], reference_id=held.pk)

    Customer.objects.create(name="Parity Caller", phone="01711000078")

    def sale(branch, actor, lines, payments, **fields) -> Order:
        return pos.create_pos_sale(
            branch=branch,
            actor=actor,
            data=SaleInput(
                lines=[SaleLineInput(variant_id=sku(code).pk, quantity=qty) for code, qty in lines],
                payments=[
                    PaymentInput(method=method, amount=Decimal(amount))
                    for method, amount in payments
                ],
                **fields,
            ),
        )

    sale(
        home,
        cashier,
        [("RGN-ESS-XL-WHI", 1)],
        [("CASH", "890.00")],
        register="R1",
        idempotency_key=SALES_MARKER,
    )
    sale(home, cashier, [("RGN-ESS-XL-WHI", 1)], [("CASH", "890.00")], idempotency_key="")
    # For a named customer, so PAR3 still has no walk-in record of its own.
    sale(
        mirpur,
        mirpur_manager,
        [("PAR-TEE-S-WHT", 1)],
        [("CASH", "1100.00")],
        register="M1",
        customer_id=Customer.objects.get(email="parity.guest@rangon.test").pk,
    )
    sale(
        home,
        manager,
        [("RGN-CLA-S-NAV", 2), ("RGN-ESS-XL-WHI", 1)],
        [("CASH", "2000.00"), ("CARD", "1983.00")],
        customer_id=Customer.objects.get(email="parity.many@rangon.test").pk,
        coupon_code="STORE100",
        manual_discount_percent=Decimal("30"),
        register="R2",
        note="Parity split payment",
    )
    print("parity sales fixture applied")


if Order.objects.filter(idempotency_key=SALES_MARKER).exists():
    print("parity sales fixture already applied")
else:
    with transaction.atomic():
        apply_sales()
