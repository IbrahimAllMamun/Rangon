"""In-app notifications.

Delivery over other channels (email, SMS) is done by Celery tasks reading these
rows, so a failed email never blocks a sale.
"""

from __future__ import annotations

from django.db import models

from core.models import BaseModel


class NotificationType(models.TextChoices):
    NEW_ONLINE_ORDER = "NEW_ONLINE_ORDER", "New online order"
    PAYMENT_RECEIVED = "PAYMENT_RECEIVED", "Payment received"
    LOW_STOCK = "LOW_STOCK", "Low stock"
    OUT_OF_STOCK = "OUT_OF_STOCK", "Out of stock"
    ORDER_SHIPPED = "ORDER_SHIPPED", "Order shipped"
    ORDER_DELIVERED = "ORDER_DELIVERED", "Order delivered"
    RETURN_REQUESTED = "RETURN_REQUESTED", "Return requested"
    REFUND_COMPLETED = "REFUND_COMPLETED", "Refund completed"
    STOCK_EXPIRING = "STOCK_EXPIRING", "Stock expiring"
    INTEGRITY_ALERT = "INTEGRITY_ALERT", "Inventory integrity alert"


class NotificationLevel(models.TextChoices):
    INFO = "INFO", "Info"
    SUCCESS = "SUCCESS", "Success"
    WARNING = "WARNING", "Warning"
    ERROR = "ERROR", "Error"


class Notification(BaseModel):
    user = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="notifications",
        help_text="Null means it is addressed to a permission group rather than a person.",
    )
    permission_code = models.CharField(
        max_length=64, blank=True, help_text="Everyone holding this code sees the notification."
    )
    branch = models.ForeignKey(
        "accounts.Branch", null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )
    notification_type = models.CharField(max_length=32, choices=NotificationType.choices)
    level = models.CharField(
        max_length=16, choices=NotificationLevel.choices, default=NotificationLevel.INFO
    )
    title = models.CharField(max_length=160)
    body = models.TextField(blank=True)
    link = models.CharField(max_length=255, blank=True)
    data = models.JSONField(default=dict, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    emailed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notifications_notification"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["user", "read_at", "-created_at"]),
            models.Index(fields=["notification_type", "-created_at"]),
        ]

    def __str__(self) -> str:
        return self.title

    @property
    def is_read(self) -> bool:
        return self.read_at is not None
