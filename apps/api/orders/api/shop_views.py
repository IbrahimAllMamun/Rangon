"""Public storefront API: catalog browsing, cart, checkout, account."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db.models import Avg, Count, Q
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsCustomer
from accounts.services import default_branch
from catalog.models import Brand, Category, Product, ProductVariant, PublishStatus
from catalog.search import facets, search_products, visible_products
from core.exceptions import NotFound, ValidationError
from core.pagination import StandardPagination
from customers.api.serializers import CustomerAddressSerializer
from customers.models import Customer, CustomerAddress
from engagement.models import Review, ReviewStatus, Wishlist, WishlistItem
from inventory import services as inventory_services
from orders.api.serializers import CartSerializer, CheckoutSerializer, OrderDetailSerializer
from orders.models import Order
from orders.services import checkout as checkout_services

CART_HEADER = "HTTP_X_CART_TOKEN"


def _customer_for(request: Request) -> Customer | None:
    user = request.user
    if not (user and user.is_authenticated):
        return None
    return getattr(user, "customer", None)


def _cart_for(request: Request):
    return checkout_services.get_or_create_cart(
        token=request.META.get(CART_HEADER) or request.query_params.get("cart_token"),
        customer=_customer_for(request),
        branch=default_branch(),
    )


def _product_payload(product: Product, *, request: Request, snapshots: dict) -> dict[str, Any]:
    images = [
        {
            "url": request.build_absolute_uri(image.image.url) if image.image else "",
            "alt": image.effective_alt,
            "variant": str(image.variant_id) if image.variant_id else None,
        }
        for image in product.images.all()
    ]
    variants = []
    for variant in product.variants.all():
        if variant.status != PublishStatus.ACTIVE:
            continue
        snapshot = snapshots.get(str(variant.pk))
        variants.append(
            {
                "id": str(variant.pk),
                "sku": variant.sku,
                "label": variant.label,
                "price": str(variant.price),
                "compare_at_price": str(variant.compare_at_price)
                if variant.compare_at_price
                else None,
                "available": snapshot.available if snapshot else 0,
                "in_stock": bool(snapshot and snapshot.available > 0),
                "attributes": {
                    link.attribute.code: {
                        "value": link.attribute_value.value,
                        "label": link.attribute_value.display,
                        "swatch": link.attribute_value.swatch,
                    }
                    for link in variant.attribute_values.all()
                },
            }
        )

    prices = [Decimal(v["price"]) for v in variants] or [Decimal("0.00")]
    return {
        "id": str(product.pk),
        "name": product.name,
        "slug": product.slug,
        "short_description": product.short_description,
        "description": product.description,
        "material": product.material,
        "care_instructions": product.care_instructions,
        "category": {"name": product.category.name, "slug": product.category.slug},
        "brand": {"name": product.brand.name, "slug": product.brand.slug}
        if product.brand
        else None,
        "images": images,
        "variants": variants,
        "price_min": str(min(prices)),
        "price_max": str(max(prices)),
        "in_stock": any(v["in_stock"] for v in variants),
        "featured": product.featured,
        "seo_title": product.seo_title or product.name,
        "seo_description": product.seo_description or product.short_description,
    }


class ShopProductViewSet(viewsets.GenericViewSet):
    permission_classes = [AllowAny]
    pagination_class = StandardPagination
    throttle_scope = "search"
    lookup_field = "slug"
    queryset = Product.objects.none()  # get_queryset is authoritative

    def get_queryset(self) -> Any:
        params = self.request.query_params
        attribute_filters = {
            key[5:]: params.getlist(key) for key in params if key.startswith("attr_")
        }
        return search_products(
            query=params.get("q", ""),
            category_slug=params.get("category", ""),
            brand_slugs=params.getlist("brand"),
            price_min=params.get("price_min") or None,
            price_max=params.get("price_max") or None,
            attribute_filters=attribute_filters,
            in_stock_only=params.get("in_stock") == "true",
            branch=default_branch(),
            sort=params.get("sort", "relevance"),
        )

    def list(self, request: Request) -> Response:
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        products = page if page is not None else list(queryset)

        branch = default_branch()
        variants = ProductVariant.objects.filter(product__in=products)
        snapshots = inventory_services.availability(branch=branch, variants=list(variants))

        payload = [
            _product_payload(product, request=request, snapshots=snapshots) for product in products
        ]
        return self.get_paginated_response(payload) if page is not None else Response(payload)

    def retrieve(self, request: Request, slug: str | None = None) -> Response:
        product = (
            visible_products()
            .prefetch_related(
                "images",
                "variants__attribute_values__attribute_value",
                "variants__attribute_values__attribute",
            )
            .filter(slug=slug)
            .first()
        )
        if product is None:
            raise NotFound("That product is not available.")

        branch = default_branch()
        snapshots = inventory_services.availability(
            branch=branch, variants=list(product.variants.all())
        )
        payload = _product_payload(product, request=request, snapshots=snapshots)

        reviews = product.reviews.filter(status=ReviewStatus.APPROVED).select_related("customer")
        payload["reviews"] = {
            "average": reviews.aggregate(avg=Avg("rating"))["avg"],
            "count": reviews.count(),
            "items": [
                {
                    "id": str(review.pk),
                    "rating": review.rating,
                    "title": review.title,
                    "comment": review.comment,
                    "author": review.customer.name,
                    "verified": review.verified_purchase,
                    "created_at": review.created_at,
                }
                for review in reviews[:20]
            ],
        }
        related = (
            visible_products()
            .filter(category=product.category)
            .exclude(pk=product.pk)
            .prefetch_related("images", "variants")[:8]
        )
        related_snapshots = inventory_services.availability(
            branch=branch,
            variants=list(ProductVariant.objects.filter(product__in=related)),
        )
        payload["related"] = [
            _product_payload(item, request=request, snapshots=related_snapshots) for item in related
        ]
        return Response(payload)

    @action(detail=True, methods=["post"], permission_classes=[IsAuthenticated, IsCustomer])
    def reviews(self, request: Request, slug: str | None = None) -> Response:
        """Only a verified purchaser may review, and it waits for moderation."""
        product = get_object_or_404(visible_products(), slug=slug)
        customer = _customer_for(request)
        if customer is None:
            raise ValidationError("A customer account is required to review.")

        order = (
            Order.objects.filter(
                customer=customer,
                items__variant__product=product,
                status__in=["DELIVERED", "RETURNED", "REFUNDED"],
            )
            .order_by("-placed_at")
            .first()
        )
        if order is None:
            raise ValidationError("You can only review a product you have received.")
        if Review.objects.filter(product=product, customer=customer, order=order).exists():
            raise ValidationError("You have already reviewed this purchase.")

        rating = int(request.data.get("rating", 0))
        if not 1 <= rating <= 5:
            raise ValidationError("Rating must be between 1 and 5.")

        review = Review.objects.create(
            product=product,
            customer=customer,
            order=order,
            rating=rating,
            title=str(request.data.get("title", ""))[:140],
            comment=str(request.data.get("comment", "")),
            verified_purchase=True,
            status=ReviewStatus.PENDING,
        )
        return Response(
            {
                "id": str(review.pk),
                "status": review.status,
                "message": "Thank you — your review will appear once it has been checked.",
            },
            status=status.HTTP_201_CREATED,
        )


class ShopCategoryView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request, slug: str | None = None) -> Response:
        if slug:
            category = get_object_or_404(Category, slug=slug, is_active=True)
            return Response(
                {
                    "id": str(category.pk),
                    "name": category.name,
                    "slug": category.slug,
                    "description": category.description,
                    "image": request.build_absolute_uri(category.image.url)
                    if category.image
                    else "",
                    "breadcrumbs": [
                        {"name": ancestor.name, "slug": ancestor.slug}
                        for ancestor in category.ancestors()
                    ],
                    "children": [
                        {"name": child.name, "slug": child.slug}
                        for child in category.children.filter(is_active=True)
                    ],
                    "seo_title": category.seo_title or category.name,
                    "seo_description": category.seo_description,
                }
            )

        roots = Category.objects.filter(
            parent__isnull=True, is_active=True, show_in_navigation=True
        ).prefetch_related("children")
        return Response(
            [
                {
                    "name": root.name,
                    "slug": root.slug,
                    "image": request.build_absolute_uri(root.image.url) if root.image else "",
                    "children": [
                        {"name": child.name, "slug": child.slug}
                        for child in root.children.filter(is_active=True)
                    ],
                }
                for root in roots
            ]
        )


class ShopFacetsView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "search"

    def get(self, request: Request) -> Response:
        products = search_products(
            query=request.query_params.get("q", ""),
            category_slug=request.query_params.get("category", ""),
        )
        return Response(facets(products=products, branch=default_branch()))


class ShopHomeView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        branch = default_branch()

        def serialise(queryset: Any) -> list[dict[str, Any]]:
            products = list(queryset)
            snapshots = inventory_services.availability(
                branch=branch,
                variants=list(ProductVariant.objects.filter(product__in=products)),
            )
            return [
                _product_payload(product, request=request, snapshots=snapshots)
                for product in products
            ]

        base = visible_products().prefetch_related("images", "variants__attribute_values")

        best_sellers = (
            base.annotate(sold=Count("variants__order_items"))
            .filter(sold__gt=0)
            .order_by("-sold")[:8]
        )

        return Response(
            {
                "featured_categories": [
                    {
                        "name": category.name,
                        "slug": category.slug,
                        "image": request.build_absolute_uri(category.image.url)
                        if category.image
                        else "",
                    }
                    for category in Category.objects.filter(
                        is_active=True, show_in_navigation=True, parent__isnull=True
                    )[:6]
                ],
                "new_arrivals": serialise(base.order_by("-created_at")[:8]),
                "featured": serialise(base.filter(featured=True)[:8]),
                "best_sellers": serialise(best_sellers),
                "brands": [
                    {
                        "name": brand.name,
                        "slug": brand.slug,
                        "logo": request.build_absolute_uri(brand.logo.url) if brand.logo else "",
                    }
                    for brand in Brand.objects.filter(is_active=True, is_featured=True)[:8]
                ],
            }
        )


class CartView(APIView):
    permission_classes = [AllowAny]

    def _respond(self, request: Request, cart: Any) -> Response:
        view = checkout_services.price_cart(cart=cart)
        serializer = CartSerializer(
            cart,
            context={
                "request": request,
                "priced": view.priced,
                "issues": view.issues,
                "availability": view.availability,
            },
        )
        response = Response(serializer.data)
        response["X-Cart-Token"] = cart.token
        return response

    def get(self, request: Request) -> Response:
        return self._respond(request, _cart_for(request))

    def post(self, request: Request) -> Response:
        cart = _cart_for(request)
        checkout_services.add_item(
            cart=cart,
            variant_id=request.data.get("variant"),
            quantity=int(request.data.get("quantity", 1)),
        )
        return self._respond(request, cart)

    def patch(self, request: Request) -> Response:
        cart = _cart_for(request)
        checkout_services.update_item(
            cart=cart,
            item_id=request.data.get("item"),
            quantity=int(request.data.get("quantity", 0)),
        )
        return self._respond(request, cart)

    def delete(self, request: Request) -> Response:
        cart = _cart_for(request)
        item_id = request.query_params.get("item") or request.data.get("item")
        if item_id:
            checkout_services.update_item(cart=cart, item_id=item_id, quantity=0)
        else:
            cart.items.all().delete()
        return self._respond(request, cart)


class CartCouponView(APIView):
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        cart = _cart_for(request)
        checkout_services.apply_coupon(cart=cart, code=request.data.get("code", ""))
        return CartView()._respond(request, cart)

    def delete(self, request: Request) -> Response:
        cart = _cart_for(request)
        checkout_services.remove_coupon(cart=cart)
        return CartView()._respond(request, cart)


class ShippingOptionsView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        cart = _cart_for(request)
        view = checkout_services.price_cart(cart=cart)
        return Response(
            checkout_services.shipping_options(
                city=request.query_params.get("city", ""), subtotal=view.priced.subtotal
            )
        )


class CheckoutView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "checkout"

    def post(self, request: Request) -> Response:
        serializer = CheckoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            raise ValidationError(
                "An Idempotency-Key header is required for checkout.",
                details={"header": ["Idempotency-Key is required."]},
            )

        cart = _cart_for(request)
        order = checkout_services.place_order(
            cart=cart,
            shipping_address=data["shipping_address"],
            billing_address=data.get("billing_address"),
            shipping_method_id=data.get("shipping_method"),
            payment_method=data["payment_method"],
            customer=_customer_for(request),
            contact_name=data.get("contact_name", ""),
            contact_phone=data.get("contact_phone", ""),
            contact_email=data.get("contact_email", ""),
            note=data.get("note", ""),
            idempotency_key=idempotency_key,
            expected_total=data.get("expected_total"),
        )
        return Response(
            {
                "order": OrderDetailSerializer(order).data,
                "tracking_token": order.guest_token,
            },
            status=status.HTTP_201_CREATED,
        )


class OrderTrackingView(APIView):
    """Guest order tracking: order number plus a signed token, never number alone."""

    permission_classes = [AllowAny]

    def get(self, request: Request, number: str) -> Response:
        order = Order.objects.filter(number=number).first()
        if order is None:
            raise NotFound("Order not found.")

        customer = _customer_for(request)
        token = request.query_params.get("token", "")
        if not (customer and order.customer_id == customer.pk) and token != order.guest_token:
            raise NotFound("Order not found.")

        data = OrderDetailSerializer(order).data
        data["events"] = [event for event in data["events"] if event["is_customer_visible"]]
        return Response(data)


class AccountOrdersView(APIView):
    permission_classes = [IsAuthenticated, IsCustomer]

    def get(self, request: Request, number: str | None = None) -> Response:
        customer = _customer_for(request)
        if customer is None:
            return Response({"results": []})

        if number:
            order = get_object_or_404(Order, number=number, customer=customer)
            return Response(OrderDetailSerializer(order).data)

        orders = (
            Order.objects.filter(customer=customer)
            .prefetch_related("items")
            .order_by("-placed_at")[:50]
        )
        from orders.api.serializers import OrderListSerializer

        return Response({"results": OrderListSerializer(orders, many=True).data})


class AccountAddressView(APIView):
    permission_classes = [IsAuthenticated, IsCustomer]

    def get(self, request: Request) -> Response:
        customer = _customer_for(request)
        addresses = customer.addresses.all() if customer else []
        return Response(CustomerAddressSerializer(addresses, many=True).data)

    def post(self, request: Request) -> Response:
        customer = _customer_for(request)
        serializer = CustomerAddressSerializer(data={**request.data, "customer": customer.pk})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def patch(self, request: Request) -> Response:
        customer = _customer_for(request)
        address = get_object_or_404(CustomerAddress, pk=request.data.get("id"), customer=customer)
        serializer = CustomerAddressSerializer(address, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def delete(self, request: Request) -> Response:
        customer = _customer_for(request)
        address = get_object_or_404(
            CustomerAddress, pk=request.query_params.get("id"), customer=customer
        )
        address.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WishlistView(APIView):
    permission_classes = [IsAuthenticated, IsCustomer]

    def get(self, request: Request) -> Response:
        customer = _customer_for(request)
        wishlist, _ = Wishlist.objects.get_or_create(customer=customer)
        branch = default_branch()
        items = wishlist.items.select_related("product").prefetch_related(
            "product__images", "product__variants"
        )
        snapshots = inventory_services.availability(
            branch=branch,
            variants=list(
                ProductVariant.objects.filter(product__in=[item.product for item in items])
            ),
        )
        return Response(
            [
                {
                    "id": str(item.pk),
                    "product": _product_payload(item.product, request=request, snapshots=snapshots),
                }
                for item in items
            ]
        )

    def post(self, request: Request) -> Response:
        customer = _customer_for(request)
        wishlist, _ = Wishlist.objects.get_or_create(customer=customer)
        product = get_object_or_404(visible_products(), pk=request.data.get("product"))
        item, created = WishlistItem.objects.get_or_create(wishlist=wishlist, product=product)
        return Response(
            {"id": str(item.pk), "created": created},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def delete(self, request: Request) -> Response:
        customer = _customer_for(request)
        wishlist = Wishlist.objects.filter(customer=customer).first()
        if wishlist:
            wishlist.items.filter(
                Q(pk=request.query_params.get("id"))
                | Q(product_id=request.query_params.get("product"))
            ).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class PaymentWebhookView(APIView):
    """Provider webhook endpoint.

    Signature verification and event parsing live in the provider class; this
    view only routes and deduplicates (docs/architecture/payments.md).
    """

    permission_classes = [AllowAny]
    authentication_classes: list = []

    def post(self, request: Request, provider: str) -> Response:
        from orders.payments.registry import get_provider
        from orders.services import payments as payment_services

        try:
            provider_impl = get_provider(provider)
        except KeyError:
            raise NotFound(f"Unknown payment provider '{provider}'.") from None

        try:
            event = provider_impl.parse_webhook(body=request.body, headers=dict(request.headers))
        except NotImplementedError:
            raise NotFound("This provider does not send webhooks.") from None

        order = Order.objects.filter(number=event.order_number).first()
        payment = (
            order.payments.filter(status__in=["PENDING", "AUTHORIZED"]).first() if order else None
        )
        stored = payment_services.handle_provider_event(
            provider=provider,
            provider_event_id=event.event_id,
            event_type=event.event_type,
            payload=event.raw,
            order=order,
            payment=payment,
        )
        return Response({"received": True, "result": stored.result})
