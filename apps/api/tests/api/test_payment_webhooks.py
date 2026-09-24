"""Nothing captures a payment from a webhook the shop cannot trust (D100).

`security.md` says capture requires a verified webhook. Measured 2026-09-24:

* The only registered provider is `manual`, which receives no webhooks, so a
  forged "payment.success" is refused -- 404, nothing captured. That holds, and
  the first two tests keep it.
* Signature checking belongs to each provider's `parse_webhook`; the view only
  routes. But the view then captured the order's *first* pending payment,
  whoever it was with and whatever it was for. With a gateway registered, a
  gateway's event could capture a cash-on-delivery payment, and an event for
  ৳1 captured ৳1,000. `StubPay` below stands in for a gateway whose signature
  check has already passed -- the case the view has to be right about.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest

from orders.models import PaymentEvent, PaymentMethod, PaymentState
from orders.payments import registry
from orders.payments.providers.base import ProviderEvent
from orders.services import payments as payment_services
from tests import factories

pytestmark = pytest.mark.django_db


class StubPay:
    """A gateway whose signature check has passed: it believes the body."""

    code = "stubpay"
    label = "Stub gateway"
    supports_refund = False

    def parse_webhook(self, *, body: bytes, headers: dict[str, str]) -> ProviderEvent:
        data = json.loads(body)
        return ProviderEvent(
            event_id=data["event_id"],
            event_type=data["event_type"],
            order_number=data["order_number"],
            amount=Decimal(data["amount"]) if "amount" in data else None,
            raw=data,
        )


@pytest.fixture
def stubpay() -> Iterator[None]:
    registry.register(StubPay())  # type: ignore[arg-type]
    yield
    registry._PROVIDERS.pop("stubpay", None)


def _pending(shop: dict[str, Any], *, provider: str, method: str = PaymentMethod.CARD) -> Any:
    order = factories.order(branch=shop["branch"], grand_total=Decimal("1000.00"))
    return payment_services.record_payment(
        order=order,
        method=method,
        amount=Decimal("1000.00"),
        status=PaymentState.PENDING,
        provider=provider,
    )


def _post(api: Any, provider: str, **event: Any) -> Any:
    return api.post(f"/api/v1/shop/payments/{provider}/webhook/", event, format="json")


class TestForgedWebhooks:
    def test_the_manual_provider_takes_no_webhooks(self, api: Any, shop: dict[str, Any]) -> None:
        payment = _pending(shop, provider="manual", method=PaymentMethod.COD)

        response = _post(
            api,
            "manual",
            event_id="forged-1",
            event_type="payment.success",
            order_number=payment.order.number,
        )

        assert response.status_code == 404
        payment.refresh_from_db()
        assert payment.status == PaymentState.PENDING
        assert not PaymentEvent.objects.exists()

    def test_an_unknown_provider_is_refused(self, api: Any, shop: dict[str, Any]) -> None:
        payment = _pending(shop, provider="manual", method=PaymentMethod.COD)

        response = _post(
            api,
            "sslcommerz",
            event_id="forged-2",
            event_type="payment.success",
            order_number=payment.order.number,
        )

        assert response.status_code == 404
        payment.refresh_from_db()
        assert payment.status == PaymentState.PENDING


@pytest.mark.usefixtures("stubpay")
class TestAVerifiedWebhookCapturesOnlyItsOwnPayment:
    def test_it_does_not_capture_another_providers_payment(
        self, api: Any, shop: dict[str, Any]
    ) -> None:
        """Fails on `main`: the gateway's event captured the COD payment."""
        payment = _pending(shop, provider="manual", method=PaymentMethod.COD)

        response = _post(
            api,
            "stubpay",
            event_id="evt-1",
            event_type="payment.success",
            order_number=payment.order.number,
            amount="1000.00",
        )

        assert response.status_code == 200
        assert response.data["result"] == "ignored"
        payment.refresh_from_db()
        assert payment.status == PaymentState.PENDING

    def test_it_does_not_capture_a_different_amount(self, api: Any, shop: dict[str, Any]) -> None:
        """Fails on `main`: an event for ৳1 captured ৳1,000."""
        payment = _pending(shop, provider="stubpay")

        response = _post(
            api,
            "stubpay",
            event_id="evt-2",
            event_type="payment.success",
            order_number=payment.order.number,
            amount="1.00",
        )

        assert response.status_code == 200
        assert response.data["result"] == "amount_mismatch"
        payment.refresh_from_db()
        assert payment.status == PaymentState.PENDING
        assert payment.order.paid_total == Decimal("0.00")

    def test_its_own_payment_is_captured_once(self, api: Any, shop: dict[str, Any]) -> None:
        """The control, and the replay: the same event twice captures once."""
        payment = _pending(shop, provider="stubpay")
        event = {
            "event_id": "evt-3",
            "event_type": "payment.success",
            "order_number": payment.order.number,
            "amount": "1000.00",
        }

        first = _post(api, "stubpay", **event)
        second = _post(api, "stubpay", **event)

        assert first.data["result"] == "captured"
        assert second.data["result"] == "captured"  # the stored outcome, not a second capture
        payment.refresh_from_db()
        payment.order.refresh_from_db()
        assert payment.status == PaymentState.CAPTURED
        assert payment.order.paid_total == Decimal("1000.00")
        assert PaymentEvent.objects.filter(provider="stubpay").count() == 1
