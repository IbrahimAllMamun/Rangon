# Rangon Fashion — Dynamic Online Store Navbar Design Specification

## 1. Purpose

Design and implement the Rangon Fashion online-store navbar as a **dynamic, data-driven, responsive, accessible, fast, campaign-ready commerce component**.

The navbar must support:

- Clothing
- Shoes
- Bags / Backpacks
- Cosmetics
- Accessories
- New categories
- Collections
- Promotions
- Seasonal campaigns
- Search
- Wishlist
- Account
- Cart

**Core rule:** administrators must be able to change navigation structure, order, badges, links, categories, campaigns, and promotional content without a frontend code deployment.

---

## 2. Mandatory Claude Code Skills

Before designing or implementing the navbar, Claude Code **MUST use**:

```text
/ui-ux-pro-max
/frontend-animation
```

### `/ui-ux-pro-max`

Use it for:

- Information architecture
- E-commerce navigation UX
- Visual hierarchy
- Mega-menu structure
- Responsive/mobile navigation
- Typography
- Spacing
- Accessibility
- Search UX

### `/frontend-animation`

Use it for:

- Mega-menu transitions
- Mobile drawer transitions
- Submenu transitions
- Search expansion
- Hover/focus interactions
- Cart/wishlist micro-interactions
- Sticky navbar transitions

Animations must be purposeful, subtle, fast, and respect `prefers-reduced-motion`.

---

# 3. Rangon Design Direction

The navbar should feel:

```text
Premium + Modern + Fashion-forward + Clean + Energetic
```

It must NOT feel like:

- A generic Bootstrap navbar
- An admin dashboard
- A template marketplace
- An overly complicated mega menu
- A corporate enterprise portal

## Brand

Primary Rangon red:

```text
#FB3208
```

Recommended light storefront colors:

```text
Background:       #FFFFFF
Primary text:     #111111
Secondary text:   #5F5F5F
Border:           #EAEAEA
Brand:            #FB3208
Brand hover:      #D92705
Soft brand:       #FFF1ED
```

Typography:

```text
Display: Space Grotesk
UI/body: Inter
```

Recommended navbar typography:

```text
Main navigation: 14–15px / 500–600
Mega-menu heading: 13–14px / 700
Mega-menu links: 14px / 400–500
Announcement: 12–13px
```

Use the main Rangon design system as the source of truth if its values are later refined.

---

# 4. Recommended Desktop Structure

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ FREE DELIVERY ON ORDERS OVER ৳2,000                                     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│ [RANGON]  Women  Men  Kids  Shoes  Bags  Cosmetics  New Arrivals  Sale │
│                                                                          │
│                              Search   Wishlist   Account   Cart          │
└──────────────────────────────────────────────────────────────────────────┘
```

The exact menu items must come from backend configuration.

---

# 5. Navbar Layers

## Layer 1 — Announcement Bar

Dynamic fields:

```text
message
url
status
priority
start_at
end_at
dismissible
```

Examples:

```text
Free Delivery on Orders Over ৳2,000
New Summer Collection — Shop Now
10% OFF on Your First Order
Cash on Delivery Available Nationwide
```

## Layer 2 — Main Navbar

Contains:

- Logo
- Dynamic primary navigation
- Search
- Wishlist
- Account
- Cart

## Layer 3 — Mega Menu

Appears for navigation items configured as `MEGA_MENU`.

---

# 6. Dynamic Navigation Architecture

Do NOT make the permanent source of truth a hard-coded React array such as:

```tsx
const navItems = [...]
```

Use:

```text
Admin
  ↓
Navigation configuration
  ↓
Django API
  ↓
Next.js data layer
  ↓
