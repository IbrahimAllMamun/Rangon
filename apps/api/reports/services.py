"""Reporting.

Everything aggregates in the database (docs/database/indexing.md).  Profit uses
the cost frozen on each order line, never today's cost (ADR-0006).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from django.db.models import (
    Case,
    Count,
    DecimalField,
    ExpressionWrapper,
    F,
    Q,
    Sum,
    Value,
    When,
)
from django.db.models.functions import Coalesce, TruncDate
from django.utils import timezone

from accounts.models import TaxMode
from core.dates import parse_moment
from core.money import ZERO, quantize
from inventory.models import Inventory, InventoryTransaction
from orders.models import (
    Channel,
    Order,
    OrderItem,
    OrderStatus,
    Payment,
    PaymentState,
    RestockDecision,
    ReturnItem,
    ReturnRequest,
    ReturnStatus,
)
from purchasing.models import PurchaseOrder

MONEY = DecimalField(max_digits=18, decimal_places=2)

#: Revenue from one order line, with VAT taken out when it is sitting inside
#: the price.  `line_total` is what the customer was charged for the goods; under
#: INCLUSIVE pricing that figure contains the tax, so counting it as revenue
#: overstates both turnover and margin by exactly the VAT.  Each line carries its
#: own allocated `tax_amount`, and the order carries the mode it was priced under,
#: so the correction is per-line and reads the frozen values rather than today's
#: setting (docs/business-rules.md §3.4).
NET_LINE_REVENUE = Case(
    When(
        order__tax_mode=TaxMode.INCLUSIVE,
        then=ExpressionWrapper(F("line_total") - F("tax_amount"), output_field=MONEY),
    ),
    default=F("line_total"),
    output_field=MONEY,
)

#: Orders that represent real trade.  Cancelled orders are excluded everywhere.
SOLD_STATUSES = [
    OrderStatus.CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.PACKED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.RETURN_REQUESTED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
]


@dataclass(frozen=True)
class DateRange:
    start: datetime
    end: datetime
    label: str = ""

    #: The presets the admin offers, in the order it offers them.
    #:
    #: Every one is anchored to a **local** calendar day.  The shop's day starts
    #: at midnight in `TIME_ZONE`, and for Asia/Dhaka that is six hours away from
    #: midnight UTC -- so deriving these from a UTC `now()` put the start of
    #: "today" at 06:00 local, dropped the night's trade from it, and between
    #: midnight and 06:00 reported twenty hours of *yesterday* as today.
    #: `date_from`/`date_to` were always read in local time, so the two controls
    #: disagreed about where a day ends.
    PRESETS = ("today", "yesterday", "7d", "30d", "90d", "month", "last_month", "year")
    DEFAULT_PRESET = "30d"

    #: Rolling presets, as a count of calendar days **including today**.  Whole
    #: days rather than a rolling N*24 hours, because `sales_over_time` buckets
    #: by `TruncDate`: a rolling window puts a part-day at each end, so "7 days"
    #: drew eight bars, two of them short for no reason a reader could see.
    _DAY_COUNTS = {"7d": 7, "30d": 30, "90d": 90}

    @classmethod
    def from_params(cls, params: Any) -> DateRange:
        now = timezone.now()
        start_param, end_param = params.get("date_from"), params.get("date_to")

        if start_param or end_param:
            # `core.dates.parse_moment` rather than a second parser here: it
            # takes a whole day *or* an exact timestamp, and it raises on
            # anything unreadable instead of returning None. The local version
            # took only `YYYY-MM-DD` and fell through to the default window on
            # everything else -- so a timestamp, or a typo, silently showed
            # thirty days and called it the answer. `core/dates.py` exists so a
            # screen and its CSV export cannot disagree about where a period
            # starts; reports were the one caller not using it.
            start = parse_moment(start_param) or (now - timedelta(days=30))
            end = parse_moment(end_param, end_of_day=True) or now
            return cls(start, end, "custom")

        preset = params.get("range") or cls.DEFAULT_PRESET
        # An unknown preset falls back, and says so.  Echoing the caller's
        # spelling back labelled a 30-day window with whatever was typed.
        if preset not in cls.PRESETS:
            preset = cls.DEFAULT_PRESET
        start, end = cls.preset_bounds(preset, now=now)
        return cls(start, end, preset)

    @classmethod
    def preset_bounds(
        cls, preset: str, *, now: datetime | None = None
    ) -> tuple[datetime, datetime]:
        """Resolve a preset to (start, end), both aware, both on local days."""
        now = now or timezone.now()
        today = timezone.localdate(now)

        if preset == "today":
            return _day_start(today), now
        if preset == "yesterday":
            # Ends on yesterday, not at midnight today: every report filters
            # with `__lte`, so a next-midnight end counted an order placed at
            # exactly 00:00:00 in both "yesterday" and "today".
            return _day_start(today - timedelta(days=1)), _day_end(today - timedelta(days=1))
        if preset == "month":
            return _day_start(today.replace(day=1)), now
        if preset == "last_month":
            this_month = today.replace(day=1)
            last_day = this_month - timedelta(days=1)
            # The whole of the previous calendar month -- the figure an owner
            # compares against, and the one a rolling "30 days" never gives
            # them.  Ends on its last day (see "yesterday" above).
            return _day_start(last_day.replace(day=1)), _day_end(last_day)
        if preset == "year":
            return _day_start(today.replace(month=1, day=1)), now
        days = cls._DAY_COUNTS[preset]
        return _day_start(today - timedelta(days=days - 1)), now


def _day_start(day: date) -> datetime:
    """Midnight at the start of `day`, in the shop's timezone."""
    return timezone.make_aware(
        datetime.combine(day, datetime.min.time()), timezone.get_current_timezone()
    )


