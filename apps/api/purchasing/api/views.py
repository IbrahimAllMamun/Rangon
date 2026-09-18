from __future__ import annotations

from typing import Any

from django.db.models import Count, Q
from django_filters import rest_framework as filters
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import branch_queryset, resolve_branch
from purchasing import services as purchasing_services
from purchasing.api.serializers import (
    CreatePurchaseOrderSerializer,
    CreatePurchaseReturnSerializer,
    PurchaseOrderDetailSerializer,
    PurchaseOrderSerializer,
    PurchaseReceiptSerializer,
    PurchaseReturnSerializer,
    ReceivePurchaseSerializer,
    SupplierPaymentSerializer,
    SupplierProductSerializer,
    SupplierSerializer,
)
from purchasing.models import (
    PurchaseOrder,
    PurchaseOrderStatus,
    Supplier,
    SupplierPayment,
    SupplierProduct,
)
from purchasing.services import PurchaseLine, ReturnLine


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
    # `search_fields` below was declared but inert: SearchFilter is not one of
    # the global DEFAULT_FILTER_BACKENDS, so `?search=` was silently ignored.
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
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
        # Returning is the mirror of receiving and the same physical authority
        # does it — the storeman with the goods in front of him. It is worth
        # noting that a return also creates a credit, which receiving does not,
        # so a distinct `purchases.return` code is arguable; that would mean
        # editing the role matrix, which is a wider change than this.
        "purchase_return": ["purchases.receive"],
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
                "returns__returned_by",
                "returns__items__purchase_order_item__variant",
            ),
        ).order_by("-created_at")

    def get_serializer_class(self) -> Any:
        if self.action == "create":
            return CreatePurchaseOrderSerializer
        # `unpublished_products` costs a query per order, so only the detail
        # view carries it — on the list it was a measured N+1.
        if self.action == "retrieve":
            return PurchaseOrderDetailSerializer
        return PurchaseOrderSerializer

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
                    tax_rate=line.get("tax_rate", 0),
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

    @action(detail=True, methods=["post"], url_path="return")
    def purchase_return(self, request: Request, pk: str | None = None) -> Response:
        """Send goods back: writes PURCHASE_RETURN ledger rows and credits the order.

        `Idempotency-Key` is honoured because a replay would take the stock off
        the shelf twice and credit the order twice (CLAUDE.md §7) — the same
        reason `SupplierPayment` carries one.
        """
        serializer = CreatePurchaseReturnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        purchase_return = purchasing_services.create_purchase_return(
            purchase_order=self.get_object(),
            lines=[
                ReturnLine(purchase_order_item_id=line["item"], quantity=line["quantity"])
                for line in data["lines"]
            ],
            reason=data["reason"],
            actor=request.user,
            notes=data.get("notes", ""),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
        return Response(
            {
                "purchase_return": PurchaseReturnSerializer(purchase_return).data,
                "purchase_order": PurchaseOrderSerializer(
                    PurchaseOrder.objects.get(pk=purchase_return.purchase_order_id)
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
            account=data.get("account"),
            branch=resolve_branch(request.user, request.data.get("branch")),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
        return Response(SupplierPaymentSerializer(payment).data, status=status.HTTP_201_CREATED)


class SupplierProductFilter(filters.FilterSet):
    """`?product=` as well as `?variant=`.

    The product screen wants every supplier of every variant of one product.
    Without this it would have to issue one request per variant — twelve for a
    shirt in three colours and four sizes.
    """

    product = filters.UUIDFilter(field_name="variant__product")

    class Meta:
        model = SupplierProduct
        fields = ["supplier", "variant", "product", "is_preferred", "is_active"]


class SupplierProductViewSet(viewsets.ModelViewSet):
    """Which suppliers sell which variants, and what they charge.

    Reference data rather than financial record, so unlike orders and receipts
    these rows may be edited and deleted (docs/business-rules.md § 7a).

    Not branch-scoped, deliberately: a supplier's price list is an agreement
    with the business, not with one shop. Branch scoping lives on the purchase
    orders that spend against it.
    """

    serializer_class = SupplierProductSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["purchases.view"],
        "retrieve": ["purchases.view"],
        "create": ["purchases.create"],
        "update": ["purchases.create"],
        "partial_update": ["purchases.create"],
        "destroy": ["purchases.create"],
        "set_preferred": ["purchases.create"],
    }
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = SupplierProductFilter
    search_fields = ["supplier_sku", "variant__sku", "variant__product__name", "supplier__name"]
    ordering_fields = ["last_cost", "last_purchased_at", "created_at"]

    def get_queryset(self) -> Any:
        return SupplierProduct.objects.select_related(
            "supplier", "variant", "variant__product"
        ).order_by("-is_preferred", "last_cost")

    def perform_create(self, serializer: Any) -> None:
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=["post"], url_path="set-preferred")
    def set_preferred(self, request: Request, pk: str | None = None) -> Response:
        """Promote this supplier, demoting whoever held it, in one transaction."""
        offer = self.get_object()
        updated = purchasing_services.set_preferred_supplier(
            variant_id=offer.variant_id,
            supplier=offer.supplier,
            actor=request.user,
        )
        return Response(self.get_serializer(updated).data)