Navbar
```

The frontend renders a generic navigation model.

---

# 7. Suggested Data Model

Use entities such as:

```text
NavigationMenu
NavigationItem
NavigationGroup
NavigationLink
Announcement
NavigationCampaign
```

A practical `NavigationItem`:

```text
id
parent_id
title
slug
type
url
icon
image
description
badge
sort_order
is_active
open_in_new_tab
visibility
start_at
end_at
created_at
updated_at
```

Possible types:

```text
LINK
CATEGORY
MEGA_MENU
COLLECTION
PROMOTION
EXTERNAL
```

The frontend must not contain category-specific business logic.

---

# 8. Dynamic Hierarchy

The database must support hierarchical navigation.

Example:

```text
Women
├── Clothing
│   ├── Dresses
│   ├── Tops
│   ├── Shirts
│   └── Jeans
├── Shoes
│   ├── Heels
│   ├── Sneakers
│   └── Flats
├── Bags
│   ├── Handbags
│   ├── Backpacks
│   └── Crossbody
└── Accessories
    ├── Watches
    ├── Belts
    └── Sunglasses
```

Do not create separate React components for every category.

---

# 9. Category Integration

Product categories and navigation must integrate.

Example:

```text
Category: Women
Subcategories:
Dresses
Tops
Bottoms
Shoes
Bags
Accessories
```

If an administrator creates:

```text
Linen Collection
```

the item can be added to navigation without changing frontend code.

---

# 10. Admin Navigation Builder

Create an admin UI where authorized users can:

- Create navigation items
- Edit items
- Activate/deactivate
- Delete/archive
- Reorder
- Nest items
- Assign categories
- Assign collections
- Assign URLs
- Add badges
- Add promotional images
- Schedule visibility
- Preview desktop/mobile
- Publish

Use drag-and-drop ordering where practical.

Persist order with:

```text
sort_order
```

Never rely on insertion order.

---

# 11. Draft / Published Workflow

For production:

```text
DRAFT
PUBLISHED
ARCHIVED
```

Workflow:

```text
Edit
 ↓
Validate
 ↓
Preview
 ↓
Publish
 ↓
Invalidate navigation cache
 ↓
Storefront updates
```

Partially edited navigation must never accidentally appear to customers.

---

# 12. Mega Menu

For major categories use a mega menu.

Example:

```text
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│ CLOTHING           SHOES              BAGS          FEATURED     │
│ Dresses            Heels              Handbags      New Arrivals │
│ Tops               Sneakers           Backpacks     Trending     │
│ Shirts             Flats              Crossbody     Summer Edit  │
│ Jeans              Boots              Wallets       Sale         │
│                                                                  │
│                         [PROMOTIONAL IMAGE]                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Mega menus should support:

- Multiple columns
- Groups
- Links
- Images
- Promotional cards
- Featured collections
- CTA buttons
- Badges

---

# 13. Mega Menu Data

Example:

```text
Women
 ├── Clothing
 │    ├── Dresses
 │    ├── Tops
 │    └── Jeans
 ├── Shoes
 │    ├── Sneakers
 │    └── Heels
 └── Featured
      ├── New Arrivals
      └── Sale
```

Render this from the navigation tree. Never hard-code a `WomenMegaMenu` with fixed products/categories.

---

# 14. Promotional Content

Mega-menu promotions may contain:

```text
title
description
image
url
CTA text
start_at
end_at
priority
```

Example:

```text
SUMMER EDIT
[IMAGE]
Shop Now →
```

The admin controls this content.

---

# 15. Dynamic Badges

Support:

```text
NEW
SALE
HOT
TRENDING
20% OFF
```

Store the badge in data:

```text
NavigationItem.badge
```

Never use logic such as:

```tsx
if (item.title === "Sale") ...
```

---

# 16. Campaign Navigation

Navigation can change during campaigns.

Example:

### Normal

```text
New Arrivals
Women
Men
Shoes
Bags
Cosmetics
Sale
```

### Ramadan campaign

```text
New Arrivals
Women
Men
Ramadan
Gifts
Sale
```

### Winter campaign

```text
New Arrivals
Men
Women
Winter Collection
Outerwear
Sale
```

Campaigns should be scheduled with:

```text
start_at
end_at
priority
```

