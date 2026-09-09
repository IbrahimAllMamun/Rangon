"""Store every customer phone number one way: `8801XXXXXXXXX`.

Identity is phone-first (docs/business-rules.md §6), and nothing normalised the
number.  `phone` is `unique=True` on the raw string, so `01712345678` and
`+8801712345678` were two rows for one person: their order history split, and
lifetime spend, loyalty and the party ledger all under-reported (D48).

Three things happen here, in order.

1. A number that is not a Bangladeshi mobile in any spelling cannot be
   canonicalised.  It is moved into `notes` and the field cleared, rather than
   left to fail validation the next time anyone edits that customer.  Nothing
   is thrown away.
2. Customers whose numbers canonicalise to the same subscriber are one person,
   so they are merged.  The oldest row survives, everything pointing at the
   others is repointed at it (CLAUDE.md §3 — orders are never deleted), and the
   duplicates are retired: deactivated, their number released, and a note
   saying where their history went.
3. Every surviving number, and every address contact number, is rewritten in
   canonical form.

`core.phone.canonical` is imported rather than copied on purpose.  It is a pure
string function, and a migration that disagreed with the model about what
"canonical" means would leave the table in a state the model then refuses to
write.  One definition, one answer.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations

from core.phone import canonical, normalize_if_mobile

#: Everything that can point at a Customer as of this migration.  `Wishlist` is
#: absent deliberately: it is a OneToOne and is handled on its own below.
CUSTOMER_REFERENCES = (
    ("orders", "Order", "customer"),
    ("orders", "Cart", "customer"),
    ("orders", "HeldSale", "customer"),
    ("promotions", "CouponRedemption", "customer"),
    ("customers", "CustomerAddress", "customer"),
    ("customers", "CustomerNote", "customer"),
    # `Review` is unique per (product, customer, order).  Two rows for one
    # person can only collide here if both reviewed the same product with no
    # order attached, which needs a human to resolve, so a collision raises
    # rather than quietly dropping somebody's review.
    ("engagement", "Review", "customer"),
)


def _append_note(existing: str, line: str, *, limit: int | None = None) -> str:
    note = f"{existing}\n{line}".strip() if existing else line
    return note[:limit] if limit else note


def canonicalise_phone_numbers(apps, schema_editor):
    Customer = apps.get_model("customers", "Customer")
    CustomerAddress = apps.get_model("customers", "CustomerAddress")
    Wishlist = apps.get_model("engagement", "Wishlist")

    # --- 1. Group every customer by the subscriber their number resolves to.
    groups: dict[str, list] = {}
    for customer in (
        Customer.objects.exclude(phone=None).exclude(phone="").order_by("created_at", "id")
    ):
        number = canonical(customer.phone)
        if number is None:
            # Not a Bangladeshi mobile in any spelling.  Keep the digits where
            # a human can read them and free the field.
            Customer.objects.filter(pk=customer.pk).update(
                phone=None,
                notes=_append_note(
                    customer.notes,
                    f"Phone number on file could not be read as a Bangladeshi "
                    f"mobile and was cleared: {customer.phone}",
                ),
            )
            continue
        groups.setdefault(number, []).append(customer)

    # --- 2 and 3. Merge the rows that are one person, then canonicalise.
    for number, rows in groups.items():
        # Oldest wins: it carries the longest history.  `id` only breaks a tie.
        survivor, losers = rows[0], rows[1:]

        for loser in losers:
            for app_label, model_name, field in CUSTOMER_REFERENCES:
                model = apps.get_model(app_label, model_name)
                model._default_manager.filter(**{field: loser.pk}).update(**{field: survivor.pk})

            # A wishlist is a convenience, not a record.  Merging two of them
            # item by item is a product decision rather than a data fix, so the
            # survivor keeps theirs and the duplicate's stays on the retired
            # row where it can still be read.
            if not Wishlist._default_manager.filter(customer=survivor.pk).exists():
                Wishlist._default_manager.filter(customer=loser.pk).update(customer=survivor.pk)

            survivor.total_orders += loser.total_orders
            survivor.total_spent += loser.total_spent or Decimal("0.00")
            survivor.loyalty_points += loser.loyalty_points
            if loser.last_order_at and (
                survivor.last_order_at is None or loser.last_order_at > survivor.last_order_at
            ):
                survivor.last_order_at = loser.last_order_at

            # Retired, not deleted: the row keeps its id so anything holding one
            # externally still resolves, and it says where the history went.
            Customer.objects.filter(pk=loser.pk).update(
                phone=None,
                is_active=False,
                notes=_append_note(
                    loser.notes,
                    f"Merged into customer {survivor.pk} ({survivor.name}): the same "
                    f"number was on file twice, as {loser.phone} and {survivor.phone}.",
                ),
            )

        if losers:
            survivor.notes = _append_note(
                survivor.notes,
                f"Absorbed {len(losers)} duplicate record(s) filed under other "
                f"spellings of {number}.",
            )

        Customer.objects.filter(pk=survivor.pk).update(
            phone=number,
            notes=survivor.notes,
            total_orders=survivor.total_orders,
            total_spent=survivor.total_spent,
            loyalty_points=survivor.loyalty_points,
            last_order_at=survivor.last_order_at,
        )

    # --- Delivery contact numbers, which are matched against the above.
    for address in CustomerAddress.objects.exclude(phone=""):
        number = canonical(address.phone)
        if number == address.phone:
            continue
        if number is None:
            CustomerAddress.objects.filter(pk=address.pk).update(
                phone="",
                notes=_append_note(
                    address.notes,
                    f"Unreadable contact number cleared: {address.phone}",
                    limit=255,
                ),
            )
        else:
            CustomerAddress.objects.filter(pk=address.pk).update(phone=number)


#: Contact numbers that are not an identity.  A branch, a supplier or the
#: organization itself may publish a landline or a short hotline, so these are
#: rewritten only when they are recognisably a mobile, and left alone otherwise.
CONTACT_NUMBERS = (
    ("accounts", "User"),
    ("accounts", "Branch"),
    ("accounts", "Organization"),
    ("purchasing", "Supplier"),
    ("shipping", "Courier"),
)


def canonicalise_contact_numbers(apps, schema_editor):
    """Make the rest of the database agree with the customer table.

    A supplier's mobile and a customer's mobile are the same kind of thing, and
    a staff member's number is copied onto their customer record at
    registration.  Leaving these in whatever spelling they were typed in would
    reintroduce, one field at a time, the mismatch this migration exists to
    remove.
    """
    for app_label, model_name in CONTACT_NUMBERS:
        model = apps.get_model(app_label, model_name)
        for row in model._default_manager.exclude(phone="").only("pk", "phone").iterator():
            number = normalize_if_mobile(row.phone)
            if number != row.phone:
                model._default_manager.filter(pk=row.pk).update(phone=number)


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0003_one_walk_in_customer_per_branch"),
        # The merge repoints rows in these apps, so their tables must exist.
        ("engagement", "0002_initial"),
        ("orders", "0004_order_tax_mode"),
        ("promotions", "0002_free_shipping_carries_no_value"),
        # Contact numbers elsewhere are rewritten in the same pass.
        ("accounts", "0001_initial"),
        ("purchasing", "0001_initial"),
        ("shipping", "0001_initial"),
    ]

    operations = [
        # Neither a merge nor a normalisation can be undone: the spellings the
        # rows were written with are gone once they agree.
        migrations.RunPython(canonicalise_phone_numbers, migrations.RunPython.noop),
        migrations.RunPython(canonicalise_contact_numbers, migrations.RunPython.noop),
    ]
