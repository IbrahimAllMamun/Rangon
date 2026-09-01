"""Inventory: cached stock position + append-only ledger.

See docs/architecture/inventory.md and ADR-0004.  Nothing outside
inventory.services may write on_hand or reserved.
"""

from __future__ import annotations

from django.db import models

from core.models import AppendOnlyModel, BaseModel, money_field


class TransactionType(models.TextChoices):
    PURCHASE = "PURCHASE", "Purchase received"
    SALE = "SALE", "Sale"
    RETURN = "RETURN", "Customer return"
    DAMAGE = "DAMAGE", "Damaged"
    LOSS = "LOSS", "Lost or stolen"
    ADJUSTMENT = "ADJUSTMENT", "Manual adjustment"
    TRANSFER_IN = "TRANSFER_IN", "Transfer in"
    TRANSFER_OUT = "TRANSFER_OUT", "Transfer out"
    RESERVATION = "RESERVATION", "Reserved for an order"
    RESERVATION_RELEASE = "RESERVATION_RELEASE", "Reservation released"
    PURCHASE_RETURN = "PURCHASE_RETURN", "Returned to supplier"


#: Types that change on_hand (everything except the reservation pair).
STOCK_AFFECTING = {
    TransactionType.PURCHASE,
    TransactionType.SALE,
    TransactionType.RETURN,
    TransactionType.DAMAGE,
    TransactionType.LOSS,
    TransactionType.ADJUSTMENT,
    TransactionType.TRANSFER_IN,
    TransactionType.TRANSFER_OUT,
    TransactionType.PURCHASE_RETURN,
}

#: Types that change reserved.
RESERVATION_AFFECTING = {
    TransactionType.RESERVATION,
    TransactionType.RESERVATION_RELEASE,
}

#: Sign applied to the absolute quantity supplied by the caller.
TRANSACTION_SIGN = {
    TransactionType.PURCHASE: 1,
    TransactionType.SALE: -1,
    TransactionType.RETURN: 1,
    TransactionType.DAMAGE: -1,
    TransactionType.LOSS: -1,
    TransactionType.TRANSFER_IN: 1,
    TransactionType.TRANSFER_OUT: -1,
    TransactionType.PURCHASE_RETURN: -1,
    TransactionType.RESERVATION: 1,
    TransactionType.RESERVATION_RELEASE: -1,
    # ADJUSTMENT carries its own sign — the caller states the delta.
    TransactionType.ADJUSTMENT: 0,
}

#: Reason is mandatory for these: an unexplained stock change is a red flag.
REASON_REQUIRED = {
    TransactionType.ADJUSTMENT,
    TransactionType.DAMAGE,
    TransactionType.LOSS,
}


class Inventory(BaseModel):
    """Stock position for one variant at one branch.

    on_hand / reserved are transactional caches over InventoryTransaction.
    verify_integrity() proves they still agree with the ledger.
    """

    branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="inventory"
    )
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="inventory"
    )
    on_hand = models.IntegerField(default=0)
    reserved = models.IntegerField(default=0)
    average_cost = money_field(help_text="Weighted average cost at this branch (ADR-0006).")
    reorder_point = models.IntegerField(default=5)
    bin_location = models.CharField(max_length=64, blank=True)

    class Meta:
        db_table = "inventory_inventory"
        verbose_name_plural = "inventory"
        constraints = [
            models.UniqueConstraint(
                fields=["branch", "variant"], name="inventory_branch_variant_uniq"
            ),
            # `reserved` can never legitimately go negative — a database
            # constraint is the right backstop.
            #
            # `on_hand` deliberately has NO such constraint.  Negative stock is
            # a real, if rare, business state: RANGON_ALLOW_OVERSELL, and the
            # V2 offline POS, where a sale physically happened while the
            # register was disconnected and the ledger must reflect reality
            # (docs/architecture/offline-pos.md).  Overselling is prevented by
            # the service guard under SELECT … FOR UPDATE, and any drift is
            # caught by verify_integrity().
            models.CheckConstraint(
                condition=models.Q(reserved__gte=0), name="inventory_reserved_gte_0"
            ),
        ]
        indexes = [
            models.Index(fields=["branch", "variant"]),
            models.Index(fields=["variant"]),
        ]

    def __str__(self) -> str:
        return f"{self.variant.sku} @ {self.branch.code}: {self.available} available"

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved

    @property
    def is_low_stock(self) -> bool:
        return self.available <= self.reorder_point

    @property
    def stock_value(self):
        return self.average_cost * self.on_hand


