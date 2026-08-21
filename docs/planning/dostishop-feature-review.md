# Dostishop feature review

A read of the Dosti Shop codebase (`~/Desktop/dostishop`) against Rangon, to decide what is worth
borrowing. Reviewed 2026-08-21.

Dosti Shop is an Express + Prisma + Next.js multi-vendor marketplace for Bangladesh. The multi-vendor
parts (shops, commission, payouts, sub-orders) are out of scope — Rangon is one shop.

## Verdict

The two projects are strong in opposite places.

- **Rangon's backend is architecturally ahead**: ledger-driven inventory, immutable financial rows,
  multi-branch, POS, a real service layer, 172 passing tests. Dostishop keeps `stockQty` as an
  integer column on the variant and decrements it with `updateMany`.
- **Dostishop is well ahead on merchandising and admin UX** — which is exactly where Rangon's
  roadmap is a wall of partials. Rangon's admin product list is read-only; a product cannot be
  created from the UI at all.

So: borrow the **features and interaction patterns**, re-implement them on Rangon's services. Borrow
none of the data architecture.

## Tier 1 — things Rangon cannot do today

### 1. Product form with a variant matrix generator

`dashboard/src/components/ProductFormFields.tsx`. The flow:

1. Pick which attributes this product uses. Everything below scopes to that choice, so a handbag
   never sees a Size dropdown.
2. Attributes split into **variant axes** (create stock rows) and **specs** (stated once, rendered as
   a detail list).
3. Tick the values the product comes in; the rows below regenerate as the cartesian product.
4. One row per combination, with column headers rendered once rather than a label per row.

The detail that makes it safe is `reconcile()`: unticking a value never destroys a row the user
invested in. Rows with a saved id, stock, or a price override survive and are flagged "not selected"
in amber; only genuinely empty rows are dropped.

**Rangon adaptation, non-negotiable:** the stock column must not write stock. On create, post an
`OPENING_STOCK` transaction through `inventory.services`. On edit, render stock read-only with an
"Adjust" action opening the count/adjustment flow. Copying this literally would violate CLAUDE.md §3.2.

### 2. CSV product import/export

`api/src/controllers/product-csv.controller.ts`. Shopify-style: one row per variant, consecutive rows
sharing a `name` are one product, images pipe-separated on the first row. Includes a hand-rolled
RFC-4180 parser. Rangon has CSV only in reports. For onboarding an existing catalogue this is the
difference between launching and not.

### 3. Media library

`MediaFolder` + `MediaAsset` + a `MediaPicker` dialog. Upload once, reuse across products. Folders
are deliberately flat. The valuable part is **usage counting**: it groups `ProductImage.url` to show
"used by 3 products" and offers a used/unused filter, so deleting is safe. Deleting a folder unfiles
its assets rather than cascading. Rangon re-uploads per product with no reuse.

### 4. Notification bell and feed

Rangon has the model, the API and the Celery tasks, and **no UI at all** (roadmap phase 25). Before
building it, borrow one schema idea: `Notification.key`. A repeating condition — low stock on variant
X — raises one row that stands until it is read, instead of one per checkout. Rangon's
`Notification` has no dedupe key, so `LOW_STOCK` will spam the bell the moment it is wired up.

### 5. Banner / homepage CMS

