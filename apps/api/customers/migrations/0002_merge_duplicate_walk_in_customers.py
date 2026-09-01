"""Collapse duplicate walk-in customers, then make that row unique per branch.

`orders.services.pos.walk_in_customer()` resolves the branch's anonymous
counter customer with `get_or_create(is_walk_in=True, name="Walk-in (<code>)")`.
`get_or_create` is only atomic when a unique constraint backs the lookup, and
there was none: two simultaneous counter sales both missed the SELECT, both
INSERTed, and from then on *every* anonymous sale at that branch raised
`MultipleObjectsReturned`.

Expand/contract, in two migrations.  This one merges the duplicates a
database may already hold; `0003` adds the constraint that stops new ones.
They cannot share a migration: Django runs each in a single transaction, and
PostgreSQL refuses to `CREATE INDEX` on a table that still has pending foreign
key trigger events from the repointing done here ("cannot CREATE INDEX ...
because it has pending trigger events").

Orders are repointed at the survivor, never deleted (CLAUDE.md §3); only the
redundant customer row goes.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations, models

#: Everything that can point at a Customer as of this migration.  A duplicate
#: only ever reached `Order.customer` in practice — the rest are here so the
#: merge stays correct if one was reached some other way.  `Wishlist.customer`
#: is a OneToOne and `Review` is unique per (product, customer, order), so a
#: real collision raises rather than silently dropping a row; that needs a
#: human, and a walk-in row cannot own either without a storefront login.
CUSTOMER_REFERENCES = (
    ("orders", "Order", "customer"),
    ("orders", "Cart", "customer"),
    ("orders", "HeldSale", "customer"),
    ("promotions", "CouponRedemption", "customer"),
    ("customers", "CustomerAddress", "customer"),
    ("customers", "CustomerNote", "customer"),
    ("engagement", "Wishlist", "customer"),
    ("engagement", "Review", "customer"),
)


def collapse_duplicate_walk_ins(apps, schema_editor):
    Customer = apps.get_model("customers", "Customer")

    duplicated_names = [
        row["name"]
        # `.order_by()` clears Meta.ordering, which would otherwise join the
        # GROUP BY and make every row its own group.
        for row in Customer.objects.filter(is_walk_in=True)
        .order_by()
        .values("name")
        .annotate(rows=models.Count("id"))
        .filter(rows__gt=1)
    ]

    for name in duplicated_names:
        # Oldest wins: it is the row the branch has been selling against
        # longest, so it carries the most history.  `id` only breaks a tie.
        rows = list(
            Customer.objects.filter(is_walk_in=True, name=name).order_by("created_at", "id")
        )
        survivor, losers = rows[0], rows[1:]
        loser_ids = [row.pk for row in losers]

        for app_label, model_name, field in CUSTOMER_REFERENCES:
            model = apps.get_model(app_label, model_name)
            model._default_manager.filter(**{f"{field}__in": loser_ids}).update(
                **{field: survivor.pk}
            )

        # The counter sales were split across the duplicates, so the survivor
        # absorbs their lifetime figures.  (`_touch_customer` skips walk-in
        # rows today, so these are normally all zero.)
        survivor.total_orders += sum(row.total_orders for row in losers)
        survivor.total_spent += sum((row.total_spent for row in losers), Decimal("0.00"))
        survivor.loyalty_points += sum(row.loyalty_points for row in losers)
        order_dates = [row.last_order_at for row in rows if row.last_order_at is not None]
        survivor.last_order_at = max(order_dates) if order_dates else None
        survivor.save(
            update_fields=["total_orders", "total_spent", "loyalty_points", "last_order_at"]
        )

        Customer.objects.filter(pk__in=loser_ids).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0001_initial"),
        # The merge repoints rows in these apps, so their tables must exist.
        ("engagement", "0002_initial"),
        ("orders", "0004_order_tax_mode"),
        ("promotions", "0002_free_shipping_carries_no_value"),
    ]

    operations = [
        # A merge cannot be un-merged, so the reverse is a no-op.
        migrations.RunPython(collapse_duplicate_walk_ins, migrations.RunPython.noop),
    ]
