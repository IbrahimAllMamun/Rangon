from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.conf import settings
from django.utils import timezone
from rest_framework import serializers

from accounts.models import Branch
from finance.models import (
    Account,
    AccountKind,
    AccountTransaction,
    AccountTransactionType,
    AccountTransfer,
    Expense,
    ExpenseCategory,
)


class AccountSerializer(serializers.ModelSerializer):
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    branch_name = serializers.CharField(source="branch.name", read_only=True)
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)

    # Write-only, and only honoured on create: an opening balance is an
    # OPENING ledger row, not a column, so it cannot be "edited" later.
    opening_balance = serializers.DecimalField(
        max_digits=14, decimal_places=2, write_only=True, required=False
    )

    class Meta:
        model = Account
        fields = [
            "id",
            "branch",
            "branch_code",
            "branch_name",
            "name",
            "kind",
            "kind_display",
            "account_number",
            "bank_name",
            "balance",
            "is_active",
            "is_default",
            "allow_overdraft",
            "notes",
            "opening_balance",
            "created_at",
            "updated_at",
        ]
        # `balance` is a cache over the ledger. Exposing it as writable would
        # invite exactly the bug this app exists to prevent.
        read_only_fields = ["id", "balance", "created_at", "updated_at"]


class AccountTransactionSerializer(serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True)
    account_kind = serializers.CharField(source="account.kind", read_only=True)
    branch_code = serializers.CharField(source="account.branch.code", read_only=True)
    type_display = serializers.CharField(source="get_transaction_type_display", read_only=True)
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")

    class Meta:
        model = AccountTransaction
        fields = [
            "id",
            "account",
            "account_name",
            "account_kind",
            "branch_code",
            "transaction_type",
            "type_display",
            "amount",
            "balance_after",
            "reference_type",
            "reference_id",
            "reason",
            "notes",
            "occurred_at",
            "created_by_email",
            "created_at",
        ]
        read_only_fields = fields


class RecordMovementSerializer(serializers.Serializer):
    """A manual cash-book entry: a deposit, a withdrawal or a correction.

    Movements caused by a sale, a refund or a supplier payment are posted by
    those services and are deliberately not creatable here -- entering one by
    hand would double-count the money.
    """

    MANUAL_TYPES = [
        AccountTransactionType.DEPOSIT,
        AccountTransactionType.WITHDRAWAL,
        AccountTransactionType.ADJUSTMENT,
    ]

    account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.all())
    transaction_type = serializers.ChoiceField(choices=MANUAL_TYPES)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    reason = serializers.CharField(allow_blank=True, required=False, default="")
    notes = serializers.CharField(allow_blank=True, required=False, default="")
    occurred_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        kind = attrs["transaction_type"]
        amount = attrs["amount"]
        if kind == AccountTransactionType.ADJUSTMENT:
            if amount == 0:
                raise serializers.ValidationError(
                    {"amount": "An adjustment of zero changes nothing."}
                )
        elif amount <= 0:
            raise serializers.ValidationError({"amount": "The amount must be positive."})
        return attrs


class CreateTransferSerializer(serializers.Serializer):
    source_account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.all())
    target_account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.all())
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    notes = serializers.CharField(allow_blank=True, required=False, default="")
    occurred_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["source_account"].pk == attrs["target_account"].pk:
            raise serializers.ValidationError(
                {"target_account": "Source and destination accounts must differ."}
            )
        if attrs["amount"] <= 0:
            raise serializers.ValidationError({"amount": "The amount must be positive."})
        return attrs


class AccountTransferSerializer(serializers.ModelSerializer):
    source_account_name = serializers.CharField(source="source_account.name", read_only=True)
    target_account_name = serializers.CharField(source="target_account.name", read_only=True)
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")

    class Meta:
        model = AccountTransfer
        fields = [
            "id",
            "number",
            "source_account",
            "source_account_name",
            "target_account",
            "target_account_name",
            "amount",
            "occurred_at",
            "notes",
            "created_by_email",
            "created_at",
        ]
        read_only_fields = fields