def _day_end(day: date) -> datetime:
    """The last instant of `day`, in the shop's timezone."""
    return timezone.make_aware(
        datetime.combine(day, datetime.max.time()), timezone.get_current_timezone()
    )


#: A zero-filled series is capped here so a wide custom range cannot return a
#: row per day for years.  Beyond it the caller gets only the days that traded,
#: which is the old behaviour and acceptable at that zoom.
_MAX_FILLED_DAYS = 370


def _fill_missing_days(rows: list[dict], date_range: DateRange) -> list[dict]:
    """Put a zero row on every day of the window that saw no sales.

    The chart plots exactly the rows it is given, so a day with no orders used
    to be absent from the axis rather than flat on it: a quiet week drew as a
    straight line between the two days either side of it, and "7 days" drew six
    bars.  Filling here rather than in the component keeps the CSV export, the
    chart and anything else reading this endpoint telling the same story
    (CLAUDE.md §4 -- the backend owns the shape of the answer).
    """
    first, last = timezone.localdate(date_range.start), timezone.localdate(date_range.end)
    if last < first or (last - first).days + 1 > _MAX_FILLED_DAYS:
        return rows

    traded = {row["day"]: row for row in rows}
    filled = []
    day = first
    while day <= last:
        filled.append(
            traded.get(day)
            or {"day": day, "orders": 0, "revenue": ZERO, "pos": ZERO, "online": ZERO}
        )
        day += timedelta(days=1)
    return filled


def sold_orders(date_range: DateRange, *, branch: Any = None, channel: str = "") -> Any:
    queryset = Order.objects.filter(
        status__in=SOLD_STATUSES,
        placed_at__gte=date_range.start,
        placed_at__lte=date_range.end,
    )
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    if channel:
        queryset = queryset.filter(channel=channel)
    return queryset


