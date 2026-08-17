from __future__ import annotations

from django.utils import timezone
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from engagement.models import Review, ReviewStatus


class ReviewSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True)

    class Meta:
        model = Review
        fields = [
            "id",
            "product",
            "product_name",
            "customer",
            "customer_name",
            "order",
            "rating",
            "title",
            "comment",
            "verified_purchase",
            "status",
            "moderation_note",
            "moderated_at",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "product",
            "customer",
            "order",
            "rating",
            "title",
            "comment",
            "verified_purchase",
            "created_at",
        ]


class ReviewModerationViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """Reviews are hidden until a human approves them (plan §25)."""

    queryset = Review.objects.select_related("product", "customer")
    serializer_class = ReviewSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["content.review_moderate"],
        "retrieve": ["content.review_moderate"],
        "approve": ["content.review_moderate"],
        "reject": ["content.review_moderate"],
    }
    filterset_fields = ["status", "product", "rating"]
    ordering_fields = ["created_at", "rating"]

    def _moderate(self, request: Request, new_status: str) -> Response:
        review = self.get_object()
        review.status = new_status
        review.moderated_by = request.user
        review.moderated_at = timezone.now()
        review.moderation_note = request.data.get("note", "")
        review.save(
            update_fields=[
                "status",
                "moderated_by",
                "moderated_at",
                "moderation_note",
                "updated_at",
            ]
        )
        return Response(ReviewSerializer(review).data)

    @action(detail=True, methods=["post"])
    def approve(self, request: Request, pk: str | None = None) -> Response:
        return self._moderate(request, ReviewStatus.APPROVED)

    @action(detail=True, methods=["post"])
    def reject(self, request: Request, pk: str | None = None) -> Response:
        return self._moderate(request, ReviewStatus.REJECTED)
