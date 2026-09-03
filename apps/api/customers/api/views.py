from __future__ import annotations

from typing import Any

from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from customers import services
from customers.api.serializers import (
    CustomerAddressSerializer,
    CustomerLookupSerializer,
    CustomerNoteSerializer,
    CustomerSerializer,
)
from customers.models import Customer, CustomerAddress, CustomerNote


class CustomerViewSet(viewsets.ModelViewSet):
    serializer_class = CustomerSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    # `addresses` and `notes` each serve a read and a write verb, so they
    # declare a requirement per method: an accountant holds `customers.view`
    # and deliberately not `customers.update`, and must not be able to write
    # an address through the read endpoint's permission.
    required_permissions = {
        "list": ["customers.view"],
        "retrieve": ["customers.view"],
        "create": ["customers.create"],
        "update": ["customers.update"],
        "partial_update": ["customers.update"],
        "destroy": ["customers.update"],
        "lookup": ["customers.view"],
        "orders": ["customers.view"],
        "addresses": {"GET": ["customers.view"], "POST": ["customers.update"]},
        "address_detail": {
            "PATCH": ["customers.update"],
            "DELETE": ["customers.update"],
        },
        "notes": {"GET": ["customers.view"], "POST": ["customers.update"]},
        "note_detail": {"DELETE": ["customers.update"]},
    }
    filterset_fields = ["customer_type", "is_active"]
    ordering_fields = ["name", "created_at", "total_spent", "last_order_at"]

    def get_queryset(self) -> Any:
        queryset = Customer.objects.prefetch_related("addresses")
        if search := self.request.query_params.get("search"):
            queryset = queryset.filter(
                Q(name__icontains=search) | Q(phone__icontains=search) | Q(email__icontains=search)
            )
        return queryset.order_by("-created_at")

    def perform_create(self, serializer: Any) -> None:
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance: Customer) -> None:
        # Customers with history are deactivated: their orders must remain intact.
        instance.is_active = False
        instance.save(update_fields=["is_active", "updated_at"])

    # How many characters must be typed before the server will search.
    #
    # `phone__icontains` compiles to `LIKE '%...%'`, which no index on `phone`
    # can serve, so every lookup is a sequential scan of the customer table.
    # That is affordable for a substring specific enough to be worth typing and
    # not for one digit, which matches most of the table and returns ten
    # arbitrary strangers. Three is the shortest prefix a cashier reads off a
    # customer aloud ("last three digits?") and long enough to keep the scan
    # rare.
    LOOKUP_MIN_LENGTH = 3

    @action(detail=False, methods=["get"])
    def lookup(self, request: Request) -> Response:
        """Fast phone lookup for the POS counter.

        Deliberately *not* `get_queryset()`: that prefetches addresses for the
        admin list, and this answers with `CustomerLookupSerializer`, which has
        no addresses to prefetch. Going through it would cost the prefetch and
        render nothing with it.

        Walk-in rows are excluded. They carry no phone so they cannot match
        today, but they are the one customer a cashier must never attach to a
        sale by hand -- `create_pos_sale` resolves the branch's own walk-in row
        when no customer is given, and picking another branch's from a list
        would file the sale against the wrong branch's anonymous customer.
        """
        phone = request.query_params.get("phone", "").strip()
        if len(phone) < self.LOOKUP_MIN_LENGTH:
            return Response({"results": [], "min_length": self.LOOKUP_MIN_LENGTH})

        matches = (
            Customer.objects.filter(phone__icontains=phone, is_active=True)
            .exclude(is_walk_in=True)
            # `only` because the serializer drops `notes`, `tags`, `total_spent`
            # and the rest anyway: there is no reason to read ten strangers'
            # staff commentary out of the database to then throw it away.
            .only(
                "id",
                "name",
                "phone",
                "email",
                "customer_type",
                "total_orders",
                "last_order_at",
            )
            .order_by("name", "pk")[:10]
        )
        return Response({"results": CustomerLookupSerializer(matches, many=True).data})

    @action(detail=True, methods=["get"])
    def orders(self, request: Request, pk: str | None = None) -> Response:
        from orders.api.serializers import OrderListSerializer

        customer = self.get_object()
        queryset = customer.orders.select_related("branch").order_by("-placed_at")[:100]
        return Response(OrderListSerializer(queryset, many=True).data)

    # --- addresses ---------------------------------------------------------
    @action(detail=True, methods=["get", "post"])
    def addresses(self, request: Request, pk: str | None = None) -> Response:
        customer = self.get_object()
        if request.method == "GET":
            return Response(CustomerAddressSerializer(customer.addresses.all(), many=True).data)

        serializer = CustomerAddressSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # The service owns the one-default-per-customer invariant.
        address = services.add_address(
            customer=customer,
            data=serializer.validated_data,
            actor=request.user,
        )
        return Response(CustomerAddressSerializer(address).data, status=201)

    @action(
        detail=True,
        methods=["patch", "delete"],
        url_path=r"addresses/(?P<address_id>[^/.]+)",
    )
    def address_detail(
        self, request: Request, pk: str | None = None, address_id: str | None = None
    ) -> Response:
        customer = self.get_object()
        address = get_object_or_404(CustomerAddress, pk=address_id, customer=customer)

        if request.method == "DELETE":
            services.delete_address(address=address, actor=request.user)
            return Response(status=204)

        serializer = CustomerAddressSerializer(address, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = services.update_address(
            address=address,
            data=serializer.validated_data,
            actor=request.user,
        )
        return Response(CustomerAddressSerializer(updated).data)

    # --- notes -------------------------------------------------------------
    @action(detail=True, methods=["get", "post"])
    def notes(self, request: Request, pk: str | None = None) -> Response:
        customer = self.get_object()
        if request.method == "GET":
            return Response(CustomerNoteSerializer(customer.customer_notes.all(), many=True).data)

        serializer = CustomerNoteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        note = services.add_note(
            customer=customer,
            body=serializer.validated_data["body"],
            is_pinned=serializer.validated_data.get("is_pinned", False),
            actor=request.user,
        )
        return Response(CustomerNoteSerializer(note).data, status=201)

    @action(
        detail=True,
        methods=["delete"],
        url_path=r"notes/(?P<note_id>[^/.]+)",
    )
    def note_detail(
        self, request: Request, pk: str | None = None, note_id: str | None = None
    ) -> Response:
        customer = self.get_object()
        note = get_object_or_404(CustomerNote, pk=note_id, customer=customer)
        services.delete_note(note=note, actor=request.user)
        return Response(status=204)