def dashboard(*, date_range: DateRange, branch: Any = None) -> dict[str, Any]:
    orders = sold_orders(date_range, branch=branch)

    totals = orders.aggregate(
        order_count=Count("id"),
        revenue=Coalesce(Sum("grand_total"), Value(ZERO), output_field=MONEY),
        discount=Coalesce(Sum("discount_total"), Value(ZERO), output_field=MONEY),
        refunded=Coalesce(Sum("refunded_total"), Value(ZERO), output_field=MONEY),
    )

    items = OrderItem.objects.filter(order__in=orders).aggregate(
        units=Coalesce(Sum("quantity"), Value(0)),
        cogs=Coalesce(
            Sum(ExpressionWrapper(F("unit_cost") * F("quantity"), output_field=MONEY)),
            Value(ZERO),
            output_field=MONEY,
        ),
        net_sales=Coalesce(Sum(NET_LINE_REVENUE), Value(ZERO), output_field=MONEY),
        tax=Coalesce(Sum("tax_amount"), Value(ZERO), output_field=MONEY),
    )

    gross_profit = quantize(items["net_sales"] - items["cogs"])
    margin = quantize(gross_profit / items["net_sales"] * 100) if items["net_sales"] else ZERO

    by_channel = list(
        orders.values("channel")
        .annotate(
            orders=Count("id"),
            revenue=Coalesce(Sum("grand_total"), Value(ZERO), output_field=MONEY),
        )
        .order_by("-revenue")
    )

    daily = list(
        orders.annotate(day=TruncDate("placed_at"))
        .values("day")
        .annotate(
            orders=Count("id"),
            revenue=Coalesce(Sum("grand_total"), Value(ZERO), output_field=MONEY),
            pos=Coalesce(
                Sum("grand_total", filter=Q(channel=Channel.POS)), Value(ZERO), output_field=MONEY
            ),
            online=Coalesce(
                Sum("grand_total", filter=Q(channel=Channel.ONLINE)),
                Value(ZERO),
                output_field=MONEY,
            ),
        )
        .order_by("day")
    )
    daily = _fill_missing_days(daily, date_range)

    payments = list(
        Payment.objects.filter(
            order__in=orders, status__in=[PaymentState.CAPTURED, PaymentState.PARTIALLY_REFUNDED]
        )
        .values("method")
        .annotate(
            amount=Coalesce(Sum("amount"), Value(ZERO), output_field=MONEY), count=Count("id")
        )
        .order_by("-amount")
    )

    top_products = list(
        OrderItem.objects.filter(order__in=orders)
        .values("sku", "product_name")
        .annotate(
            units=Sum("quantity"),
            revenue=Coalesce(Sum(NET_LINE_REVENUE), Value(ZERO), output_field=MONEY),
        )
        .order_by("-units")[:10]
    )

    category_sales = list(
        OrderItem.objects.filter(order__in=orders)
        .values(category=F("variant__product__category__name"))
        .annotate(
            units=Sum("quantity"),
            revenue=Coalesce(Sum(NET_LINE_REVENUE), Value(ZERO), output_field=MONEY),
        )
        .order_by("-revenue")[:10]
    )

    inventory = Inventory.objects.all()
    if branch is not None:
        inventory = inventory.filter(branch=branch)
    stock = inventory.aggregate(
        value=Coalesce(
            Sum(ExpressionWrapper(F("on_hand") * F("average_cost"), output_field=MONEY)),
            Value(ZERO),
            output_field=MONEY,
        ),
        units=Coalesce(Sum("on_hand"), Value(0)),
    )

    returns = ReturnRequest.objects.filter(
        created_at__gte=date_range.start, created_at__lte=date_range.end
    )
    if branch is not None:
        returns = returns.filter(order__branch=branch)

    pending_online = Order.objects.filter(
        channel=Channel.ONLINE,
        status__in=[OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING],
    )
    if branch is not None:
        pending_online = pending_online.filter(branch=branch)

    return {
        "range": {"start": date_range.start, "end": date_range.end, "label": date_range.label},
        "kpis": {
            "revenue": totals["revenue"],
            "orders": totals["order_count"],
            "units_sold": items["units"],
            "gross_profit": gross_profit,
            "margin_percent": margin,
            "discount_total": totals["discount"],
            "refunded_total": totals["refunded"],
            "average_order_value": quantize(
                totals["revenue"] / totals["order_count"] if totals["order_count"] else ZERO
            ),
            "returns": returns.count(),
            "pending_online_orders": pending_online.count(),
            "low_stock_products": inventory.filter(on_hand__lte=F("reorder_point")).count(),
            "inventory_value": stock["value"],
            "inventory_units": stock["units"],
        },
        "sales_over_time": daily,
        "by_channel": by_channel,
        "payment_methods": payments,
        "top_products": top_products,
        "category_sales": category_sales,
    }


