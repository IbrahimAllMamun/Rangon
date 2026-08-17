"""Provider registry: resolve a provider by code, configured in settings."""

from __future__ import annotations

from django.conf import settings

from orders.payments.providers.base import PaymentProvider
from orders.payments.providers.manual import ManualProvider

_PROVIDERS: dict[str, PaymentProvider] = {
    ManualProvider.code: ManualProvider(),
}


def register(provider: PaymentProvider) -> None:
    _PROVIDERS[provider.code] = provider


def get_provider(code: str | None = None) -> PaymentProvider:
    code = code or settings.RANGON["DEFAULT_PAYMENT_PROVIDER"]
    provider = _PROVIDERS.get(code)
    if provider is None:
        raise KeyError(
            f"Payment provider {code!r} is not registered. "
            f"Available: {', '.join(sorted(_PROVIDERS))}. "
            "See docs/roadmap.md gap #2 for the gateway work."
        )
    return provider


def available_providers() -> list[str]:
    return sorted(_PROVIDERS)
