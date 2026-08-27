"""Seed the expense categories a retail shop needs on day one.

Without these the expenses screen opens empty and unusable: recording an
expense requires a category, and creating a category requires
``finance.manage``, which a branch manager deliberately does not hold.

These are *labels*, not money and not rules.  Each one can be renamed or
retired from ``/admin/expenses``, and the list is deliberately short -- a
category nobody uses is worse than a missing one, because it makes the
category-wise total look like a form to fill in rather than a picture of where
the money went.

Chosen from the expense heads the Bseba ERP audit recorded as actually in use
(docs/planning/bseba-erp-feature-audit.md).
"""

from __future__ import annotations

from django.db import migrations

DEFAULT_CATEGORIES = [
    ("RENT", "Rent", "Shop rent and service charge."),
    ("SALARY", "Salary", "Staff wages, bonuses and overtime."),
    ("UTILITIES", "Utilities", "Electricity, gas, water, internet."),
    ("TRANSPORT", "Transport", "Delivery, courier and travel."),
    ("MARKETING", "Marketing", "Advertising, printing, photography."),
    ("MAINTENANCE", "Maintenance", "Repairs, cleaning, fixtures."),
    ("SUPPLIES", "Office supplies", "Packaging, stationery, consumables."),
    ("BANK_CHARGES", "Bank charges", "Bank fees, MFS cash-out charges."),
    ("OTHER", "Other", "Anything the heads above do not cover."),
]


def create_default_categories(apps, schema_editor):
    ExpenseCategory = apps.get_model("finance", "ExpenseCategory")
    for code, name, description in DEFAULT_CATEGORIES:
        if ExpenseCategory.objects.filter(code=code).exists():
            continue
        ExpenseCategory.objects.create(
            code=code, name=name, description=description, is_active=True
        )


def remove_default_categories(apps, schema_editor):
    """Reverse only the categories nothing was ever filed under.

    A category with expenses against it is part of those expenses' history, so
    it stays -- a reverse migration must not re-label a cash book.
    """
    ExpenseCategory = apps.get_model("finance", "ExpenseCategory")
    ExpenseCategory.objects.filter(
        code__in=[code for code, _, _ in DEFAULT_CATEGORIES], expenses__isnull=True
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("finance", "0003_expensecategory_expense"),
    ]

    operations = [
        migrations.RunPython(create_default_categories, remove_default_categories),
    ]
