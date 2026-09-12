"""Abandoned checkout leads.

A shopper types a phone number into checkout and then does not finish. For a
cash-on-delivery shop that is not a lost sale yet -- it is a phone call someone
can make this afternoon -- but only if the number was kept at the moment it was
typed, which is before the order exists and before the rest of the form is
known to be valid.

Two rules shape everything here:

  **The lead is keyed by the person, not the attempt.** One open lead per phone
  number. A shopper who abandons twice before lunch is one call to make. The
  row is updated in place while it is `OPEN`; the uniqueness is conditional on
  that status, so a recovered lead stays as history and a later abandonment
  opens a fresh row.

  **Capturing must never be able to break checkout.** This runs from a public
  endpoint on every keystroke-ish event the storefront decides to send. It is
  not part of the order transaction, it holds no stock, and a failure here is
  swallowed -- a missed lead is a missed phone call, and an exception is a
  shopper who cannot buy.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from core.phone import canonical
from orders.models import AbandonedCheckout, AbandonedCheckoutStatus, Cart, Order

logger = logging.getLogger(__name__)


def capture(
    *,
    phone: str,
    branch: Any,
    cart: Cart | None = None,
    name: str = "",
    email: str = "",
    cart_total: Decimal | None = None,
    item_count: int | None = None,
) -> AbandonedCheckout | None:
    """Record, or refresh, an open lead for this phone number.

    Returns `None` when the number is not a mobile we could ring, which is the
    only reason to hold a lead at all. A landline, a half-typed number or a
    blank field are all "not yet", not an error -- the storefront sends this
    while the shopper is still typing.
    """
    digits = canonical(phone)
    if not digits:
        return None

    # Only what was on the screen. Re-pricing here would let a lead disagree
    # with the basket the shopper walked away from, which is the one number the
    # person making the call needs to be looking at.
    totals = {
        "cart_total": cart_total if cart_total is not None else Decimal("0.00"),
        "item_count": item_count or 0,
    }

    defaults = {
        "branch": branch,
        "cart": cart,
        "customer": getattr(cart, "customer", None),
        "name": (name or "").strip()[:120],
        "email": (email or "").strip()[:254],
        "last_seen_at": timezone.now(),
        **totals,
    }

    try:
        with transaction.atomic():
            lead, created = AbandonedCheckout.objects.select_for_update().get_or_create(
                phone=digits,
                status=AbandonedCheckoutStatus.OPEN,
                defaults=defaults,
            )
            if not created:
                # Keep a name and email once given: the shopper may clear a
                # field on a second pass, and losing the name would make the
                # call-back list worse than it was a minute ago.
                for field, value in defaults.items():
                    if field in {"name", "email"} and not value:
                        continue
                    setattr(lead, field, value)
                lead.save(update_fields=[*defaults.keys(), "updated_at"])
            return lead
    except IntegrityError:
        # Two tabs, same number, same instant. The constraint did its job; the
        # row the other request wrote is as good as the one this would have.
        logger.info("abandoned-checkout capture raced for %s", digits)
        return AbandonedCheckout.objects.filter(
            phone=digits, status=AbandonedCheckoutStatus.OPEN
        ).first()


def recover_for_order(order: Order) -> AbandonedCheckout | None:
    """Close the open lead this order answers, if there is one.

    Called after an order is created. Matching is on the canonical subscriber
    digits of whatever the order was placed with -- the customer's stored
    number first, then the shipping snapshot -- so the lead a shopper opened
    while typing `01712…` is closed by an order placed as `+8801712…`.
    """
    for candidate in (
        getattr(order.customer, "phone", None),
        (order.shipping_address or {}).get("phone"),
    ):
        digits = canonical(candidate)
        if not digits:
            continue
        lead = AbandonedCheckout.objects.filter(
            phone=digits, status=AbandonedCheckoutStatus.OPEN
        ).first()
        if lead is None:
            continue
        lead.status = AbandonedCheckoutStatus.RECOVERED
        lead.recovered_at = timezone.now()
        lead.recovered_order = order
        lead.save(update_fields=["status", "recovered_at", "recovered_order", "updated_at"])
        return lead
    return None


def mark_lost(*, lead: AbandonedCheckout, note: str = "") -> AbandonedCheckout:
    """Write a lead off, so it leaves the call-back list without being deleted.

    Deleting would lose the one thing the list is for -- knowing how many leads
    were chased and how many turned into orders.
    """
    lead.status = AbandonedCheckoutStatus.LOST
    if note:
        lead.note = note
    lead.save(update_fields=["status", "note", "updated_at"])
    return lead
