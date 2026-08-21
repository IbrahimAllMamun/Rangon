"""Bind product images to a colour instead of a variant — contract step.

Runs after 0002 has copied every pinned variant's colour onto the new column.
Deploy the two together only once 0002 is known to have completed everywhere.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("catalog", "0002_productimage_attribute_value")]

    operations = [
        migrations.RemoveField(model_name="productimage", name="variant"),
    ]
