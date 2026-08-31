from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import (
    Branch,
    Organization,
    Permission,
    Role,
    RoleCode,
    Status,
    TaxMode,
    User,
)
from core.models import AuditLog


class BranchSerializer(serializers.ModelSerializer):
    class Meta:
        model = Branch
        fields = [
            "id",
            "name",
            "code",
            "address",
            "phone",
            "email",
            "is_default",
            "fulfils_online_orders",
            "register_count",
            "status",
            "created_at",
        ]
        read_only_fields = ["id", "created_at"]


class OrganizationSerializer(serializers.ModelSerializer):
    branches = BranchSerializer(many=True, read_only=True)
    tax_settled_by_name = serializers.CharField(
        source="tax_settled_by.full_name", read_only=True, default=""
    )

    class Meta:
        model = Organization
        fields = [
            "id",
            "name",
            "slug",
            "legal_name",
            "status",
            "email",
            "phone",
            "address",
            "vat_registration",
            "currency",
            "receipt_footer",
            "tax_mode",
            "default_tax_rate",
            "tax_settled_at",
            "tax_settled_by_name",
            "branches",
        ]
        # The VAT fields are readable here but only writable through
        # PATCH /organization/tax/, which is the path that carries the
        # confirmation guard and the audit entry.  Leaving them writable on the
        # generic PATCH would let a change slip through with neither.
        read_only_fields = [
            "id",
            "slug",
            "tax_mode",
            "default_tax_rate",
            "tax_settled_at",
            "tax_settled_by_name",
        ]


class TaxSettingsSerializer(serializers.Serializer):
    """Input for settling the VAT decision (docs/business-rules.md §3.4)."""

    tax_mode = serializers.ChoiceField(choices=TaxMode.choices)
    default_tax_rate = serializers.DecimalField(
        max_digits=6,
        decimal_places=4,
        min_value=Decimal("0"),
        max_value=Decimal("1"),
        help_text="A fraction, not a percentage: 0.0750 is 7.5%.",
    )
    confirm = serializers.BooleanField(
        default=False,
        help_text=(
            "Required once orders exist, to acknowledge that reports " "will span two treatments."
        ),
    )
    reason = serializers.CharField(required=False, allow_blank=True, max_length=500)


class PermissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Permission
        fields = ["id", "code", "name", "group", "description"]


class RoleSerializer(serializers.ModelSerializer):
    permissions = serializers.SlugRelatedField(
        many=True, slug_field="code", queryset=Permission.objects.all(), required=False
    )

    class Meta:
        model = Role
        fields = ["id", "code", "name", "description", "is_staff_role", "is_system", "permissions"]
        read_only_fields = ["id", "is_system"]


class UserSerializer(serializers.ModelSerializer):
    role_code = serializers.CharField(source="role.code", read_only=True)
    role_name = serializers.CharField(source="role.name", read_only=True)
    branch_name = serializers.CharField(source="branch.name", read_only=True, default="")
    full_name = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "first_name",
            "last_name",
            "full_name",
            "phone",
            "status",
            "role",
            "role_code",
            "role_name",
            "branch",
            "branch_name",
            "date_joined",
            "last_login",
        ]
        read_only_fields = ["id", "date_joined", "last_login"]


class UserWriteSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, min_length=10)
    role_code = serializers.ChoiceField(choices=RoleCode.choices, write_only=True, required=False)

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "first_name",
            "last_name",
            "phone",
            "status",
            "branch",
            "password",
            "role_code",
        ]

    def validate_password(self, value: str) -> str:
        validate_password(value)
        return value

    def create(self, validated_data: dict[str, Any]) -> User:
        from accounts.services import create_staff_user

        password = validated_data.pop("password", None)
        role_code = validated_data.pop("role_code", RoleCode.CASHIER)
        if not password:
            raise serializers.ValidationError({"password": ["A password is required."]})
        return create_staff_user(
            email=validated_data["email"],
            password=password,
            role_code=role_code,
            branch=validated_data.get("branch"),
            first_name=validated_data.get("first_name", ""),
            last_name=validated_data.get("last_name", ""),
            phone=validated_data.get("phone", ""),
            actor=self.context["request"].user,
        )

    def update(self, instance: User, validated_data: dict[str, Any]) -> User:
        password = validated_data.pop("password", None)
        role_code = validated_data.pop("role_code", None)
        if role_code:
            instance.role = Role.objects.get(code=role_code)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
        instance.save()
        return instance


class MeSerializer(serializers.ModelSerializer):
    role = serializers.CharField(source="role.code", read_only=True, default="")
    role_name = serializers.CharField(source="role.name", read_only=True, default="")
    branch = BranchSerializer(read_only=True)
    permissions = serializers.SerializerMethodField()
    organization = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "first_name",
            "last_name",
            "full_name",
            "phone",
            "role",
            "role_name",
            "branch",
            "permissions",
            "organization",
            "status",
        ]

    def get_permissions(self, user: User) -> list[str]:
        return sorted(user.permission_codes())

    def get_organization(self, user: User) -> dict[str, Any] | None:
        organization = user.organization
        if organization is None:
            from accounts.services import get_organization

            organization = get_organization()
        if organization is None:
            return None
        return {
            "id": str(organization.pk),
            "name": organization.name,
            "currency": organization.currency,
            "receipt_footer": organization.receipt_footer,
        }


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        request = self.context.get("request")
        user = authenticate(
            request, username=attrs["email"].lower().strip(), password=attrs["password"]
        )
        if user is None:
            # Deliberately identical message for wrong email and wrong password.
            raise serializers.ValidationError({"detail": "Incorrect email address or password."})
        if user.status != Status.ACTIVE:
            raise serializers.ValidationError({"detail": "This account is not active."})
        attrs["user"] = user
        return attrs

    @staticmethod
    def tokens_for(user: User) -> dict[str, str]:
        refresh = RefreshToken.for_user(user)
        return {"access": str(refresh.access_token), "refresh": str(refresh)}


class RegisterSerializer(serializers.Serializer):
    """Customer self-registration only — staff accounts are created by an admin."""

    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=10)
    first_name = serializers.CharField(required=False, allow_blank=True, max_length=80)
    last_name = serializers.CharField(required=False, allow_blank=True, max_length=80)
    phone = serializers.CharField(required=False, allow_blank=True, max_length=32)

    def validate_email(self, value: str) -> str:
        if User.objects.filter(email__iexact=value.strip()).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value.lower().strip()

    def validate_password(self, value: str) -> str:
        validate_password(value)
        return value


class PasswordChangeSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=10)

    def validate_current_password(self, value: str) -> str:
        user = self.context["request"].user
        if not user.check_password(value):
            raise serializers.ValidationError("Your current password is incorrect.")
        return value

    def validate_new_password(self, value: str) -> str:
        validate_password(value, self.context["request"].user)
        return value


class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor_label", read_only=True)

    class Meta:
        model = AuditLog
        fields = [
            "id",
            "actor",
            "actor_email",
            "action",
            "entity_type",
            "entity_id",
            "entity_label",
            "old_values",
            "new_values",
            "reason",
            "ip_address",
            "request_id",
            "created_at",
        ]
