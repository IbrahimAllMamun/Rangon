"""Suppliers and purchasing.

PurchaseOrder -> PurchaseReceipt is the shape (ADR-0008): receiving is the event
that touches inventory, and it may happen in several partial deliveries.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import models

from core.models import BaseModel, money_field, rate_field


class SupplierStatus(models.TextChoices):
    ACTIVE = "ACTIVE", "Active"
    INACTIVE = "INACTIVE", "Inactive"


class Supplier(BaseModel):
    name = models.CharField(max_length=200)
    code = models.CharField(max_length=32, unique=True)
    contact_person = models.CharField(max_length=120, blank=True)
    phone = models.CharField(max_length=32, blank=True)
    email = models.EmailField(blank=True)
    address = models.TextField(blank=True)
    tax_id = models.CharField(max_length=64, blank=True)
    payment_terms_days = models.PositiveSmallIntegerField(default=0)
    lead_time_days = models.PositiveSmallIntegerField(default=7)
    status = models.CharField(
        max_length=16, choices=SupplierStatus.choices, default=SupplierStatus.ACTIVE
    )
    notes = models.TextField(blank=True)

    class Meta:
        db_table = "purchasing_supplier"
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name


class PurchaseOrderStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    SENT = "SENT", "Sent to supplier"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED", "Partially received"
    RECEIVED = "RECEIVED", "Received"
    CLOSED = "CLOSED", "Closed"
    CANCELLED = "CANCELLED", "Cancelled"


class PaymentStatus(models.TextChoices):
    UNPAID = "UNPAID", "Unpaid"
    PARTIALLY_PAID = "PARTIALLY_PAID", "Partially paid"
    PAID = "PAID", "Paid"


class PurchaseOrder(BaseModel):
    number = models.CharField(max_length=32, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="purchase_orders")
    branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="purchase_orders"
    )
    status = models.CharField(
        max_length=24, choices=PurchaseOrderStatus.choices, default=PurchaseOrderStatus.DRAFT
    )
    payment_status = models.CharField(
        max_length=16, choices=PaymentStatus.choices, default=PaymentStatus.UNPAID
    )

    invoice_number = models.CharField(max_length=64, blank=True)
    ordered_at = models.DateTimeField(null=True, blank=True)
    expected_at = models.DateField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    subtotal = money_field()
    discount_total = money_field()
    tax_total = money_field()
    shipping_total = money_field()
    grand_total = money_field()
    paid_total = money_field()

    currency = models.CharField(max_length=8, default="BDT")
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "purchasing_purchaseorder"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["supplier", "-created_at"]),
            models.Index(fields=["status"]),
            models.Index(fields=["branch", "-created_at"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(grand_total__gte=Decimal("0.00")),
                name="purchasing_po_total_gte_0",
            )
        ]

    def __str__(self) -> str:
        return f"{self.number} — {self.supplier.name}"

    @property
    def outstanding(self) -> Decimal:
        return self.grand_total - self.paid_total

    @property
    def is_editable(self) -> bool:
        return self.status in {PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT}


class PurchaseOrderItem(BaseModel):
    purchase_order = models.ForeignKey(
        PurchaseOrder, on_delete=models.CASCADE, related_name="items"
    )
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="purchase_items"
    )
    quantity_ordered = models.PositiveIntegerField()
    quantity_received = models.PositiveIntegerField(default=0)
    unit_cost = money_field()
    discount = money_field()
    tax_rate = rate_field()
    line_total = money_field()

    class Meta:
        db_table = "purchasing_purchaseorderitem"
        constraints = [
            models.UniqueConstraint(
                fields=["purchase_order", "variant"], name="purchasing_poi_uniq"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity_ordered__gt=0), name="purchasing_poi_qty_gt_0"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity_received__lte=models.F("quantity_ordered")),
                name="purchasing_poi_received_lte_ordered",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.variant_id} x{self.quantity_ordered}"

    @property
    def quantity_outstanding(self) -> int:
        return self.quantity_ordered - self.quantity_received


class PurchaseReceipt(BaseModel):
    """One physical delivery against a purchase order."""

    number = models.CharField(max_length=32, unique=True)
    purchase_order = models.ForeignKey(
        PurchaseOrder, on_delete=models.PROTECT, related_name="receipts"
    )
    received_at = models.DateTimeField()
    received_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    notes = models.TextField(blank=True)
    is_posted = models.BooleanField(
        default=False, help_text="True once inventory transactions have been written."
    )

    class Meta:
        db_table = "purchasing_purchasereceipt"
        ordering = ("-received_at",)

    def __str__(self) -> str:
        return self.number


class PurchaseReceiptItem(BaseModel):
    receipt = models.ForeignKey(PurchaseReceipt, on_delete=models.CASCADE, related_name="items")
    purchase_order_item = models.ForeignKey(
        PurchaseOrderItem, on_delete=models.PROTECT, related_name="receipt_items"
    )
    quantity = models.PositiveIntegerField()
    unit_cost = money_field(help_text="Cost actually paid — drives weighted average cost.")

    class Meta:
        db_table = "purchasing_purchasereceiptitem"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0), name="purchasing_pri_qty_gt_0"
            )
        ]


class SupplierPaymentMethod(models.TextChoices):
    CASH = "CASH", "Cash"
    BANK = "BANK", "Bank transfer"
    CHEQUE = "CHEQUE", "Cheque"
    MOBILE_MFS = "MOBILE_MFS", "Mobile financial service"
    OTHER = "OTHER", "Other"


class SupplierPayment(BaseModel):
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="payments")
    purchase_order = models.ForeignKey(
        PurchaseOrder, null=True, blank=True, on_delete=models.PROTECT, related_name="payments"
    )
    amount = money_field()
    method = models.CharField(max_length=16, choices=SupplierPaymentMethod.choices)
    reference = models.CharField(max_length=120, blank=True)
    paid_at = models.DateTimeField()
    notes = models.TextField(blank=True)
    #: Which of the business's own accounts this money came out of.
    #: Nullable for the same reason as orders.Payment.account.
    account = models.ForeignKey(
        "finance.Account",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="supplier_payments",
        help_text="Where this money came out of.",
    )
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "purchasing_supplierpayment"
        ordering = ("-paid_at",)
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=Decimal("0.00")),
                name="purchasing_supplierpayment_amount_gt_0",
            )
        ]

    def __str__(self) -> str:
        return f"{self.supplier.name}: {self.amount}"
