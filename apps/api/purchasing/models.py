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
    #: Value of goods sent back, set against what is owed. Mirrors `paid_total`:
    #: `grand_total` is what was agreed and never moves, so a credit accumulates
    #: alongside rather than rewriting the order (CLAUDE.md §3.3).
    credited_total = money_field()

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
        """What is still owed: the agreed total, less cash paid and credit taken.

        Can go negative when goods are returned after the order was paid — the
        supplier then owes the business. `finance.selectors.payables` drops
        those rather than showing a negative liability; see the DECISION
        REQUIRED note in business-rules.md § 7b.
        """
        return self.grand_total - self.paid_total - self.credited_total

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
    quantity_returned = models.PositiveIntegerField(default=0)
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
            # You cannot send back more than turned up.
            models.CheckConstraint(
                condition=models.Q(quantity_returned__lte=models.F("quantity_received")),
                name="purchasing_poi_returned_lte_received",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.variant_id} x{self.quantity_ordered}"

    @property
    def quantity_outstanding(self) -> int:
        return self.quantity_ordered - self.quantity_received

    @property
    def quantity_returnable(self) -> int:
        """Received and not yet sent back."""
        return self.quantity_received - self.quantity_returned


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
    #: Paying a supplier twice is unrecoverable money, so a retried request must
    #: return the payment already recorded.  Same shape as orders.Order and
    #: orders.Refund; nullable because most payments are recorded from a screen
    #: that supplies one, and history carries none.
    idempotency_key = models.CharField(max_length=80, null=True, blank=True, unique=True)

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