The backend must enforce campaign visibility.

---

# 17. User-Aware Navbar

Guest:

```text
Search
Wishlist
Login
Cart
```

Authenticated customer:

```text
Search
Wishlist
Account
Cart
```

Account menu:

```text
My Account
Orders
Wishlist
Addresses
Profile
Logout
```

Customers must never receive admin navigation.

---

# 18. Search

Search must be a first-class navbar feature.

Desktop:

```text
┌─────────────────────────────────────────────┐
│ Search products, brands, categories...     │
└─────────────────────────────────────────────┘
```

Possible suggestions:

```text
PRODUCTS
Black Oversized T-Shirt
Black Sneakers
Black Backpack

CATEGORIES
Black Dresses
Black Shoes

POPULAR SEARCHES
Sneakers
Backpack
Dresses
```

On mobile, search should preferably become a dedicated full-width overlay.

---

# 19. Cart and Wishlist

Cart:

```text
🛒 3
```

Wishlist:

```text
♡
```

On add-to-cart:

```text
Add
 ↓
Cart count updates
 ↓
Subtle micro-animation
```

On wishlist toggle:

```text
♡ → ♥
```

Use `/frontend-animation` for these interactions.

Avoid excessive bouncing.

---

# 20. Desktop Interaction

Recommended behavior:

```text
Hover → preview mega menu
Click → category landing page
```

The system must not make important navigation accessible only through hover.

Explicit states:

```text
DEFAULT
HOVER
FOCUS
ACTIVE
OPEN
STICKY
SCROLLED
DISABLED
```

---

# 21. Mega Menu Animation

Use `/frontend-animation`.

Recommended:

```text
Closed:
opacity: 0
transform: translateY(-6px)

Open:
opacity: 1
transform: translateY(0)
```

Typical duration:

```text
150–250ms
```

Avoid:

- Long transitions
- Bounce
- Large movement
- Continuous animation

Respect:

```css
@media (prefers-reduced-motion: reduce)
```

---

# 22. Sticky Navbar

The navbar should be sticky.

Initial:

```text
Announcement
Main navbar
```

After scrolling:

```text
Compact sticky navbar
```

Possible behavior:

```text
Scroll down → compact
Scroll up   → visible
```

Do not hide navigation aggressively.

Avoid layout shift when the navbar becomes sticky.

---

# 23. Mobile Navbar

Do NOT simply shrink the desktop navbar.

Recommended:

```text
┌───────────────────────────────────┐
│ ☰       RANGON       ♡      🛒 2 │
├───────────────────────────────────┤
│ 🔍 Search products...             │
└───────────────────────────────────┘
```

Mobile should use a dedicated navigation drawer.

---

# 24. Mobile Drawer

```text
┌───────────────────────────────────┐
│ ← Menu                         ✕ │
├───────────────────────────────────┤
│ New Arrivals                   → │
│ Women                          → │
│ Men                            → │
│ Kids                           → │
│ Shoes                          → │
│ Bags                           → │
│ Cosmetics                      → │
│ Sale                           → │
├───────────────────────────────────┤
│ Account                          │
│ Wishlist                         │
│ Orders                           │
└───────────────────────────────────┘
```

Use progressive disclosure:

```text
Women
 ↓
Clothing
Shoes
Bags
Accessories
 ↓
Dresses
Tops
Jeans
```

Do not show the full desktop mega menu on mobile.

---

# 25. Mobile Animation

Use `/frontend-animation`.

Drawer:

```text
translateX(-100%) → translateX(0)
```

Submenu:

```text
Parent panel → child panel slides in
```

Include a clear back action.

Respect `prefers-reduced-motion`.

---

# 26. Responsive Breakpoints

Use the global project breakpoint system. At minimum test:

```text
320px
375px
390px
414px
768px
1024px
1280px
1440px
1920px
```

Baseline:

```text
<640px       Mobile
640–767px    Large mobile
768–1023px   Tablet
1024–1279px  Desktop
1280px+      Large desktop
```

