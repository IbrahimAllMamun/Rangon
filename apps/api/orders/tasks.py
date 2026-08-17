"""Order background jobs.

These clean up *after* the fact.  Order creation, payment and stock movement all
complete synchronously — a dead worker must never lose a sale.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger("rangon.orders")


@shared_task
def release_expired_reservations() -> str:
    """Cancel unpaid online orders past the reservation window and free the stock.

    COD orders are exempt: they are CONFIRMED at creation and are not waiting
    for a payment (docs/business-rules.md §1.5).
    """
    from orders.models import Channel, Order, OrderStatus, PaymentMethod
    from orders.services.lifecycle import transition

    cutoff = timezone.now() - timedelta(minutes=int(settings.RANGON["RESERVATION_MINUTES"]))
    expired = (
        Order.objects.filter(
            channel=Channel.ONLINE,
            status=OrderStatus.PENDING,
            placed_at__lt=cutoff,
            stock_committed=False,
        )
        .exclude(payments__method=PaymentMethod.COD)
        .distinct()
    )

    released = 0
    for order in expired:
        try:
            transition(
                order=order,
                to_status=OrderStatus.CANCELLED,
                reason="PAYMENT_TIMEOUT: reservation expired",
                notify=False,
            )
            released += 1
        except Exception:  # one bad order must not stop the sweep
            logger.exception("Could not release reservation for order %s", order.number)

    return f"released:{released}"


@shared_task
def expire_abandoned_carts(days: int = 30) -> str:
    from orders.models import Cart

    cutoff = timezone.now() - timedelta(days=days)
    updated = Cart.objects.filter(is_active=True, last_activity_at__lt=cutoff).update(
        is_active=False
    )
    return f"expired:{updated}"
