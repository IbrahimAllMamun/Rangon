"""Serializers for storefront content.

The public navigation payload is assembled by hand from `content.selectors`
rather than by a ModelSerializer: what it returns is a resolved tree that may
never have touched `NavigationItem` at all (ADR-0009 fallback).
"""

from __future__ import annotations

import copy
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Model
from rest_framework import serializers

from content.models import (
    NavigationItem,
    SitePage,
    SiteSettings,
    SocialLink,
    SocialPlatform,
    StorefrontBanner,
)
from content.rich_text import MAX_BODY_CHARS
from content.selectors import NavNode
from content.services import MAX_OPENING_HOURS_ROWS
from content.validators import (
    PLATFORM_EXAMPLES,
    is_external,
    map_link_for_address,
    whatsapp_number,
)
from core.media import RelativeImageField, media_url, validate_image_upload


def serialise_node(node: NavNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "label": node.label,
        "url": node.url,
        "type": node.type,
        "badge": node.badge or None,
        "layout": node.layout,
        "description": node.description,
        "image": media_url(node.image) or None,
        "children": [serialise_node(child) for child in node.children],
    }


def serialise_banner(banner: StorefrontBanner | None) -> dict[str, Any] | None:
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
        "image": media_url(banner.image) or None,
        "dismissible": banner.dismissible,
    }