class InventoryTransaction(AppendOnlyModel):
    """One movement of stock.  Immutable: corrections are new rows."""

    branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="inventory_transactions"
    )
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="inventory_transactions"
    )
    transaction_type = models.CharField(max_length=24, choices=TransactionType.choices)
    quantity = models.IntegerField(help_text="Signed delta applied by this row.")
    unit_cost = money_field(null=True, blank=True, default=None)

    on_hand_after = models.IntegerField()
    reserved_after = models.IntegerField()

    reference_type = models.CharField(max_length=32, blank=True, db_index=True)
    reference_id = models.CharField(max_length=64, blank=True, db_index=True)
    reason = models.TextField(blank=True)
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "inventory_inventorytransaction"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["branch", "variant", "-created_at"]),
            models.Index(fields=["reference_type", "reference_id"]),
            models.Index(fields=["transaction_type", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.transaction_type} {self.quantity:+d} {self.variant_id} @ {self.branch_id}"


class TransferStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    IN_TRANSIT = "IN_TRANSIT", "In transit"
    RECEIVED = "RECEIVED", "Received"
    CANCELLED = "CANCELLED", "Cancelled"


class StockTransfer(BaseModel):
    number = models.CharField(max_length=32, unique=True)
    source_branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="transfers_out"
    )
    target_branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="transfers_in"
    )
    status = models.CharField(
        max_length=16, choices=TransferStatus.choices, default=TransferStatus.DRAFT
    )
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    #: When the goods left the source. Set by `inventory.services.transfer`,
    #: which is also when the source's stock is reduced.
    dispatched_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    received_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    #: Why a dispatched transfer came back instead of arriving. Mandatory on
    #: cancellation -- stock returning to the shelf without a reason is
    #: indistinguishable from stock being invented.
    cancellation_reason = models.TextField(blank=True)

    class Meta:
        db_table = "inventory_stocktransfer"
        ordering = ("-created_at",)
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(source_branch=models.F("target_branch")),
                name="inventory_transfer_distinct_branches",
            ),
            models.CheckConstraint(
                condition=(~models.Q(status="CANCELLED") | ~models.Q(cancellation_reason="")),
                name="inventory_transfer_cancellation_reason",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.number}: {self.source_branch_id} -> {self.target_branch_id}"

    @property
    def is_in_transit(self) -> bool:
        return self.status == TransferStatus.IN_TRANSIT

    @property
    def units_dispatched(self) -> int:
        return sum(item.quantity for item in self.items.all())

    @property
    def units_received(self) -> int:
        return sum(item.received_quantity or 0 for item in self.items.all())

    @property
    def units_lost(self) -> int:
        """Dispatched but never arrived. Zero until the transfer is received."""
        if self.status != TransferStatus.RECEIVED:
            return 0
        return self.units_dispatched - self.units_received


class StockTransferItem(BaseModel):
    transfer = models.ForeignKey(StockTransfer, on_delete=models.CASCADE, related_name="items")
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="+"
    )
    #: What left the source. Frozen at dispatch.
    quantity = models.PositiveIntegerField()
    #: What actually turned up. `None` until the transfer is received; equal to
    #: `quantity` unless something went missing on the way.
    received_quantity = models.PositiveIntegerField(null=True, blank=True)
    unit_cost = money_field(null=True, blank=True, default=None)

    class Meta:
        db_table = "inventory_stocktransferitem"
        constraints = [
            models.UniqueConstraint(
                fields=["transfer", "variant"], name="inventory_transferitem_uniq"
            ),
            # More cannot arrive than was sent. That is a data error, not an
            # event -- the extra units have no cost and no provenance.
            models.CheckConstraint(
                condition=models.Q(received_quantity__isnull=True)
                | models.Q(received_quantity__lte=models.F("quantity")),
                name="inventory_transferitem_received_lte_sent",
            ),
        ]

    @property
    def shortfall(self) -> int:
        if self.received_quantity is None:
            return 0
        return self.quantity - self.received_quantity


class StockCountStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    COUNTING = "COUNTING", "Counting"
    APPLIED = "APPLIED", "Applied"
    CANCELLED = "CANCELLED", "Cancelled"


