"""Request-scoped context: request id and audit actor.

Both are stored in a ContextVar so a service deep in the call stack can attach
them to an audit entry without every function signature carrying a request.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from contextvars import ContextVar
from typing import Any

from django.http import HttpRequest, HttpResponse

from core.ip import client_ip

_request_id: ContextVar[str] = ContextVar("request_id", default="")
# Default is None, not {}: a mutable default on a ContextVar is shared by every
# context that never sets it, which is exactly the bug this module must not have.
_audit_context: ContextVar[dict[str, Any] | None] = ContextVar("audit_context", default=None)


def get_request_id() -> str:
    return _request_id.get()


def get_audit_context() -> dict[str, Any]:
    return dict(_audit_context.get() or {})


def set_audit_context(**values: Any) -> None:
    _audit_context.set({**get_audit_context(), **values})


class RequestIDMiddleware:
    """Accept or mint an X-Request-ID and echo it back on the response."""

    header = "HTTP_X_REQUEST_ID"

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        incoming = request.META.get(self.header, "")
        # Never trust an arbitrary-length client value in logs.
        request_id = incoming[:64] if incoming else uuid.uuid4().hex
        token = _request_id.set(request_id)
        request.request_id = request_id  # type: ignore[attr-defined]
        try:
            response = self.get_response(request)
        finally:
            _request_id.reset(token)
        response["X-Request-ID"] = request_id
        return response


class AuditContextMiddleware:
    """Capture actor/IP/user-agent once per request for the audit log."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        token = _audit_context.set(
            {
                # `core.ip`, not a second reading of the header here. This
                # used to take the left-most `X-Forwarded-For` entry, which is
                # the part the client writes -- so the trail recorded whatever
                # address an attacker typed, and recorded it as fact.
                "ip_address": client_ip(request),
                "user_agent": request.META.get("HTTP_USER_AGENT", "")[:512],
                "request_id": get_request_id(),
            }
        )
        try:
            return self.get_response(request)
        finally:
            _audit_context.reset(token)
