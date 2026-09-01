"""Customers.

Identity is phone-first (docs/business-rules.md §6): many walk-in shoppers have
no email, and a phone number is what a Bangladeshi retailer actually uses to
find someone.
"""

from __future__ import annotations

from django.db import models

from core.models import BaseModel, money_field


class CustomerType(models.TextChoices):
    WALK_IN = "WALK_IN", "Walk-in"
    REGISTERED = "REGISTERED", "Registered"
    GUEST = "GUEST", "Guest"
    WHOLESALE = "WHOLESALE", "Wholesale"


class Customer(BaseModel):
    user = models.OneToOneField(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="customer",
        help_text="Set when the customer has a storefront login.",
    )
    name = models.CharField(max_length=160)
    phone = models.CharField(max_length=32, unique=True, null=True, blank=True)
    email = models.EmailField(unique=True, null=True, blank=True)
    customer_type = models.CharField(
        max_length=16, choices=CustomerType.choices, default=CustomerType.GUEST
    )
    is_walk_in = models.BooleanField(
        default=False, help_text="The branch's anonymous counter customer."
    )
    is_active = models.BooleanField(default=True)

    date_of_birth = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)
    tags = models.JSONField(default=list, blank=True)

    # Denormalised lifetime figures, refreshed when an order completes.
    # Convenience for list views only — reports always aggregate from orders.
    total_orders = models.PositiveIntegerField(default=0)
    total_spent = money_field()
    loyalty_points = models.IntegerField(default=0)
    last_order_at = models.DateTimeField(null=True, blank=True)

    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "customers_customer"
        ordering = ("name",)
        constraints = [
            # One anonymous counter row per branch.  `orders.services.pos.
            # walk_in_customer()` resolves it with get_or_create, which is only
            # atomic when its lookup is backed by a unique constraint: without
            # this, two simultaneous counter sales both miss the SELECT, both
            # INSERT, and every later call raises MultipleObjectsReturned — so
            # anonymous sales at that branch stop until a row is deleted by
            # hand.  Partial, because ordinary customers may share a name.
            models.UniqueConstraint(
                fields=["is_walk_in", "name"],
                condition=models.Q(is_walk_in=True),
                name="customers_customer_walk_in_name_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["phone"]),
            models.Index(fields=["email"]),
            models.Index(fields=["-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.phone or self.email or 'no contact'})"

    def save(self, *args, **kwargs) -> None:
        # Empty strings would collide under the unique index; NULLs do not.
        if not self.phone:
            self.phone = None
        if not self.email:
            self.email = None
        else:
            self.email = self.email.lower().strip()
        super().save(*args, **kwargs)


class AddressType(models.TextChoices):
    SHIPPING = "SHIPPING", "Shipping"
    BILLING = "BILLING", "Billing"
    BOTH = "BOTH", "Shipping and billing"


class CustomerAddress(BaseModel):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="addresses")
    label = models.CharField(max_length=40, blank=True, help_text="Home, Office…")
    address_type = models.CharField(
        max_length=16, choices=AddressType.choices, default=AddressType.BOTH
    )
    recipient_name = models.CharField(max_length=160)
    phone = models.CharField(max_length=32)
    line1 = models.CharField(max_length=200)
    line2 = models.CharField(max_length=200, blank=True)
    area = models.CharField(max_length=120, blank=True)
    city = models.CharField(max_length=120)
    district = models.CharField(max_length=120, blank=True)
    postal_code = models.CharField(max_length=20, blank=True)
    country = models.CharField(max_length=64, default="Bangladesh")
    is_default = models.BooleanField(default=False)
    notes = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "customers_customeraddress"
        ordering = ("-is_default", "-created_at")
        indexes = [models.Index(fields=["customer", "-is_default"])]

    def __str__(self) -> str:
        return f"{self.recipient_name}, {self.line1}, {self.city}"

    def as_snapshot(self) -> dict:
        """Frozen copy stored on an order — editing an address must not rewrite history."""
        return {
            "recipient_name": self.recipient_name,
            "phone": self.phone,
            "line1": self.line1,
            "line2": self.line2,
            "area": self.area,
            "city": self.city,
            "district": self.district,
            "postal_code": self.postal_code,
            "country": self.country,
        }


class CustomerNote(BaseModel):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="customer_notes")
    body = models.TextField()
    is_pinned = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "customers_customernote"
        ordering = ("-is_pinned", "-created_at")

    def __str__(self) -> str:
        return self.body[:60]
