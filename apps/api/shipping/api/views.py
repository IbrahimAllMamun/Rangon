from __future__ import annotations

from typing import Any

from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from orders.models import OrderEventType, OrderStatus
from orders.services.lifecycle import log_event, transition
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
    ShipmentEvent,
    ShipmentStatus,
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

    def perform_create(self, serializer: Any) -> None:
        shipment = serializer.save(created_by=self.request.user)
        log_event(
            shipment.order,
            OrderEventType.SHIPMENT_CREATED,
            f"Shipment created{f' ({shipment.courier.name})' if shipment.courier else ''}",
            data={"tracking_number": shipment.tracking_number},
            actor=self.request.user,
        )

    @action(detail=True, methods=["post"])
    def events(self, request: Request, pk: str | None = None) -> Response:
        """Record a tracking update and keep the order status in step."""
        shipment = self.get_object()
        new_status = request.data.get("status", ShipmentStatus.IN_TRANSIT)

        event = ShipmentEvent.objects.create(
            shipment=shipment,
            status=new_status,
            message=request.data.get("message", ""),
            location=request.data.get("location", ""),
            occurred_at=request.data.get("occurred_at") or timezone.now(),
            created_by=request.user,
        )
        shipment.status = new_status
        if new_status == ShipmentStatus.DISPATCHED and not shipment.dispatched_at:
            shipment.dispatched_at = timezone.now()
        if new_status == ShipmentStatus.DELIVERED and not shipment.delivered_at:
            shipment.delivered_at = timezone.now()
        shipment.save(update_fields=["status", "dispatched_at", "delivered_at", "updated_at"])

        order = shipment.order
        log_event(
            order,
            OrderEventType.SHIPMENT_EVENT,
            f"{new_status}: {event.message}"[:255],
            data={"shipment_id": str(shipment.pk), "status": new_status},
            actor=request.user,
        )
        if new_status == ShipmentStatus.DISPATCHED and order.status == OrderStatus.PACKED:
            transition(order=order, to_status=OrderStatus.SHIPPED, actor=request.user)
        elif new_status == ShipmentStatus.DELIVERED and order.status in {
            OrderStatus.SHIPPED,
            OrderStatus.PACKED,
        }:
            transition(order=order, to_status=OrderStatus.DELIVERED, actor=request.user)

        return Response(ShipmentEventSerializer(event).data, status=status.HTTP_201_CREATED)
