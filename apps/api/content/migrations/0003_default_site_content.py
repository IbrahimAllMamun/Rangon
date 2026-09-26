"""Move the footer, About, Contact and policy copy out of the web app and into rows.

Until now all of it was hardcoded in `apps/web`: the Help and Company footer
columns, the tagline, the bottom bar, and the text of six pages.  This writes
exactly that content, so the storefront looks the same the moment it starts
reading from the API -- and a fresh install gets it without `seed_demo`, which
production never runs.

Nothing is invented here.  The page copy is the text the web app shipped on
2026-09-26 (owner sign-off before launch is still on the go-live checklist),
and the social profiles are created empty and hidden: a channel nobody set up
is never advertised.

Idempotent and additive: an install that already has a footer column, a page
or a social row keeps it.
"""

from __future__ import annotations

from django.db import migrations

SOCIAL_PLATFORMS = (
    "FACEBOOK",
    "INSTAGRAM",
    "TIKTOK",
    "YOUTUBE",
    "WHATSAPP",
    "MESSENGER",
    "X",
    "LINKEDIN",
    "PINTEREST",
    "THREADS",
    "TELEGRAM",
)


def _p(*paragraphs: str) -> str:
    return "".join(f"<p>{text}</p>" for text in paragraphs)


def _section(heading: str, *paragraphs: str) -> str:
    return f"<h2>{heading}</h2>{_p(*paragraphs)}"


PAGES = {
    "about": {
        "title": "About Rangon Fashion",
        "meta_description": (
            "Rangon Fashion — clothing, shoes, bags and cosmetics, online and in Dhaka."
        ),
        "body": _p(
            "Rangon Fashion is a Dhaka retailer selling clothing, shoes, bags, cosmetics and "
            "accessories — from our store at Panthapath and online, with the same stock behind "
            "both.",
            "When you buy something here, the same system that runs the till in the shop "
            "reserves it for you. That is why the availability you see is what is actually on "
            "the shelf, and why an item someone buys at the counter disappears from the website "
            "within seconds.",
        )
        + _section(
            "What we sell",
            "Everyday menswear and womenswear, kidswear, footwear, bags and cosmetics — chosen "
            "for Dhaka’s climate and how people here actually dress, not for a catalogue "
            "photograph.",
        )
        + _section(
            "Visit us",
            "Level 3, Bashundhara City, Panthapath, Dhaka 1215. Saturday to Thursday, "
            "10:00–20:00.",
        ),
    },
    "contact": {
        "title": "Contact us",
        "meta_description": (
            "Talk to Rangon Fashion — phone, email, or visit our Panthapath store in Dhaka."
        ),
        "body": _p("Questions about an order, a size, or a return? We are happy to help."),
    },
    "shipping": {
        "title": "Shipping",
        "meta_description": "Shipping policy for Rangon Fashion.",
        "body": _section(
            "Where we deliver",
            "We deliver across Bangladesh. Inside Dhaka usually takes 1–2 working days; outside "
            "Dhaka 2–5 working days.",
            "You can also collect your order from our Panthapath store free of charge.",
        )
        + _section(
            "Delivery charges",
            "Inside Dhaka: ৳70, free on orders over ৳3,000.",
            "Outside Dhaka: ৳130, free on orders over ৳5,000.",
            "The exact charge for your address is shown at checkout before you pay.",
        )
        + _section(
            "Cash on delivery",
            "You can pay the courier when your order arrives. We will call the number on your "
            "order before delivery.",
        ),
    },
    "returns": {
        "title": "Returns & exchanges",
        "meta_description": "Returns & exchanges policy for Rangon Fashion.",
        "body": _section(
            "Our return window",
            "You can return an item within 14 days of receiving it, as long as it is unworn, "
            "unwashed and in its original condition with the receipt.",
            "Items marked final sale cannot be returned.",
        )
        + _section(
            "How to return something",
            "Bring the item and your receipt to our store, or contact us to arrange a return for "
            "an online order.",
            "Once we receive and check the item, we issue your refund to the method you "
            "originally paid with.",
        )
        + _section(
            "Delivery charges on returns",
            "If the item was faulty, damaged, or not what you ordered, we refund the delivery "
            "charge too.",
            "If you simply changed your mind, the delivery charge is not refunded.",
        ),
    },
    "privacy": {
        "title": "Privacy",
        "meta_description": "Privacy policy for Rangon Fashion.",
        "body": _section(
            "What we collect",
            "Your name, phone number, delivery address and — if you give it — your email "
            "address. We keep a record of what you have ordered.",
            "We do not store card numbers. Card payments are handled by the payment terminal or "
            "the payment provider.",
        )
        + _section(
            "How we use it",
            "To take payment, deliver your order, handle returns, and keep the accounting "
            "records the law requires.",
            "We do not sell your information.",
        )
        + _section(
            "Your choices",
            "Contact us to see, correct or delete the personal information we hold. We keep "
            "financial records where we are legally required to, but we can anonymise your "
            "personal details.",
        ),
    },
    "terms": {
        "title": "Terms",
        "meta_description": "Terms of sale for Rangon Fashion.",
        "body": _section(
            "Orders",
            "Placing an order is an offer to buy. We confirm it once we have checked stock and "
            "your details.",
            "Prices and availability shown on this site are confirmed by our system at checkout. "
            "If a price is wrong we will contact you before dispatching.",
        )
        + _section(
            "Cancellation",
            "You can cancel an order before it is packed. After that, please use the returns "
            "process.",
        ),
    },
}

