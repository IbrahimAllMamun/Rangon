"""Reporting.

Everything aggregates in the database (docs/database/indexing.md).  Profit uses
the cost frozen on each order line, never today's cost (ADR-0006).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from django.db.models import (
    Count,
    DecimalField,
    ExpressionWrapper,
    F,
    Q,
    Sum,
    Value,
)
from django.db.models.functions import Coalesce, TruncDate
from django.utils import timezone

from core.money import ZERO, quantize
from inventory.models import Inventory, InventoryTransaction
from orders.models import (
    Channel,
    Order,
    OrderItem,
    OrderStatus,
    Payment,
    PaymentState,
    ReturnRequest,
)
from purchasing.models import PurchaseOrder

MONEY = DecimalField(max_digits=18, decimal_places=2)

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

    @classmethod
    def from_params(cls, params: Any) -> DateRange:
        now = timezone.now()
        preset = params.get("range", "30d")
        start_param, end_param = params.get("date_from"), params.get("date_to")

        if start_param or end_param:
            start = _parse_date(start_param) or (now - timedelta(days=30))
            end = _parse_date(end_param, end_of_day=True) or now
            return cls(start, end, "custom")

        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        presets = {
            "today": (today_start, now),
            "yesterday": (today_start - timedelta(days=1), today_start),
            "7d": (now - timedelta(days=7), now),
            "30d": (now - timedelta(days=30), now),
            "90d": (now - timedelta(days=90), now),
            "year": (now.replace(month=1, day=1, hour=0, minute=0, second=0), now),
        }
        start, end = presets.get(preset, presets["30d"])
        return cls(start, end, preset)


def _parse_date(value: str | None, *, end_of_day: bool = False) -> datetime | None:
    if not value:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    moment = datetime.combine(parsed, datetime.max.time() if end_of_day else datetime.min.time())
    return timezone.make_aware(moment, timezone.get_current_timezone())


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
        net_sales=Coalesce(Sum("line_total"), Value(ZERO), output_field=MONEY),
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
            revenue=Coalesce(Sum("line_total"), Value(ZERO), output_field=MONEY),
        )
        .order_by("-units")[:10]
    )

    category_sales = list(
        OrderItem.objects.filter(order__in=orders)
        .values(category=F("variant__product__category__name"))
        .annotate(
            units=Sum("quantity"),
            revenue=Coalesce(Sum("line_total"), Value(ZERO), output_field=MONEY),
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
            revenue=Coalesce(Sum("line_total"), Value(ZERO), output_field=MONEY),
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
            revenue=Coalesce(Sum("line_total"), Value(ZERO), output_field=MONEY),
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
