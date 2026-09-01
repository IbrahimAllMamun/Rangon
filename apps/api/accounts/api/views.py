from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.api.serializers import (
    AuditLogSerializer,
    BranchSerializer,
    LoginSerializer,
    MeSerializer,
    OrganizationSerializer,
    PasswordChangeSerializer,
    PermissionSerializer,
    RegisterSerializer,
    RoleSerializer,
    TaxSettingsSerializer,
    UserSerializer,
    UserWriteSerializer,
)
from accounts.models import Branch, Permission, Role, RoleCode, User
from accounts.permissions import RolePermission
from accounts.services import get_organization, priced_order_count, update_tax_settings
from core import audit
from core.middleware import get_audit_context
from core.models import AuditLog
from customers.models import Customer, CustomerType


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"
    serializer_class = LoginSerializer

    def post(self, request: Request) -> Response:
        serializer = LoginSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            audit.record(
                action=audit.AuditAction.LOGIN_FAILED,
                entity_type="User",
                entity_label=str(request.data.get("email", ""))[:255],
                reason="Invalid credentials",
            )
            return Response(
                {
                    "error": {
                        "code": "AUTHENTICATION_REQUIRED",
                        "message": "Incorrect email address or password.",
                        "details": {},
                    }
                },
                status=status.HTTP_401_UNAUTHORIZED,
            )

        user = serializer.validated_data["user"]
        tokens = LoginSerializer.tokens_for(user)

        user.last_login = timezone.now()
        user.last_login_ip = get_audit_context().get("ip_address")
        user.save(update_fields=["last_login", "last_login_ip"])

        audit.record(action=audit.AuditAction.LOGIN, entity=user, actor=user)
        return Response({**tokens, "user": MeSerializer(user).data})