def sales_report(*, date_range: DateRange, branch: Any = None, channel: str = "") -> list[dict]:
    orders = sold_orders(date_range, branch=branch, channel=channel)
    return list(
        orders.values(
            "number",
            "placed_at",
            "channel",
            "status",
            "payment_status",
            "subtotal",
            "discount_total",
            "tax_total",
            "shipping_total",
            "grand_total",
        )
        .annotate(
            customer=F("customer__name"),
            branch_code=F("branch__code"),
        )
        .order_by("-placed_at")
    )


def product_performance(*, date_range: DateRange, branch: Any = None) -> list[dict]:
    orders = sold_orders(date_range, branch=branch)
    rows = list(
        OrderItem.objects.filter(order__in=orders)
        .values("sku", "product_name", "variant_label")
        .annotate(
            units=Sum("quantity"),
            revenue=Coalesce(Sum(NET_LINE_REVENUE), Value(ZERO), output_field=MONEY),
            cost=Coalesce(
                Sum(ExpressionWrapper(F("unit_cost") * F("quantity"), output_field=MONEY)),
                Value(ZERO),
                output_field=MONEY,
            ),
            returned=Coalesce(Sum("returned_quantity"), Value(0)),
        )
        .order_by("-revenue")
    )
    for row in rows:
        row["gross_profit"] = quantize(row["revenue"] - row["cost"])
        row["margin_percent"] = (
            quantize(row["gross_profit"] / row["revenue"] * 100) if row["revenue"] else ZERO
        )
    return rows


def inventory_report(*, branch: Any = None) -> list[dict]:
    queryset = Inventory.objects.select_related("branch", "variant", "variant__product")
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    return list(
        queryset.annotate(
            available_qty=F("on_hand") - F("reserved"),
            stock_value=ExpressionWrapper(F("on_hand") * F("average_cost"), output_field=MONEY),
            retail_value=ExpressionWrapper(F("on_hand") * F("variant__price"), output_field=MONEY),
        )
        .values(
            "variant__sku",
            "variant__product__name",
            "variant__product__category__name",
            "branch__code",
            "on_hand",
            "reserved",
            "available_qty",
            "average_cost",
            "stock_value",
            "retail_value",
            "reorder_point",
        )
        .order_by("variant__product__name")
    )


def purchase_report(*, date_range: DateRange, branch: Any = None) -> list[dict]:
    queryset = PurchaseOrder.objects.filter(
        created_at__gte=date_range.start, created_at__lte=date_range.end
    )
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    return list(
        queryset.values(
            "number", "status", "payment_status", "created_at", "grand_total", "paid_total"
        )
        .annotate(supplier=F("supplier__name"), outstanding=F("grand_total") - F("paid_total"))
        .order_by("-created_at")
    )


def returns_report(*, date_range: DateRange, branch: Any = None) -> list[dict]:
    queryset = ReturnRequest.objects.filter(
        created_at__gte=date_range.start, created_at__lte=date_range.end
    )
    if branch is not None:
        queryset = queryset.filter(order__branch=branch)
    return list(
        queryset.values("number", "reason", "status", "refund_amount", "created_at")
        .annotate(
            order_number=F("order__number"),
            channel=F("order__channel"),
            units=Coalesce(Sum("items__quantity"), Value(0)),
        )
        .order_by("-created_at")
    )


