"""Navigation resolution.

Read path only.  The order is fixed by ADR-0009:

    1. live NavigationItem rows for the placement
    2. if that set is empty -> the category tree
    3. (the frontend supplies a static fallback if this endpoint is unreachable)

Nothing here takes a `request`: images come back as the field file and the API
layer absolutises them.

The tree is expanded one query *per level*, never per node — the whole payload
is a handful of queries however many categories there are
(docs/database/indexing.md, guarded by tests/api/test_navigation.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from catalog.models import Category
from content.models import (
    NavigationItem,
    NavigationItemType,
    NavigationLayout,
    Placement,
    SitePage,
    SiteSettings,
    SocialLink,
)

#: Root + child + grandchild.  The catalogue is two deep today, so this yields
#: dropdowns; a third level starts producing mega menus with no frontend change
#: (navigation.md §4).
NAVIGATION_MAX_DEPTH = 3


@dataclass(slots=True)
class NavNode:
    id: str
    label: str
    url: str
    type: str = NavigationItemType.CATEGORY
    badge: str = ""
    layout: str = NavigationLayout.AUTO
    description: str = ""
    image: Any = None
    children: list[NavNode] = field(default_factory=list)


def category_path(category: Category) -> str:
    """`women/kurti` — the canonical path for a category."""
    return "/".join([*(ancestor.slug for ancestor in category.ancestors()), category.slug])


def category_url(path: str) -> str:
    return f"/category/{path}"


def _node_for(category: Category, path: str) -> NavNode:
    return NavNode(
        id=str(category.pk),
        label=category.name,
        url=category_url(path),
        description=category.description,
        image=category.image or None,
    )


def _expand(seeds: dict[Any, tuple[NavNode, str]], *, depth: int) -> None:
    """Attach `depth` further levels of active children under each seed node.

    `seeds` maps a category id to the node it should hang off and that
    category's path.  Mutates the nodes in place.
    """
    frontier = seeds
    for _ in range(max(depth, 0)):
        if not frontier:
            return
        children = Category.objects.filter(parent_id__in=list(frontier), is_active=True).order_by(
            "position", "name"
        )

        next_frontier: dict[Any, tuple[NavNode, str]] = {}
        for child in children:
            parent_node, parent_path = frontier[child.parent_id]
            path = f"{parent_path}/{child.slug}"
            node = _node_for(child, path)
            parent_node.children.append(node)
            next_frontier[child.pk] = (node, path)
        frontier = next_frontier


def category_navigation() -> list[NavNode]:
    """The default navigation: the catalogue itself."""
    roots = list(
        Category.objects.filter(
            parent__isnull=True, is_active=True, show_in_navigation=True
        ).order_by("position", "name")
    )
    nodes = [_node_for(root, root.slug) for root in roots]
    _expand(
        {root.pk: (node, root.slug) for root, node in zip(roots, nodes, strict=True)},
        depth=NAVIGATION_MAX_DEPTH - 1,
    )
    return nodes


def _item_node(item: NavigationItem) -> NavNode:
    url = item.url
    # Guarded on the object, not on `category_id`: the same test, but it is
    # the object the next line needs and the one the checker can narrow.  The
    # row is `select_related`, so reading it costs no query.
    if item.type == NavigationItemType.CATEGORY and item.category:
        url = category_url(category_path(item.category))
    return NavNode(
        id=str(item.pk),
        label=item.display_label,
        url=url,
        type=item.type,
        badge=item.badge,
        layout=item.layout,
        description=item.description,
        image=item.image or None,
    )


def override_navigation(*, placement: str = Placement.HEADER, now=None) -> list[NavNode]:
    """Live override rows for a placement, or `[]` when none are configured."""
    items = list(
        NavigationItem.objects.live(now=now)
        .filter(placement=placement)
        .select_related("category", "category__parent")
        .order_by("position", "label")
    )
    if not items:
        return []

    by_id = {item.pk: _item_node(item) for item in items}
    roots: list[NavNode] = []
    for item in items:
        parent_node = by_id.get(item.parent_id) if item.parent_id else None
        if parent_node is not None:
            parent_node.children.append(by_id[item.pk])
        elif item.parent_id is None:
            roots.append(by_id[item.pk])
        # An item whose parent is not live is hidden with it, deliberately: a
        # scheduled campaign menu must not leak its children.

    # A CATEGORY override with no hand-built children inherits the real ones,
    # so overriding a label does not silently delete a submenu. Every such item
    # is expanded together, level by level.
    inherit = {
        item.category_id: (by_id[item.pk], category_path(item.category))
        for item in items
        if item.type == NavigationItemType.CATEGORY
        and item.category_id
        and not by_id[item.pk].children
    }
    _expand(inherit, depth=NAVIGATION_MAX_DEPTH - 1)
    return roots


def navigation(*, placement: str = Placement.HEADER, now=None) -> list[NavNode]:
    """Override rows if any exist for this placement, otherwise the catalogue."""
    override = override_navigation(placement=placement, now=now)
    if override:
        return override
    return category_navigation() if placement == Placement.HEADER else []


# --- footer & site -----------------------------------------------------------

#: How many categories a "Top categories" footer entry expands to.  A footer
#: column is a short list; the navbar is where the whole tree lives.
FOOTER_CATEGORY_LIMIT = 8


def site_settings() -> SiteSettings:
    """The one settings row, created on first read if a migration never made it."""
    settings, _ = SiteSettings.objects.get_or_create(key="default")
    return settings


def _top_categories() -> list[NavNode]:
    roots = Category.objects.filter(
        parent__isnull=True, is_active=True, show_in_navigation=True
    ).order_by("position", "name")[:FOOTER_CATEGORY_LIMIT]
    return [
        NavNode(id=str(root.pk), label=root.name, url=category_url(root.slug)) for root in roots
    ]


def _footer_links(item: NavigationItem, top_categories: list[NavNode]) -> list[NavNode]:
    """What one footer entry renders as: zero, one or (for a category list) several links."""
    kind = item.type
    if kind == NavigationItemType.CATEGORY_LIST:
        return top_categories
    if kind == NavigationItemType.CATEGORY:
        if item.category is None or not item.category.is_active:
            return []
        url = category_url(category_path(item.category))
    elif kind == NavigationItemType.PAGE:
        # An unpublished page 404s, so a link to it would too.
        if item.page is None or not item.page.is_published:
            return []
        url = item.page.path
    elif kind in (NavigationItemType.LINK, NavigationItemType.PROMO) and item.url:
        url = item.url
    else:
        return []
    return [NavNode(id=str(item.pk), label=item.display_label, url=url, type=kind)]


def footer_columns(*, now=None) -> list[NavNode]:
    """The footer's link columns: live `GROUP` rows, each with its live links.

    Two queries however long the footer gets -- the rows, and the category
    list only when some column asks for it.  A column whose links all resolve
    to nothing is left out: a heading over an empty list is noise.
    """
    items = list(
        NavigationItem.objects.live(now=now)
        .filter(placement=Placement.FOOTER)
        .select_related("category__parent__parent", "page")
        .order_by("position", "label")
    )
    top_categories = (
        _top_categories()
        if any(item.type == NavigationItemType.CATEGORY_LIST for item in items)
        else []
    )

    children: dict[Any, list[NavigationItem]] = {}
    for item in items:
        if item.parent_id is not None:
            children.setdefault(item.parent_id, []).append(item)

    columns: list[NavNode] = []
    for item in items:
        if item.parent_id is not None or item.type != NavigationItemType.GROUP:
            continue
        links = [
            link
            for child in children.get(item.pk, [])
            for link in _footer_links(child, top_categories)
        ]
        if links:
            columns.append(
                NavNode(
                    id=str(item.pk),
                    label=item.label,
                    url="",
                    type=NavigationItemType.GROUP,
                    children=links,
                )
            )
    return columns


def live_social_links() -> list[SocialLink]:
    """Visible profiles with a URL, in the shop's chosen order."""
    return list(
        SocialLink.objects.filter(is_visible=True).exclude(url="").order_by("position", "platform")
    )


def published_page(slug: str) -> SitePage | None:
    return SitePage.objects.filter(slug=slug, is_published=True).first()


def published_pages() -> list[SitePage]:
    return list(SitePage.objects.filter(is_published=True).order_by("-is_system", "title"))
