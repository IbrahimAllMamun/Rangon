"""One walk-in customer per branch.

The contract half of the expand/contract begun in `0002`, which merged the
duplicates an unconstrained database may already hold.  Separate migrations on
purpose: Django runs each in a single transaction, and PostgreSQL refuses to
`CREATE INDEX` on a table still carrying pending foreign key trigger events
from `0002`'s repointing.

Partial, so ordinary customers may still share a name — only the branch's
anonymous counter row is unique.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0002_merge_duplicate_walk_in_customers"),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="customer",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_walk_in", True)),
                fields=("is_walk_in", "name"),
                name="customers_customer_walk_in_name_uniq",
            ),
        ),
    ]
