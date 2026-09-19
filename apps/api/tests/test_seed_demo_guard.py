"""`seed_demo` must not put the README's password on a production database.

It did, unguarded, for as long as the command existed. `scripts/rebuild-local-
prod.sh` ran `seed_demo --reset` against `config.settings.prod`, which gave
every role an account opening with `rangon12345` -- the password printed in the
public README -- and that stack was published through a Cloudflare tunnel. The
only thing standing between the two was a comment reading "never reaches
production".
"""

from __future__ import annotations

from typing import Any

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from accounts.models import User
from catalog.models import Product
from core.management.commands.seed_demo import PASSWORD, Command, demo_password
from core.models import AuditLog

pytestmark = pytest.mark.django_db

OWN_PASSWORD = "Tunnel-Proof-Demo-7431"


# -- which password, or none ------------------------------------------------


def test_development_uses_the_readme_password_by_default(settings: Any) -> None:
    settings.DEMO_SEED = "development"
    settings.DEMO_SEED_PASSWORD = ""
    assert demo_password() == PASSWORD


def test_development_takes_a_supplied_password(settings: Any) -> None:
    settings.DEMO_SEED = "development"
    settings.DEMO_SEED_PASSWORD = OWN_PASSWORD
    assert demo_password() == OWN_PASSWORD


@pytest.mark.parametrize("mode", ["off", "", "prod", "Production"])
def test_anything_but_the_two_modes_refuses(settings: Any, mode: str) -> None:
    settings.DEMO_SEED = mode
    settings.DEMO_SEED_PASSWORD = OWN_PASSWORD
    with pytest.raises(CommandError, match="disabled"):
        demo_password()


@pytest.mark.parametrize(
    ("supplied", "message"),
    [
        ("", "must be set"),
        (PASSWORD, "printed in the README"),
        ("short", "too weak"),
        ("1234567890123", "too weak"),  # long enough, entirely numeric
        ("password1234", "too weak"),  # on the common-password list
    ],
)
def test_production_refuses_a_missing_public_or_weak_password(
    settings: Any, supplied: str, message: str
) -> None:
    settings.DEMO_SEED = "production"
    settings.DEMO_SEED_PASSWORD = supplied
    with pytest.raises(CommandError, match=message):
        demo_password()


def test_production_accepts_a_strong_password_of_its_own(settings: Any) -> None:
    settings.DEMO_SEED = "production"
    settings.DEMO_SEED_PASSWORD = OWN_PASSWORD
    assert demo_password() == OWN_PASSWORD


# -- the command as a whole ---------------------------------------------------


def test_the_refusal_comes_before_reset_is_attempted(settings: Any, monkeypatch: Any) -> None:
    """Not merely rolled back afterwards.

    `handle()` is one transaction, so a refusal raised after `_reset()` would
    undo the deletion and the test below would still pass -- it was tried, and
    it did. Relying on that makes "refused" mean "deleted every order, then put
    them back", on a production database, under whatever locks that takes.
    """
    attempted: list[bool] = []
    monkeypatch.setattr(Command, "_reset", lambda self: attempted.append(True))
    settings.DEMO_SEED = "off"

    with pytest.raises(CommandError):
        call_command("seed_demo", "--reset", verbosity=0)

    assert not attempted


def test_a_refused_reset_deletes_nothing(settings: Any, shop: Any) -> None:
    """A refused `--reset` leaves every product and every account where it was."""
    settings.DEMO_SEED = "off"
    products = Product.objects.count()
    # The factories' staff are `@rangon.test` too, which is exactly what
    # `_reset()` deletes -- so their survival is the evidence it never ran.
    staff = User.objects.filter(email__endswith="@rangon.test").count()
    assert products and staff

    with pytest.raises(CommandError):
        call_command("seed_demo", "--reset", "--orders", "1", verbosity=0)

    assert Product.objects.count() == products
    assert User.objects.filter(email__endswith="@rangon.test").count() == staff


def test_production_seed_leaves_no_account_on_the_readme_password(settings: Any) -> None:
    """Including the ones an earlier seed created and this run did not.

    `_users` skips accounts that already exist, which is what makes the seed
    re-runnable -- and it meant re-seeding with a new password left every
    existing demo account still opening with the README one.
    """
    settings.DEMO_SEED = "production"
    settings.DEMO_SEED_PASSWORD = OWN_PASSWORD
    # What an earlier, unguarded seed left behind...
    User.objects.create_user(email="owner@rangon.test", password=PASSWORD)
    User.objects.create_user(email="customer@rangon.test", password=PASSWORD)
    # ...and one somebody had already rotated by hand, which is theirs to keep.
    User.objects.create_user(email="manager@rangon.test", password="Rotated-By-Hand-2026")

    call_command("seed_demo", "--orders", "1", verbosity=0)

    seeded = list(User.objects.filter(email__endswith="@rangon.test"))
    assert len(seeded) == 6
    assert not [u.email for u in seeded if u.check_password(PASSWORD)]

    by_email = {u.email: u for u in seeded}
    assert by_email["owner@rangon.test"].check_password(OWN_PASSWORD)
    assert by_email["customer@rangon.test"].check_password(OWN_PASSWORD)
    assert by_email["cashier@rangon.test"].check_password(OWN_PASSWORD)  # created by this run
    assert by_email["manager@rangon.test"].check_password("Rotated-By-Hand-2026")

    # A password change is a security event: the replacement is audited, the
    # value never is.
    owner_entries = AuditLog.objects.filter(
        entity_id=str(by_email["owner@rangon.test"].pk), new_values__password_reset=True
    )
    assert owner_entries.exists()
    assert OWN_PASSWORD not in str(list(owner_entries.values("old_values", "new_values")))
