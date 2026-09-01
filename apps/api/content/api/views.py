"""Storefront content API.

Public:  GET /api/v1/shop/navigation/   — the whole navbar in one request
Staff:   /api/v1/navigation-items/, /api/v1/storefront-banners/
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import RolePermission
from content.api.serializers import (
    NavigationItemSerializer,
    StorefrontBannerSerializer,
    serialise_banner,
    serialise_node,
)
from content.models import BannerPlacement, NavigationItem, Placement, StorefrontBanner
from content.selectors import navigation
from content.tasks import request_revalidation
from core import audit
from core.exceptions import ValidationError

NAVIGATION_PERMISSIONS = {
    "list": ["settings.view"],
    "retrieve": ["settings.view"],
    "create": ["content.navigation_manage"],
    "update": ["content.navigation_manage"],
    "partial_update": ["content.navigation_manage"],
    "destroy": ["content.navigation_manage"],
    "move": ["content.navigation_manage"],
}


class ShopNavigationView(APIView):
    """One request for the entire navbar (spec §29).

    Never one request per item, and never a 500: the storefront degrades to the
    category tree and then to its own static list (navigation.md §6).
    """

    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        announcement = (
            StorefrontBanner.objects.live()
            .filter(placement=BannerPlacement.ANNOUNCEMENT)
            .order_by("-priority", "-created_at")
            .first()
        )
        return Response(
            {
                "announcement": serialise_banner(announcement),
                "items": [serialise_node(node) for node in navigation(placement=Placement.HEADER)],
                "footer": [serialise_node(node) for node in navigation(placement=Placement.FOOTER)],
            }
        )


class NavigationItemViewSet(viewsets.ModelViewSet):
    """Merchandiser overrides. Anonymous and customer tokens are refused."""

    queryset = NavigationItem.objects.select_related("category", "parent").all()
    serializer_class = NavigationItemSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = NAVIGATION_PERMISSIONS
    filterset_fields = ["placement", "type", "is_active", "parent"]
    ordering_fields = ["position", "label", "created_at"]
    pagination_class = None

    def get_queryset(self) -> Any:
        return self.queryset.order_by("placement", "position", "label")

    def perform_create(self, serializer: Any) -> None:
        item = serializer.save()
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=item,
            actor=self.request.user,
            new_values={"label": item.display_label, "placement": item.placement},
        )

    def perform_update(self, serializer: Any) -> None:
        tracked = ("label", "url", "badge", "position", "is_active", "layout")
        before = {field: getattr(serializer.instance, field) for field in tracked}
        item = serializer.save()
        old, new = audit.diff(before, {field: getattr(item, field) for field in tracked})
        if new:
            audit.record(
                action=audit.AuditAction.SETTINGS_CHANGED,
                entity=item,
                actor=self.request.user,
                old_values=old,
                new_values=new,
            )

    def perform_destroy(self, instance: NavigationItem) -> None:
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=instance,
            actor=self.request.user,
            old_values={"label": instance.display_label},
            reason="Navigation item removed.",
        )
        instance.delete()

    @action(detail=True, methods=["post"])
    def move(self, request: Request, pk: str | None = None) -> Response:
        """Swap `position` with the previous/next sibling.

        Up/down rather than drag-and-drop so the control is operable by keyboard
        and screen reader (ADR-0009); the field is the same either way.
        """
        direction = str(request.data.get("direction", "")).lower()
        if direction not in {"up", "down"}:
            raise ValidationError("Direction must be 'up' or 'down'.")

        item = self.get_object()
        siblings = NavigationItem.objects.filter(
            placement=item.placement, parent_id=item.parent_id
        ).order_by("position", "label")

        with transaction.atomic():
            ordered = list(siblings.select_for_update())
            index = next(i for i, row in enumerate(ordered) if row.pk == item.pk)
            target = index - 1 if direction == "up" else index + 1
            if 0 <= target < len(ordered):
                neighbour = ordered[target]
                item.position, neighbour.position = neighbour.position, item.position
                # Equal positions fall back to label ordering, which would make
                # the swap invisible. Renumber the whole run instead.
                if item.position == neighbour.position:
                    ordered[index], ordered[target] = ordered[target], ordered[index]
                    for offset, row in enumerate(ordered):
                        row.position = offset
                    NavigationItem.objects.bulk_update(ordered, ["position"])
                else:
                    NavigationItem.objects.bulk_update([item, neighbour], ["position"])

        request_revalidation("navigation")
        return Response(self.get_serializer(self.get_object()).data)


class StorefrontBannerViewSet(viewsets.ModelViewSet):
    queryset = StorefrontBanner.objects.all()
    serializer_class = StorefrontBannerSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = NAVIGATION_PERMISSIONS
    filterset_fields = ["placement", "is_active"]
    ordering_fields = ["priority", "created_at"]
    pagination_class = None

    def perform_create(self, serializer: Any) -> None:
        banner = serializer.save()
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=banner,
            actor=self.request.user,
            new_values={"placement": banner.placement, "message": banner.message},
        )

    def perform_update(self, serializer: Any) -> None:
        tracked = ("message", "title", "url", "is_active", "priority")
        before = {field: getattr(serializer.instance, field) for field in tracked}
        banner = serializer.save()
        old, new = audit.diff(before, {field: getattr(banner, field) for field in tracked})
        if new:
            audit.record(
                action=audit.AuditAction.SETTINGS_CHANGED,
                entity=banner,
                actor=self.request.user,
                old_values=old,
                new_values=new,
            )

    def perform_destroy(self, instance: StorefrontBanner) -> None:
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=instance,
            actor=self.request.user,
            old_values={"placement": instance.placement, "message": instance.message},
            reason="Banner removed.",
        )
        instance.delete()
