from __future__ import annotations

from typing import Any, cast

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.utils import get_md5_hash_password

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
from accounts.services import (
    change_own_password,
    get_organization,
    mint_refresh_token,
    priced_order_count,
    update_tax_settings,
)
from core import audit
from core.dates import parse_window
from core.middleware import get_audit_context
from core.models import AuditLog
from core.requests import AuthedRequest, actor
from core.throttling import ScopedRateThrottle
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
            user = User.objects.get(pk=refresh["user_id"])
            # A deactivated account, or a token issued under a password that
            # has since changed, is signed out -- not handed a fresh pair.
            # A token with no password claim at all predates the claim
            # (2026-09-19); it is honoured, because a password change
            # blacklists it like any other (`accounts.services.end_sessions`).
            claim = refresh.get(jwt_settings.REVOKE_TOKEN_CLAIM)
            if not user.is_active or (
                claim is not None and claim != get_md5_hash_password(user.password)
            ):
                raise TokenError("This session has been signed out.")
            refresh.blacklist()  # rotation: the old refresh token dies here
            # Both tokens are minted afresh rather than the access token being
            # derived from the old refresh, so both carry the current claim.
            fresh = mint_refresh_token(user)
            access, new_refresh = str(fresh.access_token), str(fresh)
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
    """End the session a refresh token belongs to.

    Holding the refresh token *is* the credential, so no access token is asked
    for. One used to be (`IsAuthenticated`), and an access token lives thirty
    minutes -- as does the cookie carrying it. Sign out after half an hour away
    from the counter and the API answered 401, the web route cleared the
    cookies regardless, and the refresh token stayed good for the rest of its
    fourteen days: the one case the route exists for (D92).

    No throttle, deliberately. There is nothing here to guess -- a refresh
    token is signed -- and a 429 would leave the token alive, which is this
    defect again by another road.

    Always 204: signing out of a session that is already over is not an error,
    and the answer does not say whether the token was live.
    """

    authentication_classes = ()
    permission_classes = [AllowAny]
    throttle_classes = ()

    def post(self, request: Request) -> Response:
        token = request.data.get("refresh")
        if token:
            try:
                refresh = RefreshToken(token)
                user = User.objects.filter(pk=refresh["user_id"]).first()
                refresh.blacklist()
            except TokenError:
                user = None  # expired, already rotated or signed out, or not ours
            if user is not None:
                audit.record(action=audit.AuditAction.LOGOUT, entity=user, actor=user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request: AuthedRequest) -> Response:
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
        # Already canonical: `RegisterSerializer.phone` normalises it, so the
        # match is against the one spelling the table stores.
        phone = data.get("phone") or ""
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
    """Change your own password, and sign every other session out.

    Answers with a fresh token pair for the session that made the change --
    every token the account held, this session's included, has just been
    revoked. The web app's `/api/auth/password` route stores them in the
    httpOnly cookies and never hands them to the browser (ADR-0005).
    """

    permission_classes = [IsAuthenticated]
    serializer_class = PasswordChangeSerializer
    # Named here rather than left to the defaults: this is a password check,
    # and a stolen session could otherwise guess the real password at the
    # general 600-a-minute rate (D87). Same scope as the sign-in form.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request: AuthedRequest) -> Response:
        serializer = self.get_serializer(data=request.data)
        user = request.user
        if not serializer.is_valid():
            # A wrong guess, not a blank field: `validate_current_password`
            # raises with the default "invalid" code, `required`/`blank` do not.
            # drf-stubs widens `.errors` to cover a `many=True` serializer,
            # which answers with a list.  This view never builds one (D6).
            errors = cast(dict[str, Any], serializer.errors)
            guesses = errors.get("current_password", [])
            if any(getattr(error, "code", "") == "invalid" for error in guesses):
                audit.record(
                    action=audit.AuditAction.LOGIN_FAILED,
                    entity=user,
                    actor=user,
                    reason="Wrong current password when changing the password",
                )
            raise ValidationError(errors)

        change_own_password(user=user, new_password=serializer.validated_data["new_password"])
        return Response(LoginSerializer.tokens_for(user))


class OrganizationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request: AuthedRequest) -> Response:
        organization = get_organization()
        if organization is None:
            return Response({"detail": "No organisation configured."}, status=404)
        return Response(OrganizationSerializer(organization).data)

    def patch(self, request: AuthedRequest) -> Response:
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

    def get(self, request: AuthedRequest) -> Response:
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

    def patch(self, request: AuthedRequest) -> Response:
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
    queryset = User.objects.select_related("role", "branch", "staff_profile").exclude(
        role__code=RoleCode.CUSTOMER
    )
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
        # `@action` is annotated as returning the plain function rather than a
        # descriptor, so the bound call looks to mypy as though it is missing
        # `self` (D6).
        return self.deactivate(request, *args, **kwargs)  # type: ignore[arg-type]

    @action(detail=True, methods=["post"])
    def deactivate(self, request: AuthedRequest, pk: str | None = None) -> Response:
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
    def activate(self, request: AuthedRequest, pk: str | None = None) -> Response:
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
    serializer_class = AuditLogSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["audit.view"]
    filterset_fields = ["action", "entity_type", "entity_id", "actor", "branch"]
    ordering_fields = ["created_at"]

    def get_queryset(self) -> Any:
        user = actor(self.request)
        queryset = AuditLog.objects.select_related("actor", "branch")

        # Branch-scoped like every other staff list (D85). A row with no branch
        # is organisation-wide -- the catalogue, settings, staff accounts,
        # sign-ins -- and belongs to every reader; a row that names a branch
        # belongs to that branch's readers and to those who see across them.
        if not (user.is_superuser or user.can_cross_branch) and user.branch_id:
            queryset = queryset.filter(Q(branch_id=user.branch_id) | Q(branch__isnull=True))

        params = self.request.query_params
        date_from, date_to = parse_window(params)
        if date_from:
            queryset = queryset.filter(created_at__gte=date_from)
        if date_to:
            queryset = queryset.filter(created_at__lte=date_to)

        # Who, what and why: an order number, a staff email, "damaged box".
        if search := params.get("search", "").strip():
            queryset = queryset.filter(
                Q(entity_label__icontains=search)
                | Q(reason__icontains=search)
                | Q(actor_label__icontains=search)
            )
        return queryset.order_by("-created_at", "-id")
