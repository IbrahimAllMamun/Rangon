/**
 * Domain errors, one for one with the Django API's `core.exceptions`.
 *
 * Services throw these; `EnvelopeFilter` turns them into the documented error
 * envelope (docs/api/conventions.md). The codes and statuses are the contract
 * the web app reads, so they are copied, not reinvented.
 */

export type ErrorDetails = Record<string, unknown> | unknown[];

export class BusinessError extends Error {
  // Static, so a subclass states its defaults once and an instance can still
  // override `code` -- `core.exceptions.BusinessError` lets a caller pass
  // `code=` and it wins. (Instance field defaults would run after this
  // constructor and silently overwrite it.)
  static code = 'BUSINESS_ERROR';
  static statusCode = 400;
  static defaultMessage = 'The operation could not be completed.';

  readonly code: string;
  readonly statusCode: number;
  readonly details: ErrorDetails;

  constructor(message?: string, options: { details?: ErrorDetails; code?: string } = {}) {
    const kind = new.target as typeof BusinessError;
    super(message || kind.defaultMessage);
    this.name = kind.name;
    this.code = options.code ?? kind.code;
    this.statusCode = kind.statusCode;
    this.details = options.details ?? {};
  }
}

export class ValidationError extends BusinessError {
  static override code = 'VALIDATION_ERROR';
  static override statusCode = 400;
  static override defaultMessage = 'Invalid input.';
}

export class PermissionDenied extends BusinessError {
  static override code = 'PERMISSION_DENIED';
  static override statusCode = 403;
  static override defaultMessage = 'You do not have permission to perform this action.';
}

export class NotFound extends BusinessError {
  static override code = 'NOT_FOUND';
  static override statusCode = 404;
  static override defaultMessage = 'The requested resource was not found.';
}

export class Conflict extends BusinessError {
  static override code = 'CONFLICT';
  static override statusCode = 409;
  static override defaultMessage = 'The request conflicts with the current state.';
}

export class InsufficientStock extends BusinessError {
  static override code = 'INSUFFICIENT_STOCK';
  static override statusCode = 409;
  static override defaultMessage = 'The requested quantity is not available.';
}

export class NotReceived extends BusinessError {
  static override code = 'NOT_RECEIVED';
  static override statusCode = 409;
  static override defaultMessage =
    'This has never been received here. Receive it on a purchase order.';
}

export class InsufficientFunds extends BusinessError {
  static override code = 'INSUFFICIENT_FUNDS';
  static override statusCode = 409;
  static override defaultMessage = 'That account does not hold enough money for this movement.';
}

export class InvalidStatusTransition extends BusinessError {
  static override code = 'INVALID_STATUS_TRANSITION';
  static override statusCode = 409;
  static override defaultMessage = 'That status change is not allowed.';
}

export class PriceChanged extends BusinessError {
  static override code = 'PRICE_CHANGED';
  static override statusCode = 409;
  static override defaultMessage = 'Prices have changed since the cart was last priced.';
}

export class CouponInvalid extends BusinessError {
  static override code = 'COUPON_INVALID';
  static override statusCode = 422;
  static override defaultMessage = 'This coupon cannot be applied.';
}

export class PaymentFailed extends BusinessError {
  static override code = 'PAYMENT_FAILED';
  static override statusCode = 402;
  static override defaultMessage = 'The payment could not be processed.';
}

export class RefundExceedsCaptured extends BusinessError {
  static override code = 'REFUND_EXCEEDS_CAPTURED';
  static override statusCode = 422;
  static override defaultMessage = 'A refund cannot exceed the amount actually paid.';
}

export class PaymentExceedsOutstanding extends BusinessError {
  static override code = 'PAYMENT_EXCEEDS_OUTSTANDING';
  static override statusCode = 422;
  static override defaultMessage =
    'A payment cannot exceed what is outstanding on the purchase order.';
}

export class IdempotencyConflict extends Conflict {
  static override code = 'IDEMPOTENCY_CONFLICT';
  static override defaultMessage = 'This request was already processed with different content.';
}

/**
 * The framework-level errors DRF raises and `core.handlers` maps to codes.
 * Thrown by this API's own plumbing (authentication, routing, pagination).
 */
export class AuthenticationRequired extends BusinessError {
  static override code = 'AUTHENTICATION_REQUIRED';
  static override statusCode = 401;
  static override defaultMessage = 'Authentication credentials were not provided.';
}

export class MethodNotAllowed extends BusinessError {
  static override code = 'METHOD_NOT_ALLOWED';
  static override statusCode = 405;
  static override defaultMessage = 'Method not allowed.';

  constructor(method: string) {
    super(`Method "${method}" not allowed.`);
  }
}

export class RateLimited extends BusinessError {
  static override code = 'RATE_LIMITED';
  static override statusCode = 429;
  static override defaultMessage = 'Request was throttled.';
}

/**
 * The URL matched no route *as Django would read it*: a path segment failed a
 * converter (`<slug:slug>` accepts `[-a-zA-Z0-9_]+`). Fastify's routes accept
 * any segment, so handlers check and throw this; the filter answers with
 * Django's HTML 404 page, which is what the URL resolver gives.
 */
export class RouteNotMatched extends Error {}

const SLUG = /^[-a-zA-Z0-9_]+$/;

/** Django's `slug` path converter. */
export function slugParam(value: string): string {
  if (!SLUG.test(value)) throw new RouteNotMatched();
  return value;
}