class AccountKindTotalSerializer(serializers.Serializer):
    kind = serializers.CharField()
    total = serializers.DecimalField(max_digits=16, decimal_places=2)


class AccountBalanceSerializer(serializers.Serializer):
    id = serializers.CharField()
    name = serializers.CharField()
    kind = serializers.CharField()
    branch = serializers.CharField()
    balance = serializers.DecimalField(max_digits=16, decimal_places=2)


class MovementTotalsSerializer(serializers.Serializer):
    money_in = serializers.DecimalField(max_digits=16, decimal_places=2)
    money_out = serializers.DecimalField(max_digits=16, decimal_places=2)
    net = serializers.DecimalField(max_digits=16, decimal_places=2)


class CashPositionSerializer(serializers.Serializer):
    """Shape returned by /accounts/cash-position/.

    Every figure is a `DecimalField`, so it leaves as the string `"661480.00"`
    rather than the JSON number `661480.0`.  Money crossing a boundary is never
    a float (CLAUDE.md section 4) -- and `CashPosition` in the web app's
    `types.ts` has always declared these as strings.
    """

    total = serializers.DecimalField(max_digits=16, decimal_places=2)
    by_kind = AccountKindTotalSerializer(many=True)
    accounts = AccountBalanceSerializer(many=True)
    movements = MovementTotalsSerializer()


ACCOUNT_KINDS = [{"value": value, "label": label} for value, label in AccountKind.choices]


class ExpenseCategorySerializer(serializers.ModelSerializer):
    expense_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = ExpenseCategory
        fields = [
            "id",
            "name",
            "code",
            "description",
            "is_active",
            "expense_count",
            "created_at",
            "updated_at",
        ]
        # The code is the stable key an expense was filed under. Renaming the
        # category is fine; re-keying it would re-label history.
        read_only_fields = ["id", "expense_count", "created_at", "updated_at"]
        extra_kwargs = {"code": {"required": False}}


class ExpenseSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)
    category_code = serializers.CharField(source="category.code", read_only=True)
    account_name = serializers.CharField(source="account.name", read_only=True)
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    created_by_email = serializers.CharField(source="created_by.email", read_only=True, default="")
    voided_by_email = serializers.CharField(source="voided_by.email", read_only=True, default="")
    attachment_url = serializers.SerializerMethodField()

    class Meta:
        model = Expense
        fields = [
            "id",
            "number",
            "branch",
            "branch_code",
            "category",
            "category_name",
            "category_code",
            "account",
            "account_name",
            "amount",
            "spent_at",
            "note",
            "attachment",
            "attachment_url",
            "status",
            "status_display",
            "transaction",
            "reversal",
            "voided_at",
            "voided_by_email",
            "void_reason",
            "created_by_email",
            "created_at",
        ]
        read_only_fields = fields

    def get_attachment_url(self, expense: Expense) -> str:
        if not expense.attachment:
            return ""
        request = self.context.get("request")
        url = expense.attachment.url
        return request.build_absolute_uri(url) if request else url


#: A receipt is a photo or a scanned bill. Anything executable is refused
#: outright rather than stored and served back (CLAUDE.md section 8).
ALLOWED_ATTACHMENT_TYPES = (*settings.RANGON_ALLOWED_IMAGE_TYPES, "application/pdf")
ALLOWED_ATTACHMENT_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".pdf")


