from __future__ import annotations

from typing import Any

from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from promotions.api.serializers import CouponRedemptionSerializer, CouponSerializer
from promotions.models import Coupon


class CouponViewSet(viewsets.ModelViewSet):
    queryset = Coupon.objects.prefetch_related("categories", "products").all()
    serializer_class = CouponSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["content.coupons_manage"],
        "retrieve": ["content.coupons_manage"],
        "create": ["content.coupons_manage"],
        "update": ["content.coupons_manage"],
        "partial_update": ["content.coupons_manage"],
        "destroy": ["content.coupons_manage"],
        "redemptions": ["content.coupons_manage"],
    }
    filterset_fields = ["is_active", "discount_type"]
    ordering_fields = ["created_at", "used_count"]

    def perform_create(self, serializer: Any) -> None:
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance: Coupon) -> None:
        # A coupon that has been used is deactivated: its redemptions are part
        # of order history.
        if instance.redemptions.exists():
            instance.is_active = False
            instance.save(update_fields=["is_active", "updated_at"])
            return
        instance.delete()

    @action(detail=True, methods=["get"])
    def redemptions(self, request: Request, pk: str | None = None) -> Response:
        coupon = self.get_object()
        queryset = coupon.redemptions.select_related("order", "customer").order_by("-created_at")
        return Response(CouponRedemptionSerializer(queryset, many=True).data)
