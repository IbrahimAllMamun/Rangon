from __future__ import annotations

from typing import Any

from django.db.models import Q
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from customers.api.serializers import (
    CustomerAddressSerializer,
    CustomerNoteSerializer,
    CustomerSerializer,
)
from customers.models import Customer


class CustomerViewSet(viewsets.ModelViewSet):
    serializer_class = CustomerSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["customers.view"],
        "retrieve": ["customers.view"],
        "create": ["customers.create"],
        "update": ["customers.update"],
        "partial_update": ["customers.update"],
        "destroy": ["customers.update"],
        "lookup": ["customers.view"],
        "orders": ["customers.view"],
        "addresses": ["customers.view"],
        "notes": ["customers.view"],
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

    @action(detail=False, methods=["get"])
    def lookup(self, request: Request) -> Response:
        """Fast phone lookup for the POS counter."""
        phone = request.query_params.get("phone", "").strip()
        if not phone:
            return Response({"results": []})
        matches = Customer.objects.filter(phone__icontains=phone, is_active=True)[:10]
        return Response({"results": CustomerSerializer(matches, many=True).data})

    @action(detail=True, methods=["get"])
    def orders(self, request: Request, pk: str | None = None) -> Response:
        from orders.api.serializers import OrderListSerializer

        customer = self.get_object()
        queryset = customer.orders.select_related("branch").order_by("-placed_at")[:100]
        return Response(OrderListSerializer(queryset, many=True).data)

    @action(detail=True, methods=["get", "post"])
    def addresses(self, request: Request, pk: str | None = None) -> Response:
        customer = self.get_object()
        if request.method == "GET":
            return Response(CustomerAddressSerializer(customer.addresses.all(), many=True).data)
        serializer = CustomerAddressSerializer(data={**request.data, "customer": customer.pk})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=201)

    @action(detail=True, methods=["get", "post"])
    def notes(self, request: Request, pk: str | None = None) -> Response:
        customer = self.get_object()
        if request.method == "GET":
            return Response(CustomerNoteSerializer(customer.customer_notes.all(), many=True).data)
        serializer = CustomerNoteSerializer(data={**request.data, "customer": customer.pk})
        serializer.is_valid(raise_exception=True)
        serializer.save(created_by=request.user)
        return Response(serializer.data, status=201)
