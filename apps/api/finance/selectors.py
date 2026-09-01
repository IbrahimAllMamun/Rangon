"""Read queries over the finance tables, used by more than one caller.

Nothing here mutates.  Anything that changes a balance belongs in
finance.services.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from django.db.models import Count, F, Q, QuerySet, Sum
from django.utils import timezone

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


# --------------------------------------------------------------------------- party ledger


#: Ageing buckets, in days.  The last one is open-ended.
AGEING_BUCKETS: tuple[tuple[str, int, int | None], ...] = (
    ("current", 0, 30),
    ("d31_60", 31, 60),
    ("d61_90", 61, 90),
    ("over_90", 91, None),
)


def _bucket_for(days: int) -> str:
    for name, start, end in AGEING_BUCKETS:
        if days >= start and (end is None or days <= end):
            return name
    return AGEING_BUCKETS[0][0]


def _empty_ageing() -> dict[str, Decimal]:
    return {name: ZERO for name, _, _ in AGEING_BUCKETS}


def _ageing_days(*, since: datetime, now: datetime) -> int:
    """Whole days from `since` to `now`, counted on the calendar.

    Ageing is a business figure, not a stopwatch reading.  An invoice that fell
    due yesterday evening is one day overdue this morning, and the same report
    run twice in one afternoon must give the same number both times -- so the
    count ticks at local midnight, in the shop's own timezone, not at each
    document's time of day.  This is the same lesson as D42: a day boundary
    means the *local* day boundary.

    It also removes a real source of flake.  The obvious spelling,
    `(now - due).days`, floors towards negative infinity, so it turns any
    backward clock step -- however small -- into a whole missing day.  The
    container clock here does step backwards (roadmap D46 records the
    measurement), which made
    `test_ageing_runs_from_the_due_date_not_the_order_date` report 9 days
    overdue instead of 10 in a full-suite run.  Counting dates rather than
    flooring an elapsed interval cannot lose a day to sub-second skew.
    """
    return (timezone.localdate(now) - timezone.localdate(since)).days


def receivables(*, branch: Branch | None = None, as_of: Any = None) -> dict[str, Any]:
    """What customers still owe, derived rather than stored.

    Phase 37.  There is deliberately **no balance column on `Customer`**: a
    stored balance is a second source of truth that drifts from the orders it
    claims to summarise, and this codebase already learned that lesson with
    inventory (CLAUDE.md §3.2).  The figure is the sum of what each order was
    charged minus what has been paid against it, every time it is asked for.

    The common case today is COD: goods delivered, cash not yet collected.  If
    the owner ever answers D-A ("do we sell on credit?") with yes, this needs no
    change -- a credit sale is already an order with a balance.

    An order is only a receivable once it is real trade: PENDING baskets and
    CANCELLED orders are excluded, and a refunded balance is not money owed.
    """
    from orders.models import Order, OrderStatus

    now = as_of or timezone.now()
    queryset = (
        Order.objects.filter(grand_total__gt=F("paid_total"))
        .exclude(status__in=[OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.REFUNDED])
        .select_related("customer", "branch")
    )
    if branch is not None:
        queryset = queryset.filter(branch=branch)

    parties: dict[str, dict[str, Any]] = {}
    total = ZERO
    ageing = _empty_ageing()

    for order in queryset.order_by("placed_at"):
        outstanding = quantize(order.grand_total - order.paid_total)
        if outstanding <= ZERO:
            continue
        placed = order.placed_at or order.created_at
        days = max(_ageing_days(since=placed, now=now), 0)
        bucket = _bucket_for(days)

        # `Order.customer` is NOT NULL -- a POS walk-in gets a real customer
        # row (`pos.walk_in_customer`), so there is no anonymous case to handle.
        customer = order.customer
        party = parties.setdefault(
            str(customer.pk),
            {
                "party_id": str(customer.pk),
                "name": customer.name or "Unnamed customer",
                "phone": customer.phone or "",
                "outstanding": ZERO,
                "document_count": 0,
                "oldest_days": 0,
                "ageing": _empty_ageing(),
                "documents": [],
            },
        )
        party["outstanding"] = quantize(party["outstanding"] + outstanding)
        party["document_count"] += 1
        party["oldest_days"] = max(party["oldest_days"], days)
        party["ageing"][bucket] = quantize(party["ageing"][bucket] + outstanding)
        party["documents"].append(
            {
                "id": str(order.pk),
                "number": order.number,
                "dated": placed,
                "days": days,
                "channel": order.channel,
                "status": order.status,
                "total": quantize(order.grand_total),
                "paid": quantize(order.paid_total),
                "outstanding": outstanding,
            }
        )

        total = quantize(total + outstanding)
        ageing[bucket] = quantize(ageing[bucket] + outstanding)

    rows = sorted(parties.values(), key=lambda row: row["outstanding"], reverse=True)
    return {
        "total": total,
        "party_count": len(rows),
        "document_count": sum(row["document_count"] for row in rows),
        "ageing": ageing,
        "parties": rows,
    }


def payables(*, branch: Branch | None = None, as_of: Any = None) -> dict[str, Any]:
    """What the business still owes suppliers, derived the same way.

    Ageing runs from the **due date**, not the order date: a supplier on 30-day
    terms is not overdue on day one, and treating it as overdue would make every
    open purchase look like a late payment.  `Supplier.payment_terms_days`
    already carries the terms; 0 means due on receipt.

    A DRAFT purchase order is not a liability -- nothing has been committed to
    the supplier yet -- and a CANCELLED one never will be.
    """
    from purchasing.models import PurchaseOrder, PurchaseOrderStatus

    now = as_of or timezone.now()
    queryset = (
        PurchaseOrder.objects.filter(grand_total__gt=F("paid_total"))
        .exclude(status__in=[PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.CANCELLED])
        .select_related("supplier", "branch")
    )
    if branch is not None:
        queryset = queryset.filter(branch=branch)

    parties: dict[str, dict[str, Any]] = {}
    total = ZERO
    ageing = _empty_ageing()

    for purchase in queryset.order_by("ordered_at"):
        outstanding = quantize(purchase.grand_total - purchase.paid_total)
        if outstanding <= ZERO:
            continue
        supplier = purchase.supplier
        raised = purchase.completed_at or purchase.ordered_at or purchase.created_at
        due = raised + timedelta(days=int(supplier.payment_terms_days or 0))
        days_overdue = max(_ageing_days(since=due, now=now), 0)
        bucket = _bucket_for(days_overdue)

        party = parties.setdefault(
            str(supplier.pk),
            {
                "party_id": str(supplier.pk),
                "name": supplier.name,
                "phone": supplier.phone,
                "outstanding": ZERO,
                "document_count": 0,
                "oldest_days": 0,
                "ageing": _empty_ageing(),
                "documents": [],
            },
        )
        party["outstanding"] = quantize(party["outstanding"] + outstanding)
        party["document_count"] += 1
        party["oldest_days"] = max(party["oldest_days"], days_overdue)
        party["ageing"][bucket] = quantize(party["ageing"][bucket] + outstanding)
        party["documents"].append(
            {
                "id": str(purchase.pk),
                "number": purchase.number,
                "dated": raised,
                "due": due,
                "days": days_overdue,
                "status": purchase.status,
                "invoice_number": purchase.invoice_number,
                "total": quantize(purchase.grand_total),
                "paid": quantize(purchase.paid_total),
                "outstanding": outstanding,
            }
        )

        total = quantize(total + outstanding)
        ageing[bucket] = quantize(ageing[bucket] + outstanding)

    rows = sorted(parties.values(), key=lambda row: row["outstanding"], reverse=True)
    return {
        "total": total,
        "party_count": len(rows),
        "document_count": sum(row["document_count"] for row in rows),
        "ageing": ageing,
        "parties": rows,
    }


def party_ledger(*, branch: Branch | None = None, as_of: Any = None) -> dict[str, Any]:
    """Both sides at once, plus the net position between them."""
    receivable = receivables(branch=branch, as_of=as_of)
    payable = payables(branch=branch, as_of=as_of)
    return {
        "receivable": receivable,
        "payable": payable,
        # Positive: more is owed to the business than by it.
        "net_position": quantize(receivable["total"] - payable["total"]),
    }
