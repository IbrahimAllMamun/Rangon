"""The product feed Meta and Google read to build a shopping catalogue.

A Bangladeshi fashion shop sells through Facebook and Instagram, and both read
the same thing: a file at a URL, re-fetched on a schedule, one row per buyable
thing. Meta accepts CSV, TSV, RSS 2.0 and Atom; Google Merchant reads RSS 2.0
with the `g:` namespace. So this module produces *one* list of rows and renders
it two ways -- RSS for the channels that prefer it, CSV for a human who wants to
open the feed in a spreadsheet and see what the shop is actually advertising.
Two renderers over one selector, so the two cannot drift.

**A row is a variant, not a product.** "Kurti" is not buyable; "Kurti, Maroon,
M" is. Sizes and colours each need their own row so the advert can land on the
one the customer clicked, and `item_group_id` ties them back together so Meta
shows them as one product with options rather than eleven near-identical ads.

Three things here are easy to get subtly wrong, and each costs money rather
than raising an error:

* **`price` is the pre-discount price.** The feed convention is that `price`
  carries the higher figure and `sale_price` the one being charged, so the ad
  renders a strikethrough. Publishing the discounted figure as `price` with no
  `sale_price` is not an error -- the shop simply loses the discount badge.
* **Availability is per branch.** Stock is a branch-level fact, and the feed
  advertises the online branch. `default_branch()` is the same answer the
  storefront gives, so the feed cannot say "in stock" about a product the
  storefront calls sold out.
* **Every URL must be absolute.** `media_url()` deliberately returns a root
  relative path, because the API cannot know its public origin
  (`core/media.py`). Meta is not on that origin and cannot resolve it, so the
  feed needs the origin stated once, in `RANGON["PUBLIC_URL"]`, and refuses to
  render without it rather than publishing links nothing can follow.

## A product with no photograph is still published

Meta requires `image_link` and rejects a row without one, so a product with no
photography cannot be advertised either way. It is published anyway, with the
field empty: a rejection Meta reports back is something the shop can see and
act on, and a row quietly missing from the feed is not. This is not
hypothetical — the seeded catalogue has no images at all (D9), so today every
row is in that state.
"""

from __future__ import annotations

import csv
import io
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any, ClassVar
from xml.etree import ElementTree as ET

from django.conf import settings
from django.db.models import Prefetch

from accounts.services import default_branch, get_organization
from catalog.models import AttributeKind, ProductImage, PublishStatus
from catalog.search import visible_products
from core.exceptions import BusinessError
from core.media import media_url
from inventory import services as inventory_services

#: Meta truncates a longer title in the ad itself, so truncate deliberately.
TITLE_LIMIT = 200
#: Meta's limit is 9999; the storefront's own descriptions are far shorter.
DESCRIPTION_LIMIT = 5000
#: Meta accepts up to 10 extra images per item.
ADDITIONAL_IMAGE_LIMIT = 10

#: The `g:` namespace every RSS product feed uses.
G_NAMESPACE = "http://base.google.com/ns/1.0"

#: Column order for the CSV rendering. Meta matches on header name rather than
#: position, so this order is for the human opening it in a spreadsheet: what
#: the thing is, then what it costs, then where to see it.
CSV_COLUMNS = (
    "id",
    "item_group_id",
    "title",
    "description",
    "availability",
    "inventory",
    "condition",
    "price",
    "sale_price",
    "link",
    "image_link",
    "additional_image_link",
    "brand",
    "product_type",
    "color",
    "size",
    "gtin",
    "mpn",
)


class FeedNotConfigured(BusinessError):
    """The public origin is unset, so no link in the feed could be followed."""

    code = "FEED_NOT_CONFIGURED"
    status_code = 503


@dataclass(frozen=True)
class FeedItem:
    """One buyable variant, in the vocabulary Meta and Google share."""

    id: str
    item_group_id: str
    title: str
    description: str
    availability: str
    inventory: int
    condition: str
    price: str
    sale_price: str
    link: str
    image_link: str
    additional_image_link: str
    brand: str
    product_type: str
    color: str
    size: str
    gtin: str
    mpn: str

    #: Fields an empty value should omit rather than publish blank. A blank
    #: `gtin` is fine; a blank `title` would be a rejected row, but that is the
    #: caller's problem to see, not something to paper over here. A ClassVar so
    #: the dataclass does not treat it as an eighteenth column.
    OPTIONAL: ClassVar[tuple[str, ...]] = (
        "item_group_id",
        "sale_price",
        "additional_image_link",
        "product_type",
        "color",
        "size",
        "gtin",
        "mpn",
    )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def public_url() -> str:
    """The origin customers reach the shop on, without a trailing slash."""
    configured = str(settings.RANGON.get("PUBLIC_URL", "")).strip()
    if not configured:
        raise FeedNotConfigured(
            "The product feed needs the public address of the storefront. "
            "Set RANGON_PUBLIC_URL to it, for example https://rangonfashion.com."
        )
    return configured.rstrip("/")


