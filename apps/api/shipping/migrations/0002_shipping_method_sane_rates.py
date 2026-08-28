"""Two constraints a shipping method should always have satisfied.

Both of these were reachable through the API, so unlike promotions/0002 (which
only widened a rule) these *tighten* one, and a database written before today
may hold rows that violate them. `AddConstraint` fails outright against such a
row, so each is repaired first.

- `free_over` below zero. `ShippingMethod.price_for()` returns 0 whenever
  `subtotal >= free_over`, so a negative threshold is satisfied by every order
  and all shipping silently becomes free. Repaired to NULL, which is the field's
  "no free-shipping offer" value: it stops the giveaway rather than inventing a
  threshold nobody chose.

- `max_days` before `min_days`, which renders to a shopper as "5–2 days".
  Repaired by widening `max_days` to `min_days`, giving the single-day estimate
  the method most likely meant.

Both repairs are reported in the migration output rather than done silently: if
a real rate was wrong, somebody needs to know it changed. There is no reverse
repair — the old values were invalid, and restoring them would only re-break the
rows — so the reverse simply drops the constraints.
"""

from decimal import Decimal

from django.db import migrations, models


def repair_invalid_rates(apps, schema_editor):
    ShippingMethod = apps.get_model("shipping", "ShippingMethod")

    giveaways = ShippingMethod.objects.filter(free_over__lt=Decimal("0.00"))
    for method in giveaways:
        print(
            f"  shipping: {method.name} had free_over={method.free_over} "
            f"(every order shipped free) — cleared to NULL"
        )
    giveaways.update(free_over=None)

    backwards = ShippingMethod.objects.filter(max_days__lt=models.F("min_days"))
    for method in backwards:
        print(
            f"  shipping: {method.name} had min_days={method.min_days} "
            f"max_days={method.max_days} — max_days widened to {method.min_days}"
        )
    backwards.update(max_days=models.F("min_days"))


def noop(apps, schema_editor):
    """The pre-repair values were invalid; there is nothing to restore."""


class Migration(migrations.Migration):
    dependencies = [
        ("shipping", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(repair_invalid_rates, noop),
        migrations.AddConstraint(
            model_name="shippingmethod",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("free_over__isnull", True),
                    ("free_over__gte", Decimal("0.00")),
                    _connector="OR",
                ),
                name="shipping_method_free_over_gte_0",
            ),
        ),
        migrations.AddConstraint(
            model_name="shippingmethod",
            constraint=models.CheckConstraint(
                condition=models.Q(("max_days__gte", models.F("min_days"))),
                name="shipping_method_days_ordered",
            ),
        ),
    ]