---

# 27. Logo

Use the official Rangon Fashion logo.

Rules:

- Preserve aspect ratio
- Never stretch
- Keep adequate whitespace
- Link to homepage
- Accessible alt text
- Work on mobile and desktop

Approximate heights:

```text
Desktop: 32–40px
Mobile:  28–32px
```

---

# 28. Component Architecture

Recommended:

```text
Navbar
├── AnnouncementBar
├── DesktopNavbar
│   ├── Logo
│   ├── NavigationMenu
│   │   ├── NavigationItem
│   │   └── MegaMenu
│   └── NavbarActions
│       ├── SearchButton
│       ├── WishlistButton
│       ├── AccountMenu
│       └── CartButton
└── MobileNavbar
    ├── MenuButton
    ├── Logo
    ├── WishlistButton
    ├── CartButton
    ├── MobileSearch
    └── MobileMenuDrawer
        └── MobileNavigationTree
```

Interactive pieces should be client components only where needed.

Prefer Server Components for data rendering.

---

# 29. Data Fetching

Recommended:

```text
Django
 ↓
GET /api/v1/storefront/navigation
 ↓
Next.js server-side data layer
 ↓
Navbar
```

Fetch the navigation tree once where possible.

Do not make one API request per navigation item.

---

# 30. Example API Response

```json
{
  "announcement": {
    "message": "Free Delivery on Orders Over ৳2,000",
    "url": "/shipping",
    "dismissible": true
  },
  "items": [
    {
      "id": "women",
      "title": "Women",
      "type": "MEGA_MENU",
      "url": "/women",
      "badge": null,
      "groups": [
        {
          "title": "Clothing",
          "items": [
            {
              "title": "Dresses",
              "url": "/women/clothing/dresses"
            },
            {
              "title": "Tops",
              "url": "/women/clothing/tops"
            }
          ]
        }
      ]
    }
  ]
}
```

Frontend must render this generically.

---

# 31. Caching

Navigation changes relatively infrequently.

Use appropriate caching/revalidation:

```text
Admin update
 ↓
Publish
 ↓
Invalidate/revalidate navigation
 ↓
Storefront receives new navbar
```

Avoid making every storefront request depend on a slow uncached navigation API.

---

# 32. Performance

The navbar appears on almost every page.

Requirements:

- Minimal client-side JavaScript
- Server-render dynamic navigation where possible
- Hydrate only interactive pieces
- Lazy-load mega-menu images when appropriate
- Avoid loading all product data in the navbar
- Avoid huge navigation payloads
- Avoid layout shift
- Efficient scroll handling
- No expensive repeated API requests

---

# 33. Accessibility

Use semantic:

```html
<nav>
```

Requirements:

- Keyboard navigation
- Visible focus states
- Escape closes menus
- Tab/Shift+Tab works
- Appropriate ARIA where necessary
- Touch targets around 44×44px minimum
- Screen-reader labels for icon buttons
- No hover-only access to important navigation
- Reduced-motion support

Never remove focus outlines without providing an accessible replacement.

---

# 34. SEO

Important navigation links must be crawlable normal links:

```html
<a href="/women/dresses">
```

Do not make SEO-critical navigation dependent entirely on JavaScript.

Use meaningful URLs and stable category paths.

---

# 35. Analytics

Track useful interactions:

```text
navbar_item_clicked
mega_menu_opened
search_opened
search_submitted
wishlist_clicked
cart_clicked
account_clicked
campaign_clicked
```

Do not collect unnecessary personal data.

---

# 36. Navigation Validation

Backend validation must prevent:

- Circular navigation trees
- Invalid parent references
- Broken category references
- Invalid URLs
- Duplicate ordering conflicts
- Invalid campaign dates
- Missing titles
- Excessive navigation depth

Backend authorization is mandatory for navigation management.

---

# 37. Failure and Fallback

If dynamic navigation fails:

```text
Do not crash the storefront.
```

Use:

