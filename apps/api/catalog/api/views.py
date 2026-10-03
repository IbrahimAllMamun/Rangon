from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import (
    Count,
    IntegerField,
    Max,
    Min,
    OuterRef,
    Prefetch,
    Q,
    Subquery,
    Value,
)
from django.db.models.functions import Coalesce
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import resolve_branch
from catalog import importers
from catalog.api.serializers import (
    AttributeSerializer,
    AttributeValueSerializer,
    BrandSerializer,
    CategoryAttributeSerializer,
    CategorySerializer,
    GenerateVariantsSerializer,
    LabelMarksSerializer,
    LabelSheetVariantSerializer,
    ProductDetailSerializer,
    ProductImageSerializer,
    ProductImportSerializer,
    ProductListSerializer,
    ProductVariantSerializer,
    ProductWriteSerializer,
    SizeChartSerializer,
)
from catalog.models import (
    Attribute,
    AttributeValue,
    Brand,
    Category,
    Product,
    ProductAttributeValue,
    ProductImage,
    ProductVariant,
    PublishStatus,
    SizeChart,
    SizeChartRow,
    VariantAttributeValue,
)
from catalog.services import (
    category_attributes,
    create_single_variant,
    delete_size_chart,
    generate_barcode,
    generate_variants,
    publish_product,
    save_size_chart,
    set_product_size_chart,
    set_product_specs,
)
from core import audit
from core.exceptions import Conflict, ValidationError
from core.requests import AuthedRequest, actor
from inventory import labels as label_services
from inventory import services as inventory_services

PRODUCT_PERMISSIONS = {
    "list": ["products.view"],
    "retrieve": ["products.view"],
    "create": ["products.create"],
    "update": ["products.update"],
    "partial_update": ["products.update"],
    "destroy": ["products.delete"],
}


class CategoryViewSet(viewsets.ModelViewSet):
    serializer_class = CategorySerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["is_active", "parent"]
    ordering_fields = ["position", "name", "created_at"]
    pagination_class = None

    def get_queryset(self) -> Any:
        queryset = Category.objects.select_related("parent").annotate(
            product_count=Count("products", filter=Q(products__published=True))
        )
        if self.request.query_params.get("tree") == "true":
            return queryset.filter(parent__isnull=True).order_by("position", "name")
        return queryset.order_by("position", "name")

    def get_serializer_context(self) -> dict[str, Any]:
        context = super().get_serializer_context()
        context["tree"] = self.request.query_params.get("tree") == "true"
        return context

    @action(detail=True, methods=["get"])
    def attributes(self, request: AuthedRequest, pk: str | None = None) -> Response:
        """Which attributes this category uses, inherited from its ancestors.

        The product form asks this whenever the category changes, so a handbag
        never offers a Shoe size and cosmetics offer Volume. The answer covers
        both halves -- `is_variant_defining` splits it into the axes that build
        SKUs and the specifications stated once on the product.
        """
        links = category_attributes(self.get_object())
        return Response(CategoryAttributeSerializer(links, many=True).data)


class BrandViewSet(viewsets.ModelViewSet):
    queryset = Brand.objects.all()
    serializer_class = BrandSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["is_active", "is_featured"]
    ordering_fields = ["name"]
    pagination_class = None


#: How many variants each attribute defines, as one subquery rather than a
#: COUNT per row. `VariantAttributeValue.attribute` is `related_name="+"`, so
#: there is no reverse relation to annotate across.
_VARIANT_USAGE = Coalesce(
    Subquery(
        VariantAttributeValue.objects.filter(attribute=OuterRef("pk"))
        .values("attribute")
        .annotate(total=Count("pk"))
        .values("total")[:1],
        output_field=IntegerField(),
    ),
    Value(0),
)