class SupplierProduct(BaseModel):
    """What one supplier charges for one variant.

    The catalogue had no link to a supplier at all. `PurchaseOrderItem` points at
    a variant and `PurchaseOrder` points at a supplier, but nothing joined the
    two, so three ordinary questions had no answer: who sells us this, what did
    *they* last charge, and which of them should we buy it from.

    The practical cost of that was on the purchase order form, which defaulted a
    line's unit cost to `ProductVariant.cost` — the last price paid to *any*
    supplier. Ordering from the cheaper of two vendors silently pre-filled the
    dearer one's price, and a buyer who accepted the default overpaid on paper
    while the receipt corrected it later (D72/D73 are the same family of bug:
    one cost column standing in for several distinct facts).

    This is reference data, not a financial record: a price list may be edited
    and deleted, unlike the purchase orders and receipts that record what was
    actually agreed and paid. That is why both foreign keys cascade.

    Rows appear on their own. Receiving a delivery upserts the offer for the
    supplier it came from (`purchasing.services.record_supplier_product`), so
    the list builds itself out of real purchase history rather than needing to
    be maintained by hand; a buyer may also add one ahead of ordering to record
    a quote.
    """

    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="offers")
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.CASCADE, related_name="supplier_offers"
    )

    #: The supplier's own code for this item, off their invoice or price list.
    #: Ours is `ProductVariant.sku`; theirs is what you quote back at them.
    supplier_sku = models.CharField(max_length=64, blank=True)

    #: What this supplier charged on the most recent receipt, or the quote a
    #: buyer recorded. Distinct from `ProductVariant.cost` (the last price paid
    #: to anyone) and from `Inventory.average_cost` (the weighted average that
    #: values stock and prices COGS) — see docs/business-rules.md § 4.
    last_cost = money_field()

    #: Overrides `Supplier.lead_time_days` for this item only; null means "use
    #: the supplier's". A vendor can be quick in general and slow on one line.
    lead_time_days = models.PositiveSmallIntegerField(null=True, blank=True)

    #: What this supplier will not sell fewer of. Advisory: the purchase order
    #: service surfaces it rather than refusing, because suppliers flex and a
    #: refusal would be a business rule nobody stated.
    minimum_order_quantity = models.PositiveIntegerField(default=1)

    #: At most one per variant, enforced below. The first supplier a variant is
    #: ever received from becomes preferred; after that it is an explicit act.
    is_preferred = models.BooleanField(default=False)

    #: A supplier who has discontinued the line. Kept rather than deleted, so
    #: the purchase history still explains itself.
    is_active = models.BooleanField(default=True)

    last_purchased_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "purchasing_supplierproduct"
        ordering = ("-is_preferred", "last_cost")
        indexes = [
            # "Who supplies this, cheapest offer first" — the product screen and
            # the purchase order form's cost lookup.
            models.Index(fields=["variant", "-is_preferred", "last_cost"]),
            # "What do we buy from this supplier, most recently bought first."
            models.Index(fields=["supplier", "-last_purchased_at"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["supplier", "variant"], name="purchasing_supplierproduct_uniq"
            ),
            # One preferred supplier per variant, or "preferred" means nothing.
            # Partial, so the many non-preferred offers do not collide.
            models.UniqueConstraint(
                fields=["variant"],
                condition=models.Q(is_preferred=True),
                name="purchasing_supplierproduct_one_preferred",
            ),
            models.CheckConstraint(
                condition=models.Q(last_cost__gte=Decimal("0.00")),
                name="purchasing_supplierproduct_cost_gte_0",
            ),
            models.CheckConstraint(
                condition=models.Q(minimum_order_quantity__gte=1),
                name="purchasing_supplierproduct_moq_gte_1",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.supplier.name} → {self.variant.sku}"

    @property
    def effective_lead_time_days(self) -> int:
        """This item's lead time, falling back to the supplier's."""
        if self.lead_time_days is not None:
            return self.lead_time_days
        return self.supplier.lead_time_days


class PurchaseReturnReason(models.TextChoices):
    DAMAGED = "DAMAGED", "Damaged in transit"
    DEFECTIVE = "DEFECTIVE", "Faulty goods"
    WRONG_ITEM = "WRONG_ITEM", "Wrong item delivered"
    OVER_DELIVERED = "OVER_DELIVERED", "More than was ordered"
    EXPIRED = "EXPIRED", "Expired or short-dated"
    OTHER = "OTHER", "Other"


class PurchaseReturn(BaseModel):
    """Goods sent back to the supplier, and the credit they are worth.

    `PurchaseReturn` is to `PurchaseReceipt` what a customer return is to a
    sale: the mirror of the event that moved the stock, never an edit of it.
    `TransactionType.PURCHASE_RETURN` has existed since the first migration —
    scored in the sign table, accepted by the ledger — with no service and no
    caller, so faulty goods could not go back at all.

    The money is a **credit, not a refund**. A supplier is rarely paid back in
    cash; the value is set against what is owed them. `PurchaseOrder.grand_total`
    is what was agreed and never moves, exactly as `paid_total` never rewrites
    it — the credit accumulates alongside in `credited_total`, and the payable
    is what is left (CLAUDE.md §3.3, docs/business-rules.md § 7b).

    Posted in one transaction: there is no draft state, because a return that
    has taken stock off the shelf without recording the credit is the exact
    half-written record the ledger exists to prevent.
    """

    number = models.CharField(max_length=32, unique=True)
    purchase_order = models.ForeignKey(
        PurchaseOrder, on_delete=models.PROTECT, related_name="returns"
    )
    reason = models.CharField(max_length=24, choices=PurchaseReturnReason.choices)
    notes = models.TextField(blank=True)
    returned_at = models.DateTimeField()
    returned_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    #: What the supplier owes back for these goods, at the cost they were
    #: received at. Sums the lines; stored so the payable is one column read.
    credit_total = money_field()

    #: Sending goods back twice is stock that never left and money never owed.
    #: Same shape as `SupplierPayment`, and for the same reason (CLAUDE.md §7).
    idempotency_key = models.CharField(max_length=80, null=True, blank=True, unique=True)

    class Meta:
        db_table = "purchasing_purchasereturn"
        ordering = ("-returned_at",)
        indexes = [models.Index(fields=["purchase_order", "-returned_at"])]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(credit_total__gte=Decimal("0.00")),
                name="purchasing_purchasereturn_credit_gte_0",
            )
        ]

    def __str__(self) -> str:
        return self.number


class PurchaseReturnItem(BaseModel):
    purchase_return = models.ForeignKey(
        PurchaseReturn, on_delete=models.CASCADE, related_name="items"
    )
    purchase_order_item = models.ForeignKey(
        PurchaseOrderItem, on_delete=models.PROTECT, related_name="return_items"
    )
    quantity = models.PositiveIntegerField()
    #: The cost the goods came in at, which is what the credit is worth — not
    #: today's price and not the branch's blended average.
    unit_cost = money_field()

    class Meta:
        db_table = "purchasing_purchasereturnitem"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0), name="purchasing_pri_return_qty_gt_0"
            )
        ]

    def __str__(self) -> str:
        return f"{self.purchase_order_item_id} x{self.quantity}"