class CreateExpenseSerializer(serializers.Serializer):
    """Recording an expense: what was bought, from which account, when."""

    branch = serializers.PrimaryKeyRelatedField(
        queryset=Branch.objects.all(), required=False, allow_null=True
    )
    category = serializers.PrimaryKeyRelatedField(queryset=ExpenseCategory.objects.all())
    account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.all())
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    spent_at = serializers.DateTimeField(required=False, allow_null=True)
    note = serializers.CharField(allow_blank=True, required=False, default="")
    attachment = serializers.FileField(required=False, allow_null=True)

    def validate_amount(self, value: Decimal) -> Decimal:
        if value <= 0:
            raise serializers.ValidationError("An expense must be greater than zero.")
        return value

    def validate_spent_at(self, value: Any) -> Any:
        # A future-dated expense is money that has not left yet; posting it
        # would put the cash book ahead of reality.
        if value and value > timezone.now():
            raise serializers.ValidationError("An expense cannot be dated in the future.")
        return value

    def validate_attachment(self, value: Any) -> Any:
        if not value:
            return value
        if value.size > settings.RANGON_MAX_IMAGE_BYTES:
            limit = settings.RANGON_MAX_IMAGE_BYTES // (1024 * 1024)
            raise serializers.ValidationError(f"The receipt must be smaller than {limit} MB.")
        content_type = (getattr(value, "content_type", "") or "").lower()
        if content_type and content_type not in ALLOWED_ATTACHMENT_TYPES:
            raise serializers.ValidationError("Attach an image or a PDF of the receipt.")
        if not str(value.name).lower().endswith(ALLOWED_ATTACHMENT_EXTENSIONS):
            raise serializers.ValidationError("Attach an image or a PDF of the receipt.")
        return value


class VoidExpenseSerializer(serializers.Serializer):
    reason = serializers.CharField()

    def validate_reason(self, value: str) -> str:
        if not value.strip():
            raise serializers.ValidationError("Say why this expense is being voided.")
        return value


class ExpenseCategoryTotalSerializer(serializers.Serializer):
    category_id = serializers.CharField()
    category = serializers.CharField()
    code = serializers.CharField()
    total = serializers.DecimalField(max_digits=16, decimal_places=2)
    count = serializers.IntegerField()
    share = serializers.DecimalField(max_digits=6, decimal_places=2)


class ExpenseTotalsSerializer(serializers.Serializer):
    """Shape returned by /expenses/summary/. Money leaves as a string, not a float."""

    total = serializers.DecimalField(max_digits=16, decimal_places=2)
    count = serializers.IntegerField()
    by_category = ExpenseCategoryTotalSerializer(many=True)


# --------------------------------------------------------------------------- party ledger

MONEY_FIELD = {"max_digits": 16, "decimal_places": 2}


class AgeingSerializer(serializers.Serializer):
    """Outstanding money split by how old it is."""

    current = serializers.DecimalField(**MONEY_FIELD)
    d31_60 = serializers.DecimalField(**MONEY_FIELD)
    d61_90 = serializers.DecimalField(**MONEY_FIELD)
    over_90 = serializers.DecimalField(**MONEY_FIELD)


class PartyDocumentSerializer(serializers.Serializer):
    """One order or purchase order carrying a balance."""

    id = serializers.CharField()
    number = serializers.CharField()
    dated = serializers.DateTimeField()
    due = serializers.DateTimeField(required=False)
    days = serializers.IntegerField()
    status = serializers.CharField()
    channel = serializers.CharField(required=False)
    invoice_number = serializers.CharField(required=False)
    total = serializers.DecimalField(**MONEY_FIELD)
    paid = serializers.DecimalField(**MONEY_FIELD)
    outstanding = serializers.DecimalField(**MONEY_FIELD)


class PartySerializer(serializers.Serializer):
    party_id = serializers.CharField(allow_blank=True)
    name = serializers.CharField()
    phone = serializers.CharField(allow_blank=True)
    outstanding = serializers.DecimalField(**MONEY_FIELD)
    document_count = serializers.IntegerField()
    oldest_days = serializers.IntegerField()
    ageing = AgeingSerializer()
    documents = PartyDocumentSerializer(many=True)


class PartySideSerializer(serializers.Serializer):
    total = serializers.DecimalField(**MONEY_FIELD)
    party_count = serializers.IntegerField()
    document_count = serializers.IntegerField()
    ageing = AgeingSerializer()
    parties = PartySerializer(many=True)


class PartyLedgerSerializer(serializers.Serializer):
    """Shape returned by /party-ledger/.

    Serialized rather than returned raw for the reason spelled out on
    `CashPositionSerializer`: money leaves as a string, never a JSON float.
    """

    receivable = PartySideSerializer()
    payable = PartySideSerializer()
    net_position = serializers.DecimalField(**MONEY_FIELD)
