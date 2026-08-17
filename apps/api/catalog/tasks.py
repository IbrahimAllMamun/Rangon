"""Catalog background jobs."""

from __future__ import annotations

from datetime import timedelta

from celery import shared_task
from django.db.models import F
from django.utils import timezone


@shared_task
def check_expiring_stock(days: int = 60) -> str:
    """Warn about cosmetics (or anything else) approaching its expiry date."""
    from inventory.models import Inventory
    from notifications import services as notification_services

    horizon = timezone.now().date() + timedelta(days=days)
    rows = (
        Inventory.objects.select_related("variant", "variant__product", "branch")
        .filter(
            variant__expiry_date__isnull=False,
            variant__expiry_date__lte=horizon,
            on_hand__gt=F("reserved"),
        )
        .order_by("variant__expiry_date")[:100]
    )
    if not rows:
        return "none"

    notification_services.notify_staff(
        notification_type="STOCK_EXPIRING",
        title=f"{len(rows)} stocked item(s) expire within {days} days",
        body="\n".join(
            f"{row.variant.sku} — {row.variant.product.name}: "
            f"{row.available} units, expires {row.variant.expiry_date}"
            for row in rows[:30]
        ),
        permission_code="inventory.view",
        level="WARNING",
        link="/admin/inventory?filter=expiring",
    )
    return f"expiring:{len(rows)}"
