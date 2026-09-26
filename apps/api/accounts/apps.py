from typing import Any

from django.apps import AppConfig
from django.apps import apps as global_apps
from django.apps.registry import Apps
from django.db.models.signals import post_migrate


def sync_permissions_after_migrate(
    sender: AppConfig,
    apps: Apps = global_apps,
    plan: list[tuple[Any, bool]] | None = None,
    **kwargs: Any,
) -> None:
    """Grant new permission codes on every deploy, not only when someone reseeds.

    `migrate` emits post_migrate even with nothing to apply, so a code added to
    accounts.permissions reaches the roles the next time a deploy migrates.
    `flush` (and so every TransactionTestCase) emits it with no `apps` or `plan`.
    """
    # `migrate accounts zero` still emits post_migrate for this app, with the
    # tables gone. The migration state knows that; the live models do not.
    try:
        apps.get_model("accounts", "Permission")
        apps.get_model("accounts", "Role")
    except LookupError:
        return
    # A rollback may leave the schema behind the live models, and the next
    # forward migrate syncs anyway.
    if plan and any(backwards for _, backwards in plan):
        return

    from accounts.services import sync_permissions

    sync_permissions()


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"
    verbose_name = "Accounts"

    def ready(self) -> None:
        post_migrate.connect(
            sync_permissions_after_migrate,
            sender=self,
            dispatch_uid="accounts.sync_permissions_after_migrate",
        )
