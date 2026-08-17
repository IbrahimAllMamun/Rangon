from __future__ import annotations

from typing import Any

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from notifications import services as notification_services
from notifications.models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    is_read = serializers.BooleanField(read_only=True)

    class Meta:
        model = Notification
        fields = [
            "id",
            "notification_type",
            "level",
            "title",
            "body",
            "link",
            "data",
            "is_read",
            "read_at",
            "created_at",
        ]


class NotificationViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self) -> Any:
        queryset = Notification.objects.filter(user=self.request.user)
        if self.request.query_params.get("unread") == "true":
            queryset = queryset.filter(read_at__isnull=True)
        return queryset.order_by("-created_at")

    @action(detail=False, methods=["get"])
    def count(self, request: Request) -> Response:
        unread = Notification.objects.filter(user=request.user, read_at__isnull=True).count()
        return Response({"unread": unread})

    @action(detail=False, methods=["post"], url_path="mark-read")
    def mark_read(self, request: Request) -> Response:
        updated = notification_services.mark_read(
            user=request.user, notification_ids=request.data.get("ids")
        )
        return Response({"updated": updated})
