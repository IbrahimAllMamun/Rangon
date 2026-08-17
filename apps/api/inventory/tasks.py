"""Inventory background jobs."""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger("rangon.inventory")


@shared_task
def notify_low_stock(inventory_id: str) -> str:
    from inventory.models import Inventory
    from notifications import services as notification_services

    inventory = (
        Inventory.objects.select_related("variant", "variant__product", "branch")
        .filter(pk=inventory_id)
        .first()
    )
    if inventory is None or not inventory.is_low_stock:
        return "skipped"

    out_of_stock = inventory.available <= 0
    notification_services.notify_staff(
        notification_type="OUT_OF_STOCK" if out_of_stock else "LOW_STOCK",
        title=(
            f"{'Out of stock' if out_of_stock else 'Low stock'}: "
            f"{inventory.variant.product.name} {inventory.variant.label}"
        ),
        body=(
            f"{inventory.variant.sku} at {inventory.branch.code}: "
            f"{inventory.available} available (reorder point {inventory.reorder_point})."
        ),
        permission_code="inventory.view",
        branch=inventory.branch,
        level="ERROR" if out_of_stock else "WARNING",
        link="/admin/inventory?filter=low-stock",
        data={"variant_id": str(inventory.variant_id), "available": inventory.available},
    )
    return "notified"


@shared_task
def verify_inventory_integrity() -> str:
    """Nightly ledger-vs-cache check.  Reports; never silently rewrites data."""
    from inventory import services
    from notifications import services as notification_services

    issues = services.verify_integrity()
    if not issues:
        return "clean"

    logger.error("Inventory integrity drift on %s position(s)", len(issues))
    notification_services.notify_staff(
        notification_type="INTEGRITY_ALERT",
        title=f"Inventory integrity: {len(issues)} position(s) drifted",
        body="\n".join(
            f"{issue.sku} @ {issue.branch_code}: cached {issue.cached_on_hand} vs "
            f"ledger {issue.ledger_on_hand}"
            for issue in issues[:20]
        ),
        permission_code="inventory.adjust",
        level="ERROR",
        link="/admin/inventory?filter=integrity",
    )
    return f"drift:{len(issues)}"


@shared_task
def send_low_stock_digest() -> str:
    from django.db.models import F

    from inventory.models import Inventory
    from notifications import services as notification_services

    low = (
        Inventory.objects.select_related("variant", "variant__product", "branch")
        .filter(on_hand__lte=F("reorder_point"))
        .order_by("branch", "on_hand")[:100]
    )
    if not low:
        return "none"

    notification_services.notify_staff(
        notification_type="LOW_STOCK",
        title=f"{len(low)} product(s) need reordering",
        body="\n".join(
            f"{row.variant.sku} — {row.variant.product.name}: {row.available} left"
            for row in low[:30]
        ),
        permission_code="purchases.create",
        level="WARNING",
        link="/admin/inventory?filter=low-stock",
        email=True,
    )
    return f"digest:{len(low)}"
