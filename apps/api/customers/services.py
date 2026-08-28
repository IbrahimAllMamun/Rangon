"""Customer engine -- the only code allowed to write a customer's addresses.

There is exactly one rule here worth a service layer, and it is the default
address.  `CustomerAddress.Meta.ordering` is `("-is_default", "-created_at")`,
so every caller that takes `addresses.first()` -- checkout's pre-selected
address among them -- is really asking "which one is the default?".  If two
rows carry `is_default=True` that question has no answer, and the shipping
address a customer sees pre-filled becomes whichever row PostgreSQL felt like
returning.

So the invariant is: **at most one default address per customer**, and it is
enforced by locking the customer's address rows and demoting the others in the
same transaction, not by hoping callers behave.

docs/business-rules.md section 6 - CLAUDE.md section 4
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from accounts.models import User
from core import audit
from core.exceptions import ValidationError
from core.models import AuditAction
from customers.models import Customer, CustomerAddress, CustomerNote

# Written on every address mutation so the audit trail shows the whole row.
ADDRESS_FIELDS = [
    "label",
    "address_type",
    "recipient_name",
    "phone",
    "line1",
    "line2",
    "area",
    "city",
    "district",
    "postal_code",
    "country",
    "is_default",
    "notes",
]


def _demote_other_defaults(customer: Customer, keep: CustomerAddress) -> None:
    """Clear `is_default` on every other address belonging to this customer."""
    (
        CustomerAddress.objects.filter(customer=customer, is_default=True)
        .exclude(pk=keep.pk)
        .update(is_default=False)
    )


@transaction.atomic
def add_address(
    *,
    customer: Customer,
    data: dict[str, Any],
    actor: User | None = None,
) -> CustomerAddress:
    """Create an address, holding the one-default-per-customer invariant.

    The first address a customer ever gets is made the default whatever the
    caller asked for: a customer with addresses but no default is a customer
    checkout cannot pre-fill, which is the bug this function exists to stop.
    """
    # Lock the customer so two concurrent "make this the default" requests
    # cannot both read "no default exists" and both write one.
    locked = Customer.objects.select_for_update().get(pk=customer.pk)

    wants_default = bool(data.get("is_default"))
    is_first = not CustomerAddress.objects.filter(customer=locked).exists()

    address = CustomerAddress.objects.create(
        customer=locked, **{**data, "is_default": wants_default or is_first}
    )
    if address.is_default:
        _demote_other_defaults(locked, keep=address)

    audit.record(
        action=AuditAction.CREATE,
        entity=address,
        actor=actor,
        new_values=audit.snapshot(address, ADDRESS_FIELDS),
        reason="Customer address added",
    )
    return address


@transaction.atomic
def update_address(
    *,
    address: CustomerAddress,
    data: dict[str, Any],
    actor: User | None = None,
) -> CustomerAddress:
    """Edit an address in place, holding the same invariant.

    Note that editing an address never rewrites an order: orders store a frozen
    `as_snapshot()` copy taken at checkout (CLAUDE.md section 3.3).
    """
    locked = Customer.objects.select_for_update().get(pk=address.customer_id)
    before = audit.snapshot(address, ADDRESS_FIELDS)

    for field, value in data.items():
        setattr(address, field, value)

    # Refusing to un-default the only default keeps every customer that has
    # addresses having exactly one, rather than sometimes none.
    if before["is_default"] and not address.is_default:
        others = CustomerAddress.objects.filter(customer=locked).exclude(pk=address.pk)
        if not others.exists():
            raise ValidationError(
                "This is the only address on file, so it stays the default. "
                "Add another address and make that one the default instead."
            )
        address.is_default = True

    address.save()
    if address.is_default:
        _demote_other_defaults(locked, keep=address)

    old, new = audit.diff(before, audit.snapshot(address, ADDRESS_FIELDS))
    if new:
        audit.record(
            action=AuditAction.UPDATE,
            entity=address,
            actor=actor,
            old_values=old,
            new_values=new,
            reason="Customer address updated",
        )
    return address


@transaction.atomic
def delete_address(*, address: CustomerAddress, actor: User | None = None) -> None:
    """Remove an address, promoting a replacement default if this was it.

    Addresses are genuinely deleted rather than soft-deleted: they are contact
    details, not a financial record, and the orders that used one already hold
    their own frozen copy.
    """
    locked = Customer.objects.select_for_update().get(pk=address.customer_id)
    was_default = address.is_default
    before = audit.snapshot(address, ADDRESS_FIELDS)
    address_pk = str(address.pk)

    audit.record(
        action=AuditAction.DELETE,
        entity=address,
        actor=actor,
        old_values=before,
        reason="Customer address deleted",
    )
    address.delete()

    if was_default:
        # `Meta.ordering` puts the newest first once no row claims default.
        replacement = CustomerAddress.objects.filter(customer=locked).first()
        if replacement is not None:
            replacement.is_default = True
            replacement.save(update_fields=["is_default", "updated_at"])
            audit.record(
                action=AuditAction.UPDATE,
                entity=replacement,
                actor=actor,
                old_values={"is_default": False},
                new_values={"is_default": True},
                reason=f"Promoted to default after address {address_pk} was deleted",
            )


@transaction.atomic
def add_note(
    *,
    customer: Customer,
    body: str,
    is_pinned: bool = False,
    actor: User | None = None,
) -> CustomerNote:
    """Attach a note to a customer."""
    body = body.strip()
    if not body:
        raise ValidationError("A note cannot be empty.")

    note = CustomerNote.objects.create(
        customer=customer, body=body, is_pinned=is_pinned, created_by=actor
    )
    audit.record(
        action=AuditAction.CREATE,
        entity=note,
        actor=actor,
        new_values={"body": note.body, "is_pinned": note.is_pinned},
        reason="Customer note added",
    )
    return note


@transaction.atomic
def delete_note(*, note: CustomerNote, actor: User | None = None) -> None:
    """Remove a note. Notes are staff commentary, not a financial record."""
    audit.record(
        action=AuditAction.DELETE,
        entity=note,
        actor=actor,
        old_values={"body": note.body, "is_pinned": note.is_pinned},
        reason="Customer note deleted",
    )
    note.delete()
