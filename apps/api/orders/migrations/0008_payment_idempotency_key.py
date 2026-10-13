"""The `Idempotency-Key` of the staff request that recorded a payment (D167).

`POST /orders/<id>/payments/` took no key, so the same request sent twice was
the money twice. The key is claimed on the payment row, as it is on a refund,
an order and a ledger entry: the unique index is what makes a second request
with the same key lose, and the service turns that loss into the first one's
payment.

Additive and nullable: every payment taken another way -- at the counter, at
checkout, by a gateway -- carries no key, and PostgreSQL's unique index ignores
NULLs. Safe to apply under the running API, which neither reads nor writes
the column until it is upgraded.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("orders", "0007_one_order_for_the_lines_of_a_document"),
    ]

    operations = [
        migrations.AddField(
            model_name="payment",
            name="idempotency_key",
            field=models.CharField(blank=True, max_length=80, null=True, unique=True),
        ),
    ]
