# The product feed

> Where Facebook and Instagram get the catalogue from.
> Endpoint: `catalog/feeds.py` · Tests: `apps/api/tests/api/test_product_feed.py`

---

## What it is

A Bangladeshi fashion shop sells through Facebook and Instagram, and Meta does not
scrape a storefront — it reads a **feed**: a file at a URL, fetched on a schedule,
one row per buyable thing. Give Meta the URL once and the catalogue, the prices and
the stock levels stay in step on their own.

Two URLs, the same rows:

| URL | Format | Give this to |
|---|---|---|
| `https://<your-domain>/api/v1/shop/feed.xml` | RSS 2.0 + the `g:` namespace | Meta Commerce Manager, Google Merchant Center |
| `https://<your-domain>/api/v1/shop/feed.csv` | CSV | a spreadsheet, when you want to read what is being advertised |

Both are public and need no credentials, because a scheduled fetch from Meta's
infrastructure has no way to hold one. Nothing in the feed is private: it is what the
storefront already shows anybody. **`cost` is never in it** — that is the one
catalogue figure a competitor would actually want, and there is a test that says so.

## Set this before you use it

```bash
RANGON_PUBLIC_URL=https://rangonfashion.com
```

Every link in a feed has to be absolute. The API deliberately publishes root-relative
media paths (`apps/api/core/media.py` explains why), and Meta is not on this origin,
so it cannot resolve one. Without this variable the feed answers **503** with
`FEED_NOT_CONFIGURED` rather than publishing links nothing can follow.

## Connecting it to Meta

1. **Commerce Manager → Catalogue → Data sources → Add items → Scheduled feed.**
2. Paste the `.xml` URL. No username or password.
3. Set the schedule to **hourly** if you change prices during the day, **daily**
   otherwise. There is no benefit to more often: the response is cached for 15
   minutes.
4. Meta validates the first fetch and lists any rejected rows. Fix them in
   `/admin/products` — the feed is a view of the catalogue, never edited directly.

Google Merchant Center reads the same `.xml` unchanged.

## What a row says

One row per **variant**, not per product. "Kurti" is not buyable; "Kurti, Maroon, M"
is. Sizes and colours each get their own row so the advert lands on the one the
customer clicked, and `item_group_id` ties them back together so Meta shows one
product with options rather than eleven near-identical adverts.

| Field | Comes from |
|---|---|
| `id` | the variant's SKU |
| `item_group_id` | the product's slug |
| `title` | product name — variant label, clipped to 200 characters |
| `availability` · `inventory` | live stock **at the branch the storefront sells from** |
| `price` | `compare_at_price` when the item is discounted, otherwise `price` |
| `sale_price` | `price`, only when the item is discounted |
| `link` | `RANGON_PUBLIC_URL` + `/product/<slug>` |
| `image_link` | the variant's own colour photograph if it has one, else the product's primary |
| `brand` | the product's brand, or the shop's own name when it has none |
| `product_type` | the full category path, `Women > Ethnic > Kurti` |
| `color` · `size` | the variant's attributes, matched on attribute **kind** |
| `gtin` | the barcode, but only when it is barcode-shaped |

### Three things that are easy to get wrong

**The discount convention is backwards from what you would guess.** `price` carries
the *higher*, pre-discount figure and `sale_price` the one actually charged. The
strikethrough in the advert is the difference between them. Publishing the charged
figure as `price` with no `sale_price` raises no error anywhere — the shop just
silently stops getting the discount badge it is paying for.

**Availability is per branch.** Stock is a branch-level fact and the feed advertises
the branch the storefront sells from, so it can never say "in stock" about something
the storefront calls sold out.

**A generated barcode is not a GTIN.** This shop mints its own EAN-13s for items that
arrive without one (`catalog.services.generate_barcode`). Publishing an internal
number as a GTIN gets the row rejected at best and matched to somebody else's product
at worst, so only barcode-shaped values (8, 12, 13 or 14 digits) are published as one.

## A product with no photograph

Meta requires an image and rejects a row without one, so an unphotographed product
cannot be advertised either way. The feed publishes it anyway with the field empty,
because a rejection Meta reports back is something you can see and act on, while a
row quietly missing from the feed is not.

This is not hypothetical: the demo catalogue has no product photography at all
(D9 in the roadmap), so on seeded data **every** row is in this state. Meta's first
validation pass will list them, and that list is the photography backlog.

## What is excluded

Unpublished products, draft products, and archived variants — the same rule the
storefront uses, because a feed that advertises something nobody can buy is worse
than one product fewer.

## Cost of a fetch

The feed is the only endpoint here with no page size: it walks the whole catalogue.
Its query count is budgeted and growth-tested in `tests/test_performance.py`
(see [indexing.md](../database/indexing.md#query-budgets-enforced-in-tests)) — 9
queries for a 9-product catalogue, flat as it grows.
