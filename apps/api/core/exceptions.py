"""Domain exceptions.

Services raise these; core.handlers turns them into the documented error
envelope (docs/api/conventions.md).  A service never returns an HTTP response
and never imports DRF response classes.
"""

from __future__ import annotations

from typing import Any


class BusinessError(Exception):
    """Base class for every rule the backend refuses to break."""

    code = "BUSINESS_ERROR"
    status_code = 400
    default_message = "The operation could not be completed."

    def __init__(
        self,
        message: str | None = None,
        *,
        details: dict[str, Any] | None = None,
        code: str | None = None,
    ) -> None:
        self.message = message or self.default_message
        self.details = details or {}
        if code:
            self.code = code
        super().__init__(self.message)

    def as_dict(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class ValidationError(BusinessError):
    code = "VALIDATION_ERROR"
    status_code = 400
    default_message = "Invalid input."


class PermissionDenied(BusinessError):
    code = "PERMISSION_DENIED"
    status_code = 403
    default_message = "You do not have permission to perform this action."


class NotFound(BusinessError):
    code = "NOT_FOUND"
    status_code = 404
    default_message = "The requested resource was not found."


class Conflict(BusinessError):
    code = "CONFLICT"
    status_code = 409
    default_message = "The request conflicts with the current state."


class InsufficientStock(BusinessError):
    code = "INSUFFICIENT_STOCK"
    status_code = 409
    default_message = "The requested quantity is not available."


class InsufficientFunds(BusinessError):
    """A cash drawer cannot pay out money it does not hold.

    The money equivalent of InsufficientStock, and refused in the same place:
    inside the service, under SELECT ... FOR UPDATE on the account row.
    """

    code = "INSUFFICIENT_FUNDS"
    status_code = 409
    default_message = "That account does not hold enough money for this movement."


class InvalidStatusTransition(BusinessError):
    code = "INVALID_STATUS_TRANSITION"
    status_code = 409
    default_message = "That status change is not allowed."


class PriceChanged(BusinessError):
    code = "PRICE_CHANGED"
    status_code = 409
    default_message = "Prices have changed since the cart was last priced."


class CouponInvalid(BusinessError):
    code = "COUPON_INVALID"
    status_code = 422
    default_message = "This coupon cannot be applied."


class PaymentFailed(BusinessError):
    code = "PAYMENT_FAILED"
    status_code = 402
    default_message = "The payment could not be processed."


class RefundExceedsCaptured(BusinessError):
    code = "REFUND_EXCEEDS_CAPTURED"
    status_code = 422
    default_message = "A refund cannot exceed the amount actually paid."


class IdempotencyConflict(Conflict):
    code = "IDEMPOTENCY_CONFLICT"
    default_message = "This request was already processed with different content."
