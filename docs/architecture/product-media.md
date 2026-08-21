# Product media

How product images are stored, bound to colours, and rendered on the storefront.

## 1. Principle

**An image belongs to a colour, not to a variant.**

A shirt in 3 colours and 4 sizes has 12 variants but only 3 sets of photographs. Binding an image to
a `ProductVariant` would mean uploading the same black photo four times, and adding size XXL later
would silently ship a variant with no images.

Binding to the `AttributeValue` — "Colour: Black" — means the photo is uploaded once and applies to
every size in that colour, and new sizes inherit it automatically.

This is the same reasoning behind a shared colour registry: define the thing once, reference it many
times.

## 2. Data model

```text
ProductImage
  product          FK -> Product
  attribute_value  FK -> AttributeValue, null   the colour this image shows
  image            ImageField
  alt_text         str
  position         int
  is_primary       bool
  width / height   int
```

`attribute_value` null means the image is **shared** — a flat-lay, a size chart, packaging, a fabric
close-up. Shared images appear for every colour and never change the selection.

### Migration note

`ProductImage.variant` (FK to `ProductVariant`) existed before this design and was never read: the
payload emitted it and `ProductGallery` ignored it. It is replaced rather than supplemented, so there
is never an ambiguous precedence between two nullable foreign keys.

Before dropping it, check for rows where `variant_id IS NOT NULL`. If any exist, use expand/contract
(CLAUDE.md §6): add `attribute_value`, backfill from each variant's colour link, then drop `variant`
in a second migration.

### Rules

1. `attribute_value` must point at a value of an attribute whose `kind` is `COLOR` and whose
   `is_variant_defining` is true. Validated in the serializer and in `ProductImage.clean()`.
2. The value must belong to an attribute the product actually uses. An image cannot reference a
   colour none of the product's variants come in.
3. Deleting an `AttributeValue` sets `attribute_value` to null rather than cascading. Losing the
   grouping is recoverable; losing the photograph is not.
4. Ordering within a colour is `position`, then `created_at` — the same rule as the product-level
   order.

## 3. API

Each image carries its colour so the frontend can group without a second request:

```json
{
  "images": [
    {
      "url": "https://.../black-front.jpg",
      "alt": "Cotton shirt in Black",
      "color": { "code": "color", "value": "black", "label": "Black", "swatch": "#111111" }
    },
    {
      "url": "https://.../size-chart.jpg",
      "alt": "Size chart",
      "color": null
    }
  ]
}
```

Grouping is derived from data already inside the existing `images` prefetch in
`orders/api/shop_views.py`. It costs one added `select_related("attribute_value__attribute")` and no
extra query.

## 4. Storefront behaviour

The requirement is that **all images stay visible**. Selecting a colour moves the main image; it does
not filter the strip.

- The thumbnail strip always shows every image, grouped by colour with a **visible text label**
  ("Black — 4 photos"). Colour is never the only carrier of meaning (CLAUDE.md §11).
- Choosing **Black** in the buy panel moves the main image to Black's first photo and scrolls the
  strip to it.
- Clicking a **Red** thumbnail moves the main image **and updates the colour selection to Red**, so
  browsing the strip is a way to shop the colourways. If the resulting combination does not exist,
  the other axes are repaired the same way the variant picker repairs them.
- Shared images (`color: null`) are always present and never change the selection.
- The main image `alt` includes the colour name.

### Shared state

`ProductGallery` and `ProductBuyPanel` are sibling client components with no shared state, so neither
can drive the other. A thin `"use client"` `ProductDetail` wrapper owns
`{ selectedVariant, activeImage }` and renders both.

Not Zustand: CLAUDE.md reserves that for genuinely app-wide client state, and this is two siblings on
one page. The route stays a server component, so metadata and JSON-LD are untouched.

### Performance

Product detail already exceeds its documented latency budget
([roadmap phase 28](../roadmap.md)), so this must not make it worse:

- `priority` on the current image only; every other image is `loading="lazy"`. A product with 5
  colours and 4 photos each must not fetch 20 images on load.
- Strip auto-scroll uses `behavior: "auto"` under `prefers-reduced-motion`, not `"smooth"`.
- No new query — see §3.

## 5. Admin

Per-colour upload lives in the product form, as a section scoped by the ticked colour values — the
same pattern the variant matrix uses.

```text
Colour   [Black x]  [Red x]  [ Navy ]

  Black    [img] [img] [img] [ + ]
  Red      [img] [ + ]
  Shared   [img] [ + ]        shown for every colour
```

Only ticked colour values get an upload row. Unticking a colour leaves its images attached but hides
the row, so a mis-click cannot destroy a photo shoot — the same protection the variant matrix gives
to stock counts.

## 6. Phases

| # | Scope | State |
|---|---|---|
| B1 | `attribute_value` migration, validation, payload grouping, pytest | done. Expand/contract: `catalog/migrations/0002_productimage_attribute_value.py` backfills from `variant`, `0003_remove_productimage_variant.py` drops it |
| B2 | `ProductDetail` wrapper, colour-linked gallery, bidirectional strip | done |
| B3 | Per-colour upload in the admin product form | done — `components/admin/product-images.tsx`, mounted on `/admin/products/[id]`. Uploads go through `apiUpload` (multipart) to `POST /product-images/`; the colour list is built from the colours the product's variants actually use, so the API's "this product has no variant in that colour" rule cannot be tripped from the UI |

B1 and B2 shipped independently of B3, so images could be attached through the Django admin while
customers already had the colour-linked gallery.

Two details of B3 worth recording:

- **Uploads needed the proxy to stop decoding bodies as text.** `/api/proxy/[...path]` read every
  request body with `await request.text()`; a JPEG round-tripped through UTF-8 decode/encode is
  corrupt. It now uses `arrayBuffer()`, which is a superset — JSON is unaffected.
- **The colour dropdown is derived, not free.** It lists only colours the product has a variant in,
  because `ProductImage.clean()` refuses anything else. Offering the full colour registry would put
  a validation error behind an ordinary-looking choice.

B2 should be done **together with the variant-picker rework**, since both rewrite `ProductBuyPanel`
and colour switching reuses the same "does this combination exist" resolution.

## 7. Testing

pytest:

- an image bound to a non-colour attribute value is rejected;
- an image bound to a colour the product does not use is rejected;
- deleting an `AttributeValue` nulls `attribute_value` and keeps the image;
- the product payload stays within its query budget after grouping is added.

Browser: choosing a colour moves the main image; clicking another colour's thumbnail updates the
selection; shared images appear for every colour; nothing disappears from the strip.
