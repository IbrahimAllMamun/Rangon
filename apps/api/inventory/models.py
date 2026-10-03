"""Inventory: cached stock position + append-only ledger.

See docs/architecture/inventory.md and ADR-0004.  Nothing outside
inventory.services may write on_hand or reserved.
"""

from __future__ import annotations

from django.db import models

from core.models import AppendOnlyModel, BaseModel, idempotency_key_field, money_field


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
#: Keyed by ``str`` rather than by the enum: callers hold a validated
#: ``transaction_type: str`` (see ``inventory.services.apply_transaction``), and
#: ``TextChoices`` members *are* strings, so both forms hash to the same bucket.
TRANSACTION_SIGN: dict[str, int] = {
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

#: Movements that bring units in *with the cost that bought them*. A branch
#: that has had one of these for a variant has a cost basis for it, so a counted
#: surplus can be written in at that branch's weighted average. A branch that
#: has not has only the column default of 0.00, and stock counted in at that is
#: stock worth nothing (D72, business-rules.md § 4.0a). The CSV import receives
#: through `receive_stock`, so its rows are `PURCHASE` too.
COST_BEARING_INBOUND = {
    TransactionType.PURCHASE,
    TransactionType.TRANSFER_IN,
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
    #: Set only by the paths that accept an `Idempotency-Key` header; see
    #: `core.models.idempotency_key_field`.
    idempotency_key = idempotency_key_field()

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
    received_at = models.DateTimeField(null=True, blank=True)
    received_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    #: Set only by the paths that accept an `Idempotency-Key` header; see
    #: `core.models.idempotency_key_field`.
    idempotency_key = idempotency_key_field()

    class Meta:
        db_table = "inventory_stocktransfer"
        ordering = ("-created_at",)
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(source_branch=models.F("target_branch")),
                name="inventory_transfer_distinct_branches",
            )
        ]

    def __str__(self) -> str:
        return f"{self.number}: {self.source_branch_id} -> {self.target_branch_id}"


class StockTransferItem(BaseModel):
    transfer = models.ForeignKey(StockTransfer, on_delete=models.CASCADE, related_name="items")
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="+"
    )
    quantity = models.PositiveIntegerField()
    unit_cost = money_field(null=True, blank=True, default=None)

    class Meta:
        db_table = "inventory_stocktransferitem"
        constraints = [
            models.UniqueConstraint(
                fields=["transfer", "variant"], name="inventory_transferitem_uniq"
            )
        ]


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


class LabelPrint(AppendOnlyModel):
    """A branch saying it has, or has not, finished printing a variant's labels.

    The label screen lists every variant of a product beside its stock, and
    whoever is at the printer ticks each one off as its stickers come out. This
    row is that tick, kept so the next person -- or the same one tomorrow --
    can see which sizes are done without counting stickers on the rail.

    Append-only, like the ledger beside it. Un-ticking a variant writes a new
    row with ``printed=False`` rather than deleting or editing the old one, so
    the current state is simply the newest row for the branch and variant, and
    nothing anyone marked is lost to a mis-click. The references are PROTECT
    for the same reason: a variant whose labels are on physical stock is
    archived, not deleted (``ProductVariantViewSet.perform_destroy``), so the
    barcode on those stickers keeps resolving.

    Per branch, because labels go on the units a branch holds: one shop having
    printed for its twelve says nothing about the other shop's five.

    ``on_hand`` is read by the server from the stock row at marking time and is
    never taken from the browser (CLAUDE.md section 3.4). Nothing here moves
    stock; it only records what a person did with a printer.
    """

    branch = models.ForeignKey(
        "accounts.Branch", on_delete=models.PROTECT, related_name="label_prints"
    )
    variant = models.ForeignKey(
        "catalog.ProductVariant", on_delete=models.PROTECT, related_name="label_prints"
    )
    printed = models.BooleanField(
        default=True, help_text="False is an un-mark: the newest row is the state."
    )
    quantity = models.PositiveIntegerField(
        default=0, help_text="Labels the person reported printing in this run."
    )
    on_hand = models.IntegerField(default=0, help_text="Stock at the branch when this was marked.")
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "inventory_labelprint"
        ordering = ("-created_at",)
        indexes = [
            # The label sheet: the newest mark per variant at one branch
            # (`inventory.labels.latest_marks`, a DISTINCT ON over this order).
            models.Index(fields=["branch", "variant", "-created_at"]),
        ]

    def __str__(self) -> str:
        state = "printed" if self.printed else "not printed"
        return f"{self.variant_id} @ {self.branch_id}: {state} ({self.quantity})"
