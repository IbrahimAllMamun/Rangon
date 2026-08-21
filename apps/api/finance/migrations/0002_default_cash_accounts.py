"""Give every existing branch a cash drawer to post into.

Without this, the first deploy of the finance app would leave every sale
falling into the "no account could be resolved" gap that ``verify_accounts``
reports -- technically honest, but useless.

This invents an *account*, not any *money*: the opening balance is zero and no
``OPENING`` row is written, so ``balance == SUM(transactions.amount) == 0``
holds from the start and ``verify_accounts`` is clean immediately after the
migration.  What each drawer actually held on the day of the migration is a
figure only the owner knows; they post it as an opening deposit from
``/admin/finance``.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations


def create_default_cash_accounts(apps, schema_editor):
    Branch = apps.get_model("accounts", "Branch")
    Account = apps.get_model("finance", "Account")

    for branch in Branch.objects.all():
        if Account.objects.filter(branch=branch, kind="CASH").exists():
            continue
        Account.objects.create(
            branch=branch,
            name=f"{branch.code} Cash Drawer",
            kind="CASH",
            balance=Decimal("0.00"),
            is_active=True,
            is_default=True,
            allow_overdraft=False,
            notes=(
                "Created automatically when the finance app was installed. "
                "Rename it, or set another account as the default, at any time."
            ),
        )


def remove_default_cash_accounts(apps, schema_editor):
    """Reverse only the untouched drawers.

    An account with movements against it is financial history (CLAUDE.md
    section 3.3), so it is left in place rather than deleted -- a reverse
    migration must not destroy a cash book.
    """
    Account = apps.get_model("finance", "Account")
    Account.objects.filter(transactions__isnull=True, notes__startswith="Created automatically").delete()


class Migration(migrations.Migration):
    dependencies = [
        ("finance", "0001_initial"),
        ("accounts", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(create_default_cash_accounts, remove_default_cash_accounts),
    ]
