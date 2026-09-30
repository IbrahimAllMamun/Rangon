"""Second parity stage: storefront content the demo seed leaves blank.

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_content.py

- Social links: a WhatsApp chat link (floating button), a plain profile, and
  a visible platform with no URL (left out).
- A custom page (served under /pages/) and an unpublished one (404).
Idempotent; one transaction.
"""

from django.db import transaction

from content.models import SitePage, SocialLink


def apply() -> None:
    SocialLink.objects.filter(platform="WHATSAPP").update(url="https://wa.me/8801712345678", is_visible=True, position=2)
    SocialLink.objects.filter(platform="FACEBOOK").update(url="https://www.facebook.com/rangon", is_visible=True, position=1)
    SocialLink.objects.filter(platform="INSTAGRAM").update(url="", is_visible=True, position=0)
    SitePage.objects.create(slug="parity-size-guide", title="Size guide", body="<p>Measure twice.</p>")
    SitePage.objects.create(slug="parity-draft-page", title="Draft page", is_published=False)
    print("parity content fixture applied")


if SitePage.objects.filter(slug="parity-size-guide").exists():
    print("parity content fixture already applied")
else:
    with transaction.atomic():
        apply()