def _shop_name() -> str:
    """The shop's own name, which is what an unbranded item is sold under.

    Meta requires a `brand` on every row. Most of this catalogue carries one,
    but a tailor-made kurti has no manufacturer, and the shop is the brand in
    that case. Read from the organisation the owner named in
    `/admin/settings` rather than a constant, so renaming the shop renames it
    here too.
    """
    organization = get_organization()
    return organization.name if organization else "Rangon Fashion"


def _absolute(url: str, *, origin: str) -> str:
    """Absolutise a root-relative media path; leave a full URL alone.

    With `USE_S3=1` the stored URL is already a fully-qualified bucket address,
    so prefixing it would produce nonsense.
    """
    if not url:
        return ""
    if url.startswith(("http://", "https://")):
        return url
    return f"{origin}/{url.lstrip('/')}"


def _money(amount: Decimal) -> str:
    """`1290.00 BDT` — the amount and the ISO code, which the format requires."""
    currency = settings.RANGON["CURRENCY"]
    return f"{Decimal(amount).quantize(Decimal('0.01'))} {currency}"


def _clip(text: str, limit: int) -> str:
    """Trim on a word boundary where there is one, so the text still reads."""
    collapsed = " ".join(str(text or "").split())
    if len(collapsed) <= limit:
        return collapsed
    cut = collapsed[:limit]
    spaced = cut.rsplit(" ", 1)[0]
    return (spaced if len(spaced) > limit * 0.6 else cut).rstrip(" ,;.-") + "…"


def _category_path(category: Any) -> str:
    """`Women > Ethnic > Kurti`, the separator both platforms expect."""
    names: list[str] = []
    node = category
    seen = 0
    while node is not None and seen < 10:  # a cycle here would hang the feed
        names.append(node.name)
        node = node.parent
        seen += 1
    return " > ".join(reversed(names))


#: GS1 reserves these EAN prefixes for restricted circulation -- a shop's own
#: numbering, variable-weight items, coupons. They are unique inside one shop
#: and meaningless outside it. `catalog.services.generate_barcode` mints
#: exactly these, and says so.
_RESTRICTED_EAN_PREFIXES = (range(20, 30), range(40, 50), range(200, 300))


def _check_digit(digits: str) -> int:
    """The GS1 modulo-10 check digit for a body of any GTIN length.

    Weights alternate 3 and 1 from the RIGHT, which is what makes this work
    unchanged for GTIN-8, -12, -13 and -14 despite their different lengths.
    """
    total = sum(
        int(digit) * (3 if index % 2 == 0 else 1) for index, digit in enumerate(reversed(digits))
    )
    return (10 - (total % 10)) % 10


def _looks_like_gtin(barcode: str) -> bool:
    """Only publish a barcode as a GTIN when it really is one.

    Two ways a number here is not a GTIN, and both were live in this shop:

    * **It is the shop's own.** `catalog.services.generate_barcode` mints
      EAN-13s under prefix 20-29 precisely *because* GS1 reserves that range
      for in-store use, so it cannot collide with a manufacturer's. Publishing
      one as a GTIN claims a global identity it does not have -- the row is
      rejected at best, and matched to somebody else's product at worst. Every
      seeded variant carried one, which is how this was found: by reading the
      feed the running API actually served, not by reasoning about it.
    * **It is a SKU somebody typed into the barcode column.** The check digit
      catches that far better than a length test: `1234567890123` is
      thirteen digits and not a barcode.

    Anything rejected here is simply left blank. A GTIN is optional; a wrong
    one is not.
    """
    if not barcode.isdigit() or len(barcode) not in (8, 12, 13, 14):
        return False
    if _check_digit(barcode[:-1]) != int(barcode[-1]):
        return False

    # A GTIN-14 is a packaging level in front of a GTIN-13; a UPC-A is a
    # GTIN-13 with a leading zero. Compare on the 13-digit form so one rule
    # covers all of them.
    thirteen = barcode[-13:].rjust(13, "0")
    prefix = int(thirteen[:3])
    return not any(prefix in restricted for restricted in _RESTRICTED_EAN_PREFIXES)


