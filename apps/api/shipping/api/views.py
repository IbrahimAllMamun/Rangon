from __future__ import annotations

from typing import Any

from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import branch_queryset
from core.requests import AuthedRequest, actor
from orders.models import Order
from shipping import services as shipping_services
from shipping.api.serializers import (
    CourierSerializer,
    ShipmentEventSerializer,
    ShipmentSerializer,
    ShippingMethodSerializer,
    ShippingZoneSerializer,
)
from shipping.models import (
    Courier,
    Shipment,
    ShippingMethod,
    ShippingZone,
)

SETTINGS_PERMISSIONS = {
    "list": ["settings.view"],
    "retrieve": ["settings.view"],
    "create": ["settings.manage"],
    "update": ["settings.manage"],
    "partial_update": ["settings.manage"],
    "destroy": ["settings.manage"],
}


class ShippingZoneViewSet(viewsets.ModelViewSet):
    queryset = ShippingZone.objects.prefetch_related("methods").all()
    serializer_class = ShippingZoneSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = SETTINGS_PERMISSIONS
    pagination_class = None


class ShippingMethodViewSet(viewsets.ModelViewSet):
    queryset = ShippingMethod.objects.select_related("zone").all()
    serializer_class = ShippingMethodSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = SETTINGS_PERMISSIONS
    filterset_fields = ["zone", "is_active"]
    pagination_class = None


class CourierViewSet(viewsets.ModelViewSet):
    queryset = Courier.objects.all()
    serializer_class = CourierSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = SETTINGS_PERMISSIONS
    pagination_class = None


class ShipmentViewSet(viewsets.ModelViewSet):
    """Parcels, and what has happened to each of them.

    Thin on purpose: every rule about *which* orders may be shipped, what a
    shipment starts as, and what a tracking update may say lives in
    `shipping.services`, because all three reach into the order's status
    machine (CLAUDE.md §4).
    """

    queryset = Shipment.objects.select_related("order", "courier").prefetch_related("events")
    serializer_class = ShipmentSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["orders.view"],
        "retrieve": ["orders.view"],
        "create": ["orders.fulfil"],
        "update": ["orders.fulfil"],
        "partial_update": ["orders.fulfil"],
        "destroy": ["orders.fulfil"],
        "events": ["orders.fulfil"],
    }
    filterset_fields = ["order", "status", "courier"]

    def get_queryset(self) -> Any:
        # This was the only write viewset in the codebase with no branch scope
        # (D68), while orders, inventory, purchasing and finance all have one.
        # A manager confined to one branch could list, read and ship another
        # branch's orders.
        return branch_queryset(actor(self.request), super().get_queryset(), field="order__branch")

    def get_serializer(self, *args: Any, **kwargs: Any) -> Any:
        serializer = super().get_serializer(*args, **kwargs)
        # Narrow the `order` field to the same set, so an order the user may not
        # see reads as one that does not exist rather than one they may ship.
        fields = getattr(serializer, "fields", None)
        if fields and "order" in fields:
            fields["order"].queryset = branch_queryset(actor(self.request), Order.objects.all())
        return serializer

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        shipment = shipping_services.create_shipment(
            order=data["order"],
            courier=data.get("courier"),
            shipping_method=data.get("shipping_method"),
            tracking_number=data.get("tracking_number", ""),
            cost=data.get("cost"),
            notes=data.get("notes", ""),
            actor=actor(request),
        )
        return Response(ShipmentSerializer(shipment).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def events(self, request: AuthedRequest, pk: str | None = None) -> Response:
        """Record a tracking update and keep the order status in step.

        The payload goes through `ShipmentEventSerializer` rather than being
        read off `request.data`: a `ShipmentEvent` is append-only and its status
        drives `PACKED -> SHIPPED -> DELIVERED`, so an undefined status is not
        cosmetic. It is permanent, and it stops the order progressing.
        """
        shipment = self.get_object()

        serializer = ShipmentEventSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        event = shipping_services.record_event(
            shipment=shipment,
            status=serializer.validated_data.get("status"),
            message=serializer.validated_data.get("message", ""),
            location=serializer.validated_data.get("location", ""),
            occurred_at=serializer.validated_data.get("occurred_at"),
            actor=request.user,
        )
        return Response(ShipmentEventSerializer(event).data, status=status.HTTP_201_CREATED)
