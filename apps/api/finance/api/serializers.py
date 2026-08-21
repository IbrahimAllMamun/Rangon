from __future__ import annotations

from typing import Any

from rest_framework import serializers

from finance.models import (
    Account,
    AccountKind,
    AccountTransaction,
    AccountTransactionType,
    AccountTransfer,
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


class CashPositionSerializer(serializers.Serializer):
    """Shape returned by /accounts/cash-position/, for the schema."""

    total = serializers.DecimalField(max_digits=16, decimal_places=2)
    by_kind = serializers.ListField(child=serializers.DictField())
    accounts = serializers.ListField(child=serializers.DictField())


ACCOUNT_KINDS = [{"value": value, "label": label} for value, label in AccountKind.choices]
