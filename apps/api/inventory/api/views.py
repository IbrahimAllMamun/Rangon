from __future__ import annotations

from typing import Any

from django.db.models import DecimalField, ExpressionWrapper, F, Q, Sum
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import Branch, Status
from accounts.permissions import RolePermission
from accounts.services import branch_queryset, resolve_branch
from core.dates import parse_window
from core.exceptions import Conflict, ValidationError
from core.requests import AuthedRequest, actor
from core.services import next_number
from inventory import services as inventory_services
from inventory.api import documents
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
    TransactionType,
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
        queryset = branch_queryset(actor(self.request), queryset)

        params = self.request.query_params
        # Soonest-expiring first is the whole point of that filter, so it sets
        # its own ordering.  It used to call `.order_by()` here and have it
        # thrown away by the `.order_by()` at the end of this method, which
        # silently sorted the expiring view by product name instead.
        ordering = ["variant__product__name", "variant__position"]
        if params.get("filter") == "low-stock":
            queryset = queryset.filter(on_hand__lte=F("reorder_point"))
        elif params.get("filter") == "out-of-stock":
            queryset = queryset.filter(on_hand__lte=F("reserved"))
        elif params.get("filter") == "expiring":
            queryset = queryset.filter(variant__expiry_date__isnull=False)
            ordering = ["variant__expiry_date"]

        if category := params.get("category"):
            queryset = queryset.filter(variant__product__category__slug=category)
        if search := params.get("search"):
            queryset = queryset.filter(
                Q(variant__sku__icontains=search)
                | Q(variant__barcode=search)
                | Q(variant__product__name__icontains=search)
            )
        # `pk` last, so the order is total.  Every one of a product's variants
        # is `position` 0 until somebody reorders them, and PostgreSQL may
        # return tied rows in any order it likes: page 2 could repeat a row
        # from page 1, and refreshing after an adjustment could move the row
        # that was just corrected somewhere else on the page.  Same defect as
        # D13 on the admin product list, one table over.
        return queryset.order_by(*ordering, "pk")

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
    def adjust(self, request: AuthedRequest) -> Response:
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
    def write_off(self, request: AuthedRequest) -> Response:
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
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
        return Response(InventoryTransactionSerializer(entry).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["get"], url_path="low-stock")
    def low_stock(self, request: AuthedRequest) -> Response:
        queryset = self.get_queryset().filter(on_hand__lte=F("reorder_point"))
        page = self.paginate_queryset(queryset)
        serializer = self.get_serializer(page or queryset, many=True)
        return self.get_paginated_response(serializer.data) if page else Response(serializer.data)

    @action(detail=False, methods=["get"])
    def valuation(self, request: AuthedRequest) -> Response:
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
    def verify_integrity(self, request: AuthedRequest) -> Response:
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
        ).prefetch_related("variant__attribute_values__attribute_value")
        queryset = branch_queryset(actor(self.request), queryset)
        params = self.request.query_params

        # The same parser the cash book and the reports use, so "the 14th"
        # means the shop's 14th on every screen.
        date_from, date_to = parse_window(params)
        if date_from:
            queryset = queryset.filter(created_at__gte=date_from)
        if date_to:
            queryset = queryset.filter(created_at__lte=date_to)

        # `types=DAMAGE,LOSS`: the screen filters by family (everything written
        # off, everything transferred), which `transaction_type` cannot express.
        if types := params.get("types"):
            wanted = {part.strip().upper() for part in types.split(",") if part.strip()}
            unknown = sorted(wanted - set(TransactionType.values))
            if unknown:
                raise ValidationError(
                    f"Unknown movement type: {', '.join(unknown)}.",
                    details={"types": [f"Choose from {', '.join(TransactionType.values)}."]},
                )
            queryset = queryset.filter(transaction_type__in=wanted)

        if search := params.get("search", "").strip():
            queryset = queryset.filter(
                Q(variant__sku__icontains=search) | Q(variant__product__name__icontains=search)
            )
        # `id` breaks ties: a transfer writes its two rows in the same instant,
        # and without a total order they swap places between page loads.
        return queryset.order_by("-created_at", "-id")

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        rows = list(page if page is not None else queryset)
        context = {**self.get_serializer_context(), "documents": documents.resolve(rows)}
        data = self.get_serializer_class()(rows, many=True, context=context).data
        return self.get_paginated_response(data) if page is not None else Response(data)


class StockTransferViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["inventory.view"],
        "retrieve": ["inventory.view"],
        "create": ["inventory.transfer"],
    }

    def get_queryset(self) -> Any:
        # Either end: a transfer is the source's stock leaving and the
        # target's arriving, and each branch has to see its own half (D94).
        return branch_queryset(
            actor(self.request),
            StockTransfer.objects.select_related("source_branch", "target_branch"),
            field=("source_branch", "target_branch"),
        )

    def get_serializer_class(self) -> Any:
        from inventory.api.serializers import StockTransferSerializer

        return CreateTransferSerializer if self.action == "create" else StockTransferSerializer

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        from inventory.api.serializers import StockTransferSerializer

        serializer = CreateTransferSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # The source is the branch acting -- its stock is what leaves -- so it
        # passes the same rule as every other stock write. Looked up bare, it
        # let anyone holding `inventory.transfer` at one branch empty another
        # branch's shelf into their own (D94). The target is deliberately not
        # held to that rule: sending stock somewhere else is what a transfer is.
        source = resolve_branch(actor(request), data["source_branch"])
        target = Branch.objects.filter(pk=data["target_branch"], status=Status.ACTIVE).first()
        if target is None:
            raise ValidationError(
                "That branch is not available.",
                details={"target_branch": ["That branch is not available."]},
            )

        transfer = inventory_services.transfer(
            source_branch=source,
            target_branch=target,
            lines=[(line["variant"], line["quantity"]) for line in data["lines"]],
            actor=actor(request),
            notes=data.get("notes", ""),
            idempotency_key=request.headers.get("Idempotency-Key"),
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
            actor(self.request),
            StockCount.objects.select_related("branch").prefetch_related("items__variant__product"),
        ).order_by("-created_at")

    def perform_create(self, serializer: Any) -> None:
        branch = resolve_branch(actor(self.request), self.request.data.get("branch"))
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
    def record(self, request: AuthedRequest, pk: str | None = None) -> Response:
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
    def cancel(self, request: AuthedRequest, pk: str | None = None) -> Response:
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
    def apply(self, request: AuthedRequest, pk: str | None = None) -> Response:
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