def profit_report(*, date_range: DateRange, branch: Any = None) -> dict[str, Any]:
    orders = sold_orders(date_range, branch=branch)
    daily = list(
        OrderItem.objects.filter(order__in=orders)
        .annotate(day=TruncDate("order__placed_at"))
        .values("day")
        .annotate(
            revenue=Coalesce(Sum(NET_LINE_REVENUE), Value(ZERO), output_field=MONEY),
            cost=Coalesce(
                Sum(ExpressionWrapper(F("unit_cost") * F("quantity"), output_field=MONEY)),
                Value(ZERO),
                output_field=MONEY,
            ),
        )
        .order_by("day")
    )
    for row in daily:
        row["gross_profit"] = quantize(row["revenue"] - row["cost"])

    totals = {
        "revenue": quantize(sum((row["revenue"] for row in daily), ZERO)),
        "cost": quantize(sum((row["cost"] for row in daily), ZERO)),
    }
    totals["gross_profit"] = quantize(totals["revenue"] - totals["cost"])
    totals["margin_percent"] = (
        quantize(totals["gross_profit"] / totals["revenue"] * 100) if totals["revenue"] else ZERO
    )
    return {"totals": totals, "daily": daily}


def inventory_movement(*, date_range: DateRange, branch: Any = None) -> list[dict]:
    queryset = InventoryTransaction.objects.filter(
        created_at__gte=date_range.start, created_at__lte=date_range.end
    )
    if branch is not None:
        queryset = queryset.filter(branch=branch)
    return list(
        queryset.values("transaction_type")
        .annotate(
            units=Sum("quantity"),
            entries=Count("id"),
            value=Coalesce(
                Sum(
                    ExpressionWrapper(
                        F("quantity") * Coalesce(F("unit_cost"), Value(ZERO, output_field=MONEY)),
                        output_field=MONEY,
                    )
                ),
                Value(ZERO),
                output_field=MONEY,
            ),
        )
        .order_by("transaction_type")
    )


def expense_report(*, date_range: DateRange, branch: Any = None) -> list[dict]:
    """Spending in a period, grouped by category.

    Thin on purpose: the grouping lives in ``finance.selectors.expense_totals``
    so the expenses screen, this report and (in phase 38) net profit cannot
    disagree about what the shop spent.  Voided expenses are excluded there.
    """
    from finance import selectors as finance_selectors

    totals = finance_selectors.expense_totals(
        branch=branch, date_from=date_range.start, date_to=date_range.end
    )
    return [
        {
            "category": row["category"],
            "code": row["code"],
            "expenses": row["count"],
            "total": row["total"],
            "share_percent": row["share"],
        }
        for row in totals["by_category"]
    ]


