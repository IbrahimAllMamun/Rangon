"""Writes to the storefront's footer, social links and site pages.

Every change here is a plain-argument function that owns its transaction and
its audit entry (CLAUDE.md §4).  Views validate the *shape* of a request; the
rules -- what a link may point at, what HTML a page may hold, which pages may
be deleted -- live here, so the Django admin, a management command and the API
all get the same answer.

Storefront caches are dropped by `content.signals` on commit, not from here,
so a Django-admin edit refreshes the storefront too.
"""

from __future__ import annotations

from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import QuerySet
from django.utils.text import slugify

from content import rich_text
from content.models import SYSTEM_PAGE_PATHS, SitePage, SiteSettings, SocialLink
from content.validators import (
    normalize_map_embed,
    normalize_map_link,
    normalize_social_url,
)
from core import audit
from core.exceptions import Conflict, NotFound, ValidationError

#: What `update_site_settings` accepts.  Anything else is ignored by the API
#: serializer before it gets here, and refused here if it does.
SITE_SETTINGS_FIELDS = (
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
)

MAX_OPENING_HOURS_ROWS = 7


def _fail(field: str, message: str) -> ValidationError:
    return ValidationError(message, details={field: [message]})


def _clean_hours(rows: Any) -> list[dict[str, str]]:
    """Rows of `{"days", "hours"}`, blank rows dropped, at most one per weekday."""
    if not isinstance(rows, list):
        raise _fail("opening_hours", "Opening hours must be a list of rows.")
    cleaned = []
    for row in rows:
        if not isinstance(row, dict):
            raise _fail("opening_hours", "Each opening-hours row needs days and hours.")
        days = " ".join(str(row.get("days", "")).split())[:60]
        hours = " ".join(str(row.get("hours", "")).split())[:60]
        if days or hours:
            cleaned.append({"days": days, "hours": hours})
    if len(cleaned) > MAX_OPENING_HOURS_ROWS:
        raise _fail("opening_hours", f"Use at most {MAX_OPENING_HOURS_ROWS} rows of opening hours.")
    return cleaned


def update_site_settings(*, actor: Any, changes: dict[str, Any]) -> SiteSettings:
    unknown = set(changes) - set(SITE_SETTINGS_FIELDS)
    if unknown:
        raise ValidationError(f"Unknown setting: {', '.join(sorted(unknown))}.")

    normalised: dict[str, Any] = {}
    for field, value in changes.items():
        if field == "map_embed_url":
            value = normalize_map_embed(value)
        elif field == "map_link_url":
            value = normalize_map_link(value)
        elif field == "opening_hours":
            value = _clean_hours(value)
        elif isinstance(value, str):
            value = value.strip()
        normalised[field] = value

    with transaction.atomic():
        settings, _ = SiteSettings.objects.select_for_update().get_or_create(key="default")
        before = audit.snapshot(settings, list(normalised))
        for field, value in normalised.items():
            setattr(settings, field, value)
        old, new = audit.diff(before, normalised)
        if not new:
            return settings
        settings.updated_by = actor
        settings.save()
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=settings,
            actor=actor,
            old_values=old,
            new_values=new,
        )
    return settings


# --- ordering ----------------------------------------------------------------


def move(rows: QuerySet, *, pk: Any, direction: str) -> bool:
    """Move one row of an ordered run up or down by one place.

    The whole run is renumbered 0..n rather than two positions swapped: rows
    that share a position fall back to a secondary ordering, which would make a
    swap of equal numbers invisible.  Up/down rather than drag-and-drop so the
    control works from a keyboard and a screen reader (ADR-0009).

    Returns whether anything moved.  The caller passes the run already
    filtered and ordered; the rows are locked for the renumbering.
    """
    if direction not in {"up", "down"}:
        raise ValidationError("Direction must be 'up' or 'down'.")
    with transaction.atomic():
        ordered = list(rows.select_for_update())
        index = next((i for i, row in enumerate(ordered) if row.pk == pk), None)
        if index is None:
            raise NotFound()
        target = index - 1 if direction == "up" else index + 1
        if not 0 <= target < len(ordered):
            return False
        ordered[index], ordered[target] = ordered[target], ordered[index]
        for offset, row in enumerate(ordered):
            row.position = offset
        rows.model._default_manager.bulk_update(ordered, ["position"])
    return True


# --- social links --------------------------------------------------------------


