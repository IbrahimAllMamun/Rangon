"""The SMTP connection a Celery task opens gives up instead of waiting forever.

The worker runs ``--pool=threads`` (docker-compose.yml), and Celery's thread
pool drops ``CELERY_TASK_TIME_LIMIT`` on the floor -- ``TaskPool.on_apply``
takes the timeouts as ``**_``.  Under prefork that limit killed a task stuck on
a stalled mail server after ten minutes; under threads nothing does, and
Django's own default for ``EMAIL_TIMEOUT`` is ``None``, i.e. block forever.
Four such stalls and the worker stops running anything, including
``release_expired_reservations``, so reserved stock is never freed.

The suite swaps the email backend for ``locmem``, so this asks for the SMTP
backend by name: that is the one production sends through.
"""

from __future__ import annotations

from django.core.mail import get_connection


def test_the_smtp_backend_carries_a_finite_timeout():
    connection = get_connection("django.core.mail.backends.smtp.EmailBackend")

    assert connection.timeout is not None
    assert 0 < connection.timeout <= 60
