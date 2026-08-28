"""Shipping: zones, methods, shipments and tracking.

Courier integration is deliberately behind an interface — V1 records tracking
numbers manually, and a courier API can be added without touching orders.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import models

from core.models import AppendOnlyModel, BaseModel, money_field


class Courier(BaseModel):
    name = models.CharField(max_length=120, unique=True)
    code = models.SlugField(max_length=32, unique=True)
    phone = models.CharField(max_length=32, blank=True)
    tracking_url_template = models.CharField(
        max_length=255,
        blank=True,
        help_text="e.g. https://courier.example/track/{tracking_number}",
    )
    integration = models.CharField(
        max_length=32, default="manual", help_text="Provider code; 'manual' means no API."
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "shipping_courier"
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name

    def tracking_url(self, tracking_number: str) -> str:
        if not (self.tracking_url_template and tracking_number):
            return ""
        return self.tracking_url_template.format(tracking_number=tracking_number)


class ShippingZone(BaseModel):
    """A delivery area, matched by city/district name."""

    name = models.CharField(max_length=120, unique=True)
    description = models.CharField(max_length=255, blank=True)
    cities = models.JSONField(
        default=list, blank=True, help_text="Lower-cased city/district names in this zone."
    )
    is_default = models.BooleanField(default=False, help_text="Fallback zone when no city matches.")
    position = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "shipping_shippingzone"
        ordering = ("position", "name")

    def __str__(self) -> str:
        return self.name

    def matches(self, city: str) -> bool:
        if not city:
            return self.is_default
        needle = city.strip().lower()
        return any(needle == str(entry).strip().lower() for entry in self.cities)


class ShippingMethod(BaseModel):
    zone = models.ForeignKey(ShippingZone, on_delete=models.CASCADE, related_name="methods")
    name = models.CharField(max_length=120)
    code = models.SlugField(max_length=48)
    description = models.CharField(max_length=255, blank=True)
    price = money_field()
    free_over = money_field(
        null=True, blank=True, default=None, help_text="Free shipping above this order subtotal."
    )
    min_days = models.PositiveSmallIntegerField(default=1)
    max_days = models.PositiveSmallIntegerField(default=3)
    is_pickup = models.BooleanField(default=False)
    supports_cod = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "shipping_shippingmethod"
        ordering = ("position", "price")
        constraints = [
            models.UniqueConstraint(fields=["zone", "code"], name="shipping_method_zone_code_uniq"),
            models.CheckConstraint(
                condition=models.Q(price__gte=Decimal("0.00")), name="shipping_method_price_gte_0"
            ),
            # `price_for()` returns 0 whenever `subtotal >= free_over`, so a
            # negative threshold is always satisfied and every order ships free.
            models.CheckConstraint(
                condition=models.Q(free_over__isnull=True)
                | models.Q(free_over__gte=Decimal("0.00")),
                name="shipping_method_free_over_gte_0",
            ),
            # A window that reads backwards renders as "5–2 days" to a shopper.
            models.CheckConstraint(
                condition=models.Q(max_days__gte=models.F("min_days")),
                name="shipping_method_days_ordered",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.zone.name})"

    def price_for(self, subtotal: Decimal) -> Decimal:
        if self.free_over is not None and subtotal >= self.free_over:
            return Decimal("0.00")
        return self.price

    @property
    def eta_label(self) -> str:
        if self.is_pickup:
            return "Collect in store"
        if self.min_days == self.max_days:
            return f"{self.min_days} day{'s' if self.min_days != 1 else ''}"
        return f"{self.min_days}–{self.max_days} days"


class ShipmentStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    DISPATCHED = "DISPATCHED", "Dispatched"
    IN_TRANSIT = "IN_TRANSIT", "In transit"
    DELIVERED = "DELIVERED", "Delivered"
    FAILED = "FAILED", "Delivery failed"
    RETURNED = "RETURNED", "Returned to sender"


class Shipment(BaseModel):
    order = models.ForeignKey("orders.Order", on_delete=models.PROTECT, related_name="shipments")
    courier = models.ForeignKey(
        Courier, null=True, blank=True, on_delete=models.PROTECT, related_name="shipments"
    )
    shipping_method = models.ForeignKey(
        ShippingMethod, null=True, blank=True, on_delete=models.SET_NULL, related_name="shipments"
    )
    tracking_number = models.CharField(max_length=120, blank=True)
    status = models.CharField(
        max_length=16, choices=ShipmentStatus.choices, default=ShipmentStatus.PENDING
    )
    cost = money_field()
    dispatched_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "shipping_shipment"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["order"]),
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["tracking_number"]),
        ]

    def __str__(self) -> str:
        return f"{self.order_id} via {self.courier_id or 'unassigned'}"

    @property
    def tracking_url(self) -> str:
        return self.courier.tracking_url(self.tracking_number) if self.courier else ""


class ShipmentEvent(AppendOnlyModel):
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="events")
    status = models.CharField(max_length=16, choices=ShipmentStatus.choices)
    message = models.CharField(max_length=255, blank=True)
    location = models.CharField(max_length=120, blank=True)
    occurred_at = models.DateTimeField()
    raw = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "shipping_shipmentevent"
        ordering = ("occurred_at",)

    def __str__(self) -> str:
        return f"{self.shipment_id}: {self.status}"
