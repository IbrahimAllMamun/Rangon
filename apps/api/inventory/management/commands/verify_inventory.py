"""Check the inventory ledger against the cached stock columns.

    python manage.py verify_inventory
    python manage.py verify_inventory --branch DHK1
    python manage.py verify_inventory --fix --reason "DR-2026-08-17 reconciliation"

--fix never edits the ledger.  It appends explaining rows so the correction is
itself auditable (docs/operations/disaster-recovery.md §7).
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from accounts.models import Branch
from inventory import services


class Command(BaseCommand):
    help = "Verify that cached stock levels match the inventory ledger."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--branch", help="Branch code to check (default: all).")
        parser.add_argument("--fix", action="store_true", help="Reconcile the drift found.")
        parser.add_argument("--reason", default="", help="Required with --fix.")

    def handle(self, *args: Any, **options: Any) -> None:
        branch = None
        if options["branch"]:
            branch = Branch.objects.filter(code=options["branch"]).first()
            if branch is None:
                raise CommandError(f"No branch with code {options['branch']!r}.")

        issues = services.verify_integrity(branch=branch)

        if not issues:
            self.stdout.write(self.style.SUCCESS("Inventory is consistent with the ledger."))
            return

        self.stdout.write(self.style.ERROR(f"{len(issues)} position(s) drifted from the ledger:"))
        for issue in issues:
            self.stdout.write(
                f"  {issue.sku:<28} @ {issue.branch_code:<6} "
                f"on_hand cached={issue.cached_on_hand} ledger={issue.ledger_on_hand} "
                f"(drift {issue.on_hand_drift:+d})  "
                f"reserved cached={issue.cached_reserved} ledger={issue.ledger_reserved} "
                f"(drift {issue.reserved_drift:+d})"
            )

        if not options["fix"]:
            self.stdout.write(
                "\nRun again with --fix --reason '...' to reconcile. "
                "Investigate the cause first: drift means something wrote stock "
                "outside inventory.services."
            )
            return

        if not options["reason"].strip():
            raise CommandError("--fix requires --reason.")

        for issue in issues:
            services.repair_drift(issue=issue, reason=options["reason"])
        self.stdout.write(self.style.SUCCESS(f"Reconciled {len(issues)} position(s)."))
