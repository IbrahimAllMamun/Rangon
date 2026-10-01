"""Attributes, values and size charts for the attribute admin (phase 4).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_attributes.py

All or nothing, and a second run finds the marker attribute and stops. Test
data for the parity database only. Nothing here is filterable or used by a
published product, so no storefront answer changes. What each row is for:
- "Parity Order": four values all at position 0, as the seed leaves them --
  `move` renumbers the run; no variant, specification or chart uses it, so a
  delete succeeds and takes its values and its category link with it.
- "Parity Fit Size": a Size attribute with a chart and no variants -- a
  delete is refused for the chart, a kind change too, and its values are
  refused for being in that chart.
- "Parity kids": a chart no product uses, so a delete succeeds.
- "Parity Teal": a colour whose variant has gone, with a photograph still
  grouped under it -- deleting the value clears the image's colour
  (`SET_NULL`) rather than the image.
"""

from django.db import transaction

from catalog.models import (
    Attribute,
    AttributeValue,
    Category,
    CategoryAttribute,
    Product,
    ProductImage,
)
from catalog.services import save_size_chart

MARKER = "parity-order"


def apply() -> None:
    order = Attribute.objects.create(
        name="Parity Order",
        code=MARKER,
        kind="TEXT",
        is_variant_defining=False,
        is_filterable=False,
        position=50,
    )
    for value in ("d", "b", "a", "c"):
        AttributeValue.objects.create(attribute=order, value=value)
    CategoryAttribute.objects.create(category=Category.objects.get(slug="parity-doomed"), attribute=order)

    fit = Attribute.objects.create(
        name="Parity Fit Size",
        code="parity-fit-size",
        kind="SIZE",
        is_variant_defining=True,
        is_filterable=False,
        position=51,
    )
    petite = AttributeValue.objects.create(attribute=fit, value="Petite", position=0)
    tall = AttributeValue.objects.create(attribute=fit, value="Tall", position=1)
    save_size_chart(
        attribute=fit,
        data={
            "name": "Parity fit",
            "columns": ["Height (cm)"],
            "rows": [
                {"attribute_value": petite.pk, "cells": ["150"]},
                {"attribute_value": tall.pk, "cells": ["185"]},
            ],
        },
    )

    size = Attribute.objects.get(code="size")
    xs = AttributeValue.objects.get(attribute=size, value="XS")
    save_size_chart(
        attribute=size,
        data={
            "name": "Parity kids",
            "system": "Kids",
            "columns": ["Age", "Chest (cm)"],
            "rows": [{"attribute_value": xs.pk, "cells": ["4-5", "56"]}],
            "notes": "Measure loosely.",
        },
    )

    teal = AttributeValue.objects.create(
        attribute=Attribute.objects.get(code="color"), value="Parity Teal", swatch="#008080", position=20
    )
    # The state a variant's hard delete leaves: the photograph keeps its colour.
    ProductImage.objects.create(
        product=Product.objects.get(slug="parity-draft"),
        attribute_value=teal,
        image="products/parity teal.jpg",
    )


if Attribute.objects.filter(code=MARKER).exists():
    print("parity attributes fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity attributes fixture applied")
