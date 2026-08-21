"""Bind product images to a colour instead of a variant — expand step.

`ProductImage.variant` existed from the start and was never read: the storefront
payload emitted it and `ProductGallery` ignored it.  It is *replaced* rather
than supplemented, so there is never an ambiguous precedence between two
nullable foreign keys (docs/architecture/product-media.md §2).

Expand/contract (CLAUDE.md §6): this migration adds the new column and moves
whatever the old one held; 0003 drops the old column.  Between the two, both
exist and no photograph can be lost.
"""

import django.db.models.deletion
from django.db import migrations, models


def backfill_colour(apps, schema_editor):
    """Each image inherits the colour of the variant it was pinned to."""
    ProductImage = apps.get_model("catalog", "ProductImage")
    VariantAttributeValue = apps.get_model("catalog", "VariantAttributeValue")

    colour_by_variant = dict(
        VariantAttributeValue.objects.filter(
            attribute__kind="COLOR", attribute__is_variant_defining=True
        ).values_list("variant_id", "attribute_value_id")
    )
    if not colour_by_variant:
        return

    updates = []
    for image in ProductImage.objects.filter(variant_id__isnull=False).only(
        "id", "variant_id", "attribute_value_id"
    ):
        colour_id = colour_by_variant.get(image.variant_id)
        if colour_id is not None:
            image.attribute_value_id = colour_id
            updates.append(image)
    if updates:
        ProductImage.objects.bulk_update(updates, ["attribute_value_id"], batch_size=500)


def unbackfill(apps, schema_editor):
    """Reverse: the colour column is dropped with the field, so nothing to undo."""


class Migration(migrations.Migration):
    dependencies = [("catalog", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="productimage",
            name="attribute_value",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "The colour this image shows. Blank means it applies to every colour."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="product_images",
                to="catalog.attributevalue",
            ),
        ),
        migrations.AddIndex(
            model_name="productimage",
            index=models.Index(
                fields=["attribute_value", "position"], name="catalog_image_colour_idx"
            ),
        ),
        migrations.RunPython(backfill_colour, unbackfill),
    ]
