"""Check the cash book against the cached account balances.

    python manage.py verify_accounts
    python manage.py verify_accounts --branch DHK1
    python manage.py verify_accounts --fix --reason "DR-2026-08-22 reconciliation"

The money counterpart of ``verify_inventory``.  ``--fix`` never edits the
ledger: it appends explaining rows so the correction is itself auditable
(docs/operations/disaster-recovery.md).

It also reports **unposted** money events -- payments, refunds and supplier
payments that carry no account, because the branch had none able to hold that
method's money when they happened.  Those are not drift and cannot be repaired
by replaying anything; they are simply money whose destination was never
recorded.  Listing them is the honest alternative to guessing.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from accounts.models import Branch
from finance import services


class Command(BaseCommand):
    help = "Verify that cached account balances match the cash book."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--branch", help="Branch code to check (default: all).")
        parser.add_argument("--fix", action="store_true", help="Reconcile the drift found.")
        parser.add_argument("--reason", default="", help="Required with --fix.")
        parser.add_argument(
            "--skip-unposted",
            action="store_true",
            help="Only check cache/ledger drift, not events that posted nothing.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        branch = None
        if options["branch"]:
            branch = Branch.objects.filter(code=options["branch"]).first()
            if branch is None:
                raise CommandError(f"No branch with code {options['branch']!r}.")

        issues = services.verify_integrity(branch=branch)

        if issues:
            self.stdout.write(
                self.style.ERROR(f"{len(issues)} account(s) drifted from the cash book:")
            )
            for issue in issues:
                self.stdout.write(
                    f"  {issue.account_name:<28} @ {issue.branch_code:<6} "
                    f"cached={issue.cached_balance} ledger={issue.ledger_balance} "
                    f"(drift {issue.drift:+})"
                )
        else:
            self.stdout.write(self.style.SUCCESS("Accounts are consistent with the cash book."))

        if not options["skip_unposted"]:
            self._report_unposted(branch)

        if not issues:
            return

        if not options["fix"]:
            self.stdout.write(
                "\nRun again with --fix --reason '...' to reconcile. "
                "Investigate the cause first: drift means something wrote a "
                "balance outside finance.services."
            )
            return

        if not options["reason"].strip():
            raise CommandError("--fix requires --reason.")

        for issue in issues:
            services.repair_drift(issue=issue, reason=options["reason"])
        self.stdout.write(self.style.SUCCESS(f"Reconciled {len(issues)} account(s)."))

    def _report_unposted(self, branch: Branch | None) -> None:
        """Money events that never named an account.

        Imported here rather than at module scope so that ``finance`` itself
        keeps no dependency on ``orders`` or ``purchasing``; this command is
        the composition point, not the app.
        """
        from orders.models import Payment, PaymentState, Refund, RefundStatus
        from purchasing.models import SupplierPayment

        captured = [PaymentState.CAPTURED, PaymentState.PARTIALLY_REFUNDED, PaymentState.REFUNDED]
        payments = Payment.objects.filter(account__isnull=True, status__in=captured)
        refunds = Refund.objects.filter(account__isnull=True, status=RefundStatus.COMPLETED)
        supplier_payments = SupplierPayment.objects.filter(account__isnull=True)

        if branch is not None:
            payments = payments.filter(order__branch=branch)
            refunds = refunds.filter(order__branch=branch)
            supplier_payments = supplier_payments.filter(purchase_order__branch=branch)

        rows = [
            ("captured payments", payments.count()),
            ("completed refunds", refunds.count()),
            ("supplier payments", supplier_payments.count()),
        ]
        total = sum(count for _, count in rows)
        if not total:
            self.stdout.write(self.style.SUCCESS("Every money event names an account."))
            return

        self.stdout.write(
            self.style.WARNING(
                f"\n{total} money event(s) posted nothing to any account "
                "(no account existed for that method at the time):"
            )
        )
        for label, count in rows:
            if count:
                self.stdout.write(f"  {count:>6}  {label}")
        self.stdout.write(
            "  These cannot be repaired by replaying the ledger -- the money's "
            "destination was never recorded. Open the accounts you need so that "
            "future events post, and treat the figures above as a known gap."
        )
