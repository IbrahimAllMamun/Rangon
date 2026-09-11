"""Provider registry: resolve an SMS provider by code, configured in settings.

Deliberately the same shape as `orders/payments/registry.py`. Two registries
that behave differently would be two things to learn.
"""

from __future__ import annotations

from django.conf import settings

from notifications.providers.base import SmsProvider
from notifications.providers.console import ConsoleProvider

_PROVIDERS: dict[str, SmsProvider] = {
    ConsoleProvider.code: ConsoleProvider(),
}


def register(provider: SmsProvider) -> None:
    _PROVIDERS[provider.code] = provider


def get_provider(code: str | None = None) -> SmsProvider:
    code = code or settings.RANGON["SMS_PROVIDER"]
    provider = _PROVIDERS.get(code)
    if provider is None:
        raise KeyError(
            f"SMS provider {code!r} is not registered. "
            f"Available: {', '.join(sorted(_PROVIDERS))}. "
            "See docs/operations/sms.md for what a real provider needs."
        )
    return provider


def available_providers() -> list[str]:
    return sorted(_PROVIDERS)
