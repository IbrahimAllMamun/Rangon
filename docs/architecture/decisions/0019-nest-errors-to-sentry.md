# ADR-0019 — The NestJS API reports its errors to Sentry, through `@sentry/core` alone

**Status:** Accepted · 2026-10-08 · closes the second limit [ADR-0017](0017-nest-api-serves-production.md) named

## Context

The NestJS API serves production (ADR-0017). An error nobody handled there was a line in the
container's log and nothing else. The go-live checklist asks for error tracking that receives
events, and `SENTRY_DSN` was already passed to the container: nothing read it.

Django's production settings read it (`config/settings/prod.py`): `sentry_sdk.init` with the
Django and Celery integrations, `traces_sample_rate=0.1`, `send_default_pii=False`,
`RANGON_ENV` and `RANGON_RELEASE`. That is what "as Django does" means here -- and it turned
out to describe an intention rather than a behaviour. **`sentry-sdk` is not in Django's
requirements.** The block imports it inside `try`, catches the `ImportError` and passes: with
`SENTRY_DSN` set, Django reports nothing and says nothing (D241 in the roadmap). So there was
no behaviour to copy, only settings to honour.

## Decision

**The NestJS API reports three kinds of error to Sentry, using `@sentry/core` 11.5.0 and none
of the rest of Sentry's Node SDK.**

1. **A request that ended in a 500** -- an exception nothing expected -- **or in a 409 because
   a database constraint fired** that the service layer should have caught. Both are the two
   places `EnvelopeFilter` already logs at error level.
2. **A background job that will not be tried again**: a failure its task does not retry, at
   once; a failure it does retry, when the retries are spent. Not the attempts in between --
   Celery's integration does not report a retry either.
3. **An exception that is about to end the process**, seen through Node's
   `uncaughtExceptionMonitor`, which observes and changes nothing.

On only where Django's would be: under production settings, with `SENTRY_DSN` set. A DSN that
is not one stops the API from starting, as `sentry_sdk.init` would stop Django if it ran.

### What leaves with an event

Chosen, not gathered. The exception with its stack and its causes; the environment
(`RANGON_ENV`, `production` unless set) and the release (`RANGON_RELEASE`, which the production
compose file now sets to the image's tag); the host's name; and:

| For a request | For a job | For the process |
|---|---|---|
| the method, the path and the route's pattern | the task's name | where the exception came from |
| the status answered (500 or 409) | which attempt it was | |
| the request id -- the same one in the error the client got, and in the log | | |

**Never** a request body, a query string (a customer lookup carries a phone number in one), a
header, a cookie, a token, an address, or who was signed in. `send_default_pii=False` is
Django's setting; here there is no setting to get wrong, because nothing else is collected.

### Why `@sentry/core` and not `@sentry/node`

`@sentry/node` (11.5.0: 24 packages, 84 MB) is built on OpenTelemetry. Initialising it
instruments the process: it wraps `http`, the database driver and the web framework, and adds
tracing headers to outgoing requests. This API was ported by proving, request by request, that
it answers as Django does; a library that rewrites how its requests are made and served would
have to be proven again, for a feature -- tracing -- nobody asked for.

`@sentry/core` (2 packages, 17 MB) is what every Sentry SDK is built from: the client, the
event and envelope formats, the stack parser, the transport with its queue and its handling of
Sentry's rate limits. It patches nothing. `observability/error-reports.service.ts` gives it a
`fetch` to send with and calls it from the three places above. The protocol is Sentry's own
code, so a change in what Sentry accepts arrives as a version bump rather than as a bug here.

Not writing the envelope by hand, which ADR-0018 did for S3, was the same reasoning turned
round: there the hard part was a URL rule that was Django's, and a real S3 server could check
every signature. Here the hard part *is* the protocol, and there is no Sentry in the parity
stack to say whether a hand-written envelope would be accepted.

## Consequences

- **One new dependency**, at an exact version: `@sentry/core` 11.5.0 (with `@sentry/conventions`,
  its only dependency).
- **No tracing.** Django's settings ask for a tenth of requests to be traced; this reports
  errors only. If performance tracing is wanted it is a decision of its own, with the
  instrumentation and the re-proving that come with it.
- **An exception that ends the process may not be reported.** The report is queued as the
  process dies, and nothing holds the process open for it. A request or a job that fails does
  not have that problem: the process lives on, and shutdown waits two seconds for what is
  queued.
- **The S3 client and the mailer are untouched.** Nothing adds a header to their requests.
- **Django still reports nothing.** Going back to Django with `docker-compose.django.yml` loses
  error reporting until `sentry-sdk` is added to its requirements, which is Django's change to
  make (D241).
- **Tested against a stand-in, not against Sentry.** The unit tests run a server that keeps the
  envelopes it is sent and read them back, and the built image was run once under production
  settings against such a listener, with a real 500 through the real filter. That Sentry
  accepts what `@sentry/core` builds is Sentry's own claim. No event has been sent to a real
  project from this code.

## Alternatives considered

- **`@sentry/node`.** Above.
- **Writing the envelope by hand**, with no dependency at all. Above.
- **Shipping the container's log somewhere that alerts on it**, and no Sentry. Workable, and it
  is what the go-live checklist fell back to; it gives no grouping, no stack with its causes,
  no release to pin an error to.
