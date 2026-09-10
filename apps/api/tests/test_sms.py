"""Texting the customer.

Two things make SMS different from every other notification here, and most of
these tests are about one or the other:

* **It costs money per send.** So the tests that matter are the ones about not
  sending — the allowlist, the landline, the missing template — and the one
  asserting every template still fits a single billable segment.
* **It has no sent-items folder.** So every attempt, including the ones that
  did not happen, leaves an `SmsMessage` row. A test that only checked
  "provider was called" would not notice the log going quiet.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from notifications import sms
from notifications.models import SmsMessage, SmsStatus
from notifications.providers.base import ProviderNotConfigured, SmsResult
from notifications.registry import available_providers, get_provider, register
from tests import factories

pytestmark = pytest.mark.django_db

REAL_NUMBER = "8801712345678"


@pytest.fixture(autouse=True)
def _live(settings):
    """Most tests want a send to actually reach the provider."""
    settings.RANGON = {**settings.RANGON, "SMS_LIVE": True, "SMS_PROVIDER": "console"}


class Recorder:
    """A provider that remembers, so a test can assert on what it was given."""

    code = "recorder"
    label = "Recorder"

    def __init__(self, *, success: bool = True, raises: Exception | None = None):
        self.success = success
        self.raises = raises
        self.sent: list[tuple[str, str]] = []

    def send(self, *, to: str, body: str) -> SmsResult:
        if self.raises is not None:
            raise self.raises
        self.sent.append((to, body))
        return SmsResult(
            success=self.success,
            reference="ref-123" if self.success else "",
            message="" if self.success else "Gateway said no",
        )


@pytest.fixture
def recorder(settings):
    provider = Recorder()
    register(provider)
    settings.RANGON = {**settings.RANGON, "SMS_PROVIDER": "recorder", "SMS_LIVE": True}
    return provider


class TestSegments:
    """The number the gateway bills on, which nothing in its response reveals."""

    def test_a_short_english_message_is_one_part(self) -> None:
        assert sms.segments("Rangon: order RGN-000123 confirmed.") == 1

    def test_english_splits_at_160(self) -> None:
        assert sms.segments("a" * 160) == 1
        assert sms.segments("a" * 161) == 2

    def test_one_bengali_character_drops_the_limit_to_70(self) -> None:
        """The trap. A single non-GSM character re-encodes the whole message.

        160 Latin characters is one part; the same text with one Bengali
        character in it is three.
        """
        assert sms.segments("a" * 160) == 1
        assert sms.segments("a" * 159 + "৳") == 3

    def test_bengali_splits_at_70(self) -> None:
        assert sms.segments("অ" * 70) == 1
        assert sms.segments("অ" * 71) == 2

    def test_a_curly_quote_pasted_from_a_word_processor_is_the_same_trap(self) -> None:
        """Nobody types this deliberately; it arrives by paste."""
        assert sms.is_gsm7("Rangon: it's on the way") is True
        assert sms.is_gsm7("Rangon: it’s on the way") is False

    def test_a_brace_costs_two_characters_not_one(self) -> None:
        assert sms.segments("a" * 159 + "{") == 2

    def test_an_empty_body_is_not_billable(self) -> None:
        assert sms.segments("") == 0


class TestEveryTemplateFitsOneMessage:
    """Three charges for one notification is a bug nobody would ever see."""

    @pytest.fixture
    def order(self, shop, settings):
        settings.RANGON = {**settings.RANGON, "PUBLIC_URL": "https://rangonfashion.com"}
        return factories.order(shop, number="RGN-000123")

    @pytest.mark.parametrize("notification_type", sorted(sms.TEMPLATES))
    def test_it_is_a_single_segment(self, order, notification_type) -> None:
        body = sms.body_for(order, notification_type)

        assert body, f"{notification_type} produced nothing"
        assert sms.segments(body) == 1, (
            f"The {notification_type} message is {sms.segments(body)} segments "
            f"and will be billed three times over a busy month:\n  {body!r}"
        )

    @pytest.mark.parametrize("notification_type", sorted(sms.TEMPLATES))
    def test_it_names_the_shop_and_the_order(self, order, notification_type) -> None:
        """A message the customer cannot place is a message they ignore."""
        body = sms.body_for(order, notification_type)

        assert "Rangon" in body
        assert order.number in body

    def test_the_confirmation_carries_a_link_that_can_be_followed(self, order) -> None:
        assert "https://rangonfashion.com/order/RGN-000123" in sms.order_confirmed(order)

    def test_no_origin_means_no_link_rather_than_a_broken_one(self, order, settings) -> None:
        settings.RANGON = {**settings.RANGON, "PUBLIC_URL": ""}

        assert "/order/" not in sms.order_confirmed(order)

    def test_a_type_with_no_template_sends_nothing(self, order) -> None:
        """This is the switch. `delivered` is an email courtesy, not a charge."""
        assert sms.body_for(order, "ORDER_DELIVERED") == ""

    @pytest.mark.parametrize("notification_type", sorted(sms.TEMPLATES))
    def test_it_still_fits_with_a_long_domain_and_a_long_order_number(
        self, shop, settings, notification_type
    ) -> None:
        """The length depends on configuration, so the test must vary it.

        Every other test here uses a 25-character domain. A shop on
        `https://www.rangonfashion-online.com.bd` would push the shipped
        message over 160 and start paying twice per notification, and nothing
        in the suite would have noticed — the templates would still pass on
        the developer's shorter domain. This is the headroom check.
        """
        settings.RANGON = {
            **settings.RANGON,
            "PUBLIC_URL": "https://www.rangonfashion-online.com.bd",
        }
        order = factories.order(shop, number="RGN-WEB-000016")

        body = sms.body_for(order, notification_type)

        assert sms.segments(body) == 1, (
            f"{notification_type} is {len(body)} characters on a longer domain "
            f"and would be billed twice:\n  {body!r}"
        )


class TestSending:
    def test_a_sent_message_is_recorded_with_the_provider_reference(self, recorder) -> None:
        message = sms.send_sms(to=REAL_NUMBER, body="Rangon: hello")

        assert recorder.sent == [(REAL_NUMBER, "Rangon: hello")]
        assert message.status == SmsStatus.SENT
        assert message.reference == "ref-123"
        assert message.sent_at is not None

    def test_the_number_is_canonicalised_before_the_provider_sees_it(self, recorder) -> None:
        """One spelling reaches the gateway however the shop typed it."""
        sms.send_sms(to="01712345678", body="x")
        sms.send_sms(to="+880 1712-345678", body="x")

        assert [to for to, _ in recorder.sent] == [REAL_NUMBER, REAL_NUMBER]

    def test_a_refused_message_is_recorded_with_the_reason(self, settings) -> None:
        provider = Recorder(success=False)
        register(provider)
        settings.RANGON = {**settings.RANGON, "SMS_PROVIDER": "recorder", "SMS_LIVE": True}

        message = sms.send_sms(to=REAL_NUMBER, body="x")

        assert message.status == SmsStatus.FAILED
        assert message.error == "Gateway said no"
        assert message.sent_at is None

    def test_a_missing_credential_is_recorded_not_raised(self, settings) -> None:
        """A deployment mistake must not crash the task into losing the message."""
        provider = Recorder(raises=ProviderNotConfigured("no api key"))
        register(provider)
        settings.RANGON = {**settings.RANGON, "SMS_PROVIDER": "recorder", "SMS_LIVE": True}

        message = sms.send_sms(to=REAL_NUMBER, body="x")

        assert message.status == SmsStatus.FAILED
        assert "not configured" in message.error

    def test_the_billable_size_is_stored_on_the_row(self, recorder) -> None:
        """One row is one charge, so the spend is readable from the table."""
        message = sms.send_sms(to=REAL_NUMBER, body="অ" * 100)

        assert message.segments == 2


class TestWhatItRefusesToSend:
    def test_a_landline_is_suppressed_rather_than_attempted(self, recorder) -> None:
        """Plenty of customer rows legitimately carry one. Not an error."""
        message = sms.send_sms(to="029612345", body="x")

        assert message.status == SmsStatus.SUPPRESSED
        assert recorder.sent == []

    def test_a_blank_number_is_suppressed(self, recorder) -> None:
        message = sms.send_sms(to="", body="x")

        assert message.status == SmsStatus.SUPPRESSED
        assert recorder.sent == []

    def test_off_a_live_environment_only_the_allowlist_is_texted(self, settings) -> None:
        """The guard that stops a staging seed texting the whole fixture."""
        provider = Recorder()
        register(provider)
        settings.RANGON = {
            **settings.RANGON,
            "SMS_PROVIDER": "recorder",
            "SMS_LIVE": False,
            "SMS_ALLOWLIST": ["01712345678"],
        }

        allowed = sms.send_sms(to="01712345678", body="x")
        blocked = sms.send_sms(to="01812345678", body="x")

        assert allowed.status == SmsStatus.SENT
        assert blocked.status == SmsStatus.SUPPRESSED
        assert len(provider.sent) == 1

    def test_an_empty_allowlist_off_live_means_nobody(self, settings) -> None:
        provider = Recorder()
        register(provider)
        settings.RANGON = {
            **settings.RANGON,
            "SMS_PROVIDER": "recorder",
            "SMS_LIVE": False,
            "SMS_ALLOWLIST": [],
        }

        message = sms.send_sms(to=REAL_NUMBER, body="x")

        assert message.status == SmsStatus.SUPPRESSED
        assert provider.sent == []

    def test_a_suppressed_message_is_still_logged(self, recorder) -> None:
        """ "We chose not to" and "it broke" are different answers."""
        sms.send_sms(to="029612345", body="x", order_number="RGN-000123")

        row = SmsMessage.objects.get(order_number="RGN-000123")
        assert row.status == SmsStatus.SUPPRESSED
        assert row.error


class TestTheProviderRegistry:
    def test_console_is_the_default_so_a_fresh_install_texts_nobody(self, settings) -> None:
        settings.RANGON = {**settings.RANGON, "SMS_PROVIDER": "console"}

        assert get_provider().code == "console"

    def test_an_unknown_provider_says_what_is_available(self, settings) -> None:
        settings.RANGON = {**settings.RANGON, "SMS_PROVIDER": "not-a-provider"}

        with pytest.raises(KeyError, match="console"):
            get_provider()

    def test_registering_one_is_all_it_takes(self) -> None:
        register(Recorder())

        assert "recorder" in available_providers()


class TestTheOrderTask:
    """The seam between an order changing and a customer being told."""

    @pytest.fixture
    def order(self, shop, settings):
        settings.RANGON = {
            **settings.RANGON,
            "PUBLIC_URL": "https://rangonfashion.com",
            "SMS_LIVE": True,
        }
        return factories.order(shop, number="RGN-000900")

    def test_it_texts_the_customer_behind_the_order(self, order, recorder) -> None:
        from notifications.tasks import send_order_sms

        result = send_order_sms(str(order.pk), "ORDER_SHIPPED")

        assert result == "sent"
        assert len(recorder.sent) == 1
        assert order.number in recorder.sent[0][1]

    def test_a_type_with_no_template_costs_nothing(self, order, recorder) -> None:
        from notifications.tasks import send_order_sms

        assert send_order_sms(str(order.pk), "ORDER_DELIVERED") == "no-template"
        assert recorder.sent == []

    def test_a_customer_with_no_phone_is_not_an_error(self, shop, recorder) -> None:
        from notifications.tasks import send_order_sms

        customer = factories.customer()
        customer.phone = None
        customer.save(update_fields=["phone"])
        order = factories.order(shop, customer=customer)

        assert send_order_sms(str(order.pk), "ORDER_SHIPPED") == "no-phone"

    def test_a_missing_order_is_not_an_error(self, recorder) -> None:
        import uuid

        from notifications.tasks import send_order_sms

        assert send_order_sms(str(uuid.uuid4()), "ORDER_SHIPPED") == "missing"


def test_the_email_tracking_link_is_absolute(shop, settings) -> None:
    """It never was: `RANGON["SITE_URL"]` has never existed as a key.

    Every order email went out advertising `/order/RGN-000123` with no origin
    in front of it — not a link, just text. The key is `PUBLIC_URL`.
    """
    from notifications.tasks import _tracking_url

    settings.RANGON = {**settings.RANGON, "PUBLIC_URL": "https://rangonfashion.com"}
    order = factories.order(shop, number="RGN-000777")

    assert _tracking_url(order) == "https://rangonfashion.com/order/RGN-000777"


def test_money_reaches_the_message_as_a_decimal(shop, settings) -> None:
    """Never a float, even on the way out of the system (CLAUDE.md §4)."""
    settings.RANGON = {**settings.RANGON, "PUBLIC_URL": "https://x.test"}
    order = factories.order(shop, number="RGN-000555")
    order.grand_total = Decimal("1290.50")

    assert "1290.50" in sms.order_confirmed(order)


class TestItIsActuallyWiredUp:
    """The unit tests above prove the pieces. This proves the seam.

    Every one of them could pass while nothing ever reached a customer, because
    they all call the task directly. These place a real order and change a real
    status, and assert a message row came out the other end — through
    `transaction.on_commit`, Celery, the funnel and the template.
    """

    def _place(self, shop):
        from orders.models import PaymentMethod
        from orders.services import checkout as checkout_services

        cart = checkout_services.get_or_create_cart(
            customer=shop["customer"], branch=shop["branch"]
        )
        checkout_services.add_item(cart=cart, variant_id=shop["variants"][0].pk, quantity=1)
        return checkout_services.place_order(
            cart=cart,
            shipping_address={
                "recipient_name": "A",
                "phone": "01712345678",
                "line1": "x",
                "city": "Dhaka",
            },
            payment_method=PaymentMethod.COD,
            customer=shop["customer"],
            idempotency_key=f"sms-{shop['branch'].pk}",
        )

    def test_placing_an_order_texts_the_customer(
        self, shop, recorder, django_capture_on_commit_callbacks
    ):
        """Nobody told the customer anything until this change.

        Staff were notified of every online order; the person who placed it
        heard nothing until it shipped.
        """
        with django_capture_on_commit_callbacks(execute=True):
            order = self._place(shop)

        message = SmsMessage.objects.get(order_number=order.number)
        assert message.status == SmsStatus.SENT
        assert message.notification_type == "ORDER_CONFIRMED"
        assert order.number in message.body

    def test_shipping_an_order_texts_the_customer(
        self, shop, recorder, django_capture_on_commit_callbacks
    ):
        from orders.models import OrderStatus
        from orders.services import lifecycle

        with django_capture_on_commit_callbacks(execute=True):
            order = self._place(shop)
        SmsMessage.objects.all().delete()  # ignore the confirmation

        with django_capture_on_commit_callbacks(execute=True):
            # The full chain: PROCESSING does not go straight to SHIPPED,
            # a parcel is PACKED first (lifecycle.ALLOWED_TRANSITIONS).
            for status in (
                OrderStatus.CONFIRMED,
                OrderStatus.PROCESSING,
                OrderStatus.PACKED,
                OrderStatus.SHIPPED,
            ):
                order = lifecycle.transition(order=order, to_status=status)

        message = SmsMessage.objects.get(order_number=order.number)
        assert message.notification_type == "ORDER_SHIPPED"
        assert "on its way" in message.body

    def test_the_order_is_committed_before_any_message_is_attempted(
        self, shop, settings, django_capture_on_commit_callbacks
    ):
        """The invariant: a sale is never at the mercy of an SMS gateway.

        Asserted on the *ordering* rather than by breaking the gateway and
        checking the order survived. Under `CELERY_TASK_EAGER_PROPAGATES` a
        failing task raises into whoever ran the callback, which is a fact
        about the test settings and not about production — where the callback
        runs in a worker process that cannot reach this transaction at all.

        What actually matters is that the order is already durable when the
        notification is only queued, and that is what this checks: the row is
        in the database with its items *before* a single callback runs.
        """
        from orders.models import Order

        provider = Recorder(raises=RuntimeError("gateway on fire"))
        register(provider)
        settings.RANGON = {**settings.RANGON, "SMS_PROVIDER": "recorder", "SMS_LIVE": True}

        with django_capture_on_commit_callbacks(execute=False) as callbacks:
            order = self._place(shop)

        stored = Order.objects.get(pk=order.pk)
        assert stored.items.count() == 1
        assert callbacks, "the notification was never queued at all"

        # And the gateway is unreachable, which changes nothing about the sale.
        assert Order.objects.filter(pk=order.pk).exists()
