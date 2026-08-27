"""Read queries over the finance tables, used by more than one caller.

Nothing here mutates.  Anything that changes a balance belongs in
finance.services.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db.models import Count, Q, QuerySet, Sum

from accounts.models import Branch
from core.money import ZERO, quantize
from finance.models import (
    Account,
    AccountTransaction,
    AccountTransactionType,
    Expense,
    ExpenseStatus,
)


def active_accounts(*, branch: Branch | None = None) -> QuerySet[Account]:
    queryset = Account.objects.filter(is_active=True).select_related("branch")
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    return queryset.order_by("branch__name", "kind", "name")


def cash_position(*, branch: Branch | None = None) -> dict[str, Any]:
    """What the business is holding right now, split by kind.

    The dashboard tile and the phase 38 business report both read this, which
    is why it lives here rather than in either of them.
    """
    accounts = active_accounts(branch=branch)
    totals = accounts.aggregate(total=Sum("balance"))
    by_kind = list(
        accounts.values("kind").annotate(total=Sum("balance")).order_by("kind"),
    )
    return {
        "total": quantize(totals["total"] or ZERO),
        "by_kind": [
            {"kind": row["kind"], "total": quantize(row["total"] or ZERO)} for row in by_kind
        ],
        "accounts": [
            {
                "id": str(account.pk),
                "name": account.name,
                "kind": account.kind,
                "branch": account.branch.code,
                "balance": quantize(account.balance),
            }
            for account in accounts
        ],
    }


def ledger(
    *,
    account: Any = None,
    branch: Branch | None = None,
    date_from: Any = None,
    date_to: Any = None,
    transaction_type: str | None = None,
) -> QuerySet[AccountTransaction]:
    """The cash book, filtered the way the admin screen filters it."""
    queryset = AccountTransaction.objects.select_related("account", "account__branch", "created_by")
    if account is not None:
        queryset = queryset.filter(account_id=getattr(account, "pk", account))
    if branch is not None:
        queryset = queryset.filter(account__branch=branch)
    if date_from is not None:
        queryset = queryset.filter(occurred_at__gte=date_from)
    if date_to is not None:
        queryset = queryset.filter(occurred_at__lte=date_to)
    if transaction_type:
        queryset = queryset.filter(transaction_type=transaction_type)
    return queryset.order_by("-occurred_at", "-created_at")


def movement_totals(
    *,
    branch: Branch | None = None,
    date_from: Any = None,
    date_to: Any = None,
) -> dict[str, Decimal]:
    """Money in, money out and the net for a period.

    Transfers are excluded from both sides on purpose: moving cash from the
    drawer to the bank is not income and not spending, and counting it would
    inflate both figures by the same amount.
    """
    queryset = ledger(branch=branch, date_from=date_from, date_to=date_to).exclude(
        transaction_type__in=[
            AccountTransactionType.TRANSFER_IN,
            AccountTransactionType.TRANSFER_OUT,
            AccountTransactionType.OPENING,
        ]
    )
    totals = queryset.aggregate(
        money_in=Sum("amount", filter=Q(amount__gt=0)),
        money_out=Sum("amount", filter=Q(amount__lt=0)),
    )
    money_in = quantize(totals["money_in"] or ZERO)
    money_out = quantize(abs(totals["money_out"] or ZERO))
    return {
        "money_in": money_in,
        "money_out": money_out,
        "net": quantize(money_in - money_out),
    }


def expenses(
    *,
    branch: Branch | None = None,
    category: Any = None,
    account: Any = None,
    date_from: Any = None,
    date_to: Any = None,
    include_void: bool = False,
) -> QuerySet[Expense]:
    """Expenses the way the admin screen filters them.

    Voided rows are excluded by default: they are history worth keeping, but
    counting one in a total would overstate what the shop actually spent.
    """
    queryset = Expense.objects.select_related("branch", "category", "account", "created_by")
    if not include_void:
        queryset = queryset.filter(status=ExpenseStatus.RECORDED)
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    if category is not None:
        queryset = queryset.filter(category_id=getattr(category, "pk", category))
    if account is not None:
        queryset = queryset.filter(account_id=getattr(account, "pk", account))
    if date_from is not None:
        queryset = queryset.filter(spent_at__gte=date_from)
    if date_to is not None:
        queryset = queryset.filter(spent_at__lte=date_to)
    return queryset.order_by("-spent_at", "-created_at")


def expense_totals(
    *,
    branch: Branch | None = None,
    date_from: Any = None,
    date_to: Any = None,
) -> dict[str, Any]:
    """Total spent in a period, and the same figure split by category.

    This is the shape the expenses screen renders and the shape phase 38's
    net-profit report will subtract, which is why it lives here rather than in
    either of them.
    """
    queryset = expenses(branch=branch, date_from=date_from, date_to=date_to)
    total = quantize(queryset.aggregate(total=Sum("amount"))["total"] or ZERO)
    rows = (
        queryset.values("category_id", "category__name", "category__code")
        .annotate(total=Sum("amount"), count=Count("id"))
        .order_by("-total")
    )
    return {
        "total": total,
        "count": queryset.count(),
        "by_category": [
            {
                "category_id": str(row["category_id"]),
                "category": row["category__name"],
                "code": row["category__code"],
                "total": quantize(row["total"] or ZERO),
                "count": row["count"],
                # A share makes the list readable at a glance; it is derived
                # here so the screen and the report cannot compute it
                # differently.
                "share": (
                    quantize(Decimal(row["total"] or ZERO) / total * 100) if total > ZERO else ZERO
                ),
            }
            for row in rows
        ],
    }