#: (column heading, [(type, label, url-or-page-slug)]).  Today's footer, plus the
#: links it lacked: New arrivals, All brands, Shop all.
COLUMNS = (
    (
        "Shop",
        [
            ("CATEGORY_LIST", "", ""),
            ("LINK", "New arrivals", "/shop?sort=newest"),
            ("LINK", "All brands", "/brand"),
            ("LINK", "Shop all", "/shop"),
        ],
    ),
    (
        "Help",
        [
            ("LINK", "Track your order", "/track"),
            ("PAGE", "Shipping", "shipping"),
            ("PAGE", "Returns & exchanges", "returns"),
            ("PAGE", "Contact us", "contact"),
        ],
    ),
    (
        "Company",
        [
            ("PAGE", "About us", "about"),
            ("PAGE", "Privacy policy", "privacy"),
            ("PAGE", "Terms of sale", "terms"),
        ],
    ),
)


def create_site_content(apps, schema_editor):
    SiteSettings = apps.get_model("content", "SiteSettings")
    SocialLink = apps.get_model("content", "SocialLink")
    SitePage = apps.get_model("content", "SitePage")
    NavigationItem = apps.get_model("content", "NavigationItem")

    SiteSettings.objects.get_or_create(
        key="default",
        defaults={
            "tagline": "Clothing, shoes, bags and cosmetics — online and at our Dhaka store.",
            "opening_hours": [
                {"days": "Saturday–Thursday", "hours": "10:00–20:00"},
                {"days": "Friday", "hours": "15:00–20:00"},
            ],
            "bottom_note": "Cash on delivery available across Bangladesh.",
        },
    )

    for position, platform in enumerate(SOCIAL_PLATFORMS):
        SocialLink.objects.get_or_create(
            platform=platform, defaults={"position": position, "is_visible": False}
        )

    pages = {}
    for slug, fields in PAGES.items():
        page, created = SitePage.objects.get_or_create(
            slug=slug, defaults={**fields, "is_system": True}
        )
        if not created and not page.is_system:
            page.is_system = True
            page.save(update_fields=["is_system"])
        pages[slug] = page

    footer = NavigationItem.objects.filter(placement="FOOTER")
    if footer.filter(type="GROUP").exists():
        return  # someone has already built a footer; leave it alone

    # Links the old navigation screen put in the footer were the "Shop" column.
    # Keep them, in a column, instead of the default links.
    legacy = list(footer.filter(parent__isnull=True).order_by("position", "label"))
    legacy_children = list(footer.filter(parent__isnull=False).order_by("position", "label"))

    for column_position, (heading, links) in enumerate(COLUMNS):
        column = NavigationItem.objects.create(
            placement="FOOTER", type="GROUP", label=heading, position=column_position
        )
        if heading == "Shop" and legacy:
            # Flattened: a footer is two levels, column and link.
            for offset, item in enumerate(legacy + legacy_children):
                item.parent = column
                item.position = offset
                item.save(update_fields=["parent", "position"])
            continue
        for link_position, (kind, label, target) in enumerate(links):
            NavigationItem.objects.create(
                placement="FOOTER",
                type=kind,
                parent=column,
                label=label,
                url=target if kind == "LINK" else "",
                page=pages[target] if kind == "PAGE" else None,
                position=link_position,
            )


def remove_site_content(apps, schema_editor):
    """Undo the footer columns; keep any link someone added by hand.

    Columns cascade to their children, so hand-made links are lifted out of
    them first. The settings, social and page tables are dropped by reversing
    0002 anyway, so there is nothing to do for those here.
    """
    NavigationItem = apps.get_model("content", "NavigationItem")
    footer = NavigationItem.objects.filter(placement="FOOTER")
    footer.filter(type__in=["LINK", "CATEGORY", "PROMO"], parent__type="GROUP").update(parent=None)
    footer.filter(type__in=["GROUP", "CATEGORY_LIST", "PAGE"]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("content", "0002_site_content"),
    ]

    operations = [
        migrations.RunPython(create_site_content, remove_site_content),
    ]
