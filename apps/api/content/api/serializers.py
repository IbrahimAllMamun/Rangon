"""Serializers for storefront content.

The public navigation payload is assembled by hand from `content.selectors`
rather than by a ModelSerializer: what it returns is a resolved tree that may
never have touched `NavigationItem` at all (ADR-0009 fallback).
"""

from __future__ import annotations

import copy
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from content.models import NavigationItem, StorefrontBanner
from content.selectors import NavNode


def absolute(request: Any, image: Any) -> str:
    if not image:
        return ""
    url = image.url
    return request.build_absolute_uri(url) if request else url


def serialise_node(node: NavNode, *, request: Any) -> dict[str, Any]:
    return {
        "id": node.id,
        "label": node.label,
        "url": node.url,
        "type": node.type,
        "badge": node.badge or None,
        "layout": node.layout,
        "description": node.description,
        "image": absolute(request, node.image) or None,
        "children": [serialise_node(child, request=request) for child in node.children],
    }


def serialise_banner(banner: StorefrontBanner | None, *, request: Any) -> dict[str, Any] | None:
    if banner is None:
        return None
    return {
        "id": str(banner.pk),
        "placement": banner.placement,
        "message": banner.message,
        "title": banner.title,
        "subtitle": banner.subtitle,
        "cta_label": banner.cta_label,
        "url": banner.url,
        "image": absolute(request, banner.image) or None,
        "dismissible": banner.dismissible,
    }


class ScheduledContentSerializer(serializers.ModelSerializer):
    """Shared rules for the two scheduled content models.

    The model's own `clean()` runs here so an invariant written once applies to
    the API, the Django admin and any management command alike.
    """

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        starts_at = attrs.get("starts_at", getattr(self.instance, "starts_at", None))
        ends_at = attrs.get("ends_at", getattr(self.instance, "ends_at", None))
        if starts_at and ends_at and ends_at < starts_at:
            raise serializers.ValidationError({"ends_at": "The window must end after it starts."})

        candidate = copy.copy(self.instance) if self.instance is not None else self.Meta.model()
        for key, value in attrs.items():
            setattr(candidate, key, value)
        try:
            candidate.clean()
        except DjangoValidationError as error:
            raise serializers.ValidationError(
                error.message_dict if hasattr(error, "message_dict") else error.messages
            ) from error
        return attrs


class NavigationItemSerializer(ScheduledContentSerializer):
    display_label = serializers.CharField(read_only=True)
    category_name = serializers.CharField(source="category.name", read_only=True, default="")

    class Meta:
        model = NavigationItem
        fields = [
            "id",
            "placement",
            "type",
            "parent",
            "category",
            "category_name",
            "label",
            "display_label",
            "url",
            "badge",
            "image",
            "description",
            "layout",
            "position",
            "is_active",
            "starts_at",
            "ends_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_parent(self, parent: NavigationItem | None) -> NavigationItem | None:
        if parent is None:
            return parent
        if self.instance is not None and parent.pk == self.instance.pk:
            raise serializers.ValidationError("An item cannot be its own parent.")
        if parent.parent_id is not None:
            raise serializers.ValidationError(
                "Navigation overrides are two levels deep; nest under a top-level item."
            )
        return parent


class StorefrontBannerSerializer(ScheduledContentSerializer):
    class Meta:
        model = StorefrontBanner
        fields = [
            "id",
            "placement",
            "message",
            "title",
            "subtitle",
            "cta_label",
            "url",
            "image",
            "dismissible",
            "priority",
            "is_active",
            "starts_at",
            "ends_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]
