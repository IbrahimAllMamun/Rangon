# SMS notifications

> What is built, and what you have to do to make it send.
> Code: `apps/api/notifications/sms.py`, `notifications/providers/` · Tests: `apps/api/tests/test_sms.py`

---

## Why this matters more here than it would elsewhere

Identity in this system is phone-first ([business-rules.md §6](../business-rules.md)) precisely because
many Bangladeshi customers have no email address. Until 2026-09-10 those customers were told
**nothing** — the email path returned "no-email" and moved on. For cash on delivery that is a failed
delivery waiting to happen: nobody is home, the rider leaves, and the shop pays for the trip.

## What is built

Everything except the last mile. The provider is an interface with a no-op implementation, so the
system is complete and tested with no account and no spend:

| Piece | Where |
|---|---|
| Provider interface | `notifications/providers/base.py` |
| `console` provider — logs, sends nothing, **the default** | `notifications/providers/console.py` |
| Registry | `notifications/registry.py` |
| Send + segment counting + the allowlist guard | `notifications/sms.py` |
| Message log (`SmsMessage`) | `notifications/models.py` |
| The Celery task | `notifications/tasks.py` |

Three messages are sent, and only three. Each maps to a template in `sms.TEMPLATES`; a notification
type with no template sends no SMS, which is how "delivered" stays an email courtesy rather than a
charge.

| Event | Why it earns its cost |
|---|---|
| **Order confirmed** | The customer has just promised money and has no other confirmation |
| **Order shipped** | The one that prevents a failed COD delivery — they need to be home |
| **Refund completed** | Money moving back needs a receipt they can see |

## What you have to do

### 1. Choose a provider

For Bangladesh the realistic options are local aggregators — SSL Wireless, an operator enterprise
account (Robi, Banglalink, Grameenphone), or a bulk-SMS reseller. International providers such as
Twilio work technically but cost far more per message into Bangladesh and need A2P registration; for a
domestic-only shop a local aggregator is almost always right.

Ask them for, in this order:

1. **The API documentation**, before you pay. Most BD aggregators are a single GET or POST with an
   API key.
2. **A masked sender ID** (`RANGON` rather than a number). This needs operator approval and **takes
   days to weeks**. Non-masked numeric sending usually works immediately, so start there — switching
   later is a settings change, not a code change.
3. **A delivery-report callback**, if they have one. Optional, but it is the difference between "we
   sent it" and "they got it".
4. **The per-message price at your volume**, and whether Bengali is priced differently. It usually is
   — see below.

### 2. Set the environment

```bash
SMS_PROVIDER=your-provider-code   # `console` until you have one
SMS_SENDER_ID=RANGON
SMS_LIVE=1                        # ONLY on production
SMS_ALLOWLIST=01712345678         # everywhere else: who may be texted
RANGON_PUBLIC_URL=https://your-domain   # the tracking link in the message
```

### 3. Write the provider class

About forty lines: build the request, post it, map the response to `SmsResult`. `orders/payments/providers/manual.py`
is the shape to copy. Register it in `notifications/registry.py`. Nothing else changes anywhere.

## Three things that will cost you money if ignored

**Bengali more than doubles the price.** A GSM-7 message holds 160 characters; the moment one Bengali
character appears the encoding becomes UCS-2 and the limit drops to **70**. A message of 160 Latin
characters is one charge; the same text with a single `৳` in it is **three**. Nothing in the gateway's
response tells you this. `sms.segments()` computes it, `SmsMessage.segments` records it, and a test
asserts every template still fits one part — if you edit a message and it grows, the suite fails
rather than the bill.

**A test send reaches a real person.** `SMS_LIVE=0` (the default) means only numbers in
`SMS_ALLOWLIST` are texted; everyone else is recorded as `SUPPRESSED`. An empty allowlist means
nobody. Without this a `seed_demo --reset` on a staging box texts every customer in the fixture.

**The default provider sends nothing, on purpose.** A deployment that has not deliberately named a
gateway cannot text anybody. That is the right way round for the mistake to fall.

## Answering "did the customer get told?"

Every attempt writes an `SmsMessage` row — including the ones that did not happen. SMS has no
sent-items folder and no bounce, so this table is the only thing that can answer the question, and the
only place the spend is visible: one row is one charge.

| Status | Means |
|---|---|
| `SENT` | The gateway accepted it. Delivery is a separate question unless your provider posts reports |
| `FAILED` | The gateway refused it, or the credentials are missing. `error` says which |
| `SUPPRESSED` | We chose not to send: a landline, a blank number, or not on the allowlist |
| `QUEUED` | Written but not yet attempted |

"We chose not to" and "we tried and it broke" are deliberately different statuses. They are different
answers to the same question.

## What is not built

- **Delivery reports.** No callback endpoint yet. Add one when you have a provider that posts them.
- **Marketing or bulk SMS.** This is transactional only — messages about an order the customer
  placed. Bulk marketing has consent rules attached and is a different feature.
- **An opt-out.** Not required for transactional messages, but if you ever send marketing it is, and
  the `Customer` model will need a field for it.
