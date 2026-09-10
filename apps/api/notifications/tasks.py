"""Notification delivery jobs.

No financial or stock invariant depends on these completing (CLAUDE.md §4).
"""

from __future__ import annotations

import logging

from celery import shared_task
from django.conf import settings
from django.core.mail import send_mail
from django.utils import timezone

logger = logging.getLogger("rangon.notifications")


def _tracking_url(order) -> str:
    """The customer-facing link to an order.

    This used to read `settings.RANGON.get("SITE_URL", "")`, and there has
    never been a `SITE_URL` key -- so every order email went out advertising
    `/order/RGN-000123` with no origin in front of it, which is not a link at
    all. The key is `PUBLIC_URL`, the same one the product feed absolutises
    against. Blank origin still yields a blank link rather than a broken one.
    """
    base = str(settings.RANGON.get("PUBLIC_URL", "")).rstrip("/")
    return f"{base}/order/{order.number}" if base else ""


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def send_notification_email(self, notification_id: str) -> str:
    from notifications.models import Notification

    notification = Notification.objects.filter(pk=notification_id).select_related("user").first()
    if notification is None or notification.user is None or not notification.user.email:
        return "skipped"

    try:
        send_mail(
            subject=f"[Rangon] {notification.title}",
            message=notification.body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[notification.user.email],
            fail_silently=False,
        )
    except Exception as exc:  # pragma: no cover - depends on the mail server
        logger.warning("Notification email failed: %s", exc)
        raise self.retry(exc=exc) from exc

    Notification.objects.filter(pk=notification_id).update(emailed_at=timezone.now())
    return "sent"


@shared_task(bind=True, max_retries=3, default_retry_delay=120)
def send_order_email(self, order_id: str, notification_type: str) -> str:
    from orders.models import Order

    order = Order.objects.filter(pk=order_id).select_related("customer").first()
    if order is None:
        return "missing"
    recipient = order.customer.email
    if not recipient:
        return "no-email"

    subjects = {
        "ORDER_CONFIRMED": f"We have your order {order.number}",
        "ORDER_SHIPPED": f"Order {order.number} is on its way",
        "ORDER_DELIVERED": f"Order {order.number} has been delivered",
        "REFUND_COMPLETED": f"Refund issued for order {order.number}",
    }
    subject = subjects.get(notification_type, f"Update on order {order.number}")
    body = (
        f"Hello {order.customer.name},\n\n{subject}.\n\n"
        f"Order: {order.number}\nTotal: {order.currency} {order.grand_total}\n"
        f"Status: {order.get_status_display()}\n\n"
        f"Track it: {_tracking_url(order)}\n\n"
        "Rangon Fashion"
    )

    try:
        send_mail(
            subject=f"[Rangon Fashion] {subject}",
            message=body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient],
            fail_silently=False,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Order email failed: %s", exc)
        raise self.retry(exc=exc) from exc
    return "sent"


@shared_task(bind=True, max_retries=3, default_retry_delay=120)
def send_order_sms(self, order_id: str, notification_type: str) -> str:
    """Text the customer about their order.

    Deliberately mirrors `send_order_email`: same signature, same retry policy,
    same "return a word saying what happened" contract. A shop reading the
    Celery log should not have to learn two vocabularies.

    A refused message is NOT retried -- `send_sms` has already recorded why,
    and re-sending a message the gateway rejected just spends the money again.
    Only an exception reaching this far (a network fault, a gateway 500) is
    worth another attempt.
    """
    from notifications import sms
    from orders.models import Order

    order = Order.objects.filter(pk=order_id).select_related("customer").first()
    if order is None:
        return "missing"

    number = getattr(order.customer, "phone", "")
    if not number:
        return "no-phone"

    body = sms.body_for(order, notification_type)
    if not body:
        return "no-template"

    try:
        message = sms.send_sms(
            to=number,
            body=body,
            notification_type=notification_type,
            order_number=order.number,
        )
    except Exception as exc:  # pragma: no cover - depends on the gateway
        logger.warning("Order SMS failed: %s", exc)
        raise self.retry(exc=exc) from exc

    return message.status.lower()
