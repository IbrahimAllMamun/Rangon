"""PostgreSQL extensions the platform depends on.

pg_trgm  — fuzzy product/SKU search (ADR-0007)
btree_gin — composite GIN indexes mixing scalar columns with trigram/vector ones

Kept in its own migration so it runs before anything that indexes with them.
"""

from django.contrib.postgres.operations import BtreeGinExtension, TrigramExtension
from django.db import migrations


class Migration(migrations.Migration):
    initial = True

    dependencies: list = []

    operations = [
        TrigramExtension(),
        BtreeGinExtension(),
    ]