def business_summary(*, date_range: DateRange, branch: Any = None) -> dict[str, Any]:
    """Phase 38: what the business actually made in a period.

    The one report an owner manages by, and the first one that reaches all the
    way down to net profit rather than stopping at gross margin:

        revenue        goods sold, net of VAT
        less refunds   completed returns in the period
        less COGS      the cost frozen on each line (ADR-0006), minus the cost
                       of goods that came back to sellable stock
        = gross profit
        less expenses  finance.selectors.expense_totals, voids excluded
        = net profit

    Three deliberate choices, because each is a place a plausible-looking
    figure would be wrong:

    * **VAT is not revenue.**  Under inclusive pricing the tax sits inside the
      line total, so it is taken out per line before anything is summed.  It is
      reported separately: it is money held for the government, not turnover.
    * **Each event lands in the period it happened.**  Sales by `placed_at`,
      returns by `completed_at`, expenses by `spent_at`.  A refund in August of
      a July sale reduces August, which is what the cash and the ledger did.
    * **Only restocked goods give their cost back.**  A return marked DAMAGED
      is a write-off and its cost stays a cost; one marked QUARANTINE is not
      sellable yet, so it is treated the same way until it is.  Only RESTOCK
      recovers the cost, because only RESTOCK put the goods back on the shelf.
    """
    from finance import selectors as finance_selectors

    orders = sold_orders(date_range, branch=branch)
    lines = OrderItem.objects.filter(order__in=orders)

    sales = lines.aggregate(
        revenue=Coalesce(Sum(NET_LINE_REVENUE), Value(ZERO), output_field=MONEY),
        tax=Coalesce(Sum("tax_amount"), Value(ZERO), output_field=MONEY),
        cogs=Coalesce(
            Sum(ExpressionWrapper(F("unit_cost") * F("quantity"), output_field=MONEY)),
            Value(ZERO),
            output_field=MONEY,
        ),
        units=Coalesce(Sum("quantity"), Value(0)),
    )
    order_totals = orders.aggregate(
        count=Count("id"),
        shipping=Coalesce(Sum("shipping_total"), Value(ZERO), output_field=MONEY),
        discounts=Coalesce(Sum("discount_total"), Value(ZERO), output_field=MONEY),
    )

    completed_returns = ReturnRequest.objects.filter(
        status=ReturnStatus.COMPLETED,
        completed_at__gte=date_range.start,
        completed_at__lte=date_range.end,
    )
    if branch is not None:
        completed_returns = completed_returns.filter(order__branch=branch)

    refunds = quantize(
        completed_returns.aggregate(
            total=Coalesce(Sum("refund_amount"), Value(ZERO), output_field=MONEY)
        )["total"]
    )
    cogs_recovered = quantize(
        ReturnItem.objects.filter(
            return_request__in=completed_returns,
            restock_decision=RestockDecision.RESTOCK,
        ).aggregate(
            total=Coalesce(
                Sum(
                    ExpressionWrapper(
                        F("order_item__unit_cost") * F("quantity"), output_field=MONEY
                    )
                ),
                Value(ZERO),
                output_field=MONEY,
            )
        )["total"]
    )

    revenue = quantize(sales["revenue"])
    net_revenue = quantize(revenue - refunds)
    net_cogs = quantize(sales["cogs"] - cogs_recovered)
    gross_profit = quantize(net_revenue - net_cogs)

    expense_totals = finance_selectors.expense_totals(
        branch=branch, date_from=date_range.start, date_to=date_range.end
    )
    expenses_total = quantize(expense_totals["total"])
    net_profit = quantize(gross_profit - expenses_total)

    def _percent(part: Decimal, whole: Decimal) -> Decimal:
        return quantize(part / whole * 100) if whole else ZERO

    return {
        "period": {
            "start": date_range.start,
            "end": date_range.end,
            "label": date_range.label,
        },
        "revenue": {
            "goods": revenue,
            "refunds": refunds,
            "net": net_revenue,
            "shipping_charged": quantize(order_totals["shipping"]),
            "discounts_given": quantize(order_totals["discounts"]),
            # Held for the government, never income -- shown so the figure on
            # the VAT return and the figure here come from the same place.
            "vat_collected": quantize(sales["tax"]),
        },
        "cost_of_goods": {
            "sold": quantize(sales["cogs"]),
            "recovered_from_returns": cogs_recovered,
            "net": net_cogs,
        },
        "gross_profit": gross_profit,
        "gross_margin_percent": _percent(gross_profit, net_revenue),
        "expenses": {
            "total": expenses_total,
            "count": expense_totals["count"],
            "by_category": expense_totals["by_category"],
        },
        "net_profit": net_profit,
        "net_margin_percent": _percent(net_profit, net_revenue),
        "volume": {
            "orders": order_totals["count"],
            "units": sales["units"],
            "returns": completed_returns.count(),
            "average_order_value": (
                quantize(net_revenue / order_totals["count"]) if order_totals["count"] else ZERO
            ),
        },
    }
