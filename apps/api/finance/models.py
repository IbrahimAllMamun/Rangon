"""Finance: cached account balances + an append-only cash book.

This is deliberately the same shape as the inventory engine (see
docs/architecture/inventory.md).  ``Account.balance`` is a transactional cache
over ``AccountTransaction`` exactly as ``Inventory.on_hand`` is a cache over
``InventoryTransaction``, and ``finance.services.verify_integrity()`` proves the
two still agree.

Nothing outside ``finance.services`` may write ``Account.balance``.

See docs/architecture/finance.md and ADR-0011.
"""

from __future__ import annotations

from django.db import models

from core.models import AppendOnlyModel, BaseModel, money_field


class AccountKind(models.TextChoices):
    CASH = "CASH", "Cash drawer"
    BANK = "BANK", "Bank account"
    MFS = "MFS", "Mobile financial service"
    OTHER = "OTHER", "Other"


class AccountTransactionType(models.TextChoices):
    OPENING = "OPENING", "Opening balance"
    SALE_PAYMENT = "SALE_PAYMENT", "Payment received from a customer"
    REFUND = "REFUND", "Refund paid to a customer"
    SUPPLIER_PAYMENT = "SUPPLIER_PAYMENT", "Payment made to a supplier"
    EXPENSE = "EXPENSE", "Expense paid"
    TRANSFER_IN = "TRANSFER_IN", "Transfer in"
    TRANSFER_OUT = "TRANSFER_OUT", "Transfer out"
    DEPOSIT = "DEPOSIT", "Manual deposit"
    WITHDRAWAL = "WITHDRAWAL", "Manual withdrawal"
    ADJUSTMENT = "ADJUSTMENT", "Correction"


#: Sign applied to the absolute amount supplied by the caller.
#:
#: ADJUSTMENT is 0 because the caller states the delta itself, exactly as
#: inventory.models.TRANSACTION_SIGN does for stock adjustments.
TRANSACTION_SIGN: dict[str, int] = {
    AccountTransactionType.OPENING: 1,
    AccountTransactionType.SALE_PAYMENT: 1,
    AccountTransactionType.REFUND: -1,
    AccountTransactionType.SUPPLIER_PAYMENT: -1,
    AccountTransactionType.EXPENSE: -1,
    AccountTransactionType.TRANSFER_IN: 1,
    AccountTransactionType.TRANSFER_OUT: -1,
    AccountTransactionType.DEPOSIT: 1,
    AccountTransactionType.WITHDRAWAL: -1,
    AccountTransactionType.ADJUSTMENT: 0,
}

#: An unexplained movement of money is a red flag, the same way an unexplained
#: stock change is (inventory.models.REASON_REQUIRED).
REASON_REQUIRED = {
    AccountTransactionType.ADJUSTMENT,
    AccountTransactionType.WITHDRAWAL,
}

#: Which kind of account a payment method's money lands in, when the caller
#: does not name an account.  docs/business-rules.md section 12.2.
METHOD_TO_KIND: dict[str, str] = {
    "CASH": AccountKind.CASH,
    "CARD": AccountKind.BANK,
    "BANK": AccountKind.BANK,
    "MOBILE_MFS": AccountKind.MFS,
    "ONLINE_GATEWAY": AccountKind.BANK,
    "COD": AccountKind.CASH,
    "CHEQUE": AccountKind.BANK,
    "STORE_CREDIT": AccountKind.OTHER,
    "OTHER": AccountKind.OTHER,
}


class Account(BaseModel):
    """A place money actually sits: a drawer, a bank account, a bKash wallet.

    There is no chart of accounts.  This is a flat list per branch, which is
    what was decided — docs/business-rules.md section 12.1 (decision D-B).
    """

    branch = models.ForeignKey("accounts.Branch", on_delete=models.PROTECT, related_name="accounts")
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=16, choices=AccountKind.choices, default=AccountKind.CASH)
    account_number = models.CharField(
        max_length=64, blank=True, help_text="Bank account or MFS wallet number, if any."
    )
    bank_name = models.CharField(max_length=120, blank=True)

    balance = money_field(
        help_text="Transactional cache over AccountTransaction. Written only by finance.services."
    )

    is_active = models.BooleanField(default=True)
    is_default = models.BooleanField(
        default=False, help_text="Where this branch's money of this kind lands by default."
    )
    allow_overdraft = models.BooleanField(
        default=False,
        help_text="A cash drawer cannot go negative; a bank account with an overdraft line can.",
    )

    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "finance_account"
        ordering = ("branch__name", "kind", "name")
        constraints = [
            models.UniqueConstraint(
                fields=["branch", "name"], name="finance_account_branch_name_uniq"
            ),
            # One default per (branch, kind), so resolution is never ambiguous.
            models.UniqueConstraint(
                fields=["branch", "kind"],
                condition=models.Q(is_default=True),
                name="finance_account_branch_kind_default_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["branch", "kind"]),
            models.Index(fields=["is_active", "branch"]),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.get_kind_display()})"


class AccountTransaction(AppendOnlyModel):
    """One movement of money.  Immutable: corrections are new rows.

    ``amount`` is signed -- positive is money in, negative is money out -- so
    the balance is always ``SUM(amount)`` with no per-type special cases.
    """

    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="transactions")
    transaction_type = models.CharField(max_length=24, choices=AccountTransactionType.choices)
    amount = money_field(help_text="Signed delta applied by this row.")
    balance_after = money_field()

    reference_type = models.CharField(max_length=32, blank=True, db_index=True)
    reference_id = models.CharField(max_length=64, blank=True, db_index=True)
    reason = models.TextField(blank=True)
    notes = models.TextField(blank=True)

    occurred_at = models.DateTimeField(
        db_index=True, help_text="When the money actually moved, which may predate the entry."
    )
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "finance_accounttransaction"
        ordering = ("-occurred_at", "-created_at")
        indexes = [
            models.Index(fields=["account", "-occurred_at"]),
            models.Index(fields=["reference_type", "reference_id"]),
            models.Index(fields=["transaction_type", "-occurred_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.transaction_type} {self.amount:+} on {self.account_id}"


class AccountTransfer(BaseModel):
    """Money moved between two of the business's own accounts.

    A bank run, a drawer float, a bKash cash-out.  Never crosses the business
    boundary -- that is a payment, an expense or a refund.
    """

    number = models.CharField(max_length=32, unique=True)
    source_account = models.ForeignKey(
        Account, on_delete=models.PROTECT, related_name="transfers_out"
    )
    target_account = models.ForeignKey(
        Account, on_delete=models.PROTECT, related_name="transfers_in"
    )
    amount = money_field()
    occurred_at = models.DateTimeField()
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "finance_accounttransfer"
        ordering = ("-occurred_at",)
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0), name="finance_accounttransfer_amount_gt_0"
            ),
            models.CheckConstraint(
                condition=~models.Q(source_account=models.F("target_account")),
                name="finance_accounttransfer_distinct_accounts",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.number}: {self.amount}"