class AttributeViewSet(viewsets.ModelViewSet):
    queryset = (
        Attribute.objects.prefetch_related("values")
        .annotate(variant_usage_count=_VARIANT_USAGE)
        .all()
    )
    serializer_class = AttributeSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    pagination_class = None

    def perform_destroy(self, instance: Attribute) -> None:
        """Refuse in words rather than with a bare 409.

        `VariantAttributeValue` PROTECTs both the attribute and its values, so
        the database already stops this. What it does not do is say why, and a
        409 with no body leaves the admin clicking Delete again.
        """
        used_by = VariantAttributeValue.objects.filter(attribute=instance).count()
        if used_by:
            raise Conflict(
                f"“{instance.name}” defines {used_by} variant"
                f"{'' if used_by == 1 else 's'} and cannot be deleted. "
                "Those SKUs would lose the axis they were generated on.",
                details={"variant_usage": used_by},
            )
        stated_by = ProductAttributeValue.objects.filter(
            attribute_value__attribute=instance
        ).count()
        if stated_by:
            raise Conflict(
                f"“{instance.name}” is stated as a specification on {stated_by} "
                f"product{'' if stated_by == 1 else 's'} and cannot be deleted. "
                "Clear it from those products first.",
                details={"spec_usage": stated_by},
            )
        # `SizeChart.attribute` is PROTECT: a chart's rows are this
        # attribute's values, so the chart would have nothing left to describe.
        charts = instance.size_charts.count()
        if charts:
            raise Conflict(
                f"“{instance.name}” has {charts} size chart{'' if charts == 1 else 's'} "
                "and cannot be deleted. Delete the charts first.",
                details={"size_chart_usage": charts},
            )
        super().perform_destroy(instance)


class AttributeValueViewSet(viewsets.ModelViewSet):
    queryset = AttributeValue.objects.select_related("attribute").all()
    serializer_class = AttributeValueSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["attribute"]
    pagination_class = None

    def perform_destroy(self, instance: AttributeValue) -> None:
        """Refuse in words rather than with a bare 409 (see AttributeViewSet)."""
        used_by = instance.variant_links.count()
        if used_by:
            raise Conflict(
                f"“{instance.display}” is carried by {used_by} variant"
                f"{'' if used_by == 1 else 's'} and cannot be deleted. "
                "Rename it instead — orders froze their own label at sale time, "
                "so history does not move.",
                details={"variant_usage": used_by},
            )
        # `ProductAttributeValue.attribute_value` is PROTECT too, so without
        # this the database answers a spec value's deletion with a bare 409 and
        # the admin is left clicking Delete again -- the same reason the
        # variant branch above exists.
        stated_by = instance.product_links.count()
        if stated_by:
            raise Conflict(
                f"“{instance.display}” is stated as a specification on {stated_by} "
                f"product{'' if stated_by == 1 else 's'} and cannot be deleted. "
                "Rename it instead, or clear it from those products first.",
                details={"spec_usage": stated_by},
            )
        # PROTECT again, and for the same reason: the admin typed that row's
        # figures, and deleting the size should not quietly take them with it.
        charted_in = instance.size_chart_rows.count()
        if charted_in:
            raise Conflict(
                f"“{instance.display}” is in {charted_in} size chart"
                f"{'' if charted_in == 1 else 's'} and cannot be deleted. "
                "Rename it instead, or take it out of those charts first.",
                details={"size_chart_usage": charted_in},
            )
        super().perform_destroy(instance)

    @action(detail=True, methods=["post"])
    def move(self, request: AuthedRequest, pk: str | None = None) -> Response:
        """Swap `position` with the previous/next value of the same attribute.

        Up/down rather than drag-and-drop, so the control is operable by
        keyboard and screen reader — the same choice, and the same reason, as
        the navigation editor (ADR-0009).
        """
        direction = str(request.data.get("direction", "")).lower()
        if direction not in {"up", "down"}:
            raise ValidationError("Direction must be 'up' or 'down'.")

        value = self.get_object()
        siblings = AttributeValue.objects.filter(attribute_id=value.attribute_id).order_by(
            "position", "value"
        )

        with transaction.atomic():
            ordered = list(siblings.select_for_update())
            index = next(i for i, row in enumerate(ordered) if row.pk == value.pk)
            target = index - 1 if direction == "up" else index + 1
            if 0 <= target < len(ordered):
                neighbour = ordered[target]
                value.position, neighbour.position = neighbour.position, value.position
                # Seeded values all share position 0, where a swap is invisible
                # because the ordering falls through to `value`. Renumber the
                # whole run instead (the navigation editor hits this too).
                if value.position == neighbour.position:
                    ordered[index], ordered[target] = ordered[target], ordered[index]
                    for offset, row in enumerate(ordered):
                        row.position = offset
                    AttributeValue.objects.bulk_update(ordered, ["position"])
                else:
                    AttributeValue.objects.bulk_update([value, neighbour], ["position"])

        return Response(self.get_serializer(self.get_object()).data)


