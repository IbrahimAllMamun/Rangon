"""Payment provider abstraction.

No view, serializer or service contains provider-specific logic; everything goes
through this interface (plan §15).  Adding SSLCOMMERZ or bKash means writing one
class and registering it — nothing else changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol


@dataclass(frozen=True)
class PaymentIntent:
    """What the storefront needs to take the customer to the provider."""

    provider: str
    reference: str
    redirect_url: str = ""
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderResult:
    success: bool
    reference: str = ""
    amount: Decimal | None = None
    message: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderEvent:
    """A normalised webhook.  `event_id` must be stable for replay detection."""

    event_id: str
    event_type: str
    order_number: str = ""
    reference: str = ""
    amount: Decimal | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class PaymentProvider(Protocol):
    code: str
    label: str
    supports_refund: bool

    def create_intent(
        self, *, order: Any, amount: Decimal, return_url: str, cancel_url: str
    ) -> PaymentIntent: ...

    def verify_callback(self, *, request_data: dict[str, Any]) -> ProviderResult: ...

    def parse_webhook(self, *, body: bytes, headers: dict[str, str]) -> ProviderEvent: ...

    def refund(self, *, payment: Any, amount: Decimal, reason: str) -> ProviderResult: ...


class ProviderNotConfigured(RuntimeError):
    """Raised when a provider is selected but its credentials are absent."""