def feed_items() -> list[FeedItem]:
    """Every variant the storefront would actually sell, in feed vocabulary.

    Read-only and branch-aware. One query for the products, one for the images
    and attribute values via prefetch, one for the stock snapshot — the shape
    `docs/database/indexing.md` requires of anything that walks the catalogue.
    """
    origin = public_url()
    shop_name = _shop_name()
    branch = default_branch()

    products = (
        visible_products()
        .select_related("category", "category__parent", "brand")
        .prefetch_related(None)
        .prefetch_related(
            Prefetch(
                "images",
                queryset=ProductImage.objects.select_related("attribute_value__attribute"),
            ),
            "variants__attribute_values__attribute",
            "variants__attribute_values__attribute_value",
        )
        .order_by("name", "pk")
    )
    products = list(products)

    sellable = [
        variant
        for product in products
        for variant in product.variants.all()
        if variant.status == PublishStatus.ACTIVE
    ]
    snapshots = inventory_services.availability(branch=branch, variants=sellable)

    items: list[FeedItem] = []
    for product in products:
        images = list(product.images.all())
        primary = next((i for i in images if i.is_primary), images[0] if images else None)
        product_type = _category_path(product.category)
        link = f"{origin}/product/{product.slug}"

        for variant in product.variants.all():
            if variant.status != PublishStatus.ACTIVE:
                continue

            label = variant.label
            title = f"{product.name} — {label}" if label else product.name

            # `kind`, not `code`: this shop has two colour attributes
            # (`color` for clothing, `shade` for cosmetics) and two size ones
            # (`size`, `shoe-size`), and will grow more. The kind is what the
            # attribute *is*; a code is what somebody happened to name it.
            colour_value = next(
                (
                    link_row.attribute_value
                    for link_row in variant.attribute_values.all()
                    if link_row.attribute.kind == AttributeKind.COLOR
                ),
                None,
            )
            variant_images = [
                image
                for image in images
                if colour_value is not None and image.attribute_value_id == colour_value.pk
            ]
            hero = variant_images[0] if variant_images else primary
            rest = [image for image in images if image is not hero][:ADDITIONAL_IMAGE_LIMIT]

            size_value = next(
                (
                    link_row.attribute_value.display
                    for link_row in variant.attribute_values.all()
                    if link_row.attribute.kind == AttributeKind.SIZE
                ),
                "",
            )

            snapshot = snapshots.get(str(variant.pk))
            available = snapshot.available if snapshot else 0

            on_sale = variant.is_on_sale
            barcode = variant.barcode or ""

            items.append(
                FeedItem(
                    id=variant.sku,
                    item_group_id=product.slug,
                    title=_clip(title, TITLE_LIMIT),
                    description=_clip(
                        product.description or product.short_description or product.name,
                        DESCRIPTION_LIMIT,
                    ),
                    availability="in stock" if available > 0 else "out of stock",
                    inventory=max(available, 0),
                    condition="new",
                    # Higher figure as `price`, charged figure as `sale_price`:
                    # the strikethrough in the ad comes from the difference.
                    price=_money(variant.compare_at_price if on_sale else variant.price),
                    sale_price=_money(variant.price) if on_sale else "",
                    link=link,
                    image_link=_absolute(media_url(hero.image) if hero else "", origin=origin),
                    additional_image_link=",".join(
                        _absolute(media_url(image.image), origin=origin) for image in rest
                    ),
                    brand=product.brand.name if product.brand else shop_name,
                    product_type=product_type,
                    color=colour_value.display if colour_value else "",
                    size=size_value,
                    gtin=barcode if _looks_like_gtin(barcode) else "",
                    mpn=variant.sku,
                )
            )
    return items


def render_csv(items: list[FeedItem]) -> str:
    """The tabular rendering, also the one a person can read in a spreadsheet."""
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(CSV_COLUMNS), extrasaction="ignore")
    writer.writeheader()
    for item in items:
        writer.writerow(item.as_dict())
    return buffer.getvalue()


def render_xml(items: list[FeedItem]) -> str:
    """RSS 2.0 with the `g:` namespace — what Google Merchant reads directly."""
    # `register_namespace` is the whole declaration: ElementTree writes the
    # `xmlns:g` attribute itself the first time a `{uri}tag` is serialised.
    # Passing `xmlns:g` here as well emitted it twice and made the document
    # malformed -- "duplicate attribute" -- which no amount of reading it back
    # as a string would have shown, and which Meta answers by rejecting the
    # entire feed rather than one row.
    ET.register_namespace("g", G_NAMESPACE)
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")

    shop_name = _shop_name()
    ET.SubElement(channel, "title").text = f"{shop_name} product feed"
    ET.SubElement(channel, "link").text = public_url()
    ET.SubElement(
        channel, "description"
    ).text = f"Every product {shop_name} currently sells online."

    for item in items:
        entry = ET.SubElement(channel, "item")
        for key, value in item.as_dict().items():
            if value == "" and key in item.OPTIONAL:
                continue
            # `g:title` and `g:description` are accepted, but plain RSS
            # `title`/`link`/`description` are what a feed reader shows, so
            # those three are written unprefixed as the format intends.
            tag = key if key in ("title", "description", "link") else f"{{{G_NAMESPACE}}}{key}"
            ET.SubElement(entry, tag).text = str(value)

    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(rss, encoding="unicode")
