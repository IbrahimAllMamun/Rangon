"""One courier cannot issue one tracking number to two parcels.

Conditional on a non-blank number, because the number arrives *after* the
booking does: a parcel waiting for its courier reference is the normal case,
and blanks must not collide with each other.

Backs `shipping.services.create_shipment`, which checks first for a readable
error and catches the `IntegrityError` for the race it cannot check away. Also
what stops a double-clicked fulfilment form writing two parcels.
"""


from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('orders', '0005_abandonedcheckout'),
        ('shipping', '0002_shipping_method_sane_rates'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddConstraint(
            model_name='shipment',
            constraint=models.UniqueConstraint(condition=models.Q(('tracking_number', ''), _negated=True), fields=('courier', 'tracking_number'), name='shipping_shipment_courier_tracking_uniq'),
        ),
    ]
