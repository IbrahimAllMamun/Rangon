from __future__ import annotations

from typing import Any

from django.db.models import Count, Q
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import branch_queryset, resolve_branch
from purchasing import services as purchasing_services
from purchasing.api.serializers import (
    CreatePurchaseOrderSerializer,
    PurchaseOrderSerializer,
    PurchaseReceiptSerializer,
    ReceivePurchaseSerializer,
    SupplierPaymentSerializer,
    SupplierSerializer,
)
from purchasing.models import PurchaseOrder, PurchaseOrderStatus, Supplier, SupplierPayment
from purchasing.services import PurchaseLine


class SupplierViewSet(viewsets.ModelViewSet):
    serializer_class = SupplierSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["purchases.view"],
        "retrieve": ["purchases.view"],
        "create": ["purchases.create"],
        "update": ["purchases.create"],
        "partial_update": ["purchases.create"],
        "destroy": ["settings.manage"],
    }
    filterset_fields = ["status"]
    search_fields = ["name", "code", "phone"]
    ordering_fields = ["name", "created_at"]

    def get_queryset(self) -> Any:
        return Supplier.objects.annotate(
            outstanding_orders=Count(
                "purchase_orders",
                filter=Q(
                    purchase_orders__status__in=[
                        PurchaseOrderStatus.SENT,
                        PurchaseOrderStatus.PARTIALLY_RECEIVED,
                    ]
                ),
            )
        ).order_by("name")


class PurchaseOrderViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["purchases.view"],
        "retrieve": ["purchases.view"],
        "create": ["purchases.create"],
        "send": ["purchases.create"],
        "cancel": ["purchases.create"],
        "receive": ["purchases.receive"],
        "receipts": ["purchases.view"],
    }
    filterset_fields = ["status", "supplier", "branch", "payment_status"]
    ordering_fields = ["created_at", "expected_at"]

    def get_queryset(self) -> Any:
        return branch_queryset(
            self.request.user,
            PurchaseOrder.objects.select_related("supplier", "branch").prefetch_related(
                "items__variant__product",
                # `ProductVariant.label` is a property that joins its attribute
                # values, so rendering a line label costs a query per variant
                # unless the values come along too.
                "items__variant__attribute_values__attribute_value",
                # The receipt serialisers reach further than `receipts__items`:
                # each receipt line renders `purchase_order_item.variant.sku`, and
                # each receipt renders `received_by.email`. Stopping at the items
                # cost 156 queries for two purchase orders.
                "receipts__received_by",
                "receipts__items__purchase_order_item__variant",
            ),
        ).order_by("-created_at")

    def get_serializer_class(self) -> Any:
        return CreatePurchaseOrderSerializer if self.action == "create" else PurchaseOrderSerializer

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = CreatePurchaseOrderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        purchase_order = purchasing_services.create_purchase_order(
            supplier=Supplier.objects.get(pk=data["supplier"]),
            branch=resolve_branch(request.user, data.get("branch")),
            lines=[
                PurchaseLine(
                    variant_id=line["variant"],
                    quantity=line["quantity"],
                    unit_cost=line["unit_cost"],
                    discount=line.get("discount", 0),
                )
                for line in data["lines"]
            ],
            actor=request.user,
            expected_at=data.get("expected_at"),
            invoice_number=data.get("invoice_number", ""),
            shipping_total=data.get("shipping_total", 0),
            notes=data.get("notes", ""),
        )
        return Response(
            PurchaseOrderSerializer(purchase_order).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=["post"])
    def send(self, request: Request, pk: str | None = None) -> Response:
        purchase_order = purchasing_services.send_purchase_order(
            purchase_order=self.get_object(), actor=request.user
        )
        return Response(PurchaseOrderSerializer(purchase_order).data)

    @action(detail=True, methods=["post"])
    def cancel(self, request: Request, pk: str | None = None) -> Response:
        purchase_order = purchasing_services.cancel_purchase_order(
            purchase_order=self.get_object(),
            actor=request.user,
            reason=request.data.get("reason", ""),
        )
        return Response(PurchaseOrderSerializer(purchase_order).data)

    @action(detail=True, methods=["post"])
    def receive(self, request: Request, pk: str | None = None) -> Response:
        """Receive goods: writes PURCHASE ledger rows and updates average cost."""
        serializer = ReceivePurchaseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        lines = serializer.validated_data["lines"]

        receipt = purchasing_services.receive_purchase(
            purchase_order=self.get_object(),
            lines={line["item"]: line["quantity"] for line in lines},
            unit_costs={
                str(line["item"]): line["unit_cost"]
                for line in lines
                if line.get("unit_cost") is not None
            },
            actor=request.user,
            notes=serializer.validated_data.get("notes", ""),
        )
        return Response(
            {
                "receipt": PurchaseReceiptSerializer(receipt).data,
                "purchase_order": PurchaseOrderSerializer(
                    PurchaseOrder.objects.get(pk=receipt.purchase_order_id)
                ).data,
            },
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["get"])
    def receipts(self, request: Request, pk: str | None = None) -> Response:
        purchase_order = self.get_object()
        return Response(PurchaseReceiptSerializer(purchase_order.receipts.all(), many=True).data)


class SupplierPaymentViewSet(
    mixins.ListModelMixin, mixins.CreateModelMixin, viewsets.GenericViewSet
):
    queryset = SupplierPayment.objects.select_related("supplier", "purchase_order")
    serializer_class = SupplierPaymentSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {"list": ["purchases.view"], "create": ["purchases.pay"]}
    filterset_fields = ["supplier", "purchase_order", "method"]

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        payment = purchasing_services.record_supplier_payment(
            supplier=data["supplier"],
            amount=data["amount"],
            method=data["method"],
            purchase_order=data.get("purchase_order"),
            reference=data.get("reference", ""),
            paid_at=data.get("paid_at"),
            actor=request.user,
            notes=data.get("notes", ""),
        )
        return Response(SupplierPaymentSerializer(payment).data, status=status.HTTP_201_CREATED)
