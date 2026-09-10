"""SMS provider abstraction.

The same shape as `orders/payments/providers/base.py`, and for the same reason:
no service, task or template contains provider-specific logic, so adding SSL
Wireless, a Robi or Banglalink enterprise account, or a bulk reseller means
writing one class and naming it in a setting. Nothing else changes.

Two things here are specific to sending SMS in Bangladesh rather than generic
messaging:

* **The number format is already decided.** `Customer.phone` stores one
  canonical spelling, `8801XXXXXXXXX` (`core/phone.py`). Aggregators disagree
  about what they want — some take that, some want the local `01XXXXXXXXX` —
  so the *provider* adapts, using the helpers in `core.phone`. Nothing upstream
  ever reformats a number.
* **Sending costs money and reaches a real person.** A provider is therefore
  never chosen implicitly: `SMS_PROVIDER` defaults to `console`, which writes
  to the log and sends nothing. A deployment that has not deliberately named a
  real provider cannot text anybody, which is the right way round for a
  mistake to fall.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class SmsResult:
    """What happened, in terms the message log can store.

    `reference` is the provider's own id for the message. It is the only thing
    that makes a later "did this arrive?" answerable, so a provider that
    returns one must pass it through.
    """

    success: bool
    reference: str = ""
    message: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class SmsProvider(Protocol):
    code: str
    label: str

    def send(self, *, to: str, body: str) -> SmsResult:
        """Send one message.

        `to` is the canonical `8801XXXXXXXXX`; convert inside the provider if
        the gateway wants something else.

        Raise `ProviderNotConfigured` when credentials are missing — that is a
        deployment mistake, not a delivery failure, and the two must not look
        alike in the log. Return `SmsResult(success=False, ...)` for anything
        the gateway itself refused, and let network errors propagate so the
        task can retry them.
        """
        ...


class ProviderNotConfigured(RuntimeError):
    """A provider was selected but its credentials are absent."""
