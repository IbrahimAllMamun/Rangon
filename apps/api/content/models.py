"""Storefront content: navigation, banners, the footer and site pages.

The category tree *is* the navigation (ADR-0009).  `NavigationItem` is an
override list for the handful of things a category cannot express — a filter
("Sale"), a sort ("New Arrivals"), a scheduled campaign, a badge, a promo card,
an external link.  An install with no rows here still renders a correct navbar.

`StorefrontBanner` is the first content model Rangon has had: it drives the
announcement bar and the homepage hero, both of which were hardcoded before.

The footer is the same `NavigationItem` rows under `placement=FOOTER`: a
`GROUP` row is a column, its children are the links in it (ADR-0012).
`SiteSettings` holds the footer's brand block and the shop's public contact
details, `SocialLink` the social profiles, and `SitePage` the About, Contact
and policy copy that used to be hardcoded in the web app.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import models
from django.utils import timezone

from core.exceptions import ValidationError as BusinessValidationError
from core.models import BaseModel


class Placement(models.TextChoices):
    HEADER = "HEADER", "Header"
    FOOTER = "FOOTER", "Footer"


class NavigationItemType(models.TextChoices):
    CATEGORY = "CATEGORY", "Category"
    LINK = "LINK", "Link"
    PROMO = "PROMO", "Promo card"
    PAGE = "PAGE", "Site page"
    #: A footer column heading.  Holds links; is not one.
    GROUP = "GROUP", "Footer column"
    #: Expands to the live top-level categories when the footer is resolved,
    #: so a "Shop" column follows the catalogue without anyone editing it.
    CATEGORY_LIST = "CATEGORY_LIST", "Top categories (automatic)"


#: Types that only make sense inside the footer.
FOOTER_ONLY_TYPES = (NavigationItemType.GROUP, NavigationItemType.CATEGORY_LIST)

#: The footer lays out the brand block plus this many columns.
MAX_FOOTER_COLUMNS = 4


class NavigationLayout(models.TextChoices):
    AUTO = "AUTO", "Automatic"
    DROPDOWN = "DROPDOWN", "Dropdown"
    MEGA = "MEGA", "Mega menu"


class ScheduledQuerySet(models.QuerySet):
    """Rows that are active *and* inside their publish window.

    Visibility is enforced here rather than in the frontend so a stale cache
    cannot show an expired campaign (navigation.md §2 rule 1).
    """

    def live(self, *, now=None):
        moment = now or timezone.now()
        return self.filter(is_active=True).filter(
            models.Q(starts_at__isnull=True) | models.Q(starts_at__lte=moment),
            models.Q(ends_at__isnull=True) | models.Q(ends_at__gte=moment),
        )


class NavigationItem(BaseModel):
    placement = models.CharField(max_length=16, choices=Placement.choices, default=Placement.HEADER)
    type = models.CharField(
        max_length=16, choices=NavigationItemType.choices, default=NavigationItemType.CATEGORY
    )
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="children"
    )
    category = models.ForeignKey(
        "catalog.Category",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="navigation_items",
        help_text="CATEGORY items only. Supplies the name, slug and children.",
    )
    page = models.ForeignKey(
        "content.SitePage",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="navigation_items",
        help_text="PAGE items only. The link follows the page and hides when it is unpublished.",
    )
    label = models.CharField(
        max_length=120, blank=True, help_text="Overrides the category name when set."
    )
    url = models.CharField(
        max_length=300, blank=True, help_text="LINK and PROMO items only, e.g. /shop?sort=newest"
    )
    badge = models.CharField(
        max_length=24,
        blank=True,
        help_text='Rendered as data, e.g. "NEW", "SALE", "20% OFF". Never branched on.',
    )
    image = models.ImageField(upload_to="navigation/", blank=True, null=True)
    description = models.CharField(max_length=200, blank=True)
    layout = models.CharField(
        max_length=16, choices=NavigationLayout.choices, default=NavigationLayout.AUTO
    )
    position = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)

    objects = ScheduledQuerySet.as_manager()

    class Meta:
        db_table = "content_navigationitem"
        ordering = ("position", "label")
        indexes = [
            models.Index(fields=["placement", "position"], name="content_navitem_place_idx"),
            models.Index(fields=["parent", "position"], name="content_navitem_parent_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ends_at__isnull=True)
                | models.Q(starts_at__isnull=True)
                | models.Q(ends_at__gte=models.F("starts_at")),
                name="content_navitem_window_ordered",
            )
        ]

    def __str__(self) -> str:
        return self.display_label or f"{self.type} item"

    def clean(self) -> None:
        # Imported here: the validators module imports this one for its choices.
        from content.validators import validate_link_url

        if self.type == NavigationItemType.CATEGORY and self.category_id is None:
            raise DjangoValidationError({"category": "A CATEGORY item needs a category."})
        if self.type != NavigationItemType.CATEGORY and self.category_id is not None:
            raise DjangoValidationError(
                {"category": "Only a CATEGORY item may reference a category."}
            )
        if self.type == NavigationItemType.PAGE and self.page_id is None:
            raise DjangoValidationError({"page": "A PAGE item needs a page."})
        if self.type != NavigationItemType.PAGE and self.page_id is not None:
            raise DjangoValidationError({"page": "Only a PAGE item may reference a page."})
        if self.type == NavigationItemType.LINK and not self.url:
            raise DjangoValidationError({"url": "A LINK item needs a URL."})
        if self.type == NavigationItemType.LINK and not self.label:
            raise DjangoValidationError({"label": "A LINK item needs a label."})
        if self.parent_id and self.parent_id == self.pk:
            raise DjangoValidationError({"parent": "An item cannot be its own parent."})
        if self.url:
            try:
                self.url = validate_link_url(self.url)
            except BusinessValidationError as error:
                raise DjangoValidationError({"url": error.message}) from error
        self._clean_placement()

    def _clean_placement(self) -> None:
        """The footer is columns of links; the header has neither concept."""
        if self.placement != Placement.FOOTER:
            if self.type in FOOTER_ONLY_TYPES:
                raise DjangoValidationError(
                    {"type": f"A {self.get_type_display().lower()} belongs in the footer."}
                )
            return

        if self.type == NavigationItemType.GROUP:
            if self.parent_id is not None:
                raise DjangoValidationError({"parent": "A footer column cannot be nested."})
            if not self.label:
                raise DjangoValidationError({"label": "A footer column needs a heading."})
            if self.url:
                raise DjangoValidationError({"url": "A footer column heading is not a link."})
            columns = NavigationItem.objects.filter(
                placement=Placement.FOOTER, type=NavigationItemType.GROUP
            ).exclude(pk=self.pk)
            if columns.count() >= MAX_FOOTER_COLUMNS:
                raise DjangoValidationError(
                    {
                        "type": (
                            f"The footer has room for {MAX_FOOTER_COLUMNS} columns. "
                            "Remove one before adding another."
                        )
                    }
                )
            return

        # Everything else in the footer is a link inside a column.
        if self.parent_id is None:
            raise DjangoValidationError({"parent": "Choose the footer column this link goes in."})
        if self.parent is not None and (
            self.parent.placement != Placement.FOOTER
            or self.parent.type != NavigationItemType.GROUP
        ):
            raise DjangoValidationError({"parent": "A footer link must sit in a footer column."})

    @property
    def display_label(self) -> str:
        if self.label:
            return self.label
        if self.category:
            return self.category.name
        if self.page:
            return self.page.title
        if self.type == NavigationItemType.CATEGORY_LIST:
            return NavigationItemType.CATEGORY_LIST.label
        return ""


class BannerPlacement(models.TextChoices):
    ANNOUNCEMENT = "ANNOUNCEMENT", "Announcement bar"
    HOME_HERO = "HOME_HERO", "Homepage hero"


class StorefrontBanner(BaseModel):
    placement = models.CharField(max_length=16, choices=BannerPlacement.choices)
    message = models.CharField(
        max_length=200, blank=True, help_text="Announcement bar copy (one line)."
    )
    title = models.CharField(max_length=120, blank=True, help_text="Hero headline.")
    subtitle = models.CharField(max_length=200, blank=True)
    cta_label = models.CharField(max_length=40, blank=True)
    url = models.CharField(max_length=300, blank=True)
    image = models.ImageField(upload_to="banners/", blank=True, null=True)
    dismissible = models.BooleanField(default=True)
    priority = models.IntegerField(
        default=0, help_text="Highest priority wins when several are live."
    )
    is_active = models.BooleanField(default=True)
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)

    objects = ScheduledQuerySet.as_manager()

    class Meta:
        db_table = "content_storefrontbanner"
        ordering = ("-priority", "-created_at")
        indexes = [models.Index(fields=["placement", "-priority"], name="content_banner_place_idx")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ends_at__isnull=True)
                | models.Q(starts_at__isnull=True)
                | models.Q(ends_at__gte=models.F("starts_at")),
                name="content_banner_window_ordered",
            )
        ]

    def __str__(self) -> str:
        return f"{self.get_placement_display()}: {self.message or self.title}"

    def clean(self) -> None:
        if self.placement == BannerPlacement.ANNOUNCEMENT and not self.message:
            raise DjangoValidationError({"message": "An announcement needs a message."})
        if self.placement == BannerPlacement.HOME_HERO and not self.title:
            raise DjangoValidationError({"title": "A hero banner needs a title."})


class SiteSettings(BaseModel):
    """The footer's brand block and the shop's public contact details. One row.

    The contact fields are what the *storefront* shows, and may differ from the
    registered details `Organization` prints on receipts.  Each one left blank
    falls back to the organisation's, so a fresh install still shows something
    true (ADR-0012).
    """

    #: Enforces the single row: there is only one value this may take.
    key = models.CharField(max_length=16, default="default", unique=True, editable=False)

    tagline = models.CharField(max_length=200, blank=True)
    address = models.TextField(
        blank=True, help_text="Shown under the footer logo. Blank uses the organisation's."
    )
    phone = models.CharField(max_length=32, blank=True)
    email = models.EmailField(blank=True)
    opening_hours = models.JSONField(
        default=list,
        blank=True,
        help_text='Rows of {"days": "Saturday–Thursday", "hours": "10:00–20:00"}.',
    )
    show_address = models.BooleanField(default=True)
    map_embed_url = models.URLField(
        max_length=2000,
        blank=True,
        help_text="Google Maps embed URL. Only https://www.google.com/maps is accepted.",
    )
    map_link_url = models.URLField(
        max_length=500, blank=True, help_text='The "Open in Google Maps" link.'
    )
    copyright_text = models.CharField(
        max_length=200, blank=True, help_text="{year} is replaced with the current year."
    )
    bottom_note = models.CharField(max_length=200, blank=True)
    whatsapp_float = models.BooleanField(
        default=True,
        help_text="Show the floating chat button when a WhatsApp link is visible.",
    )
    updated_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "content_sitesettings"
        verbose_name = "site settings"
        verbose_name_plural = "site settings"

    def __str__(self) -> str:
        return "Site settings"


class SocialPlatform(models.TextChoices):
    FACEBOOK = "FACEBOOK", "Facebook"
    INSTAGRAM = "INSTAGRAM", "Instagram"
    TIKTOK = "TIKTOK", "TikTok"
    YOUTUBE = "YOUTUBE", "YouTube"
    WHATSAPP = "WHATSAPP", "WhatsApp"
    MESSENGER = "MESSENGER", "Messenger"
    X = "X", "X (Twitter)"
    LINKEDIN = "LINKEDIN", "LinkedIn"
    PINTEREST = "PINTEREST", "Pinterest"
    THREADS = "THREADS", "Threads"
    TELEGRAM = "TELEGRAM", "Telegram"


class SocialLink(BaseModel):
    """One row per platform, created by migration; the admin fills them in.

    A fixed list rather than free-form rows: the admin screen is a checklist
    of every platform in the shop's chosen order, and a platform can never be
    listed twice.  A link with no URL is never shown, whatever `is_visible` says.
    """

    platform = models.CharField(max_length=16, choices=SocialPlatform.choices, unique=True)
    url = models.CharField(max_length=300, blank=True)
    is_visible = models.BooleanField(default=False)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "content_sociallink"
        ordering = ("position", "platform")

    def __str__(self) -> str:
        return self.get_platform_display()

    @property
    def is_live(self) -> bool:
        return self.is_visible and bool(self.url)


#: The pages the storefront has always had, and the paths it serves them at.
#: They cannot be deleted, and their slugs cannot change: other sites, printed
#: receipts and search engines link to these paths.
SYSTEM_PAGE_PATHS: dict[str, str] = {
    "about": "/about",
    "contact": "/contact",
    "shipping": "/policies/shipping",
    "returns": "/policies/returns",
    "privacy": "/policies/privacy",
    "terms": "/policies/terms",
}

#: Everything else a shop adds -- a size guide, an FAQ -- lives under here.
CUSTOM_PAGE_PREFIX = "/pages/"


class SitePage(BaseModel):
    """About, Contact, the policies, and any page the shop adds.

    `body` is HTML from the admin's rich-text editor, sanitised by
    `content.rich_text` before it is stored.  It is never stored raw.
    """

    slug = models.SlugField(max_length=64, unique=True)
    title = models.CharField(max_length=120)
    meta_description = models.CharField(max_length=300, blank=True)
    body = models.TextField(blank=True)
    is_published = models.BooleanField(default=True)
    is_system = models.BooleanField(default=False, editable=False)
    updated_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "content_sitepage"
        ordering = ("-is_system", "title")

    def __str__(self) -> str:
        return self.title

    @property
    def path(self) -> str:
        return SYSTEM_PAGE_PATHS.get(self.slug, f"{CUSTOM_PAGE_PREFIX}{self.slug}")