```text
Error boundary
+
Fallback navigation
+
Error logging
```

Fallback may be:

```text
Home
Shop
New Arrivals
Sale
```

The fallback must be intentionally designed.

---

# 38. Implementation Workflow for Claude

Claude Code MUST follow this sequence:

### Step 1
Read:

```text
CLAUDE.md
```

### Step 2
Use:

```text
/ui-ux-pro-max
```

to design information architecture, hierarchy, responsive behavior, and e-commerce UX.

### Step 3
Use:

```text
/frontend-animation
```

to design interaction/motion behavior.

### Step 4
Review the Rangon design system:

```text
colors
typography
spacing
radius
shadows
icons
```

### Step 5
Create the visual/static prototype.

### Step 6
Create reusable components.

### Step 7
Create backend navigation models/API.

### Step 8
Connect dynamic navigation to Next.js.

### Step 9
Implement desktop interactions.

### Step 10
Implement mobile drawer and nested navigation.

### Step 11
Implement animations.

### Step 12
Implement accessibility.

### Step 13
Implement loading/error/fallback states.

### Step 14
Test all responsive breakpoints.

### Step 15
Run Playwright tests.

### Step 16
Perform visual QA.

---

# 39. Required E2E Tests

At minimum:

```text
1. Storefront loads navigation
2. User opens Women mega menu
3. User clicks Dresses
4. User opens navbar search
5. User searches for a product
6. User opens account menu
7. User opens cart
8. Mobile user opens drawer
9. Mobile user opens Women
10. Mobile user navigates to Dresses
11. Admin creates navigation item
12. Admin reorders navigation
13. Admin publishes navigation
14. Storefront displays updated navigation
15. Expired campaign disappears
16. Unauthorized user cannot modify navigation
```

---

# 40. Visual QA Checklist

Before completion:

- [ ] Logo is correctly proportioned
- [ ] Rangon red is used consistently
- [ ] Typography matches design system
- [ ] Desktop spacing is balanced
- [ ] Mobile is intentionally designed
- [ ] Mega menu is clear
- [ ] Search is discoverable
- [ ] Wishlist is discoverable
- [ ] Account is discoverable
- [ ] Cart is discoverable
- [ ] Sale is prominent without overwhelming the design
- [ ] Hover/focus/active states work
- [ ] Animations are subtle
- [ ] Reduced-motion works
- [ ] No layout shift
- [ ] No horizontal overflow
- [ ] Keyboard navigation works
- [ ] Touch targets are sufficient
- [ ] Dynamic content renders correctly
- [ ] Fallback navigation works

---

# 41. Final UX Target

Conceptually, the desktop experience should be:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│              FREE DELIVERY ON ORDERS OVER ৳2,000                         │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│ [RANGON]   Women   Men   Kids   Shoes   Bags   Cosmetics   Sale         │
│                                                                          │
│                                   🔍   ♡   Account   🛒                  │
└──────────────────────────────────────────────────────────────────────────┘
```

Hovering a major category reveals a polished mega menu.

Mobile:

```text
┌───────────────────────────────────┐
│ ☰       RANGON       ♡      🛒 2 │
├───────────────────────────────────┤
│ 🔍 Search products...             │
└───────────────────────────────────┘
```

The experience should be visually premium but operationally simple.

---

# 42. Final Architecture Rule

The navbar is a **product feature**, not merely a header component.

It must be:

```text
DATA-DRIVEN
+
DYNAMIC
+
RESPONSIVE
+
ACCESSIBLE
+
SEO-FRIENDLY
+
FAST
+
ANIMATED
+
ADMIN-CONTROLLED
+
CAMPAIGN-READY
```

The administrator should be able to change navigation without frontend deployment.

The frontend must render a generic navigation model rather than contain business-specific category logic.

Before any frontend navbar implementation or redesign, Claude Code **MUST use `/ui-ux-pro-max` and `/frontend-animation`** and validate the result against this document and the main Rangon Fashion design system.
