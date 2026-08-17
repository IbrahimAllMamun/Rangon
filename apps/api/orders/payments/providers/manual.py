"""Manual provider: cash, card terminal, bank transfer, MFS typed by staff, COD.

This is what a physical shop actually needs on day one.  There is no external
call: a payment is captured by a staff action carrying `sales.payment_record`,
and the audit log records who did it.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from orders.payments.providers.base import PaymentIntent, ProviderEvent, ProviderResult


class ManualProvider:
    code = "manual"
    label = "Manual / in-person"
    supports_refund = True

    def create_intent(
        self, *, order: Any, amount: Decimal, return_url: str = "", cancel_url: str = ""
    ) -> PaymentIntent:
        # Nothing to redirect to: the money changes hands in the shop or on
        # delivery, and a human records it.
        return PaymentIntent(
            provider=self.code,
            reference=f"manual-{uuid.uuid4().hex[:16]}",
            redirect_url="",
            payload={"instructions": "Collect payment and record it against the order."},
        )

    def verify_callback(self, *, request_data: dict[str, Any]) -> ProviderResult:
        return ProviderResult(
            success=True,
            reference=str(request_data.get("reference", "")),
            message="Recorded manually",
        )

    def parse_webhook(self, *, body: bytes, headers: dict[str, str]) -> ProviderEvent:
        raise NotImplementedError("The manual provider does not receive webhooks.")

    def refund(self, *, payment: Any, amount: Decimal, reason: str) -> ProviderResult:
        return ProviderResult(
            success=True,
            reference=f"manual-refund-{uuid.uuid4().hex[:12]}",
            amount=amount,
            message=reason or "Refunded manually",
        )
