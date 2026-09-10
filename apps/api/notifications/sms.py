"""Sending an SMS, and knowing what it cost.

Identity in this shop is phone-first (`docs/business-rules.md` §6) precisely
because many customers have no email. Until now those customers were told
nothing — not when the order was confirmed, not when it shipped — while the
email path quietly returned "no-email" and moved on. For cash on delivery that
is a failed delivery waiting to happen: nobody is home, the rider leaves, and
the shop eats the trip.

## What is here and what is not

This module is the whole SMS layer *except the last mile*. Choosing a gateway
needs an account, a sender-ID approval and a budget, none of which is code. So
the provider is an interface (`providers/base.py`) with a no-op implementation
(`providers/console.py`), and the real one is a class and a settings line
whenever it arrives.

## Two guards, both about money

**Segments.** A GSM-7 message is 160 characters; the moment one Bengali
character appears the encoding becomes UCS-2 and the limit drops to **70**. A
chatty Bengali message is three charges, not one, and nothing in the response
says so. `segments()` makes that visible, `SmsMessage.segments` records it, and
there is a test asserting every template here fits one part.

**The allowlist.** A test send reaches a real person and costs real money.
Outside production `SMS_ALLOWLIST` names who may be texted, and everybody else
is recorded as `SUPPRESSED` rather than sent. Without it a `seed_demo --reset`
on a staging box texts every customer in the fixture.

Nothing in here may fail a sale: `CLAUDE.md` §4 puts the invariant in the
service, never in the task, and every caller goes through Celery on commit.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.utils import timezone

from core import phone as phone_utils
from notifications.models import SmsMessage, SmsStatus
from notifications.providers.base import ProviderNotConfigured
from notifications.registry import get_provider

logger = logging.getLogger("rangon.sms")

#: The GSM-7 alphabet an SMS can hold 160 of. Anything outside it — a Bengali
#: character, a curly quote pasted from a word processor, an emoji — forces the
#: whole message to UCS-2 and cuts the limit to 70.
GSM7 = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
#: These cost two GSM-7 characters each, not one.
GSM7_EXTENDED = set("^{}\\[~]|€")

SINGLE_GSM7 = 160
MULTI_GSM7 = 153  # a concatenated part loses 7 characters to the header
SINGLE_UCS2 = 70
MULTI_UCS2 = 67


def is_gsm7(body: str) -> bool:
    return all(character in GSM7 or character in GSM7_EXTENDED for character in body)


def segments(body: str) -> int:
    """How many messages the gateway will actually bill for."""
    if not body:
        return 0
    if is_gsm7(body):
        length = sum(2 if character in GSM7_EXTENDED else 1 for character in body)
        single, multi = SINGLE_GSM7, MULTI_GSM7
    else:
        length = len(body)
        single, multi = SINGLE_UCS2, MULTI_UCS2
    if length <= single:
        return 1
    return -(-length // multi)  # ceiling division


def _may_send_to(number: str) -> bool:
    """Production texts anybody; anywhere else, only the allowlist.

    An empty allowlist off production means nobody, which is the safe default:
    a staging box that has not been told who to text should text no one.
    """
    if settings.RANGON["SMS_LIVE"]:
        return True
    allowed = {
        phone_utils.canonical(entry) or entry.strip() for entry in settings.RANGON["SMS_ALLOWLIST"]
    }
    return number in allowed


def send_sms(
    *,
    to: Any,
    body: str,
    notification_type: str = "",
    order_number: str = "",
) -> SmsMessage:
    """Send one message and record it, whatever happens.

    Returns the log row rather than a bare success flag: the caller is a Celery
    task that wants to know *why* something did not send, and the row is what a
    person looking for the same answer next week will read.

    Never raises for a delivery failure. A missing credential
    (`ProviderNotConfigured`) is recorded as a failure too, because a task that
    crashes on a deployment mistake retries three times and then loses the
    message entirely.
    """
    number = phone_utils.canonical(to)
    provider = get_provider()

    message = SmsMessage(
        to=number or str(to or "")[:32],
        body=body,
        provider=provider.code,
        segments=segments(body),
        notification_type=notification_type,
        order_number=order_number,
    )

    if not number:
        # A landline, a hotline, or a blank. Not an error — plenty of customer
        # rows legitimately carry one — so it is recorded and skipped.
        message.status = SmsStatus.SUPPRESSED
        message.error = "Not a Bangladeshi mobile number."
        message.save()
        return message

    if not _may_send_to(number):
        message.status = SmsStatus.SUPPRESSED
        message.error = "Not on SMS_ALLOWLIST, and this is not a live environment."
        message.save()
        return message

    try:
        result = provider.send(to=number, body=body)
    except ProviderNotConfigured as exc:
        message.status = SmsStatus.FAILED
        message.error = f"Provider not configured: {exc}"
        message.save()
        logger.error("SMS provider %s is selected but not configured", provider.code)
        return message

    message.status = SmsStatus.SENT if result.success else SmsStatus.FAILED
    message.reference = result.reference[:128]
    message.error = "" if result.success else result.message[:2000]
    message.sent_at = timezone.now() if result.success else None
    message.save()
    return message


# ------------------------------------------------------------------ templates
#
# Each of these must fit ONE segment (`test_sms.py` asserts it). The order
# number and the shop name are the two things a customer needs to recognise the
# message; the tracking link is what makes it useful. Everything else is spend.


def _tracking_url(order: Any) -> str:
    base = str(settings.RANGON.get("PUBLIC_URL", "")).rstrip("/")
    return f"{base}/order/{order.number}" if base else ""


def order_confirmed(order: Any) -> str:
    return (
        f"Rangon: order {order.number} confirmed, "
        f"{order.currency} {order.grand_total}. {_tracking_url(order)}"
    ).strip()


def order_shipped(order: Any) -> str:
    return (
        f"Rangon: order {order.number} is on its way. "
        f"Please keep your phone nearby. {_tracking_url(order)}"
    ).strip()


def refund_completed(order: Any) -> str:
    return (
        f"Rangon: refund issued for order {order.number}, "
        f"{order.currency} {order.refunded_total}."
    ).strip()


#: `notify_customer` looks the message up here. A type with no entry sends no
#: SMS at all, which is how "delivered" stays an email-only courtesy rather
#: than a charge.
TEMPLATES = {
    "ORDER_CONFIRMED": order_confirmed,
    "ORDER_SHIPPED": order_shipped,
    "REFUND_COMPLETED": refund_completed,
}


def body_for(order: Any, notification_type: str) -> str:
    template = TEMPLATES.get(notification_type)
    return template(order) if template else ""