class SizeChartViewSet(viewsets.ModelViewSet):
    """Size charts, each describing one Size attribute (docs/business-rules.md §5b).

    Thin: create, update and delete all go through `catalog.services`, which
    owns the rules and the audit entries. Unpaginated for the reason the
    attributes are -- a shop has a handful, and the product form needs all of
    them to offer the right ones.
    """

    serializer_class = SizeChartSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["attribute"]
    pagination_class = None

    def get_queryset(self) -> Any:
        return (
            SizeChart.objects.select_related("attribute")
            .prefetch_related(
                Prefetch("rows", queryset=SizeChartRow.objects.select_related("attribute_value"))
            )
            .annotate(product_count=Count("products"))
            .order_by("attribute__position", "attribute__name", "position", "name")
        )

    @staticmethod
    def _service_data(validated: dict[str, Any]) -> dict[str, Any]:
        data = {key: value for key, value in validated.items() if key != "attribute"}
        if "rows" in data:
            data["rows"] = [
                {"attribute_value": row["attribute_value_id"], "cells": row.get("cells", [])}
                for row in data["rows"]
            ]
        return data

    def perform_create(self, serializer: Any) -> None:
        chart = save_size_chart(
            attribute=serializer.validated_data.get("attribute"),
            data=self._service_data(serializer.validated_data),
            actor=self.request.user,
        )
        # Re-read, so the response carries the rows and the product count
        # without a query per row.
        serializer.instance = self.get_queryset().get(pk=chart.pk)

    def perform_update(self, serializer: Any) -> None:
        chart = save_size_chart(
            chart=serializer.instance,
            attribute=serializer.validated_data.get("attribute"),
            data=self._service_data(serializer.validated_data),
            actor=self.request.user,
        )
        serializer.instance = self.get_queryset().get(pk=chart.pk)

    def perform_destroy(self, instance: SizeChart) -> None:
        delete_size_chart(chart=instance, actor=self.request.user)


class ProductViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        **PRODUCT_PERMISSIONS,
        "generate_variants": ["products.create"],
        "publish": ["products.update"],
        "unpublish": ["products.update"],
        # An import creates products and can receive stock, so it needs both.
        # `products.create` alone would let somebody load a catalogue without
        # the right to touch a single stock figure by hand.
        "import_csv": ["products.create", "inventory.adjust"],
        # Reading the sheet is reading the catalogue, as the label screen is.
        # Ticking a variant off is a write, gated like assigning its barcode:
        # the role that receives and labels stock holds `products.update`.
        "labels": {"GET": ["products.view"], "POST": ["products.update"]},
    }
    filterset_fields = ["status", "published", "featured", "category", "brand"]
    ordering_fields = ["name", "created_at"]

    def get_queryset(self) -> Any:
        if self.action == "labels":
            # The sheet reads its variants itself; the list's prefetches and
            # price annotations would be four queries spent on nothing.
            return Product.objects.select_related("brand")
        queryset = (
            Product.objects.select_related("brand", "category")
            .prefetch_related(
                "images",
                "variants__attribute_values__attribute_value",
                # One query for the whole page, whether a product states one
                # specification or twenty. `select_related` rather than two
                # more prefetch levels: Django issues a query per level, and
                # `Meta.ordering` needs those joins anyway.
                Prefetch(
                    "spec_values",
                    queryset=ProductAttributeValue.objects.select_related(
                        "attribute_value__attribute"
                    ),
                ),
            )
            .annotate(min_price=Min("variants__price"), max_price=Max("variants__price"))
        )
        # Drafts no purchase order has ever named: created from an order that
        # was then abandoned, or on the product form and never bought. By the
        # reverse relation, so the catalogue does not import purchasing.
        if self.request.query_params.get("never_ordered") == "true":
            queryset = queryset.filter(status=PublishStatus.DRAFT).exclude(
                variants__purchase_items__isnull=False
            )
        if search := (self.request.query_params.get("search") or "").strip():
            from catalog.search import search_products

            # The storefront's search answers a shopper -- whole words, ranked --
            # and on its own it found nothing for what staff actually type: a
            # fragment of a name ("kurt") or of a SKU ("RGN-BLO"). Both count
            # now: whatever the storefront search finds, and any product whose
            # name or SKU contains what was typed, or whose barcode it is. By
            # key rather than by joining the variants here, so a product with
            # three matching SKUs is still one row and its prices one figure.
            ranked = search_products(Product.objects.all(), query=search).values("pk")
            fragments = Product.objects.filter(
                Q(name__icontains=search)
                | Q(variants__sku__icontains=search)
                | Q(variants__barcode=search)
            ).values("pk")
            queryset = queryset.filter(Q(pk__in=ranked) | Q(pk__in=fragments))
        # Pagination over an unordered queryset is not merely untidy: PostgreSQL
        # is free to return rows in any order, so page 2 can repeat or skip
        # products that page 1 already showed. `pk` breaks ties between rows
        # created in the same transaction, which the seed does in bulk.
        return queryset.order_by("-created_at", "pk")

    def get_serializer_class(self) -> Any:
        if self.action in {"create", "update", "partial_update"}:
            return ProductWriteSerializer
        if self.action == "retrieve":
            return ProductDetailSerializer
        return ProductListSerializer

    def get_serializer_context(self) -> dict[str, Any]:
        context = super().get_serializer_context()
        if self.action == "retrieve":
            product = self.get_object()
            branch = resolve_branch(actor(self.request), self.request.query_params.get("branch"))
            variants = list(product.variants.all())
            context["stock"] = inventory_services.availability(branch=branch, variants=variants)
            context["received"] = inventory_services.received_variant_ids(
                branch=branch, variants=variants
            )
        return context

    def perform_create(self, serializer: Any) -> None:
        # Popped before `save()`: `spec_values` is not a Product column, and
        # the service -- not the serializer -- owns the rule about which
        # attributes may be stated (CLAUDE.md §4).
        specs = serializer.validated_data.pop("spec_values", None)
        chart_given = "size_chart" in serializer.validated_data
        chart = serializer.validated_data.pop("size_chart", None)
        product = serializer.save(created_by=self.request.user)
        if specs is not None:
            set_product_specs(product=product, value_ids=specs, actor=self.request.user)
        if chart_given:
            set_product_size_chart(product=product, chart=chart, actor=self.request.user)
        audit.record(
            action=audit.AuditAction.CREATE,
            entity=product,
            actor=self.request.user,
            new_values={"name": product.name, "category": product.category.name},
        )

    def perform_update(self, serializer: Any) -> None:
        before = {
            field: getattr(serializer.instance, field)
            for field in ("name", "status", "published", "featured")
        }
        specs = serializer.validated_data.pop("spec_values", None)
        # Same arrangement as the specs: the service owns the rule and the
        # audit entry, so the column is not written by `save()`.
        chart_given = "size_chart" in serializer.validated_data
        chart = serializer.validated_data.pop("size_chart", None)
        product = serializer.save()
        if specs is not None:
            set_product_specs(product=product, value_ids=specs, actor=self.request.user)
        if chart_given:
            set_product_size_chart(product=product, chart=chart, actor=self.request.user)
        after = {field: getattr(product, field) for field in before}
        old, new = audit.diff(before, after)
        if new:
            audit.record(
                action=audit.AuditAction.UPDATE,
                entity=product,
                actor=self.request.user,
                old_values=old,
                new_values=new,
            )

    def perform_destroy(self, instance: Product) -> None:
        # A product that has ever been sold *or stocked* is archived, not
        # deleted: order history and the inventory ledger both hold PROTECTed
        # references to its variants, so a hard delete would raise
        # ProtectedError and surface as an unexplained 409.
        # Printed labels count too: they carry the variants' barcodes on
        # physical stock, and `LabelPrint` PROTECTs the variant.
        if (
            instance.variants.filter(order_items__isnull=False).exists()
            or instance.variants.filter(inventory__isnull=False).exists()
            or instance.variants.filter(inventory_transactions__isnull=False).exists()
            or instance.variants.filter(label_prints__isnull=False).exists()
        ):
            instance.status = "ARCHIVED"
            instance.published = False
            instance.save(update_fields=["status", "published", "updated_at"])
            audit.record(
                action=audit.AuditAction.UPDATE,
                entity=instance,
                actor=self.request.user,
                new_values={"status": "ARCHIVED"},
                reason="Archived instead of deleted: the product has stock or sales history.",
            )
            return
        audit.record(
            action=audit.AuditAction.DELETE,
            entity=instance,
            actor=self.request.user,
            old_values={"name": instance.name},
        )
        instance.delete()

    @action(detail=True, methods=["post"], url_path="generate-variants")
    def generate_variants(self, request: AuthedRequest, pk: str | None = None) -> Response:
        product = self.get_object()
        serializer = GenerateVariantsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        if data["single"]:
            created = create_single_variant(
                product=product, price=data["price"], cost=data.get("cost", 0), actor=request.user
            )
        else:
            created = generate_variants(
                product=product,
                selections=data["selections"],
                price=data["price"],
                cost=data.get("cost", 0),
                actor=request.user,
            )
        return Response(
            {
                "created": len(created),
                "variants": ProductVariantSerializer(created, many=True).data,
            },
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["post"])
    def publish(self, request: AuthedRequest, pk: str | None = None) -> Response:
        # Thin: the gates and the audit row belong to the service (CLAUDE.md §4).
        # It used to hand-roll the error envelope here too, which is what
        # `core.exceptions.BusinessError` and the DRF handler exist to do.
        product = publish_product(product=self.get_object(), actor=request.user)
        return Response(ProductDetailSerializer(product, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def unpublish(self, request: AuthedRequest, pk: str | None = None) -> Response:
        product = self.get_object()
        product.published = False
        product.save(update_fields=["published", "updated_at"])
        return Response(ProductDetailSerializer(product, context={"request": request}).data)

    @action(detail=True, methods=["get", "post"])
    def labels(self, request: AuthedRequest, pk: str | None = None) -> Response:
        """The barcode label sheet for this product, at one branch.

        GET lists **every** variant of the product -- not only the one that was
        scanned -- with the stock the branch holds, which is the hint for how
        many stickers each needs, and whether its labels have been printed.

        POST ticks variants off (``printed: true``) or back on, and answers with
        the sheet as it now stands, so the screen redraws from one response.
        Each tick is a new ``LabelPrint`` row; nothing is edited or deleted.
        """
        product = self.get_object()
        if request.method == "POST":
            serializer = LabelMarksSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            data = serializer.validated_data
            branch = resolve_branch(request.user, data.get("branch"))
            label_services.mark_labels(
                branch=branch,
                product=product,
                marks=[
                    label_services.LabelMark(
                        variant_id=mark["variant"],
                        printed=mark["printed"],
                        quantity=mark["quantity"],
                    )
                    for mark in data["marks"]
                ],
                actor=request.user,
            )
        else:
            branch = resolve_branch(request.user, request.query_params.get("branch"))

        variants = list(
            ProductVariant.objects.filter(product=product)
            .select_related("product", "product__brand")
            .prefetch_related("attribute_values__attribute_value", "attribute_values__attribute")
        )
        marks = label_services.latest_marks(branch=branch, variant_ids=[v.pk for v in variants])
        context = {
            "request": request,
            "stock": inventory_services.availability(branch=branch, variants=variants),
            "label_marks": marks,
            "label_received": label_services.received_since(branch=branch, marks=marks),
        }
        return Response(
            {
                "product": {
                    "id": str(product.pk),
                    "name": product.name,
                    "brand_name": product.brand.name if product.brand else "",
                    "status": product.status,
                },
                "branch": {"id": str(branch.pk), "name": branch.name, "code": branch.code},
                "variants": LabelSheetVariantSerializer(variants, many=True, context=context).data,
            }
        )

    @action(detail=False, methods=["post"], url_path="import", parser_classes=[MultiPartParser])
    def import_csv(self, request: AuthedRequest) -> Response:
        """Load a catalogue from a spreadsheet.

        Two-step by design, and the client cannot skip the first: `dry_run`
        defaults to **true**, so a caller that forgets the flag gets a preview
        rather than several hundred products. Committing is the deliberate act.

        The service owns the transaction; this only reads the upload and hands
        it over (CLAUDE.md §4).
        """
        serializer = ProductImportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        content = serializer.validated_data["file"]
        dry_run = serializer.validated_data["dry_run"]

        if dry_run:
            result = importers.plan(content)
            return Response({"dry_run": True, **result.as_dict()})

        branch = resolve_branch(request.user, serializer.validated_data.get("branch"))
        result = importers.apply(content, branch=branch, actor=request.user)
        return Response(
            {"dry_run": False, **result.as_dict()},
            # A rejected file is the client's to fix, so it is a 400 -- even
            # though the rows themselves are in the body either way.
            status=status.HTTP_201_CREATED if result.ok else status.HTTP_400_BAD_REQUEST,
        )


class ProductVariantViewSet(viewsets.ModelViewSet):
    # `product__brand` is joined, not left to the serializer: `brand_name`
    # reaches through a nullable FK, and the label screen renders a page of
    # variants at a time, so without it each row costs a query for its brand
    # (the D10 shape that bit the three busiest list endpoints).
    queryset = ProductVariant.objects.select_related("product", "product__brand").prefetch_related(
        "attribute_values__attribute_value", "attribute_values__attribute"
    )
    serializer_class = ProductVariantSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        **PRODUCT_PERMISSIONS,
        "lookup": ["products.view"],
        "barcode": ["products.update"],
    }
    # SearchFilter is not a global backend, so it is named here. The purchasing
    # screens need to find a variant by SKU, barcode or product name under
    # `products.view` — the POS grid search needs `sales.create` and shows only
    # ACTIVE products, neither of which suits a buyer raising an order for stock
    # that is still a draft.
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    search_fields = ["sku", "barcode", "product__name"]
    filterset_fields = ["product", "status"]
    ordering_fields = ["sku", "created_at"]

    @action(detail=False, methods=["get"])
    def lookup(self, request: AuthedRequest) -> Response:
        """Exact-first barcode/SKU lookup shared by admin and POS."""
        from orders.services.pos import lookup_variant

        variant = lookup_variant(code=request.query_params.get("code", ""))
        if variant is None:
            return Response(
                {
                    "error": {
                        "code": "NOT_FOUND",
                        "message": "No product matches that code.",
                        "details": {},
                    }
                },
                status=404,
            )
        branch = resolve_branch(request.user, request.query_params.get("branch"))
        context = {
            "request": request,
            "stock": inventory_services.availability(branch=branch, variants=[variant]),
        }
        return Response(ProductVariantSerializer(variant, context=context).data)

    @action(detail=True, methods=["post"])
    def barcode(self, request: AuthedRequest, pk: str | None = None) -> Response:
        """Assign this variant an in-store barcode, or return the one it has.

        Locked, because the caller prints the number it is given. Two requests
        for the same unlabelled variant used to both read `barcode` as empty,
        both draw a *different* number from the sequence, and both save — so
        the first caller printed and stuck on a label carrying a number the
        database no longer held, and that label scanned as nothing. Taking the
        row lock makes the second request wait and return the first's number.

        Idempotent by design: a variant that already has a barcode keeps it.
        Re-issuing would strand every label already on the shelf.
        """
        with transaction.atomic():
            variant = ProductVariant.objects.select_for_update().get(pk=self.get_object().pk)
            if variant.barcode:
                return Response({"barcode": variant.barcode, "created": False})

            variant.barcode = generate_barcode(variant)
            variant.save(update_fields=["barcode", "updated_at"])
            # The neighbouring writes in this file all record one, and this is
            # the more permanent change: a barcode ends up printed on physical
            # stock, so "who gave this SKU that number" outlives the row.
            audit.record(
                action=audit.AuditAction.UPDATE,
                entity=variant,
                actor=request.user,
                new_values={"barcode": variant.barcode},
                reason="In-store barcode assigned for labelling",
            )
        return Response({"barcode": variant.barcode, "created": True})

    def perform_destroy(self, instance: ProductVariant) -> None:
        """Archive a variant with history; only ever hard-delete a clean one.

        `OrderItem`, `Inventory` and `InventoryTransaction` all point here with
        `on_delete=PROTECT`, so deleting a variant that has been stocked or sold
        raises `ProtectedError`. That surfaces as a bare 409 telling the user
        nothing, and the row they were trying to retire stays sellable.

        Archiving is also the answer CLAUDE.md §3.3 asks for: the ledger and the
        order lines that reference this SKU are financial history and must keep
        resolving. An ARCHIVED variant is not sellable (`is_sellable`), which is
        what "remove it" actually means for a shop.
        """
        # A variant with label marks has stickers on physical stock carrying its
        # barcode, so it is archived like one with sales: deleting it would make
        # every one of those stickers scan as nothing.
        has_history = (
            instance.order_items.exists()
            or instance.inventory.exists()
            or instance.inventory_transactions.exists()
            or instance.label_prints.exists()
        )
        if has_history:
            instance.status = PublishStatus.ARCHIVED
            instance.save(update_fields=["status", "updated_at"])
            audit.record(
                action=audit.AuditAction.UPDATE,
                entity=instance,
                actor=self.request.user,
                new_values={"status": PublishStatus.ARCHIVED},
                reason="Archived instead of deleted: the variant has stock or sales history.",
            )
            return

        audit.record(
            action=audit.AuditAction.DELETE,
            entity=instance,
            actor=self.request.user,
            old_values={"sku": instance.sku},
        )
        instance.delete()


class ProductImageViewSet(viewsets.ModelViewSet):
    queryset = ProductImage.objects.select_related("product", "attribute_value__attribute").all()
    serializer_class = ProductImageSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["product", "attribute_value"]

    def perform_create(self, serializer: Any) -> None:
        image = serializer.save()
        # The first image of a product is its primary one unless told otherwise.
        if not ProductImage.objects.filter(product=image.product, is_primary=True).exists():
            image.is_primary = True
            image.save(update_fields=["is_primary"])
