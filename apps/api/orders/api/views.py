"""Staff-facing order and return endpoints."""

from __future__ import annotations

from typing import Any

from django.db.models import Q
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import branch_queryset
from orders.api.serializers import (
    CompleteReturnSerializer,
    CreateReturnSerializer,
    OrderDetailSerializer,
    OrderEventSerializer,
    OrderListSerializer,
    ReceiveReturnSerializer,
    RecordPaymentSerializer,
    RefundRequestSerializer,
    RefundSerializer,
    ReturnRequestSerializer,
    StatusChangeSerializer,
)
from orders.models import Order, ReturnRequest
from orders.services import lifecycle as lifecycle_services
from orders.services import payments as payment_services
from orders.services import returns as return_services


class OrderViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["orders.view"],
        "retrieve": ["orders.view"],
        "timeline": ["orders.view"],
        "invoice": ["orders.view"],
        "packing_slip": ["orders.view"],
        "status": ["orders.update_status"],
        "cancel": ["sales.cancel"],
        "payments": ["sales.payment_record"],
        "refunds": ["sales.refund"],
    }
    filterset_fields = ["channel", "status", "payment_status", "branch", "customer"]
    ordering_fields = ["placed_at", "grand_total"]

    def get_queryset(self) -> Any:
        queryset = Order.objects.select_related("branch", "customer", "created_by")
        if self.action == "retrieve":
            queryset = queryset.prefetch_related(
                "items__variant__product__images", "payments", "refunds", "events__actor"
            )
        else:
            queryset = queryset.prefetch_related("items")
        queryset = branch_queryset(self.request.user, queryset)

        params = self.request.query_params
        if search := params.get("search"):
            queryset = queryset.filter(
                Q(number__icontains=search)
                | Q(customer__name__icontains=search)
                | Q(customer__phone__icontains=search)
            )
        if date_from := params.get("date_from"):
            queryset = queryset.filter(placed_at__date__gte=date_from)
        if date_to := params.get("date_to"):
            queryset = queryset.filter(placed_at__date__lte=date_to)
        return queryset.order_by("-placed_at")

    def get_serializer_class(self) -> Any:
        return OrderDetailSerializer if self.action == "retrieve" else OrderListSerializer

    @action(detail=True, methods=["post"])
    def status(self, request: Request, pk: str | None = None) -> Response:
        serializer = StatusChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        order = lifecycle_services.transition(
            order=self.get_object(),
            to_status=serializer.validated_data["to_status"],
            actor=request.user,
            reason=serializer.validated_data.get("reason", ""),
        )
        return Response(OrderDetailSerializer(order).data)

    @action(detail=True, methods=["post"])
    def cancel(self, request: Request, pk: str | None = None) -> Response:
        order = lifecycle_services.cancel_order(
            order=self.get_object(),
            actor=request.user,
            reason=request.data.get("reason", ""),
        )
        return Response(OrderDetailSerializer(order).data)

    @action(detail=True, methods=["get"])
    def timeline(self, request: Request, pk: str | None = None) -> Response:
        order = self.get_object()
        return Response(OrderEventSerializer(order.events.all(), many=True).data)

    @action(detail=True, methods=["post"])
    def payments(self, request: Request, pk: str | None = None) -> Response:
        """Record money actually received (COD remittance, bank transfer, cash)."""
        serializer = RecordPaymentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        order = self.get_object()

        pending = order.payments.filter(method=data["method"], status="PENDING").first()
        if pending is not None and pending.amount == data["amount"]:
            # The account is chosen at capture, because that is when the money
            # actually arrives — a COD order's cash lands when the courier
            # remits, not when the order was placed.
            if data.get("account") is not None:
                pending.account = data["account"]
                pending.save(update_fields=["account", "updated_at"])
            payment = payment_services.capture_payment(payment=pending, actor=request.user)
        else:
            payment = payment_services.record_payment(
                order=order,
                method=data["method"],
                amount=data["amount"],
                actor=request.user,
                reference=data.get("reference", ""),
                account=data.get("account"),
            )
        return Response(OrderDetailSerializer(payment.order).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def refunds(self, request: Request, pk: str | None = None) -> Response:
        serializer = RefundRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        refund = payment_services.refund_order(
            order=self.get_object(),
            amount=data["amount"],
            actor=request.user,
            reason=data.get("reason", ""),
            method=data.get("method"),
            account=data.get("account"),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
        return Response(RefundSerializer(refund).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def invoice(self, request: Request, pk: str | None = None) -> Response:
        """Payload for the printable A4 invoice; the frontend renders it."""
        order = self.get_object()
        return Response(
            {
                "order": OrderDetailSerializer(order).data,
                "document_type": "INVOICE",
                "organization": _organization_payload(),
            }
        )

    @action(detail=True, methods=["get"], url_path="packing-slip")
    def packing_slip(self, request: Request, pk: str | None = None) -> Response:
        order = self.get_object()
        data = OrderDetailSerializer(order).data
        for item in data["items"]:  # a packing slip never shows prices
            for field in ("unit_price", "line_discount", "tax_amount", "line_total"):
                item.pop(field, None)
        return Response(
            {
                "order": data,
                "document_type": "PACKING_SLIP",
                "organization": _organization_payload(),
            }
        )


def _organization_payload() -> dict[str, Any]:
    from accounts.services import get_organization

    organization = get_organization()
    if organization is None:
        return {}
    return {
        "name": organization.name,
        "address": organization.address,
        "phone": organization.phone,
        "email": organization.email,
        "vat_registration": organization.vat_registration,
        "receipt_footer": organization.receipt_footer,
    }


class ReturnRequestViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = ReturnRequestSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["orders.view"],
        "retrieve": ["orders.view"],
        "create": ["sales.refund"],
        "approve": ["sales.refund"],
        "reject": ["sales.refund"],
        "receive": ["sales.refund"],
        "complete": ["sales.refund"],
    }
    filterset_fields = ["status", "reason", "order"]

    def get_queryset(self) -> Any:
        return branch_queryset(
            self.request.user,
            ReturnRequest.objects.select_related(
                "order", "order__customer", "order__branch"
            ).prefetch_related("items__order_item"),
            field="order__branch",
        ).order_by("-created_at")

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = CreateReturnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        return_request = return_services.request_return(
            order=Order.objects.get(pk=data["order"]),
            lines=[(line["order_item"], line["quantity"]) for line in data["lines"]],
            reason=data["reason"],
            actor=request.user,
            customer_comment=data.get("customer_comment", ""),
            restock_decisions={
                str(line["order_item"]): line.get("restock_decision", "RESTOCK")
                for line in data["lines"]
            },
        )
        return Response(
            ReturnRequestSerializer(return_request).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=["post"])
    def approve(self, request: Request, pk: str | None = None) -> Response:
        result = return_services.approve(
            return_request=self.get_object(),
            actor=request.user,
            comment=request.data.get("comment", ""),
        )
        return Response(ReturnRequestSerializer(result).data)

    @action(detail=True, methods=["post"])
    def reject(self, request: Request, pk: str | None = None) -> Response:
        result = return_services.reject(
            return_request=self.get_object(),
            actor=request.user,
            comment=request.data.get("comment", ""),
        )
        return Response(ReturnRequestSerializer(result).data)

    @action(detail=True, methods=["post"])
    def receive(self, request: Request, pk: str | None = None) -> Response:
        """Goods are back, with the per-line decision made on inspection."""
        serializer = ReceiveReturnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        decisions = {
            str(line["id"]): {key: value for key, value in line.items() if key != "id"}
            for line in serializer.validated_data.get("items", [])
        }
        result = return_services.receive(
            return_request=self.get_object(), actor=request.user, decisions=decisions
        )
        return Response(ReturnRequestSerializer(result).data)

    @action(detail=True, methods=["post"])
    def complete(self, request: Request, pk: str | None = None) -> Response:
        serializer = CompleteReturnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        result = return_services.complete(
            return_request=self.get_object(),
            actor=request.user,
            refund_amount=data.get("refund_amount"),
            refund_method=data.get("refund_method") or None,
            account=data.get("account"),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
        return Response(ReturnRequestSerializer(result).data)
