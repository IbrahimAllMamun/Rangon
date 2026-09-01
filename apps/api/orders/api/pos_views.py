"""POS endpoints — optimised for speed at the counter."""

from __future__ import annotations

from typing import Any

from django.db.models import Q
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import RolePermission
from accounts.services import resolve_branch
from catalog.api.serializers import ProductVariantSerializer
from catalog.models import ProductVariant, PublishStatus
from core.media import media_url
from core.money import quantize
from inventory import services as inventory_services
from orders.api.serializers import (
    ElevateSerializer,
    HeldSaleSerializer,
    OrderDetailSerializer,
    PosSaleSerializer,
)
from orders.models import HeldSale, Order
from orders.services import pos as pos_services
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput


class PosSessionView(APIView):
    """Everything the POS needs to open: branch, cashier, register, open holds."""

    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["sales.create"]
    throttle_scope = "pos"

    def get(self, request: Request) -> Response:
        from accounts.services import get_organization
        from finance.selectors import active_accounts

        branch = resolve_branch(request.user, request.query_params.get("branch"))
        organization = get_organization()
        holds = HeldSale.objects.filter(branch=branch).order_by("-created_at")[:20]

        # The accounts this branch's takings can land in. Sent with the session
        # rather than fetched separately so opening the register stays one
        # request — the POS is the one screen where a second round trip is felt.
        accounts = [
            {
                "id": str(account.pk),
                "name": account.name,
                "kind": account.kind,
                "is_default": account.is_default,
            }
            for account in active_accounts(branch=branch)
        ]

        return Response(
            {
                "branch": {
                    "id": str(branch.pk),
                    "name": branch.name,
                    "code": branch.code,
                    "address": branch.address,
                    "phone": branch.phone,
                    "register_count": branch.register_count,
                },
                "cashier": {
                    "id": str(request.user.pk),
                    "name": request.user.full_name,
                    "email": request.user.email,
                    "permissions": sorted(request.user.permission_codes()),
                },
                "organization": {
                    "name": organization.name if organization else "Rangon Fashion",
                    "currency": organization.currency if organization else "BDT",
                    "receipt_footer": organization.receipt_footer if organization else "",
                    "vat_registration": organization.vat_registration if organization else "",
                },
                "holds": HeldSaleSerializer(holds, many=True).data,
                "accounts": accounts,
            }
        )


class PosLookupView(APIView):
    """Barcode / SKU scan.  Exact match only — a scan must never be fuzzy."""

    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["sales.create"]
    throttle_scope = "pos"

    def get(self, request: Request) -> Response:
        code = request.query_params.get("code", "")
        variant = pos_services.lookup_variant(code=code)
        if variant is None:
            return Response(
                {
                    "error": {
                        "code": "NOT_FOUND",
                        "message": f"No product matches '{code}'.",
                        "details": {"code": code},
                    }
                },
                status=status.HTTP_404_NOT_FOUND,
            )

        branch = resolve_branch(request.user, request.query_params.get("branch"))
        context = {
            "request": request,
            "stock": inventory_services.availability(branch=branch, variants=[variant]),
        }
        return Response(ProductVariantSerializer(variant, context=context).data)


class PosProductSearchView(APIView):
    """Grid search for cashiers who prefer tapping to scanning."""

    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["sales.create"]
    throttle_scope = "pos"

    def get(self, request: Request) -> Response:
        branch = resolve_branch(request.user, request.query_params.get("branch"))
        query = request.query_params.get("q", "").strip()
        category = request.query_params.get("category", "").strip()

        variants = (
            ProductVariant.objects.select_related("product", "product__category")
            .prefetch_related("product__images")
            .filter(status=PublishStatus.ACTIVE, product__status=PublishStatus.ACTIVE)
        )
        if query:
            variants = variants.filter(
                Q(sku__icontains=query) | Q(barcode=query) | Q(product__name__icontains=query)
            )
        if category:
            variants = variants.filter(product__category__slug=category)

        variants = variants.order_by("product__name", "position")[:60]
        snapshots = inventory_services.availability(branch=branch, variants=list(variants))

        results = []
        for variant in variants:
            snapshot = snapshots[str(variant.pk)]
            image = variant.product.primary_image
            results.append(
                {
                    "id": str(variant.pk),
                    "sku": variant.sku,
                    "barcode": variant.barcode or "",
                    "name": variant.product.name,
                    "label": variant.label,
                    "price": str(variant.price),
                    "available": snapshot.available,
                    "image": media_url(image.image) if image else "",
                    "category": variant.product.category.name,
                }
            )
        return Response({"results": results})