class ScheduledContentSerializer(serializers.ModelSerializer):
    """Shared rules for the two scheduled content models.

    The model's own `clean()` runs here so an invariant written once applies to
    the API, the Django admin and any management command alike.
    """

    # drf-stubs types `instance` to cover a `many=True` serializer too, so every
    # attribute read off it is invisible.  Declaration only: a bare annotation
    # creates no class attribute, so `SerializerMetaclass` sees nothing new and
    # nothing changes at runtime.  `Model` rather than a concrete class because
    # this base serves both content models (D6).
    instance: Model | None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        starts_at = attrs.get("starts_at", getattr(self.instance, "starts_at", None))
        ends_at = attrs.get("ends_at", getattr(self.instance, "ends_at", None))
        if starts_at and ends_at and ends_at < starts_at:
            raise serializers.ValidationError({"ends_at": "The window must end after it starts."})

        # `Meta.model` is typed as the serializer's bound model variable, which
        # mypy will not instantiate directly; the local states what it is.
        model: type[Model] = self.Meta.model
        candidate = copy.copy(self.instance) if self.instance is not None else model()
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
    image = RelativeImageField(required=False, allow_null=True)
    display_label = serializers.CharField(read_only=True)
    category_name = serializers.CharField(source="category.name", read_only=True, default="")
    page = serializers.SlugRelatedField(
        slug_field="slug",
        queryset=SitePage.objects.all(),
        required=False,
        allow_null=True,
    )
    page_title = serializers.CharField(source="page.title", read_only=True, default="")

    def validate_image(self, value: Any) -> Any:
        return validate_image_upload(value)

    class Meta:
        model = NavigationItem
        fields = [
            "id",
            "placement",
            "type",
            "parent",
            "category",
            "category_name",
            "page",
            "page_title",
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
    image = RelativeImageField(required=False, allow_null=True)

    def validate_image(self, value: Any) -> Any:
        return validate_image_upload(value)

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


# --- footer & site pages -------------------------------------------------------

DEFAULT_COPYRIGHT = "© {year} {name}. All rights reserved."


def contact_fallbacks(organization: Any) -> dict[str, str]:
    """What a blank storefront contact field shows instead: the organisation's."""
    if organization is None:
        return {"name": "", "address": "", "phone": "", "email": ""}
    return {
        "name": organization.name,
        "address": organization.address,
        "phone": organization.phone,
        "email": organization.email,
    }


def serialise_site(
    *,
    settings: SiteSettings,
    organization: Any,
    social: list[SocialLink],
    columns: list[NavNode],
) -> dict[str, Any]:
    """The whole footer in one payload (`GET /shop/site/`).

    Blank contact fields are resolved here, so the storefront never has to know
    that there are two sources.  `{year}` stays in the copyright line: the page
    around it may be cached across a new year, so the storefront fills it in.
    """
    fallback = contact_fallbacks(organization)
    name = fallback["name"] or "Rangon Fashion"
    address = settings.address or fallback["address"]
    whatsapp = next(
        (
            number
            for link in social
            if link.platform == SocialPlatform.WHATSAPP and (number := whatsapp_number(link.url))
        ),
        "",
    )
    return {
        "brand": {
            "name": name,
            "tagline": settings.tagline,
            "address": address if settings.show_address else "",
            "phone": settings.phone or fallback["phone"],
            "email": settings.email or fallback["email"],
            "opening_hours": settings.opening_hours or [],
        },
        "map": {
            "embed_url": settings.map_embed_url,
            "link_url": settings.map_link_url or map_link_for_address(address),
        },
        "social": [
            {"platform": link.platform, "label": link.get_platform_display(), "url": link.url}
            for link in social
        ],
        "columns": [
            {
                "id": column.id,
                "label": column.label,
                "links": [
                    {"label": link.label, "url": link.url, "external": is_external(link.url)}
                    for link in column.children
                ],
            }
            for column in columns
        ],
        "bottom": {
            "copyright": settings.copyright_text or DEFAULT_COPYRIGHT.replace("{name}", name),
            "note": settings.bottom_note,
        },
        # `None` means no WhatsApp link is set up at all, and the storefront may
        # fall back to its build-time number; a link with the float switched
        # off is an explicit "no button", which that fallback must not override.
        "whatsapp": (
            {"number": whatsapp, "show_float": settings.whatsapp_float} if whatsapp else None
        ),
    }


def serialise_page(page: SitePage) -> dict[str, Any]:
    return {
        "slug": page.slug,
        "title": page.title,
        "meta_description": page.meta_description,
        "body": page.body,
        "path": page.path,
        "is_system": page.is_system,
        "updated_at": page.updated_at.isoformat() if page.updated_at else None,
    }


class OpeningHoursRowSerializer(serializers.Serializer):
    days = serializers.CharField(max_length=60, allow_blank=True)
    hours = serializers.CharField(max_length=60, allow_blank=True)


class SiteSettingsSerializer(serializers.ModelSerializer):
    """Staff view of the settings row, with what each blank field falls back to."""

    fallbacks = serializers.SerializerMethodField()
    updated_by_name = serializers.SerializerMethodField()

    class Meta:
        model = SiteSettings
        fields = [
            "tagline",
            "address",
            "phone",
            "email",
            "opening_hours",
            "show_address",
            "map_embed_url",
            "map_link_url",
            "copyright_text",
            "bottom_note",
            "whatsapp_float",
            "fallbacks",
            "updated_at",
            "updated_by_name",
        ]
        read_only_fields = fields

    def get_fallbacks(self, settings: SiteSettings) -> dict[str, str]:
        return contact_fallbacks(self.context.get("organization"))

    def get_updated_by_name(self, settings: SiteSettings) -> str:
        return settings.updated_by.full_name if settings.updated_by else ""


class SiteSettingsWriteSerializer(serializers.Serializer):
    """Shape and length only; the rules are in `content.services`."""

    tagline = serializers.CharField(max_length=200, allow_blank=True, required=False)
    address = serializers.CharField(max_length=500, allow_blank=True, required=False)
    phone = serializers.CharField(max_length=32, allow_blank=True, required=False)
    email = serializers.EmailField(allow_blank=True, required=False)
    opening_hours = serializers.ListField(
        child=OpeningHoursRowSerializer(), required=False, max_length=MAX_OPENING_HOURS_ROWS
    )
    show_address = serializers.BooleanField(required=False)
    # CharField, not URLField: iframe code is accepted and reduced to its URL.
    map_embed_url = serializers.CharField(max_length=4000, allow_blank=True, required=False)
    map_link_url = serializers.CharField(max_length=500, allow_blank=True, required=False)
    copyright_text = serializers.CharField(max_length=200, allow_blank=True, required=False)
    bottom_note = serializers.CharField(max_length=200, allow_blank=True, required=False)
    whatsapp_float = serializers.BooleanField(required=False)


class SocialLinkSerializer(serializers.ModelSerializer):
    # `Field.label` is a str on the base class; the declared field replaces it.
    label = serializers.CharField(  # type: ignore[assignment]
        source="get_platform_display", read_only=True
    )
    example = serializers.SerializerMethodField()

    class Meta:
        model = SocialLink
        fields = ["id", "platform", "label", "url", "is_visible", "position", "example"]
        read_only_fields = fields

    def get_example(self, link: SocialLink) -> str:
        return PLATFORM_EXAMPLES.get(link.platform, "")


class SocialLinkWriteSerializer(serializers.Serializer):
    url = serializers.CharField(max_length=300, allow_blank=True, required=False)
    is_visible = serializers.BooleanField(required=False)


class SitePageSerializer(serializers.ModelSerializer):
    path = serializers.CharField(read_only=True)
    updated_by_name = serializers.SerializerMethodField()

    class Meta:
        model = SitePage
        fields = [
            "id",
            "slug",
            "title",
            "meta_description",
            "body",
            "is_published",
            "is_system",
            "path",
            "created_at",
            "updated_at",
            "updated_by_name",
        ]
        read_only_fields = fields

    def get_updated_by_name(self, page: SitePage) -> str:
        return page.updated_by.full_name if page.updated_by else ""


class SitePageWriteSerializer(serializers.Serializer):
    # The body limit is checked again after sanitising; this only stops a
    # multi-megabyte request before nh3 has to parse it.
    title = serializers.CharField(max_length=120, required=False)
    meta_description = serializers.CharField(max_length=300, allow_blank=True, required=False)
    body = serializers.CharField(
        max_length=MAX_BODY_CHARS * 2, allow_blank=True, required=False, trim_whitespace=False
    )
    is_published = serializers.BooleanField(required=False)


class SitePageCreateSerializer(SitePageWriteSerializer):
    slug = serializers.CharField(max_length=64, allow_blank=True, required=False)
    title = serializers.CharField(max_length=120)
