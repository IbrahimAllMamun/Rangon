from __future__ import annotations

from typing import Any

from django.db.models import Count, Max, Min, Q
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import resolve_branch
from catalog.api.serializers import (
    AttributeSerializer,
    AttributeValueSerializer,
    BrandSerializer,
    CategorySerializer,
    GenerateVariantsSerializer,
    ProductDetailSerializer,
    ProductImageSerializer,
    ProductListSerializer,
    ProductVariantSerializer,
    ProductWriteSerializer,
)
from catalog.models import (
    Attribute,
    AttributeValue,
    Brand,
    Category,
    Product,
    ProductImage,
    ProductVariant,
    PublishStatus,
)
from catalog.services import generate_barcode, generate_variants
from core import audit
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


class BrandViewSet(viewsets.ModelViewSet):
    queryset = Brand.objects.all()
    serializer_class = BrandSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["is_active", "is_featured"]
    ordering_fields = ["name"]
    pagination_class = None


class AttributeViewSet(viewsets.ModelViewSet):
    queryset = Attribute.objects.prefetch_related("values").all()
    serializer_class = AttributeSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    pagination_class = None


class AttributeValueViewSet(viewsets.ModelViewSet):
    queryset = AttributeValue.objects.select_related("attribute").all()
    serializer_class = AttributeValueSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = PRODUCT_PERMISSIONS
    filterset_fields = ["attribute"]
    pagination_class = None


class ProductViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        **PRODUCT_PERMISSIONS,
        "generate_variants": ["products.create"],
        "publish": ["products.update"],
        "unpublish": ["products.update"],
    }
    filterset_fields = ["status", "published", "featured", "category", "brand"]
    ordering_fields = ["name", "created_at"]

    def get_queryset(self) -> Any:
        queryset = (
            Product.objects.select_related("brand", "category")
            .prefetch_related("images", "variants__attribute_values__attribute_value")
            .annotate(min_price=Min("variants__price"), max_price=Max("variants__price"))
        )
        search = self.request.query_params.get("search")
        if search:
            from catalog.search import search_products

            return search_products(queryset, query=search)
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
            branch = resolve_branch(self.request.user, self.request.query_params.get("branch"))
            context["stock"] = inventory_services.availability(
                branch=branch, variants=list(product.variants.all())
            )
        return context

    def perform_create(self, serializer: Any) -> None:
        product = serializer.save(created_by=self.request.user)
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
        product = serializer.save()
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
        if (
            instance.variants.filter(order_items__isnull=False).exists()
            or instance.variants.filter(inventory__isnull=False).exists()
            or instance.variants.filter(inventory_transactions__isnull=False).exists()
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
    def generate_variants(self, request: Request, pk: str | None = None) -> Response:
        product = self.get_object()
        serializer = GenerateVariantsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        created = generate_variants(
            product=product,
            selections=serializer.validated_data["selections"],
            price=serializer.validated_data["price"],
            cost=serializer.validated_data.get("cost", 0),
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
    def publish(self, request: Request, pk: str | None = None) -> Response:
        product = self.get_object()
        if not product.variants.exists():
            return Response(
                {
                    "error": {
                        "code": "VALIDATION_ERROR",
                        "message": "A product needs at least one variant before publishing.",
                        "details": {},
                    }
                },
                status=400,
            )
        product.published = True
        product.status = "ACTIVE"
        product.save(update_fields=["published", "status", "updated_at"])
        audit.record(
            action=audit.AuditAction.UPDATE,
            entity=product,
            actor=request.user,
            new_values={"published": True},
        )
        return Response(ProductDetailSerializer(product, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def unpublish(self, request: Request, pk: str | None = None) -> Response:
        product = self.get_object()
        product.published = False
        product.save(update_fields=["published", "updated_at"])
        return Response(ProductDetailSerializer(product, context={"request": request}).data)


class ProductVariantViewSet(viewsets.ModelViewSet):
    queryset = ProductVariant.objects.select_related("product").prefetch_related(
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
    def lookup(self, request: Request) -> Response:
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
    def barcode(self, request: Request, pk: str | None = None) -> Response:
        variant = self.get_object()
        if not variant.barcode:
            variant.barcode = generate_barcode(variant)
            variant.save(update_fields=["barcode"])
        return Response({"barcode": variant.barcode})

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
        has_history = (
            instance.order_items.exists()
            or instance.inventory.exists()
            or instance.inventory_transactions.exists()
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