class RefreshView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request: Request) -> Response:
        token = request.data.get("refresh")
        if not token:
            return Response(
                {
                    "error": {
                        "code": "VALIDATION_ERROR",
                        "message": "refresh is required.",
                        "details": {"refresh": ["Required."]},
                    }
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            refresh = RefreshToken(token)
            access = str(refresh.access_token)
            refresh.blacklist()  # rotation: the old refresh token dies here
            new_refresh = str(RefreshToken.for_user(User.objects.get(pk=refresh["user_id"])))
        except (TokenError, User.DoesNotExist):
            return Response(
                {
                    "error": {
                        "code": "AUTHENTICATION_REQUIRED",
                        "message": "That session has expired. Please sign in again.",
                        "details": {},
                    }
                },
                status=status.HTTP_401_UNAUTHORIZED,
            )
        return Response({"access": access, "refresh": new_refresh})


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request: Request) -> Response:
        token = request.data.get("refresh")
        if token:
            try:
                RefreshToken(token).blacklist()
            except TokenError:
                pass  # already expired or unknown — logging out is still a success
        audit.record(action=audit.AuditAction.LOGOUT, entity=request.user, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        return Response(MeSerializer(request.user).data)


class RegisterView(GenericAPIView):
    """Customer registration.  Always creates a CUSTOMER; role is never client-supplied."""

    permission_classes = [AllowAny]
    throttle_scope = "auth"
    serializer_class = RegisterSerializer

    @transaction.atomic
    def post(self, request: Request) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        user = User.objects.create_user(
            email=data["email"],
            password=data["password"],
            first_name=data.get("first_name", ""),
            last_name=data.get("last_name", ""),
            phone=data.get("phone", ""),
            role=Role.objects.get(code=RoleCode.CUSTOMER),
            organization=get_organization(),
        )
        phone = (data.get("phone") or "").strip()
        customer = Customer.objects.filter(phone=phone).first() if phone else None
        if customer is None:
            customer = Customer.objects.create(
                name=user.full_name,
                email=user.email,
                phone=phone or None,
                customer_type=CustomerType.REGISTERED,
            )
        customer.user = user
        customer.customer_type = CustomerType.REGISTERED
        customer.save(update_fields=["user", "customer_type", "updated_at"])

        tokens = LoginSerializer.tokens_for(user)
        return Response({**tokens, "user": MeSerializer(user).data}, status=status.HTTP_201_CREATED)


class PasswordChangeView(GenericAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = PasswordChangeSerializer

    def post(self, request: Request) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        user.set_password(serializer.validated_data["new_password"])
        user.save(update_fields=["password"])
        audit.record(
            action=audit.AuditAction.USER_CHANGED,
            entity=user,
            actor=user,
            reason="Password changed",
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class OrganizationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        organization = get_organization()
        if organization is None:
            return Response({"detail": "No organisation configured."}, status=404)
        return Response(OrganizationSerializer(organization).data)

    def patch(self, request: Request) -> Response:
        if not request.user.has_perm_code("settings.manage"):
            return Response(
                {"error": {"code": "PERMISSION_DENIED", "message": "Not allowed.", "details": {}}},
                status=403,
            )
        organization = get_organization()
        serializer = OrganizationSerializer(organization, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        before = OrganizationSerializer(organization).data
        serializer.save()
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=organization,
            actor=request.user,
            old_values=dict(before),
            new_values=dict(serializer.data),
        )
        return Response(serializer.data)


class OrganizationTaxView(APIView):
    """Settle the VAT treatment — decision D-C in docs/business-rules.md.

    Separate from PATCH /organization/ on purpose: this is the one setting that
    changes how money is calculated, so it goes through a service that audits
    the change and refuses an unconfirmed one once orders exist.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        if not request.user.has_perm_code("settings.view"):
            return Response(
                {"error": {"code": "PERMISSION_DENIED", "message": "Not allowed.", "details": {}}},
                status=403,
            )
        organization = get_organization()
        if organization is None:
            return Response({"detail": "No organisation configured."}, status=404)
        return Response(
            {
                "tax_mode": organization.tax_mode,
                "default_tax_rate": str(organization.default_tax_rate),
                "tax_settled_at": organization.tax_settled_at,
                "tax_settled_by_name": (
                    organization.tax_settled_by.full_name if organization.tax_settled_by else ""
                ),
                "is_settled": organization.tax_is_settled,
                "priced_order_count": priced_order_count(),
            }
        )

    def patch(self, request: Request) -> Response:
        if not request.user.has_perm_code("settings.manage"):
            return Response(
                {"error": {"code": "PERMISSION_DENIED", "message": "Not allowed.", "details": {}}},
                status=403,
            )
        serializer = TaxSettingsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        organization = update_tax_settings(
            tax_mode=data["tax_mode"],
            default_tax_rate=data["default_tax_rate"],
            actor=request.user,
            confirm_historical=data["confirm"],
            reason=data.get("reason", ""),
        )
        return Response(
            {
                "tax_mode": organization.tax_mode,
                "default_tax_rate": str(organization.default_tax_rate),
                "tax_settled_at": organization.tax_settled_at,
                "tax_settled_by_name": (
                    organization.tax_settled_by.full_name if organization.tax_settled_by else ""
                ),
                "is_settled": organization.tax_is_settled,
                "priced_order_count": priced_order_count(),
            }
        )


class BranchViewSet(viewsets.ModelViewSet):
    queryset = Branch.objects.select_related("organization").all()
    serializer_class = BranchSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["settings.view"],
        "retrieve": ["settings.view"],
        "create": ["settings.manage"],
        "update": ["settings.manage"],
        "partial_update": ["settings.manage"],
        "destroy": ["settings.manage"],
    }

    def perform_create(self, serializer: Any) -> None:
        serializer.save(organization=get_organization())


class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.select_related("role", "branch").exclude(role__code=RoleCode.CUSTOMER)
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["users.view"],
        "retrieve": ["users.view"],
        "create": ["users.manage"],
        "update": ["users.manage"],
        "partial_update": ["users.manage"],
        "destroy": ["users.manage"],
        "deactivate": ["users.manage"],
        "activate": ["users.manage"],
    }
    filterset_fields = ["status", "branch", "role"]
    search_fields = ["email", "first_name", "last_name"]
    ordering_fields = ["email", "date_joined"]

    def get_serializer_class(self) -> Any:
        if self.action in {"create", "update", "partial_update"}:
            return UserWriteSerializer
        return UserSerializer

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        # Staff are deactivated, never deleted: their audit trail must survive.
        return self.deactivate(request, *args, **kwargs)

    @action(detail=True, methods=["post"])
    def deactivate(self, request: Request, pk: str | None = None) -> Response:
        from accounts.services import check_can_lose_access, set_user_status

        user = self.get_object()
        # Same guards as the PATCH path, in the service, so neither route can
        # lock the caller -- or the whole organisation -- out.
        check_can_lose_access(user=user, actor=request.user, what="deactivate")
        set_user_status(
            user=user,
            status="INACTIVE",
            actor=request.user,
            reason=request.data.get("reason", ""),
        )
        return Response(UserSerializer(user).data)

    @action(detail=True, methods=["post"])
    def activate(self, request: Request, pk: str | None = None) -> Response:
        from accounts.services import set_user_status

        user = set_user_status(user=self.get_object(), status="ACTIVE", actor=request.user)
        return Response(UserSerializer(user).data)


class RoleViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = Role.objects.prefetch_related("permissions").all()
    serializer_class = RoleSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["users.view"]
    pagination_class = None


class PermissionViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    queryset = Permission.objects.all()
    serializer_class = PermissionSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["users.view"]
    pagination_class = None


class AuditLogViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = AuditLog.objects.select_related("actor").all()
    serializer_class = AuditLogSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["audit.view"]
    filterset_fields = ["action", "entity_type", "actor"]
    ordering_fields = ["created_at"]