def update_social_link(
    *,
    link_id: Any,
    actor: Any,
    url: str | None = None,
    is_visible: bool | None = None,
) -> SocialLink:
    with transaction.atomic():
        link = SocialLink.objects.select_for_update().filter(pk=link_id).first()
        if link is None:
            raise NotFound()
        before = audit.snapshot(link, ["url", "is_visible"])
        if url is not None:
            link.url = normalize_social_url(link.platform, url)
        if is_visible is not None:
            link.is_visible = is_visible
        if link.is_visible and not link.url:
            raise _fail(
                "is_visible", f"Add the {link.get_platform_display()} address before showing it."
            )
        old, new = audit.diff(before, audit.snapshot(link, ["url", "is_visible"]))
        if new:
            link.save(update_fields=["url", "is_visible", "updated_at"])
            audit.record(
                action=audit.AuditAction.SETTINGS_CHANGED,
                entity=link,
                actor=actor,
                old_values=old,
                new_values=new,
            )
    return link


def move_social_link(*, link_id: Any, direction: str, actor: Any) -> SocialLink:
    run = SocialLink.objects.order_by("position", "platform")
    moved = move(run, pk=link_id, direction=direction)
    link = SocialLink.objects.get(pk=link_id)
    if moved:
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=link,
            actor=actor,
            new_values={"moved": direction, "position": link.position},
        )
    return link


# --- pages ---------------------------------------------------------------------

PAGE_FIELDS = ("title", "meta_description", "body", "is_published")


def _clean_body(body: str) -> str:
    cleaned = rich_text.sanitize(body)
    if len(cleaned) > rich_text.MAX_BODY_CHARS:
        raise _fail("body", "This page is too long. Split it into two pages.")
    return cleaned


def _clean_page_fields(changes: dict[str, Any]) -> dict[str, Any]:
    unknown = set(changes) - set(PAGE_FIELDS)
    if unknown:
        raise ValidationError(f"Unknown page field: {', '.join(sorted(unknown))}.")
    cleaned: dict[str, Any] = {}
    for field, value in changes.items():
        if field == "body":
            value = _clean_body(value)
        elif field in ("title", "meta_description"):
            value = " ".join(str(value).split())
        cleaned[field] = value
    if "title" in cleaned and not cleaned["title"]:
        raise _fail("title", "A page needs a title.")
    return cleaned


def _page_values(page: SitePage) -> dict[str, Any]:
    return audit.snapshot(page, list(PAGE_FIELDS))


def create_page(
    *,
    actor: Any,
    title: str,
    slug: str = "",
    meta_description: str = "",
    body: str = "",
    is_published: bool = True,
) -> SitePage:
    """A page of the shop's own -- a size guide, an FAQ -- served at `/pages/<slug>`."""
    slug = slugify(slug or title)[:64]
    if not slug:
        raise _fail("slug", "Give the page an address, for example size-guide.")
    if slug in SYSTEM_PAGE_PATHS:
        raise _fail("slug", f"“{slug}” is already one of the shop's standard pages.")
    fields = _clean_page_fields(
        {
            "title": title,
            "meta_description": meta_description,
            "body": body,
            "is_published": is_published,
        }
    )
    try:
        with transaction.atomic():
            page = SitePage.objects.create(slug=slug, updated_by=actor, **fields)
    except IntegrityError as error:
        raise Conflict(
            f"A page at /pages/{slug} already exists.", details={"slug": ["Already in use."]}
        ) from error
    audit.record(
        action=audit.AuditAction.SETTINGS_CHANGED,
        entity=page,
        actor=actor,
        new_values={"slug": slug, **_page_values(page)},
        reason="Site page created.",
    )
    return page


def update_page(*, slug: str, actor: Any, changes: dict[str, Any]) -> SitePage:
    cleaned = _clean_page_fields(changes)
    with transaction.atomic():
        page = SitePage.objects.select_for_update().filter(slug=slug).first()
        if page is None:
            raise NotFound()
        before = _page_values(page)
        for field, value in cleaned.items():
            setattr(page, field, value)
        old, new = audit.diff(before, _page_values(page))
        if not new:
            return page
        page.updated_by = actor
        page.save()
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=page,
            actor=actor,
            old_values=old,
            new_values=new,
        )
    return page


def delete_page(*, slug: str, actor: Any) -> None:
    """A page the shop added may go; the standard ones can only be unpublished."""
    with transaction.atomic():
        page = SitePage.objects.select_for_update().filter(slug=slug).first()
        if page is None:
            raise NotFound()
        if page.is_system:
            raise ValidationError(
                "The shop's standard pages cannot be deleted. Unpublish it instead."
            )
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=page,
            actor=actor,
            old_values={"slug": page.slug, **_page_values(page)},
            reason="Site page deleted.",
        )
        page.delete()
