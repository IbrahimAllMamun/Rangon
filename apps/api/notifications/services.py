"""Notification dispatch.

In-app rows are written synchronously (cheap); email goes out through Celery so
a slow SMTP server can never delay a sale.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from accounts.models import RoleCode, User
from notifications.models import Notification, NotificationLevel


def _recipients(permission_code: str, branch: Any = None) -> list[User]:
    """Everyone who holds the code (OWNER always does), optionally at a branch."""
    users = User.objects.filter(is_active=True).select_related("role")
    if branch is not None:
        users = users.filter(branch=branch) | users.filter(
            role__code__in=[RoleCode.OWNER, RoleCode.ADMIN]
        )
    return [
        user
        for user in users.distinct()
        if not user.is_customer and user.has_perm_code(permission_code)
    ]


def notify_staff(
    *,
    notification_type: str,
    title: str,
    body: str = "",
    permission_code: str = "orders.view",
    branch: Any = None,
    link: str = "",
    level: str = NotificationLevel.INFO,
    data: dict[str, Any] | None = None,
    email: bool = False,
) -> list[Notification]:
    notifications = [
        Notification(
            user=user,
            permission_code=permission_code,
            branch=branch,
            notification_type=notification_type,
            level=level,
            title=title[:160],
            body=body,
            link=link,
            data=data or {},
        )
        for user in _recipients(permission_code, branch)
    ]
    created = Notification.objects.bulk_create(notifications)

    if email and created:
        from notifications.tasks import send_notification_email

        for notification in created:
            transaction.on_commit(lambda pk=str(notification.pk): send_notification_email.delay(pk))
    return created


def notify_customer(
    *,
    order: Any,
    notification_type: str,
    title: str,
    body: str = "",
    email: bool = True,
    sms: bool = True,
) -> Notification | None:
    """Tell the customer behind an order what has happened.

    All three channels are best-effort and none of them can fail the order:
    the in-app row is written here because it is a local insert, and email and
    SMS go out through Celery `on_commit` (CLAUDE.md §4).

    SMS is on by default and costs money, so the guard is in the templates
    rather than at the call site: `sms.body_for` returns nothing for a type it
    has no template for, and the task stops there. Adding a message is adding a
    template; there is no second switch to remember.
    """
    user = getattr(order.customer, "user", None)
    notification = Notification.objects.create(
        user=user,
        notification_type=notification_type,
        title=title[:160],
        body=body or f"Order {order.number}",
        link=f"/account/orders/{order.number}",
        data={"order_number": order.number},
    )
    if email:
        from notifications.tasks import send_order_email

        transaction.on_commit(lambda: send_order_email.delay(str(order.pk), notification_type))
    if sms:
        from notifications.tasks import send_order_sms

        transaction.on_commit(lambda: send_order_sms.delay(str(order.pk), notification_type))
    return notification


def mark_read(*, user: User, notification_ids: list[Any] | None = None) -> int:
    from django.utils import timezone

    queryset = Notification.objects.filter(user=user, read_at__isnull=True)
    if notification_ids:
        queryset = queryset.filter(pk__in=notification_ids)
    return queryset.update(read_at=timezone.now())
