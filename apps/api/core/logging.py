from __future__ import annotations

import logging

from core.middleware import get_request_id


class RequestIDFilter(logging.Filter):
    """Put the current request id on every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id() or "-"
        return True