class PosSaleViewSet(viewsets.GenericViewSet):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "create": ["sales.create"],
        "receipt": ["sales.view"],
        "void": ["sales.cancel"],
        "retrieve": ["sales.view"],
    }
    throttle_scope = "pos"
    serializer_class = PosSaleSerializer
    queryset = Order.objects.all()

    def create(self, request: Request) -> Response:
        serializer = PosSaleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        branch = resolve_branch(request.user, data.get("branch"))

        order = pos_services.create_pos_sale(
            branch=branch,
            actor=request.user,
            data=SaleInput(
                lines=[
                    SaleLineInput(
                        variant_id=line["variant"],
                        quantity=line["quantity"],
                        line_discount=quantize(line.get("line_discount", 0)),
                    )
                    for line in data["lines"]
                ],
                payments=[
                    PaymentInput(
                        method=payment["method"],
                        amount=quantize(payment["amount"]),
                        tendered_amount=payment.get("tendered_amount"),
                        reference=payment.get("reference", ""),
                        account=payment.get("account"),
                    )
                    for payment in data["payments"]
                ],
                customer_id=data.get("customer"),
                manual_discount=quantize(data.get("manual_discount", 0)),
                register=data.get("register", ""),
                note=data.get("note", ""),
                idempotency_key=request.headers.get("Idempotency-Key"),
            ),
        )
        return Response(OrderDetailSerializer(order).data, status=status.HTTP_201_CREATED)

    def retrieve(self, request: Request, pk: str | None = None) -> Response:
        order = self.get_object()
        return Response(OrderDetailSerializer(order).data)

    @action(detail=True, methods=["get"])
    def receipt(self, request: Request, pk: str | None = None) -> Response:
        from orders.api.views import _organization_payload

        order = self.get_object()
        return Response(
            {
                "order": OrderDetailSerializer(order).data,
                "document_type": "RECEIPT",
                "organization": _organization_payload(),
                "branch": {
                    "name": order.branch.name,
                    "code": order.branch.code,
                    "address": order.branch.address,
                    "phone": order.branch.phone,
                },
                "cashier": order.created_by.full_name if order.created_by else "",
            }
        )

    @action(detail=True, methods=["post"])
    def void(self, request: Request, pk: str | None = None) -> Response:
        order = pos_services.void_sale(
            order=self.get_object(),
            actor=request.user,
            reason=request.data.get("reason", ""),
        )
        return Response(OrderDetailSerializer(order).data)


class HeldSaleViewSet(viewsets.ModelViewSet):
    serializer_class = HeldSaleSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["sales.create"]
    throttle_scope = "pos"
    pagination_class = None

    def get_queryset(self) -> Any:
        branch = resolve_branch(self.request.user, self.request.query_params.get("branch"))
        return (
            HeldSale.objects.filter(branch=branch)
            .select_related("customer")
            .order_by("-created_at")
        )

    def perform_create(self, serializer: Any) -> None:
        branch = resolve_branch(self.request.user, self.request.data.get("branch"))
        serializer.save(branch=branch, created_by=self.request.user)

    @action(detail=True, methods=["post"])
    def resume(self, request: Request, pk: str | None = None) -> Response:
        """Return the parked cart. The POS re-looks-up every line, so a stale
        hold can never sell at a stale price."""
        payload = pos_services.resume_sale(hold=self.get_object())
        return Response({"payload": payload})


class PosElevateView(APIView):
    """Manager override at the counter (refund, large discount, void)."""

    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["sales.create"]
    throttle_scope = "auth"

    def post(self, request: Request) -> Response:
        serializer = ElevateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        approver = pos_services.elevate(
            email=serializer.validated_data["email"],
            password=serializer.validated_data["password"],
            permission=serializer.validated_data["permission"],
            requested_by=request.user,
        )
        return Response(
            {
                "approved": True,
                "approved_by": approver.full_name,
                "approved_by_id": str(approver.pk),
                "permission": serializer.validated_data["permission"],
            }
        )


class PosReturnView(APIView):
    """In-store return: request, approve, receive and refund in one action."""

    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["sales.refund"]
    throttle_scope = "pos"

    def post(self, request: Request) -> Response:
        from orders.api.serializers import CreateReturnSerializer, ReturnRequestSerializer

        serializer = CreateReturnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        result = pos_services.pos_return(
            order=Order.objects.get(pk=data["order"]),
            actor=request.user,
            lines=[
                (line["order_item"], line["quantity"], line.get("restock_decision", "RESTOCK"))
                for line in data["lines"]
            ],
            reason=data["reason"],
            refund_method=request.data.get("refund_method", "CASH"),
        )
        return Response(ReturnRequestSerializer(result).data, status=status.HTTP_201_CREATED)
