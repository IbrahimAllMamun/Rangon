# Navigation

How the storefront navbar, its data model and its URLs work.

Source spec: [planning/navbar-design-spec.md](../planning/navbar-design-spec.md).
Where this document differs from that spec, this document wins and the reason is recorded in
[ADR-0009](decisions/0009-category-driven-navigation.md) and
[ADR-0010](decisions/0010-radix-navigation-menu.md).

## 1. Principle

The category tree is the navigation. `NavigationItem` is an override list for the things a category
cannot express — a filter ("Sale"), a sort ("New Arrivals"), a scheduled campaign, a badge, a promo
card, an external link.

```text
NavigationItem rows (active, inside date window)
        |  empty?
        v
Category.objects.filter(parent__isnull=True, is_active=True, show_in_navigation=True)
        |  API unreachable?
        v
static fallback: Home - Shop - New Arrivals - Sale
```

An unconfigured install renders a correct navbar. Nothing has to be set up for the feature to work.

## 2. Data model

```text
NavigationItem
  type        CATEGORY | LINK | PROMO
  category    FK -> catalog.Category   CATEGORY only; supplies name, slug, children
  label       override; blank = the category's own name
  url         LINK only
  badge       "NEW" | "SALE" | "20% OFF" - free text, rendered as data
  image       PROMO only
  layout      AUTO | DROPDOWN | MEGA
  position    int
  is_active   bool
  starts_at / ends_at   nullable; the publish window
  parent      FK -> self   grouped links and promo cards inside one menu
  placement   HEADER | FOOTER

StorefrontBanner
  placement   ANNOUNCEMENT | HOME_HERO
  message / title, url, image
  dismissible bool
  priority    int
  is_active   bool
  starts_at / ends_at
```

`StorefrontBanner` serves both the announcement bar (spec §5 layer 1) and the homepage hero. Rangon
had no content model of any kind before this; the storefront hero was hardcoded to the first
new-arrival image in `app/(storefront)/page.tsx`.

### Rules

1. **Visibility is enforced server-side.** An item outside its `starts_at`/`ends_at` window is never
   serialised. A stale frontend cache must not be able to show an expired campaign.
2. **Badges are data.** Never branch on a title (`if (item.title === "Sale")`). Spec §15.
3. **No `DRAFT`/`PUBLISHED`/`ARCHIVED`.** `is_active` plus the date window covers both drafting and
   scheduling. See ADR-0009.
4. **Header depth is capped at two** for `CATEGORY` items, matching the catalogue. The renderer does
   not assume it — see §4.
5. **Reordering swaps `position` between siblings.** No drag-and-drop; the controls must be operable
   by keyboard (CLAUDE.md §11).
6. Writing navigation requires a permission code; anonymous and customer tokens are refused.

## 3. API

```text
GET /api/v1/shop/navigation/
```

```json
{
  "announcement": {
    "id": "...",
    "message": "Free delivery on orders over 2,000 BDT",
    "url": "/policies/shipping",
    "dismissible": true
  },
  "items": [
    {
      "id": "...",
      "label": "Women",
      "url": "/category/women",
      "badge": null,
      "layout": "AUTO",
      "image": null,
      "children": [
        { "label": "Kurti", "url": "/category/women/kurti", "children": [] }
      ]
    }
  ]
}
```

One request for the whole tree; never one request per item (spec §29). Fetched in
`app/(storefront)/layout.tsx` with `revalidate` and the `navigation` cache tag. Saving a
`NavigationItem`, a `StorefrontBanner` or a `Category` revalidates that tag.

Announcement dismissal is client-side in `localStorage`, keyed by the announcement id — storefront
customers may be anonymous, so it cannot be stored per user.

## 4. Rendering

The layout of a menu is **derived from its data**, not configured per item. `layout: AUTO` means:

| Item has | Renders as |
|---|---|
| no children | plain link |
| children only | dropdown panel |
| grandchildren | mega menu, one column per child |

The catalogue is two levels today (`Men -> Shirts`, `Women -> Kurti`), so `AUTO` produces dropdowns.
If a third level is ever added, the mega menu appears with no frontend change. `DROPDOWN` and `MEGA`
force a layout when a merchandiser wants one.

This keeps category-specific logic out of the frontend (spec §7): there is no `WomenMegaMenu`.

### Component tree

```text
StorefrontLayout                 server - one fetch of /shop/navigation/
├── AnnouncementBar              client - dismiss to localStorage
└── Header                       server shell
    ├── LogoLink                 existing
    ├── PrimaryNav               client - Radix NavigationMenu (ADR-0010)
    │   └── NavItem -> Link | Dropdown | MegaMenu
    ├── NavActions
    │   ├── SearchTrigger        client - desktop popover, mobile overlay
    │   ├── WishlistButton       client - count badge
    │   ├── AccountMenu          client - Radix DropdownMenu
    │   └── CartButton           existing
    └── MobileNav                client - Radix Dialog, single-open accordion
```

