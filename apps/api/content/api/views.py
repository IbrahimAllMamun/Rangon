"""Storefront content API.

Public:  GET /api/v1/shop/navigation/     — the whole navbar in one request
         GET /api/v1/shop/site/           — the whole footer in one request
         GET /api/v1/shop/pages/[<slug>/] — published site pages
Staff:   /api/v1/navigation-items/, /api/v1/storefront-banners/,
         /api/v1/site-settings/, /api/v1/social-links/, /api/v1/site-pages/
"""

from __future__ import annotations

from typing import Any

from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import RolePermission
from accounts.services import get_organization
from content import selectors, services
from content.api.serializers import (
    NavigationItemSerializer,
    SitePageCreateSerializer,
    SitePageSerializer,
    SitePageWriteSerializer,
    SiteSettingsSerializer,
    SiteSettingsWriteSerializer,
    SocialLinkSerializer,
    SocialLinkWriteSerializer,
    StorefrontBannerSerializer,
    serialise_banner,
    serialise_node,
    serialise_page,
    serialise_site,
)
from content.models import (
    BannerPlacement,
    NavigationItem,
    Placement,
    SitePage,
    SocialLink,
    StorefrontBanner,
)
from content.selectors import navigation
from content.tasks import request_revalidation
from core import audit
from core.exceptions import NotFound

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
                # Columns of links, as `/shop/site/` serves them. Kept here for
                # callers that only fetch the navbar.
                "footer": [serialise_node(node) for node in selectors.footer_columns()],
            }
        )


class NavigationItemViewSet(viewsets.ModelViewSet):
    """Merchandiser overrides. Anonymous and customer tokens are refused."""

    queryset = NavigationItem.objects.select_related("category", "parent", "page").all()
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
        """Move one place up or down among its siblings (`content.services.move`)."""
        item = self.get_object()
        siblings = NavigationItem.objects.filter(
            placement=item.placement, parent_id=item.parent_id
        ).order_by("position", "label")
        services.move(
            siblings, pk=item.pk, direction=str(request.data.get("direction", "")).lower()
        )

        # `bulk_update` sends no `post_save`, so the signal never fires for this.
        request_revalidation("navigation", "site")
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


# --- footer & site pages -------------------------------------------------------

#: Reading is `settings.view`, as for everything else under Settings; writing
#: is its own code so a future marketing role can hold it without the navbar.
SITE_READ = ["settings.view"]
SITE_WRITE = ["content.site_manage"]


class ShopSiteView(APIView):
    """The footer's brand block, social links and link columns, in one request.

    Never a 500 for want of configuration: an install with nothing set up
    answers with the organisation's details and no columns, and the storefront
    renders that.
    """

    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        return Response(
            serialise_site(
                settings=selectors.site_settings(),
                organization=get_organization(),
                social=selectors.live_social_links(),
                columns=selectors.footer_columns(),
            )
        )


class ShopPageListView(APIView):
    """Published pages, for the sitemap and the storefront's static params."""

    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        return Response(
            [
                {"slug": page.slug, "path": page.path, "updated_at": page.updated_at.isoformat()}
                for page in selectors.published_pages()
            ]
        )


class ShopPageView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request, slug: str) -> Response:
        page = selectors.published_page(slug)
        if page is None:
            raise NotFound("That page does not exist.")
        return Response(serialise_page(page))


class SiteSettingsView(APIView):
    """`GET`/`PATCH /api/v1/site-settings/` — the one settings row."""

    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {"get": SITE_READ, "patch": SITE_WRITE}

    def _payload(self) -> dict[str, Any]:
        return SiteSettingsSerializer(
            selectors.site_settings(), context={"organization": get_organization()}
        ).data

    def get(self, request: Request) -> Response:
        return Response(self._payload())

    def patch(self, request: Request) -> Response:
        serializer = SiteSettingsWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        services.update_site_settings(actor=request.user, changes=dict(serializer.validated_data))
        return Response(self._payload())


class SocialLinkViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """One row per platform (made by migration): fill in, show/hide, reorder.

    There is no create or delete — the platform list is fixed and a row with no
    URL is simply never shown.
    """

    queryset = SocialLink.objects.order_by("position", "platform")
    serializer_class = SocialLinkSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": SITE_READ,
        "retrieve": SITE_READ,
        "partial_update": SITE_WRITE,
        "move": SITE_WRITE,
    }
    pagination_class = None

    def partial_update(self, request: Request, pk: str | None = None) -> Response:
        serializer = SocialLinkWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        link = services.update_social_link(
            link_id=self.get_object().pk, actor=request.user, **serializer.validated_data
        )
        return Response(SocialLinkSerializer(link).data)

    @action(detail=True, methods=["post"])
    def move(self, request: Request, pk: str | None = None) -> Response:
        link = services.move_social_link(
            link_id=self.get_object().pk,
            direction=str(request.data.get("direction", "")).lower(),
            actor=request.user,
        )
        request_revalidation("site")
        return Response(SocialLinkSerializer(link).data)


class SitePageViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """About, Contact, the policies, and the shop's own pages. Addressed by slug."""

    queryset = SitePage.objects.select_related("updated_by").order_by("-is_system", "title")
    serializer_class = SitePageSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": SITE_READ,
        "retrieve": SITE_READ,
        "create": SITE_WRITE,
        "partial_update": SITE_WRITE,
        "destroy": SITE_WRITE,
    }
    lookup_field = "slug"
    pagination_class = None

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = SitePageCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        page = services.create_page(actor=request.user, **serializer.validated_data)
        return Response(SitePageSerializer(page).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request: Request, slug: str | None = None) -> Response:
        serializer = SitePageWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        page = services.update_page(
            slug=self.get_object().slug,
            actor=request.user,
            changes=dict(serializer.validated_data),
        )
        return Response(SitePageSerializer(page).data)

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        services.delete_page(slug=self.get_object().slug, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)
