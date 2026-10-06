"""Accounts, manual movements and transfers, for the cash book (phase 6).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_finance.py

All or nothing, and a second run finds the first account and stops. Test data
for the parity database only; every row is written by `finance.services`.

- "Parity Petty Cash": an OTHER account at DHK1 opened with 1,500.00 and
  allowed to go overdrawn -- the one kind and the one switch no seed account
  has -- with a deposit, a withdrawal and a correction made by hand, each
  under an `Idempotency-Key` a case replays.
- "Parity Float": a second cash account at DHK1, not the default, opened with
  nothing: money cannot leave it.
- Two transfers out of the DHK1 drawer -- to the bank, and to the float --
  the first under a key a case replays; and one at PAR3's till into a new
  "Parity Mirpur Bank", which a manager bound to DHK1 cannot see.

For expenses (its own marker, the category "Parity Retired"):
- "Parity Retired": a category switched off, with one expense filed under it
  while it was on.
- An expense with a receipt attached (a one-pixel PNG), under a key a case
  replays; one dated five weeks ago; one voided; and one at PAR3, paid from
  its till.
"""

import base64
from datetime import timedelta
from decimal import Decimal

from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, User
from finance import services as finance
from finance.models import Account, AccountKind, AccountTransactionType, ExpenseCategory

MARKER = "Parity Petty Cash"


def apply() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    accountant = User.objects.get(email="accounts@rangon.test")
    drawer = Account.objects.get(name="Counter Cash Drawer")
    bank = Account.objects.get(name="City Bank Current")

    petty = finance.create_account(
        branch=home,
        name=MARKER,
        kind=AccountKind.OTHER,
        opening_balance=Decimal("1500.00"),
        allow_overdraft=True,
        notes="Tea, tips and tape",
        actor=accountant,
    )
    finance.record_movement(
        account=petty,
        transaction_type=AccountTransactionType.DEPOSIT,
        amount=Decimal("250.00"),
        notes="Topped up from the owner",
        actor=accountant,
        idempotency_key="parity-move-deposit",
    )
    finance.record_movement(
        account=petty,
        transaction_type=AccountTransactionType.WITHDRAWAL,
        amount=Decimal("90.00"),
        reason="Courier tip",
        actor=accountant,
        idempotency_key="parity-move-withdrawal",
    )
    finance.record_movement(
        account=petty,
        transaction_type=AccountTransactionType.ADJUSTMENT,
        amount=Decimal("-10.00"),
        reason="Counted short",
        actor=accountant,
    )
    floating = finance.create_account(
        branch=home, name="Parity Float", kind=AccountKind.CASH, actor=accountant
    )
    finance.transfer(
        source_account=drawer,
        target_account=bank,
        amount=Decimal("5000.00"),
        notes="Evening bank run",
        actor=accountant,
        idempotency_key="parity-transfer-banked",
    )
    finance.transfer(
        source_account=drawer,
        target_account=floating,
        amount=Decimal("300.00"),
        actor=accountant,
    )
    mirpur_bank = finance.create_account(
        branch=mirpur, name="Parity Mirpur Bank", kind=AccountKind.BANK, actor=accountant
    )
    finance.transfer(
        source_account=Account.objects.get(name="Parity Mirpur Till"),
        target_account=mirpur_bank,
        amount=Decimal("700.00"),
        notes="Mirpur takings",
        actor=User.objects.get(email="parity.mirpur@rangon.test"),
    )
    print("parity finance fixture applied")


if Account.objects.filter(name=MARKER).exists():
    print("parity finance fixture already applied")
else:
    with transaction.atomic():
        apply()


EXPENSES_MARKER = "Parity Retired"
#: The smallest PNG there is: one transparent pixel.
PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def apply_expenses() -> None:
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.get(code="PAR3")
    accountant = User.objects.get(email="accounts@rangon.test")
    drawer = Account.objects.get(name="Counter Cash Drawer")
    bank = Account.objects.get(name="City Bank Current")
    supplies = ExpenseCategory.objects.get(code="SUPPLIES")
    transport = ExpenseCategory.objects.get(code="TRANSPORT")

    retired = finance.create_expense_category(
        name=EXPENSES_MARKER, description="No longer used", actor=accountant
    )
    finance.record_expense(
        branch=home,
        category=retired,
        account=drawer,
        amount=Decimal("40.00"),
        note="Filed before the category was retired",
        actor=accountant,
    )
    finance.update_expense_category(category=retired, actor=accountant, is_active=False)

    finance.record_expense(
        branch=home,
        category=supplies,
        account=drawer,
        amount=Decimal("325.50"),
        note="Parity receipt: printer paper",
        attachment=ContentFile(PIXEL, name="receipt from the shop.PNG"),
        actor=accountant,
        idempotency_key="parity-expense-keyed",
    )
    finance.record_expense(
        branch=home,
        category=transport,
        account=bank,
        amount=Decimal("1200.00"),
        spent_at=timezone.now() - timedelta(days=35),
        note="Parity dated: courier contract",
        actor=accountant,
    )
    mistaken = finance.record_expense(
        branch=home,
        category=supplies,
        account=drawer,
        amount=Decimal("75.00"),
        note="Parity voided: entered twice",
        actor=accountant,
    )
    finance.void_expense(expense=mistaken, reason="Entered twice", actor=accountant)
    finance.record_expense(
        branch=mirpur,
        category=transport,
        account=Account.objects.get(name="Parity Mirpur Till"),
        amount=Decimal("60.00"),
        note="Parity mirpur: rickshaw",
        actor=User.objects.get(email="parity.mirpur@rangon.test"),
    )
    print("parity expenses fixture applied")


if ExpenseCategory.objects.filter(name=EXPENSES_MARKER).exists():
    print("parity expenses fixture already applied")
else:
    with transaction.atomic():
        apply_expenses()
