"""DRF exception handler: one error shape for the whole API."""

from __future__ import annotations

import logging
from typing import Any

from django.core.exceptions import ObjectDoesNotExist
from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.http import Http404
from rest_framework import exceptions as drf_exceptions
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from core.exceptions import BusinessError
from core.middleware import get_request_id

logger = logging.getLogger("rangon.api")

_DRF_CODE_MAP = {
    drf_exceptions.NotAuthenticated: ("AUTHENTICATION_REQUIRED", 401),
    drf_exceptions.AuthenticationFailed: ("AUTHENTICATION_REQUIRED", 401),
    drf_exceptions.PermissionDenied: ("PERMISSION_DENIED", 403),
    drf_exceptions.NotFound: ("NOT_FOUND", 404),
    drf_exceptions.MethodNotAllowed: ("METHOD_NOT_ALLOWED", 405),
    drf_exceptions.Throttled: ("RATE_LIMITED", 429),
    drf_exceptions.ParseError: ("VALIDATION_ERROR", 400),
    drf_exceptions.UnsupportedMediaType: ("UNSUPPORTED_MEDIA_TYPE", 415),
}


def _envelope(code: str, message: str, details: Any = None, status: int = 400) -> Response:
    body: dict[str, Any] = {"error": {"code": code, "message": message, "details": details or {}}}
    request_id = get_request_id()
    if request_id:
        body["error"]["request_id"] = request_id
    return Response(body, status=status)


def rangon_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    # 1. Our own domain errors — the common, expected case.
    if isinstance(exc, BusinessError):
        return _envelope(exc.code, exc.message, exc.details, exc.status_code)

    # 2. DRF validation — keep the per-field detail, wrap the shape.
    if isinstance(exc, drf_exceptions.ValidationError):
        return _envelope("VALIDATION_ERROR", "Invalid input.", exc.detail, 400)

    if isinstance(exc, DjangoValidationError):
        details = getattr(exc, "message_dict", None) or {"non_field_errors": exc.messages}
        return _envelope("VALIDATION_ERROR", "Invalid input.", details, 400)

    # 3. Framework errors we map onto documented codes.
    for exc_type, (code, status) in _DRF_CODE_MAP.items():
        if isinstance(exc, exc_type):
            message = str(getattr(exc, "detail", "")) or exc_type.__name__
            return _envelope(code, message, None, status)

    if isinstance(exc, Http404 | ObjectDoesNotExist):
        return _envelope("NOT_FOUND", "The requested resource was not found.", None, 404)

    if isinstance(exc, DjangoPermissionDenied):
        return _envelope("PERMISSION_DENIED", "You do not have permission.", None, 403)

    # 4. A constraint fired — the database defended an invariant the service
    #    should have caught first.  Log loudly, tell the client nothing useful.
    if isinstance(exc, IntegrityError):
        logger.exception("Integrity error escaped the service layer: %s", exc)
        return _envelope(
            "CONFLICT",
            "The request conflicts with the current state of the data.",
            None,
            409,
        )

    # 5. Anything else: let DRF try, otherwise 500 with no internals leaked.
    response = drf_exception_handler(exc, context)
    if response is not None:
        return _envelope("SERVER_ERROR", "Unexpected error.", None, response.status_code)

    logger.exception("Unhandled exception", exc_info=exc)
    return _envelope(
        "SERVER_ERROR",
        "An unexpected error occurred. Quote the request id when reporting this.",
        None,
        500,
    )
