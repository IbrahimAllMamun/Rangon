"""Celery application.

Background jobs never own a financial or inventory invariant (CLAUDE.md §4):
if a task fails, no sale, payment or stock movement is left half-applied.
Tasks here send email, generate reports, release *expired* reservations and
run integrity checks.
"""

from __future__ import annotations

import os

from celery import Celery
from celery.schedules import crontab

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("rangon")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

app.conf.beat_schedule = {
    "release-expired-reservations": {
        "task": "orders.tasks.release_expired_reservations",
        "schedule": crontab(minute="*/5"),
    },
    "verify-inventory-integrity": {
        "task": "inventory.tasks.verify_inventory_integrity",
        "schedule": crontab(hour=1, minute=30),
    },
    "low-stock-digest": {
        "task": "inventory.tasks.send_low_stock_digest",
        "schedule": crontab(hour=8, minute=0),
    },
    "expire-old-carts": {
        "task": "orders.tasks.expire_abandoned_carts",
        "schedule": crontab(hour=3, minute=0),
    },
    "cosmetics-expiry-check": {
        "task": "catalog.tasks.check_expiring_stock",
        "schedule": crontab(hour=8, minute=15),
    },
}


@app.task(bind=True, ignore_result=True)
def debug_task(self) -> str:  # pragma: no cover - operational helper
    return f"request: {self.request!r}"