Rangon has no content model; the storefront hero is hardcoded to the first new-arrival image.
Dostishop's `Banner` is six fields, plus a `Setting` singleton for store name, shipping rates and
support contact. Now folded into `StorefrontBanner` — see
[navigation.md](../architecture/navigation.md#2-data-model).

### 6. A real admin DataTable

Rangon's `resource-table.tsx` is presentational. Dostishop's `DataTable` adds search, sortable
columns, page size, pagination, row selection with a bulk-action bar, skeleton loading and an empty
state — one component behind every admin list. This is what makes the eight missing admin write
screens cheap. Pair it with their `useDialogs()` provider instead of `window.confirm`.

## Tier 2 — revenue

### 7. Four-state variant availability

`store-frontend/src/components/VariantPicker.tsx`. Rangon's buy panel has two states. Dostishop has
four, because "out of stock" and "does not come in that combination" are different facts:

| State | Meaning | Behaviour |
|---|---|---|
| fits | in stock with the current picks | normal |
| soldOut | that exact combination exists, no stock | clickable — the shopper may land on it and read why |
| stale | no such combination, but in stock elsewhere | clickable, repairs the other axes |
| dead | nothing carries it in stock anywhere | disabled |

Axes are independent — picking a colour holds the size, with a scored fallback only for sparse
catalogues. Struck through only when unbuyable. The reason goes in `aria-label`. `swatchRing()`
derives border strength from WCAG relative luminance so a cream swatch on a cream page stays visible,
and the chosen value is printed next to the label so colour is never the only carrier — which is what
CLAUDE.md §11 requires.

Pairs with [product-media.md](../architecture/product-media.md); both rewrite `ProductBuyPanel`.

### 8. Quick View and card actions

A card with more than one variant says "Choose options" and opens a modal picker instead of guessing.
Wishlist heart top-right of the image; add/choose pill along the bottom, revealed on hover but always
visible on mobile. The modal portals to `document.body` and plays its exit animation before
unmounting.

### 9. Meta product feed

`feed.controller.ts` — 49 lines emitting a CSV that Commerce Manager can poll on a schedule. For a
retailer running Facebook and Instagram ads this is a direct revenue line for almost no work. Highest
value per line in the repository.

### 10. Merchandising endpoints

- **Price drops**, biggest percentage discount first. Rangon lacks it.
- **"Customers also bought"** from real basket co-occurrence, degrading through same category, then
  same shop, then top-rated, so the row is never empty. Rangon has a `related` field but not
  co-occurrence.
- **Brand index** with product counts. Rangon has the `Brand` model and no brand landing page.

### 11. Search

- **`word_similarity` rather than `similarity`** — matches against the best-matching part of the
  name, so "bakpack" still finds "Urban Travel Backpack". Rangon uses `trigram_similar`, which
  compares whole strings and misses this.
- **Suggest endpoint** returning thumbnail and price. Rangon has none.
- **`SearchQuery` log** — every term with its result count, fire-and-forget. Answers "47 people
  searched *saree* and got nothing". Two columns, large merchandising value, and it supplies the
  "popular searches" group in the navbar search
  ([navigation.md §7 N4](../architecture/navigation.md#7-phases)).

### 12. Abandoned checkout capture

Fires when a phone number is typed at checkout, holding an `OPEN` row; an order with that phone flips
it to `RECOVERED`; the admin gets a call-back list. Suits cash-on-delivery retail, where the recovery
action is a phone call. Rangon's `expire_abandoned_carts` only deactivates stale carts after 30 days —
no lead capture, no screen.

## Tier 3 — polish

### 13. Reviews

Rangon's reviews are a dead end in the UI (roadmap D2). Dostishop's model ports directly onto
Rangon's existing `Review`/`ReviewStatus`: one review per phone per product; verified-purchase check
by order number plus phone; review photos; a moderation queue; a rating distribution histogram; and
`ratingAvg` recomputed from approved reviews only, inside a transaction, on every moderation action.

### 14. Colour registry

Dostishop keeps `Color` as its own table rather than a hex column on the value, so two products
naming the same maroon get the same swatch and correcting a hex fixes every product. Rangon stores
`swatch` as a `CharField` on `AttributeValue`, so duplicates can drift.

### 15. Product spec attributes

`ProductAttributeValue` lets one attribute hold several values — "Features: Waterproof, Lightweight" —
rendered as a spec list. Rangon has only free-text `material` and `care_instructions`. A general
retailer needs this: cosmetics need Volume and Skin Type, bags need Dimensions, shoes need Sole.

Rangon's `CategoryAttribute` (category to attribute) is better than dostishop's flat registry. The
ideal combines them: the category suggests the attributes, the product confirms which it uses.

### 16. Category icon

An icon name stored as a string and resolved against a **closed** Lucide map, because an open list
lets a typo render nothing. Fits CLAUDE.md §10 ("Lucide only, never emoji"). Belongs on `Category`.

### 17. Bengali/English toggle

Hand-rolled, cookie-based, `getT()` on the server and `useT()` on the client. Rangon formats Bengali
currency correctly but every UI string is English. The trap they document: every new string must be
added to both dictionaries.

### 18. WhatsApp float button

Environment-gated, disappears when unconfigured. Close to mandatory for retail in Bangladesh.

## Do not copy

| Thing | Why |
|---|---|
| `stockQty` on the variant row | Rangon's ledger is the source of truth. Never. |
| Denormalised `size`/`color` columns | Dostishop admits these are a "kept in sync on write" compromise. Rangon's `VariantAttributeValue` is normalised; facets should query that. |
| Guest-only customers, no auth | Rangon has accounts, addresses, notes and history. |
| `salePrice` on the product | Rangon's per-variant `compare_at_price` is better. |
| Shop / commission / payout / SubOrder | Multi-vendor. `Branch` covers the real need. |
| Client-side pagination in DataTable | Fine for a few hundred rows; Rangon's product list is server-paginated and should stay so. Take the props, keep the fetching. |

## Suggested order

1. **Operable**: product form and variant matrix, media library, CSV import, DataTable upgrade.
2. **Selling**: four-state variant picker, Quick View, Meta feed, price drops, co-occurrence, brand
   index.
3. **Sticky**: notification bell with `key` dedupe, review write path and moderation, abandoned
   checkout leads, banners and settings, Bengali toggle.

Navigation and product media were split into their own documents:
[navigation.md](../architecture/navigation.md) and
[product-media.md](../architecture/product-media.md).
