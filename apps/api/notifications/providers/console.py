"""The provider a shop has before it has an account.

Writes the message to the log and reports success. It exists so that a fresh
install, the test suite and CI all work end to end with no credentials and no
spend — the same job `ManualProvider` does for payments.

It is also the default, deliberately. The failure mode of "forgot to configure
a provider" should be a silent no-op, never an accidental send to two hundred
real customers.
"""

from __future__ import annotations

import logging
import uuid

from notifications.providers.base import SmsResult

logger = logging.getLogger("rangon.sms")


class ConsoleProvider:
    code = "console"
    label = "Console (logs only, sends nothing)"

    def send(self, *, to: str, body: str) -> SmsResult:
        logger.info("SMS to %s: %s", to, body)
        return SmsResult(success=True, reference=f"console-{uuid.uuid4().hex[:12]}")
