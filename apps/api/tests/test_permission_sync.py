"""`migrate` keeps the roles in step with accounts.permissions.

Until 2026-09-26 only `seed_demo` and the test fixtures ran sync_permissions(),
so a production database that was migrated and never reseeded never granted a
new code (`content.site_manage`) to anyone but the owner, who holds every code
implicitly.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.apps import apps as global_apps
from django.core.management import call_command
from django.db.migrations import Migration
from django.db.migrations.state import ProjectState
from django.db.models.signals import post_migrate

from accounts.models import Permission, Role, RoleCode

pytestmark = pytest.mark.django_db

CODE = "content.site_manage"


def _manager_codes() -> set[str]:
    manager = Role.objects.get(code=RoleCode.MANAGER)
    return set(manager.permissions.values_list("code", flat=True))


def _emit_post_migrate(**kwargs: Any) -> None:
    """Send post_migrate for accounts alone. `migrate` adds `apps` and `plan`; `flush` does not."""
    config = global_apps.get_app_config("accounts")
    post_migrate.send(
        sender=config,
        app_config=config,
        verbosity=0,
        interactive=False,
        using="default",
        **kwargs,
    )


@pytest.fixture
def code_missing() -> None:
    """A database that predates CODE: the row, and so every grant of it, is absent."""
    Permission.objects.filter(code=CODE).delete()
    assert CODE not in _manager_codes()


@pytest.mark.usefixtures("code_missing")
class TestPostMigrate:
    def test_recreates_the_code_and_grants_it_to_the_manager(self) -> None:
        _emit_post_migrate(apps=global_apps, plan=[])

        assert Permission.objects.filter(code=CODE).exists()
        assert CODE in _manager_codes()

    def test_flush_which_sends_no_migration_state_also_syncs(self) -> None:
        # The first version required `apps` and raised TypeError here, which
        # errored every transactional test at teardown.
        _emit_post_migrate()

        assert CODE in _manager_codes()

    def test_migrate_with_nothing_to_apply_still_syncs(self) -> None:
        # The deploy path: a new code is a code change, not a migration.
        call_command("migrate", verbosity=0, interactive=False)

        assert CODE in _manager_codes()

    def test_does_nothing_when_accounts_is_not_migrated(self) -> None:
        # `migrate accounts zero`: no accounts models in the migration state,
        # and no tables to write to.
        _emit_post_migrate(apps=ProjectState().apps, plan=[])

        assert not Permission.objects.filter(code=CODE).exists()

    def test_does_nothing_on_a_rollback(self) -> None:
        _emit_post_migrate(
            apps=global_apps, plan=[(Migration("0003_staffprofile", "accounts"), True)]
        )

        assert not Permission.objects.filter(code=CODE).exists()
