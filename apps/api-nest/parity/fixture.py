"""Extra rows for the parity database: the cases `seed_demo` never creates.

Run through Django, so every row is one Django itself would accept:

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture.py

All or nothing (one transaction), and a second run finds the marker category
and stops. Never run it against a database anyone uses -- it is test data.

What it adds, and which comparison each exists for:
- A three-level category chain with a VAT override and an inactive sibling
  (breadcrumbs, `path`, tax payloads, inactive children hidden).
- Two products with the same `created_at` and `featured` (a tie the listing's
  ORDER BY leaves to the plan -- the reason the Nest API sends Django's SQL).
- Draft, archived, brand-less and variant-less products.
- Variants: inactive with the deepest discount (drop_percent reads inactive
  ones), compare-at of zero (falsy), compare-at below price (not a discount).
- Images bound to a colour, shared, with alt text, with a space and a
  non-ASCII letter in the file name (media URL quoting).
- Reviews: approved, pending, rejected; one timestamp with no microseconds.
- Banners live, expired and scheduled; popular search terms with a tie.
- A carousel entry for a product a shopper cannot open.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from catalog.models import (
    Attribute,
    AttributeValue,
    Brand,
    Category,
    Product,
    ProductImage,
    ProductVariant,
    PublishStatus,
    SearchTerm,
    VariantAttributeValue,
)
from content.models import BannerPlacement, HomeCarouselItem, StorefrontBanner
from customers.models import Customer
from engagement.models import Review, ReviewStatus

def apply() -> None:
    root = Category.objects.create(name="Parity", slug="parity", position=99)
    middle = Category.objects.create(
        name="Parity Middle", slug="parity-middle", parent=root, tax_rate=Decimal("0.0750")
    )
    leaf = Category.objects.create(
        name="Parity Leaf", slug="parity-leaf", parent=middle, image="categories/parity leaf.jpg"
    )
    Category.objects.create(name="Parity Hidden", slug="parity-hidden", parent=root, is_active=False)

    brand = Brand.objects.create(
        name="Parity Brand", slug="parity-brand", logo="brands/logo ü.png", is_featured=True
    )
    Brand.objects.create(name="Parity Retired", slug="parity-retired", is_active=False)

    def product(name, slug, **fields):
        fields.setdefault("status", PublishStatus.ACTIVE)
        fields.setdefault("published", True)
        fields.setdefault("category", leaf)
        return Product.objects.create(name=name, slug=slug, **fields)

    def variant(owner, sku, price, **fields):
        return ProductVariant.objects.create(
            product=owner, sku=sku, price=Decimal(price), cost=Decimal("100.00"), **fields
        )

    twin_a = product("Parity Twin A", "parity-twin-a", brand=brand, featured=True)
    twin_b = product("Parity Twin B", "parity-twin-b", brand=brand, featured=True)
    variant(twin_a, "PAR-TWA", "990.00")
    variant(twin_b, "PAR-TWB", "990.00")
    same_moment = timezone.now() - timedelta(days=400)
    Product.objects.filter(pk__in=[twin_a.pk, twin_b.pk]).update(created_at=same_moment)

    draft = product("Parity Draft", "parity-draft", published=False)
    variant(draft, "PAR-DRAFT", "500.00")
    product("Parity Archived", "parity-archived", status=PublishStatus.ARCHIVED)

    loose = product(
        "Parity 100% Cotton_Tee",
        "parity-cotton-tee",
        short_description="A tee for the parity run.",
        description="Soft, and it has no brand at all.",
    )
    size = Attribute.objects.get(code="size")
    colour = Attribute.objects.get(code="color")
    black = AttributeValue.objects.get(attribute=colour, value="Black")
    white = AttributeValue.objects.get(attribute=colour, value="White")
    small = AttributeValue.objects.get(attribute=size, value="S")
    medium = AttributeValue.objects.get(attribute=size, value="M")

    on_sale = variant(loose, "PAR-TEE-S-BLK", "1200.00", compare_at_price=Decimal("1500.00"))
    retired = variant(
        loose,
        "PAR-TEE-M-BLK",
        "1000.00",
        compare_at_price=Decimal("3000.00"),
        status=PublishStatus.ARCHIVED,
    )
    zero = variant(loose, "PAR-TEE-S-WHT", "1100.00", compare_at_price=Decimal("0.00"), position=2)
    below = variant(loose, "PAR-TEE-M-WHT", "1300.00", compare_at_price=Decimal("1250.00"), position=3)
    for row, value_s, value_c in [
        (on_sale, small, black),
        (retired, medium, black),
        (zero, small, white),
        (below, medium, white),
    ]:
        VariantAttributeValue.objects.create(variant=row, attribute=size, attribute_value=value_s)
        VariantAttributeValue.objects.create(variant=row, attribute=colour, attribute_value=value_c)

    ProductImage.objects.create(product=loose, attribute_value=black, image="products/2026/09/tee black.jpg", position=0)
    ProductImage.objects.create(
        product=loose, image="products/2026/09/tee-flat.jpg", alt_text="Flat lay", position=1
    )
    ProductImage.objects.create(product=loose, image="products/2026/09/tee-ñ.webp", position=1)

    product("Parity Empty", "parity-empty", brand=brand)

    # Reviews on a seeded product, so detail pages carry real review blocks.
    shirt = Product.objects.get(slug="classic-oxford-shirt")
    customers = list(Customer.objects.filter(is_walk_in=False).order_by("created_at")[:5])
    for customer, rating, status in zip(
        customers,
        [5, 4, 4, 1, 2],
        [
            ReviewStatus.APPROVED,
            ReviewStatus.APPROVED,
            ReviewStatus.APPROVED,
            ReviewStatus.PENDING,
            ReviewStatus.REJECTED,
        ],
        strict=False,
    ):
        Review.objects.create(
            product=shirt,
            customer=customer,
            rating=rating,
            title=f"{rating} stars",
            comment="Parity review.",
            verified_purchase=rating > 3,
            status=status,
        )
    first = Review.objects.filter(product=shirt, status=ReviewStatus.APPROVED).order_by("created_at").first()
    if first is not None:
        # A whole second: isoformat() prints no fraction at all.
        Review.objects.filter(pk=first.pk).update(created_at=datetime(2026, 9, 1, 10, 0, 0, tzinfo=UTC))

    now = timezone.now()
    StorefrontBanner.objects.create(
        placement=BannerPlacement.HOME_HERO,
        title="Parity hero",
        subtitle="Shown",
        cta_label="Shop",
        url="/category/parity",
        image="banners/hero.jpg",
        priority=5,
    )
    StorefrontBanner.objects.create(
        placement=BannerPlacement.HOME_HERO, title="Expired hero", priority=50, ends_at=now - timedelta(days=1)
    )
    StorefrontBanner.objects.create(
        placement=BannerPlacement.HOME_HERO, title="Future hero", priority=60, starts_at=now + timedelta(days=1)
    )
    StorefrontBanner.objects.create(
        placement=BannerPlacement.ANNOUNCEMENT, message="Parity announcement", dismissible=False
    )

    for term, hits, results in [("shirt", 10, 5), ("panjabi", 10, 2), ("saree", 7, 0), ("tee", 3, 1)]:
        # Upserted: a parity run may already have logged these terms.
        SearchTerm.objects.update_or_create(
            term=term, defaults={"hits": hits, "last_result_count": results, "last_searched_at": now}
        )

    HomeCarouselItem.objects.create(product=draft, position=0)
    HomeCarouselItem.objects.create(product=loose, position=0)

    print("parity fixture applied")


if Category.objects.filter(slug="parity").exists():
    print("parity fixture already applied")
else:
    with transaction.atomic():
        apply()
