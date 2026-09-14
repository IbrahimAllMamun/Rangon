"""Make a supplier payment idempotent on the caller's key.

The unique index serves exactly one query, in
``purchasing.services.record_supplier_payment``::

    SupplierPayment.objects.filter(idempotency_key=key).first()

which runs before any money moves, so a retried or double-clicked payment
returns the row already written instead of paying the supplier twice
(CLAUDE.md §7).  Nullable because history carries no key, and a unique index
in PostgreSQL ignores NULLs -- so the old rows coexist with the constraint.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("purchasing", "0002_supplierpayment_account"),
    ]

    operations = [
        migrations.AddField(
            model_name="supplierpayment",
            name="idempotency_key",
            field=models.CharField(blank=True, max_length=80, null=True, unique=True),
        ),
    ]
