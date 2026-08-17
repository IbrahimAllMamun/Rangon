# Payments

## Generic model

One `Payment` table for every method and channel. No provider-specific columns leak into it.

```text
Payment
  order, method        CASH | CARD | MOBILE_MFS | BANK | ONLINE_GATEWAY | COD | STORE_CREDIT | OTHER
  status               PENDING | AUTHORIZED | CAPTURED | FAILED | VOIDED | REFUNDED | PARTIALLY_REFUNDED
  amount, currency     Decimal(14,2)
  provider             "manual" | "sslcommerz" | "bkash" | …
  provider_reference   provider's transaction id
  reference            human reference (cheque no., MFS txn id typed by the cashier, terminal slip no.)
  payload              JSON (provider response, redacted — never full card data)
  authorized_at, captured_at, failed_at, created_by, created_at

PaymentEvent            append-only, dedupe key (provider, provider_event_id) UNIQUE
Refund                  payment, amount, reason, status, provider_reference, created_by
```

Split payment is simply several `Payment` rows on one order (cash + card). The order's
`payment_status` is derived from `SUM(captured) − SUM(refunded)` versus `grand_total`.

## Provider abstraction

```python
class PaymentProvider(Protocol):
    code: str
    def create_intent(self, *, order, amount, return_url, cancel_url) -> PaymentIntent: ...
    def verify_callback(self, *, request_data, headers) -> ProviderResult: ...
    def parse_webhook(self, *, body: bytes, headers) -> ProviderEvent: ...
    def refund(self, *, payment, amount, reason) -> ProviderResult: ...
```

Implementations live in `orders/payments/providers/`; the registry resolves by code from settings.
No view, serializer or template contains provider-specific logic.

Shipped today:

- **`manual`** — cash, card terminal, bank transfer, MFS typed in by a cashier, and COD. Captured by a
  staff action with `sales.payment_record`, fully audited. This is what a physical shop actually needs
  on day one.

Not shipped (needs merchant credentials):

- **`sslcommerz`**, **`bkash`** — class skeletons and the webhook route exist; the credential-bearing
  request/verification code is intentionally not guessed. See `docs/roadmap.md` gap #2.

## Rules

1. An order is **never** marked paid from a browser callback. Only `verify_callback` (server→provider
   verification) or a signature-verified webhook may capture.
2. Webhooks are deduplicated on `(provider, provider_event_id)`; a replay is stored and ignored.
   Proven by `tests/test_concurrency.py::test_duplicate_webhook_captures_once`.
3. Refund total per order may never exceed captured total; enforced in the service and by a check in
   `Refund.clean()`.
4. Amounts are `Decimal`. Provider payloads arriving as floats/strings are converted with
   `core.money.to_decimal()` before use.
5. Card data is never stored, logged or forwarded — the terminal handles it; we store only the slip
   reference.
6. Every payment/refund writes an audit entry and an `OrderEvent`.

## COD

`method=COD`, `status=PENDING`, amount = order total, created at checkout. The courier remits later and
a staff member records capture. Refusal on delivery → payment `FAILED`, order `CANCELLED` (before
dispatch) or `RETURNED` (after), stock released or restocked.
