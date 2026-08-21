# ADR-0009 — Category-driven navigation with a one-table override

**Status:** Accepted · 2026-08-21

## Context

`rangon_fashion_dynamic_navbar_design.md` specifies a navigation CMS built from six entities —
`NavigationMenu`, `NavigationItem`, `NavigationGroup`, `NavigationLink`, `Announcement`,
`NavigationCampaign` — with a `DRAFT → PUBLISHED → ARCHIVED` workflow and a drag-and-drop builder.

Three facts argue against that shape here:

1. **`Category` already models most of it.** It carries `parent` (unlimited depth), `position`,
   `is_active`, `show_in_navigation`, `image`, `description` and SEO fields
   (`catalog/models.py`). A parallel navigation tree would duplicate it, and every new category
   would then have to be created twice. That divergence is the standard failure mode of these
   systems: the navigation and the catalogue drift, and the operator stops trusting both.
2. **Draft/publish exists to stop a team stepping on each other.** Rangon is a single shop with one
   owner and a handful of staff. There is no concurrent-editing problem to solve.
3. **Some navbar entries genuinely are not categories.** "Sale" is a filter, "New Arrivals" is a
   sort, a Ramadan campaign is a scheduled entry, and badges and promo cards are presentation.
   None can be expressed as a `Category` row without abusing the model.

## Decision

The category tree is the **default** source of navigation. A single `NavigationItem` table is an
**override list** consulted first.

```text
NavigationItem
  type          CATEGORY | LINK | PROMO
  category      FK -> catalog.Category   (CATEGORY only; inherits name, slug, children)
  label         override; blank = use the category's own name
  url           LINK only
  badge         free text ("NEW", "SALE", "20% OFF") — data, never branched on
  image         PROMO only
  layout        AUTO | DROPDOWN | MEGA
  position      int
  is_active     bool
  starts_at     nullable datetime
  ends_at       nullable datetime
  parent        FK -> self   (grouped links and promo cards inside one menu)
  placement     HEADER | FOOTER
```

Resolution order in `GET /api/v1/shop/navigation/`:

1. Active `NavigationItem` rows inside their date window, ordered by `position`.
2. If that set is **empty**, fall back to
   `Category.objects.filter(parent__isnull=True, is_active=True, show_in_navigation=True)` —
   byte-for-byte the behaviour shipped today.
3. If the API itself fails, the frontend renders a static fallback (spec §37).

`DRAFT/PUBLISHED/ARCHIVED` is replaced by `is_active` plus the `starts_at`/`ends_at` window. An item
with a future `starts_at` is simultaneously a draft and a scheduled publish, which also satisfies the
campaign scheduling of spec §16 with no extra state machine.

Reordering swaps `position` between siblings via up/down controls rather than drag-and-drop.
Drag-and-drop is difficult to operate by keyboard and screen reader, which CLAUDE.md §11 requires;
it can be layered on later over the same field with no migration.

## Consequences

- The navbar works before any navigation row exists, so the feature ships without a configuration
  step and cannot regress an unconfigured install.
- Ordinary categories can never drift out of the navigation — they flow through automatically. Only
  deliberate exceptions live in the override table.
- One migration, one serializer, one admin screen instead of six tables and a publish pipeline.
- The fallback in §37 is structural rather than a hardcoded array: navigation degrades to the real
  catalogue first, and only to a static list if the whole API is unreachable.
- Campaign visibility is enforced server-side, so an expired campaign cannot leak through a stale
  frontend cache.
- Cost: a "menu" as a first-class concept (header vs footer vs mobile) is reduced to a `placement`
  field. If Rangon ever needs genuinely independent menus with different trees, that is the seam
  where this decision would be revisited.