### Sticky behaviour

The header shrinks; it never hides. Spec §22 suggests hide-on-scroll-down; that conflicts with the
same spec's "do not hide navigation aggressively" and with §40's "no layout shift".

- The header stays a fixed height. Only the logo scale and internal padding compress, driven by a
  `data-scrolled` attribute. Animating the header's own height would reflow the page beneath it.
- Scroll state comes from a single `IntersectionObserver` sentinel, not a scroll listener (spec §32).
- The announcement bar sits above the sticky element and scrolls away naturally.

### Motion

Existing tokens only: `--duration-fast: 140ms`, `--duration-normal: 200ms` — already inside the
spec's 150–250 ms guidance. `prefers-reduced-motion` is handled globally in `styles/globals.css`.
Transform and opacity only; never `transition-all`.

### Accessibility

Radix supplies `aria-expanded`, `aria-controls`, roving `tabindex`, `Escape` and focus return. On top
of that:

- every icon-only control has an accessible name;
- touch targets are at least 44x44;
- no navigation is reachable by hover alone — every menu parent is itself a link to its landing page;
- focus rings are visible and never removed without a replacement.

## 5. URLs

Category listings live at a path, not a query parameter:

```text
/category/women            top level
/category/women/kurti      child
/shop                      browse everything
/shop?q=saree              search results
```

- The **last** segment resolves the category; `Category.slug` is globally unique.
- The path is validated against `category.ancestors()`. A mismatch returns **308** to the canonical
  full path, so `/category/kurti` and `/category/women/kurti` both work but only one is indexed.
- `/shop?category=<slug>` returns **301** to `/category/<path>` so existing links and anything
  already indexed survive.
- Facets stay query parameters: `/category/women/kurti?attr_color=black&page=2`.

`FilterPanel` already builds URLs from `usePathname()` and only mutates the query string, so it works
unchanged once the category moves into the path — and its "clear filters" handler gets shorter,
because it no longer has to carry `category` across by hand.

Canonicals, the sitemap and the product-page JSON-LD `BreadcrumbList` all emit the path form.
Filtered permutations stay `noindex, follow`, as they are today.

## 6. Failure

Navigation must never take the storefront down (spec §37).

1. `NavigationItem` empty -> categories.
2. `/shop/navigation/` errors or times out -> static fallback, logged.
3. The navbar is wrapped in an error boundary; a render failure degrades to the static fallback
   rather than blanking the page.

## 7. Phases

| # | Scope | State |
|---|---|---|
| N0 | Category URLs -> `/category/[...slug]`, redirects, sitemap, canonical, breadcrumbs | not started |
| N1 | `NavigationItem` + `StorefrontBanner`, `/shop/navigation/`, fallback, pytest | not started |
| N2 | Desktop navbar — Radix, adaptive layout, badges, announcement, compact-on-scroll | not started |
| N3 | Mobile drawer — single-open accordion, search overlay, account block | not started |
| N4 | Search suggest (products / categories / popular searches), wishlist count | not started |
| N5 | Admin — category reorder + icon, navigation override editor, announcement editor | not started |
| N6 | Verification — pytest, browser walk at 375/768/1280, axe pass | not started |

N0 is self-contained and reviewable alone. Doing it first means every navigation link in N2 and N3 is
written once.

### N0 surface

Twelve call sites across seven files, all currently emitting `/shop?category=`:

| File | Sites |
|---|---|
| `app/(storefront)/layout.tsx` | 3 — nav, submenu, footer |
| `components/commerce/mobile-nav.tsx` | 2 |
| `app/(storefront)/page.tsx` | 1 — featured category tiles |
| `app/(storefront)/product/[slug]/page.tsx` | 2 — JSON-LD and visible breadcrumb |
| `app/(storefront)/shop/page.tsx` | 1 — canonical |
| `app/sitemap.ts` | 2 |
| `components/commerce/filter-panel.tsx` | 1 — deleted, not rewritten |

No backend change: `ShopCategoryView` already resolves a category by slug and returns its ancestors.

## 8. Testing

pytest covers the logic that matters, because Playwright cannot currently execute in the dev
container ([roadmap D7](../roadmap.md#known-defects)):

- an empty override table falls back to categories;
- an item outside its date window is not serialised;
- an inactive item is not serialised;
- a category with `show_in_navigation=False` does not appear;
- an anonymous or customer token cannot write navigation;
- the navigation payload stays within its query budget
  ([indexing.md](../database/indexing.md)).

Browser verification at 375 / 768 / 1280: the menu opens by keyboard, `Escape` closes it, the drawer
traps focus, there is no horizontal overflow, and no layout shift on scroll.