class StockCount(BaseModel):
    """A physical stock take.  Applying it writes ADJUSTMENT rows, never a direct set."""

    number = models.CharField(max_length=32, unique=True)
    branch = models.ForeignKey("accounts.Branch", on_delete=models.PROTECT, related_name="counts")
    status = models.CharField(
        max_length=16, choices=StockCountStatus.choices, default=StockCountStatus.DRAFT
    )
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    applied_at = models.DateTimeField(null=True, blank=True)
    applied_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "inventory_stockcount"
        ordering = ("-created_at",)

    def __str__(self) -> str:
        return self.number


class StockCountItem(BaseModel):
    stock_count = models.ForeignKey(StockCount, on_delete=models.CASCADE, related_name="items")
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="+"
    )
    expected_quantity = models.IntegerField(default=0)
    counted_quantity = models.IntegerField(null=True, blank=True)
    notes = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "inventory_stockcountitem"
        constraints = [
            models.UniqueConstraint(
                fields=["stock_count", "variant"], name="inventory_countitem_uniq"
            )
        ]

    @property
    def difference(self) -> int | None:
        if self.counted_quantity is None:
            return None
        return self.counted_quantity - self.expected_quantity


class StockExceptionStatus(models.TextChoices):
    OPEN = "OPEN", "Open"
    RESOLVED = "RESOLVED", "Resolved"


class StockExceptionResolution(models.TextChoices):
    RESTOCKED = "RESTOCKED", "Stock arrived and covers it"
    WRITTEN_OFF = "WRITTEN_OFF", "Written off as lost"
    COUNTED = "COUNTED", "Corrected by a stock count"
    NOT_AN_ERROR = "NOT_AN_ERROR", "Expected — no action needed"


class StockException(BaseModel):
    """A movement that left `on_hand` below zero.

    "Never oversell" is the rule the inventory engine exists to enforce
    (CLAUDE.md §3.2), and it holds for every online path. There is exactly one
    case where it is deliberately relaxed: a sale that already happened at the
    counter while the register could not reach the server. The customer has
    walked out with the goods, so refusing the sale afterwards would make the
    ledger describe a world that does not exist —
    [offline-pos.md](../../docs/architecture/offline-pos.md) settles that in
    advance: accept it, go negative, and raise this for a manager.

    That doc also names this table as the **precondition** for offline POS:
    negative stock may only be permitted once somebody is guaranteed to see it.
    So this exists first, and it is written by `inventory.services` at the one
    choke point every movement passes through — nothing else may create one.

    Detection could have been derived (any `InventoryTransaction` with
    `on_hand_after < 0`), but the *resolution* cannot: who looked at it, what
    they concluded and when is state, not a query.
    """

    branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="stock_exceptions"
    )
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="stock_exceptions"
    )
    #: The ledger row that took it negative. PROTECT: the evidence must outlive
    #: any tidying up of the exception itself.
    transaction = models.OneToOneField(
        InventoryTransaction, on_delete=models.PROTECT, related_name="stock_exception"
    )

    #: How far below zero this movement left the stock, as a positive number.
    shortfall = models.PositiveIntegerField()
    on_hand_after = models.IntegerField(
        help_text="Balance immediately after the movement. Negative, by definition."
    )
    #: Copied from the transaction so the sale is findable without a join, and
    #: still findable if the reference is later archived.
    reference_type = models.CharField(max_length=32, blank=True, db_index=True)
    reference_id = models.CharField(max_length=64, blank=True, db_index=True)

    status = models.CharField(
        max_length=16, choices=StockExceptionStatus.choices, default=StockExceptionStatus.OPEN
    )
    resolution = models.CharField(
        max_length=16, choices=StockExceptionResolution.choices, blank=True
    )
    resolution_note = models.TextField(blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "inventory_stockexception"
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["status", "-created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(shortfall__gt=0),
                name="inventory_stockexception_shortfall_positive",
            ),
            # A resolved exception must say how, and an open one must not
            # pretend to have been resolved.
            models.CheckConstraint(
                condition=(
                    models.Q(status="OPEN", resolution="", resolved_at__isnull=True)
                    | models.Q(status="RESOLVED", resolved_at__isnull=False)
                    & ~models.Q(resolution="")
                ),
                name="inventory_stockexception_resolution_consistent",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.variant.sku} short {self.shortfall} at {self.branch.code}"

    @property
    def is_open(self) -> bool:
        return self.status == StockExceptionStatus.OPEN
