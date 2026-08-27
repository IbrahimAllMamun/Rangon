from __future__ import annotations

from typing import Any

from django.db.models import DecimalField, ExpressionWrapper, F, Q, Sum
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import Branch
from accounts.permissions import RolePermission
from accounts.services import branch_queryset, resolve_branch
from core.exceptions import Conflict, ValidationError
from core.services import next_number
from inventory import services as inventory_services
from inventory.api.serializers import (
    AdjustStockSerializer,
    CreateTransferSerializer,
    InventorySerializer,
    InventoryTransactionSerializer,
    RecordCountSerializer,
    StockCountSerializer,
    WriteOffSerializer,
)
from inventory.models import (
    Inventory,
    InventoryTransaction,
    StockCount,
    StockCountItem,
    StockCountStatus,
    StockTransfer,
)


class InventoryViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = InventorySerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["inventory.view"],
        "retrieve": ["inventory.view"],
        "update": ["inventory.adjust"],
        "partial_update": ["inventory.adjust"],
        "adjust": ["inventory.adjust"],
        "write_off": ["inventory.adjust"],
        "low_stock": ["inventory.view"],
        "valuation": ["reports.financial"],
        "verify_integrity": ["settings.manage"],
    }
    filterset_fields = ["branch", "variant"]
    ordering_fields = ["on_hand", "updated_at"]

    def get_queryset(self) -> Any:
        queryset = Inventory.objects.select_related(
            "branch", "variant", "variant__product", "variant__product__category"
        )
        queryset = branch_queryset(self.request.user, queryset)

        params = self.request.query_params
        if params.get("filter") == "low-stock":
            queryset = queryset.filter(on_hand__lte=F("reorder_point"))
        elif params.get("filter") == "out-of-stock":
            queryset = queryset.filter(on_hand__lte=F("reserved"))
        elif params.get("filter") == "expiring":
            queryset = queryset.filter(variant__expiry_date__isnull=False).order_by(
                "variant__expiry_date"
            )

        if category := params.get("category"):
            queryset = queryset.filter(variant__product__category__slug=category)
        if search := params.get("search"):
            queryset = queryset.filter(
                Q(variant__sku__icontains=search)
                | Q(variant__barcode=search)
                | Q(variant__product__name__icontains=search)
            )
        return queryset.order_by("variant__product__name", "variant__position")

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Only the reorder point and bin are directly editable.

        Stock levels change through /adjust/ so they always leave a ledger row.
        """
        instance = self.get_object()
        for field in ("reorder_point", "bin_location"):
            if field in request.data:
                setattr(instance, field, request.data[field])
        instance.save(update_fields=["reorder_point", "bin_location", "updated_at"])
        return Response(self.get_serializer(instance).data)

    @action(detail=False, methods=["post"])
    def adjust(self, request: Request) -> Response:
        serializer = AdjustStockSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        branch = resolve_branch(request.user, data.get("branch"))

        entry = inventory_services.adjust(
            branch=branch,
            variant=data["variant"],
            new_on_hand=data["new_on_hand"],
            reason=data["reason"],
            actor=request.user,
        )
        if entry is None:
            return Response({"detail": "Stock already matches that figure."}, status=200)
        return Response(InventoryTransactionSerializer(entry).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["post"], url_path="write-off")
    def write_off(self, request: Request) -> Response:
        serializer = WriteOffSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        branch = resolve_branch(request.user, data.get("branch"))

        entry = inventory_services.write_off(
            branch=branch,
            variant=data["variant"],
            quantity=data["quantity"],
            transaction_type=data["transaction_type"],
            reason=data["reason"],
            actor=request.user,
            notes=data.get("notes", ""),
        )
        return Response(InventoryTransactionSerializer(entry).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["get"], url_path="low-stock")
    def low_stock(self, request: Request) -> Response:
        queryset = self.get_queryset().filter(on_hand__lte=F("reorder_point"))
        page = self.paginate_queryset(queryset)
        serializer = self.get_serializer(page or queryset, many=True)
        return self.get_paginated_response(serializer.data) if page else Response(serializer.data)

    @action(detail=False, methods=["get"])
    def valuation(self, request: Request) -> Response:
        """Stock value at weighted average cost, per branch."""
        queryset = branch_queryset(request.user, Inventory.objects.all())
        totals = queryset.aggregate(
            units=Sum("on_hand"),
            value=Sum(
                ExpressionWrapper(
                    F("on_hand") * F("average_cost"),
                    output_field=DecimalField(max_digits=18, decimal_places=2),
                )
            ),
            retail=Sum(
                ExpressionWrapper(
                    F("on_hand") * F("variant__price"),
                    output_field=DecimalField(max_digits=18, decimal_places=2),
                )
            ),
        )
        by_branch = list(
            queryset.values("branch__code", "branch__name").annotate(
                units=Sum("on_hand"),
                value=Sum(
                    ExpressionWrapper(
                        F("on_hand") * F("average_cost"),
                        output_field=DecimalField(max_digits=18, decimal_places=2),
                    )
                ),
            )
        )
        return Response({"totals": totals, "by_branch": by_branch})

    @action(detail=False, methods=["post"], url_path="verify-integrity")
    def verify_integrity(self, request: Request) -> Response:
        branch = (
            resolve_branch(request.user, request.data.get("branch"))
            if request.data.get("branch")
            else None
        )
        issues = inventory_services.verify_integrity(branch=branch)
        return Response(
            {
                "clean": not issues,
                "issue_count": len(issues),
                "issues": [
                    {
                        "sku": issue.sku,
                        "branch": issue.branch_code,
                        "cached_on_hand": issue.cached_on_hand,
                        "ledger_on_hand": issue.ledger_on_hand,
                        "cached_reserved": issue.cached_reserved,
                        "ledger_reserved": issue.ledger_reserved,
                    }
                    for issue in issues
                ],
            }
        )


class InventoryTransactionViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    serializer_class = InventoryTransactionSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["inventory.view"]
    filterset_fields = ["branch", "variant", "transaction_type", "reference_type"]
    ordering_fields = ["created_at"]

    def get_queryset(self) -> Any:
        queryset = InventoryTransaction.objects.select_related(
            "branch", "variant", "variant__product", "created_by"
        )
        queryset = branch_queryset(self.request.user, queryset)
        params = self.request.query_params
        if date_from := params.get("date_from"):
            queryset = queryset.filter(created_at__date__gte=date_from)
        if date_to := params.get("date_to"):
            queryset = queryset.filter(created_at__date__lte=date_to)
        return queryset.order_by("-created_at")


class StockTransferViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    queryset = StockTransfer.objects.select_related("source_branch", "target_branch")
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["inventory.view"],
        "retrieve": ["inventory.view"],
        "create": ["inventory.transfer"],
    }

    def get_serializer_class(self) -> Any:
        from inventory.api.serializers import StockTransferSerializer

        return CreateTransferSerializer if self.action == "create" else StockTransferSerializer

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        from inventory.api.serializers import StockTransferSerializer

        serializer = CreateTransferSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        transfer = inventory_services.transfer(
            source_branch=Branch.objects.get(pk=data["source_branch"]),
            target_branch=Branch.objects.get(pk=data["target_branch"]),
            lines=[(line["variant"], line["quantity"]) for line in data["lines"]],
            actor=request.user,
            notes=data.get("notes", ""),
        )
        return Response(StockTransferSerializer(transfer).data, status=status.HTTP_201_CREATED)


class StockCountViewSet(viewsets.ModelViewSet):
    serializer_class = StockCountSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["inventory.view"],
        "retrieve": ["inventory.view"],
        "create": ["inventory.count"],
        "update": ["inventory.count"],
        "partial_update": ["inventory.count"],
        "apply": ["inventory.count"],
        "record": ["inventory.count"],
        "cancel": ["inventory.count"],
    }

    def get_queryset(self) -> Any:
        return branch_queryset(
            self.request.user,
            StockCount.objects.select_related("branch").prefetch_related("items__variant__product"),
        ).order_by("-created_at")

    def perform_create(self, serializer: Any) -> None:
        branch = resolve_branch(self.request.user, self.request.data.get("branch"))
        count = serializer.save(
            number=next_number("stock_count", prefix="SC"),
            branch=branch,
            created_by=self.request.user,
            status=StockCountStatus.COUNTING,
        )
        # Snapshot what the system believes right now, so the sheet is comparable.
        rows = Inventory.objects.filter(branch=branch).select_related("variant")
        StockCountItem.objects.bulk_create(
            [
                StockCountItem(
                    stock_count=count,
                    variant_id=row.variant_id,
                    expected_quantity=row.on_hand,
                )
                for row in rows
            ]
        )

    @action(detail=True, methods=["post"])
    def record(self, request: Request, pk: str | None = None) -> Response:
        """Write down what was actually on the shelf.

        The counting step itself, which had no endpoint before: `items` on
        `StockCountSerializer` is read-only, so nothing could set
        `counted_quantity` and `apply` therefore always adjusted nothing.
        """
        count = self.get_object()
        if count.status != StockCountStatus.COUNTING:
            raise Conflict(
                f"{count.number} is {count.get_status_display().lower()}; "
                "figures can only be recorded while it is still being counted.",
                details={"status": count.status},
            )

        serializer = RecordCountSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        lines = serializer.validated_data["lines"]

        by_variant = {str(line["variant"]): line for line in lines}
        items = list(count.items.filter(variant_id__in=by_variant.keys()))
        if len(items) != len(by_variant):
            found = {str(item.variant_id) for item in items}
            raise ValidationError(
                "Some variants are not on this count sheet.",
                details={"unknown": sorted(set(by_variant) - found)},
            )

        for item in items:
            line = by_variant[str(item.variant_id)]
            item.counted_quantity = line["counted_quantity"]
            item.notes = line.get("notes", "")
        StockCountItem.objects.bulk_update(items, ["counted_quantity", "notes", "updated_at"])

        return Response(
            {
                "recorded": len(items),
                "counted": count.items.filter(counted_quantity__isnull=False).count(),
                "total": count.items.count(),
            }
        )

    @action(detail=True, methods=["post"])
    def cancel(self, request: Request, pk: str | None = None) -> Response:
        """Abandon a count without touching stock."""
        count = self.get_object()
        if count.status == StockCountStatus.APPLIED:
            raise Conflict(
                f"{count.number} has already been applied; its adjustments are in the ledger.",
                details={"status": count.status},
            )
        count.status = StockCountStatus.CANCELLED
        count.save(update_fields=["status", "updated_at"])
        return Response(StockCountSerializer(count).data)

    @action(detail=True, methods=["post"])
    def apply(self, request: Request, pk: str | None = None) -> Response:
        """Turn counted figures into ADJUSTMENT ledger rows."""
        count = self.get_object()
        if count.status != StockCountStatus.COUNTING:
            raise Conflict(
                f"{count.number} is {count.get_status_display().lower()} and cannot be applied.",
                details={"status": count.status},
            )

        counted = count.items.filter(counted_quantity__isnull=False).select_related("variant")
        if not counted.exists():
            raise ValidationError(
                f"Nothing has been counted on {count.number} yet, so there is nothing to apply."
            )

        applied = 0
        for item in counted:
            entry = inventory_services.adjust(
                branch=count.branch,
                variant=item.variant_id,
                new_on_hand=item.counted_quantity,
                reason=f"Stock count {count.number}",
                actor=request.user,
                reference_type="stock_count",
                reference_id=count.pk,
            )
            if entry is not None:
                applied += 1

        count.status = StockCountStatus.APPLIED
        count.applied_at = timezone.now()
        count.applied_by = request.user
        count.save(update_fields=["status", "applied_at", "applied_by", "updated_at"])
        return Response({"adjusted_lines": applied, "status": count.status})
