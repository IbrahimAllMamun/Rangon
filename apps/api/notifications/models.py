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
    ORDER_CONFIRMED = "ORDER_CONFIRMED", "Order confirmed"
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


class SmsStatus(models.TextChoices):
    QUEUED = "QUEUED", "Queued"
    SENT = "SENT", "Sent"
    FAILED = "FAILED", "Failed"
    SUPPRESSED = "SUPPRESSED", "Suppressed"


class SmsMessage(BaseModel):
    """Every SMS this system tried to send, and what came of it.

    Not optional, and not an afterthought. SMS is the one channel with no
    sent-items folder and no bounce: when somebody asks "did the customer get
    told the order shipped?", this row is the only thing that can answer. It is
    also the only place the spend is visible — one row is one charge.

    Kept for failures too, and for messages deliberately not sent
    (`SUPPRESSED`), because "we chose not to text them" and "we tried and it
    broke" are different answers to the same question.
    """

    to = models.CharField(
        max_length=32,
        db_index=True,
        help_text="Canonical 8801XXXXXXXXX. What the provider was given, not what it sent.",
    )
    body = models.TextField()
    provider = models.CharField(max_length=32)
    status = models.CharField(max_length=16, choices=SmsStatus.choices, default=SmsStatus.QUEUED)
    reference = models.CharField(
        max_length=128, blank=True, help_text="The provider's own id for the message."
    )
    error = models.TextField(blank=True)
    segments = models.PositiveSmallIntegerField(
        default=1,
        help_text="Billable parts. Bengali is UCS-2, so 70 characters, not 160.",
    )
    notification_type = models.CharField(max_length=32, blank=True)
    order_number = models.CharField(max_length=32, blank=True, db_index=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notifications_smsmessage"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["order_number", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.to} {self.status}"
