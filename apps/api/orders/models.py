"""Orders, carts, payments, refunds and returns.

One order table for every channel (CLAUDE.md §3.7).  Product names, SKUs, prices
and addresses are snapshotted onto the order so history never changes when the
catalogue does.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import models
from django.utils import timezone

from accounts.models import TaxMode
from core.models import AppendOnlyModel, BaseModel, money_field, rate_field


class Channel(models.TextChoices):
    POS = "POS", "Point of sale"
    ONLINE = "ONLINE", "Online store"
    PHONE = "PHONE", "Phone order"
    SOCIAL = "SOCIAL", "Social media"
    OTHER = "OTHER", "Other"


class OrderStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    CONFIRMED = "CONFIRMED", "Confirmed"
    PROCESSING = "PROCESSING", "Processing"
    PACKED = "PACKED", "Packed"
    SHIPPED = "SHIPPED", "Shipped"
    DELIVERED = "DELIVERED", "Delivered"
    CANCELLED = "CANCELLED", "Cancelled"
    RETURN_REQUESTED = "RETURN_REQUESTED", "Return requested"
    RETURNED = "RETURNED", "Returned"
    REFUNDED = "REFUNDED", "Refunded"


class OrderPaymentStatus(models.TextChoices):
    UNPAID = "UNPAID", "Unpaid"
    PARTIALLY_PAID = "PARTIALLY_PAID", "Partially paid"
    PAID = "PAID", "Paid"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED", "Partially refunded"
    REFUNDED = "REFUNDED", "Refunded"


class PaymentMethod(models.TextChoices):
    CASH = "CASH", "Cash"
    CARD = "CARD", "Card"
    MOBILE_MFS = "MOBILE_MFS", "Mobile financial service"
    BANK = "BANK", "Bank transfer"
    ONLINE_GATEWAY = "ONLINE_GATEWAY", "Online gateway"
    COD = "COD", "Cash on delivery"
    STORE_CREDIT = "STORE_CREDIT", "Store credit"
    OTHER = "OTHER", "Other"


class PaymentState(models.TextChoices):
    PENDING = "PENDING", "Pending"
    AUTHORIZED = "AUTHORIZED", "Authorized"
    CAPTURED = "CAPTURED", "Captured"
    FAILED = "FAILED", "Failed"
    VOIDED = "VOIDED", "Voided"
    REFUNDED = "REFUNDED", "Refunded"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED", "Partially refunded"


# ---------------------------------------------------------------------------
# Cart (server-authoritative)
# ---------------------------------------------------------------------------


class Cart(BaseModel):
    """A shopping cart.  Prices here are a cache; the server re-prices on read."""

    customer = models.ForeignKey(
        "customers.Customer", null=True, blank=True, on_delete=models.CASCADE, related_name="carts"
    )
    token = models.CharField(
        max_length=64, unique=True, help_text="Guest cart identifier (X-Cart-Token)."
    )
    branch = models.ForeignKey("accounts.Branch", on_delete=models.PROTECT, related_name="carts")
    coupon = models.ForeignKey(
        "promotions.Coupon", null=True, blank=True, on_delete=models.SET_NULL, related_name="carts"
    )
    is_active = models.BooleanField(default=True)
    last_activity_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "orders_cart"
        ordering = ("-last_activity_at",)
        indexes = [models.Index(fields=["customer", "-last_activity_at"])]

    def __str__(self) -> str:
        return f"Cart {self.token[:8]}"


class CartItem(BaseModel):
    cart = models.ForeignKey(Cart, on_delete=models.CASCADE, related_name="items")
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.CASCADE, related_name="+"
    )
    quantity = models.PositiveIntegerField(default=1)

    class Meta:
        db_table = "orders_cartitem"
        ordering = ("created_at",)
        constraints = [
            models.UniqueConstraint(fields=["cart", "variant"], name="orders_cartitem_uniq"),
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0), name="orders_cartitem_qty_gt_0"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.variant_id} x{self.quantity}"


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------


class Order(BaseModel):
    number = models.CharField(max_length=32, unique=True)
    channel = models.CharField(max_length=16, choices=Channel.choices, db_index=True)
    status = models.CharField(
        max_length=24, choices=OrderStatus.choices, default=OrderStatus.PENDING
    )
    payment_status = models.CharField(
        max_length=24, choices=OrderPaymentStatus.choices, default=OrderPaymentStatus.UNPAID
    )

    branch = models.ForeignKey("accounts.Branch", on_delete=models.PROTECT, related_name="orders")
    customer = models.ForeignKey(
        "customers.Customer", on_delete=models.PROTECT, related_name="orders"
    )
    created_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="orders_created",
        help_text="Cashier or staff member. Null for self-service online orders.",
    )
    register = models.CharField(max_length=32, blank=True)

    subtotal = money_field()
    coupon_discount = money_field()
    manual_discount = money_field()
    discount_total = money_field()
    tax_total = money_field()
    tax_rate = rate_field()
    # Frozen with the order: a later change to the organisation's VAT treatment
    # must never re-interpret a total that has already been charged.
    tax_mode = models.CharField(
        max_length=16,
        choices=TaxMode.choices,
        default=TaxMode.EXCLUSIVE,
        help_text="Whether tax_total sits inside subtotal or was added on top.",
    )
    shipping_total = money_field()
    grand_total = money_field()
    paid_total = money_field()
    refunded_total = money_field()
    currency = models.CharField(max_length=8, default="BDT")

    coupon = models.ForeignKey(
        "promotions.Coupon", null=True, blank=True, on_delete=models.SET_NULL, related_name="orders"
    )
    shipping_method = models.ForeignKey(
        "shipping.ShippingMethod",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="orders",
    )
    shipping_address = models.JSONField(default=dict, blank=True)
    billing_address = models.JSONField(default=dict, blank=True)

    customer_note = models.TextField(blank=True)
    internal_note = models.TextField(blank=True)

    idempotency_key = models.CharField(max_length=80, null=True, blank=True, unique=True)
    guest_token = models.CharField(
        max_length=64, blank=True, help_text="Lets a guest track their order without an account."
    )

    placed_at = models.DateTimeField(default=timezone.now)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    packed_at = models.DateTimeField(null=True, blank=True)
    shipped_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=255, blank=True)
    stock_committed = models.BooleanField(
        default=False, help_text="True once reservations have become SALE ledger rows."
    )

    class Meta:
        db_table = "orders_order"
        ordering = ("-placed_at",)
        indexes = [
            models.Index(fields=["branch", "-placed_at"]),
            models.Index(fields=["channel", "status", "-placed_at"]),
            models.Index(fields=["customer", "-placed_at"]),
            models.Index(fields=["payment_status"]),
            models.Index(fields=["status"], name="orders_order_status_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(grand_total__gte=Decimal("0.00")),
                name="orders_order_total_gte_0",
            ),
            models.CheckConstraint(
                condition=models.Q(paid_total__gte=Decimal("0.00")),
                name="orders_order_paid_gte_0",
            ),
            models.CheckConstraint(
                condition=models.Q(refunded_total__gte=Decimal("0.00")),
                name="orders_order_refunded_gte_0",
            ),
        ]

    def __str__(self) -> str:
        return self.number

    @property
    def outstanding(self) -> Decimal:
        return self.grand_total - self.paid_total

    @property
    def is_cancellable(self) -> bool:
        return self.status in {OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING}

    @property
    def is_paid(self) -> bool:
        return self.payment_status == OrderPaymentStatus.PAID

    @property
    def item_count(self) -> int:
        return sum(item.quantity for item in self.items.all())

    @property
    def cogs_total(self) -> Decimal:
        return sum((item.unit_cost * item.quantity for item in self.items.all()), Decimal("0.00"))

    @property
    def net_revenue(self) -> Decimal:
        """Goods revenue the business keeps, excluding VAT and shipping.

        Under inclusive pricing the VAT is part of `subtotal`, so it has to be
        taken out again — otherwise every margin and profit figure built on this
        is overstated by exactly the tax.
        """
        base = self.subtotal - self.discount_total
        if self.tax_mode == TaxMode.INCLUSIVE:
            return base - self.tax_total
        return base

    @property
    def gross_profit(self) -> Decimal:
        return self.net_revenue - self.cogs_total


class OrderItem(BaseModel):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="order_items"
    )

    # Snapshots — history must not move when the catalogue changes.
    sku = models.CharField(max_length=64)
    product_name = models.CharField(max_length=200)
    variant_label = models.CharField(max_length=200, blank=True)

    quantity = models.PositiveIntegerField()
    unit_price = money_field()
    unit_cost = money_field(help_text="Weighted average cost frozen at sale time (ADR-0006).")
    line_discount = money_field()
    tax_amount = money_field()
    line_total = money_field()

    fulfilled_quantity = models.PositiveIntegerField(default=0)
    returned_quantity = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "orders_orderitem"
        ordering = ("created_at",)
        indexes = [
            models.Index(fields=["order"]),
            models.Index(fields=["variant"]),
        ]
        constraints = [
            models.CheckConstraint(condition=models.Q(quantity__gt=0), name="orders_item_qty_gt_0"),
            models.CheckConstraint(
                condition=models.Q(unit_price__gte=Decimal("0.00")),
                name="orders_item_price_gte_0",
            ),
            models.CheckConstraint(
                condition=models.Q(returned_quantity__lte=models.F("quantity")),
                name="orders_item_returned_lte_qty",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.sku} x{self.quantity}"

    @property
    def returnable_quantity(self) -> int:
        return self.quantity - self.returned_quantity

    @property
    def line_cogs(self) -> Decimal:
        return self.unit_cost * self.quantity


class OrderEventType(models.TextChoices):
    CREATED = "CREATED", "Order created"
    STATUS_CHANGED = "STATUS_CHANGED", "Status changed"
    PAYMENT_RECORDED = "PAYMENT_RECORDED", "Payment recorded"
    PAYMENT_CAPTURED = "PAYMENT_CAPTURED", "Payment captured"
    PAYMENT_FAILED = "PAYMENT_FAILED", "Payment failed"
    REFUND_ISSUED = "REFUND_ISSUED", "Refund issued"
    SHIPMENT_CREATED = "SHIPMENT_CREATED", "Shipment created"
    SHIPMENT_EVENT = "SHIPMENT_EVENT", "Shipment update"
    RETURN_REQUESTED = "RETURN_REQUESTED", "Return requested"
    RETURN_UPDATED = "RETURN_UPDATED", "Return updated"
    NOTE_ADDED = "NOTE_ADDED", "Note added"
    CANCELLED = "CANCELLED", "Cancelled"
    STOCK_RESERVED = "STOCK_RESERVED", "Stock reserved"
    STOCK_COMMITTED = "STOCK_COMMITTED", "Stock deducted"
    STOCK_RELEASED = "STOCK_RELEASED", "Stock released"


class OrderEvent(AppendOnlyModel):
    """The order timeline.  Append-only; drives admin history and customer tracking."""

    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="events")
    event_type = models.CharField(max_length=32, choices=OrderEventType.choices)
    message = models.CharField(max_length=255, blank=True)
    data = models.JSONField(default=dict, blank=True)
    is_customer_visible = models.BooleanField(default=True)
    actor = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "orders_orderevent"
        ordering = ("created_at",)
        indexes = [models.Index(fields=["order", "created_at"])]

    def __str__(self) -> str:
        return f"{self.order_id}: {self.event_type}"


# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------


class Payment(BaseModel):
    order = models.ForeignKey(Order, on_delete=models.PROTECT, related_name="payments")
    method = models.CharField(max_length=20, choices=PaymentMethod.choices)
    status = models.CharField(
        max_length=20, choices=PaymentState.choices, default=PaymentState.PENDING
    )
    amount = money_field()
    tendered_amount = money_field(
        null=True, blank=True, default=None, help_text="Cash handed over, for change calculation."
    )
    change_amount = money_field()
    currency = models.CharField(max_length=8, default="BDT")

    provider = models.CharField(max_length=32, default="manual")
    provider_reference = models.CharField(max_length=128, blank=True)
    reference = models.CharField(
        max_length=128, blank=True, help_text="Slip number, MFS transaction id, cheque number."
    )
    payload = models.JSONField(default=dict, blank=True)

    authorized_at = models.DateTimeField(null=True, blank=True)
    captured_at = models.DateTimeField(null=True, blank=True)
    failed_at = models.DateTimeField(null=True, blank=True)
    refunded_total = money_field()

    # Which of the business's own accounts the money landed in.
    #
    # Nullable, and it must stay nullable: every payment taken before the
    # finance app existed has no honest answer, and CLAUDE.md section 3.3
    # forbids inventing one after the fact.  `verify_accounts` reports the
    # rows that carry no account rather than hiding them.
    account = models.ForeignKey(
        "finance.Account",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="payments",
        help_text="Where this money landed. Set when the payment is captured.",
    )

    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "orders_payment"
        ordering = ("created_at",)
        indexes = [
            models.Index(fields=["order"]),
            models.Index(fields=["method", "-captured_at"]),
            models.Index(fields=["status"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=Decimal("0.00")), name="orders_payment_amount_gt_0"
            ),
            models.UniqueConstraint(
                fields=["provider", "provider_reference"],
                condition=~models.Q(provider_reference=""),
                name="orders_payment_provider_ref_uniq",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.method} {self.amount} ({self.status})"

    @property
    def refundable_amount(self) -> Decimal:
        if self.status not in {PaymentState.CAPTURED, PaymentState.PARTIALLY_REFUNDED}:
            return Decimal("0.00")
        return self.amount - self.refunded_total


class PaymentEvent(AppendOnlyModel):
    """Provider callbacks/webhooks.  Unique per (provider, event id) to kill replays."""

    payment = models.ForeignKey(
        Payment, null=True, blank=True, on_delete=models.SET_NULL, related_name="events"
    )
    order = models.ForeignKey(
        Order, null=True, blank=True, on_delete=models.SET_NULL, related_name="payment_events"
    )
    provider = models.CharField(max_length=32)
    provider_event_id = models.CharField(max_length=128)
    event_type = models.CharField(max_length=64, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    processed = models.BooleanField(default=False)
    result = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "orders_paymentevent"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "provider_event_id"], name="orders_paymentevent_uniq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.provider}:{self.provider_event_id}"


class RefundStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    COMPLETED = "COMPLETED", "Completed"
    FAILED = "FAILED", "Failed"


class Refund(BaseModel):
    order = models.ForeignKey(Order, on_delete=models.PROTECT, related_name="refunds")
    payment = models.ForeignKey(
        Payment, null=True, blank=True, on_delete=models.PROTECT, related_name="refunds"
    )
    return_request = models.ForeignKey(
        "orders.ReturnRequest",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="refunds",
    )
    amount = money_field()
    method = models.CharField(max_length=20, choices=PaymentMethod.choices)
    status = models.CharField(
        max_length=16, choices=RefundStatus.choices, default=RefundStatus.COMPLETED
    )
    reason = models.CharField(max_length=255, blank=True)
    provider_reference = models.CharField(max_length=128, blank=True)
    idempotency_key = models.CharField(max_length=80, null=True, blank=True, unique=True)
    #: Which account the refunded money came out of.  See Payment.account.
    account = models.ForeignKey(
        "finance.Account",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="refunds",
        help_text="Where this money came out of.",
    )
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "orders_refund"
        ordering = ("-created_at",)
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=Decimal("0.00")), name="orders_refund_amount_gt_0"
            )
        ]

    def __str__(self) -> str:
        return f"Refund {self.amount} on {self.order_id}"


# ---------------------------------------------------------------------------
# Returns
# ---------------------------------------------------------------------------


class ReturnStatus(models.TextChoices):
    REQUESTED = "REQUESTED", "Requested"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"
    RECEIVED = "RECEIVED", "Goods received"
    COMPLETED = "COMPLETED", "Completed"


class ReturnReason(models.TextChoices):
    WRONG_SIZE = "WRONG_SIZE", "Wrong size"
    DEFECTIVE = "DEFECTIVE", "Defective"
    WRONG_PRODUCT = "WRONG_PRODUCT", "Wrong product delivered"
    CUSTOMER_CHANGED_MIND = "CUSTOMER_CHANGED_MIND", "Changed mind"
    DAMAGED = "DAMAGED", "Damaged in transit"
    OTHER = "OTHER", "Other"


class RestockDecision(models.TextChoices):
    RESTOCK = "RESTOCK", "Back to sellable stock"
    DAMAGED = "DAMAGED", "Written off as damaged"
    QUARANTINE = "QUARANTINE", "Quarantined for inspection"


class ReturnRequest(BaseModel):
    number = models.CharField(max_length=32, unique=True)
    order = models.ForeignKey(Order, on_delete=models.PROTECT, related_name="returns")
    status = models.CharField(
        max_length=16, choices=ReturnStatus.choices, default=ReturnStatus.REQUESTED
    )
    reason = models.CharField(max_length=32, choices=ReturnReason.choices)
    customer_comment = models.TextField(blank=True)
    staff_comment = models.TextField(blank=True)

    refund_amount = money_field()
    refund_shipping = models.BooleanField(default=False)

    requested_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    approved_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "orders_returnrequest"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["order"]),
            models.Index(fields=["status", "-created_at"]),
        ]

    def __str__(self) -> str:
        return self.number


class ReturnItem(BaseModel):
    return_request = models.ForeignKey(
        ReturnRequest, on_delete=models.CASCADE, related_name="items"
    )
    order_item = models.ForeignKey(OrderItem, on_delete=models.PROTECT, related_name="return_items")
    quantity = models.PositiveIntegerField()
    restock_decision = models.CharField(
        max_length=16, choices=RestockDecision.choices, default=RestockDecision.RESTOCK
    )
    condition_note = models.CharField(max_length=255, blank=True)
    refund_amount = money_field()

    class Meta:
        db_table = "orders_returnitem"
        constraints = [
            models.UniqueConstraint(
                fields=["return_request", "order_item"], name="orders_returnitem_uniq"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0), name="orders_returnitem_qty_gt_0"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.order_item_id} x{self.quantity}"


# ---------------------------------------------------------------------------
# POS held sales
# ---------------------------------------------------------------------------


class HeldSale(BaseModel):
    """A parked POS cart.  Holds no stock — nothing is reserved until the sale completes."""

    branch = models.ForeignKey("accounts.Branch", on_delete=models.CASCADE, related_name="holds")
    register = models.CharField(max_length=32, blank=True)
    label = models.CharField(max_length=64, blank=True)
    customer = models.ForeignKey(
        "customers.Customer", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    payload = models.JSONField(default=dict, help_text="Cart lines, discounts and notes.")
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "orders_heldsale"
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["branch", "-created_at"])]

    def __str__(self) -> str:
        return self.label or f"Hold {str(self.pk)[:8]}"
