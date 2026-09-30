"""A stand-in payment gateway, for the NestJS parity stack only.

The only provider either API ships is `manual`, which takes no webhooks, so a
webhook can reach `handle_provider_event` -- the capture, the cash book, the
replay check -- only through a gateway. This one stands in for a gateway whose
signature check has passed: it believes the body, as `StubPay` does in
`tests/api/test_payment_webhooks.py`. `parity/gateway.ts` is its twin, and
`parity/serve.ts` registers that one in the Nest API.

Installed by `config.settings.parity` alone, from a directory that only
`docker-compose.nest.yml` mounts. No image contains it, and nothing that
accepts real traffic loads it.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from django.apps import AppConfig


class ParityPay:
    code = "paritypay"
    label = "Parity stand-in gateway"
    supports_refund = False

    def parse_webhook(self, *, body: bytes, headers: dict[str, str]) -> Any:
        from orders.payments.providers.base import ProviderEvent

        data = json.loads(body)
        return ProviderEvent(
            event_id=data["event_id"],
            event_type=data["event_type"],
            order_number=data.get("order_number", ""),
            amount=Decimal(data["amount"]) if "amount" in data else None,
            raw=data,
        )


class ParityGatewayConfig(AppConfig):
    name = "parity_gateway"
    label = "parity_gateway"

    def ready(self) -> None:
        from orders.payments import registry

        registry.register(ParityPay())  # type: ignore[arg-type]
