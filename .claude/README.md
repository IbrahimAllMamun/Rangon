# Working on Rangon with Claude Code — start here

This folder is **how to work on this repo**, not what the product does.
For the product, read in this order:

| Question | File |
|---|---|
| Rules this codebase must follow | `../CLAUDE.md` |
| What exists, what is verified, what is missing | `../docs/roadmap.md` |
| Handover summary for a human | `../docs/HANDOVER.md` |
| Business behaviour (and the decisions still owed) | `../docs/business-rules.md` |
| Why it is built this way | `../docs/architecture/decisions/` (8 ADRs) |

And in this folder:

| File | Why you care |
|---|---|
| `environment.md` | **Read before running anything.** This machine has traps that cost hours. |
| `session-history.md` | What was built, every bug found, and the lesson from each. |
| `open-questions.md` | Decisions the owner owes, and what is still unverified. |

---

## State as of 2026-08-31

**All 39 phases are ✅ or deliberately V2.** The full picture, with evidence and dates, is in
`../docs/roadmap.md`. What follows is only what you need before touching anything.

```text
Storefront   http://localhost:4000          (NOT :3000 — see environment.md)
Admin        http://localhost:4000/admin
POS          http://localhost:4000/pos
API          http://localhost:8000/api/v1/
API docs     http://localhost:8000/api/docs/
```

Logins (dev seed, all `rangon12345`): `owner@`, `manager@`, `cashier@`, `stock@`,
`accounts@`, `customer@` — all `...@rangon.test`.

`scripts/dev-stack-native.sh up` brings up postgres, redis, api and web without Docker. That is how
everything below was verified.

### Verified by actually executing it (2026-08-31)

```text
pytest ................................. 584 passed
ruff check + ruff format ............... clean
tsc --noEmit / next lint ............... clean
vitest ................................. 79 passed, 6 files
playwright, dev, reseeded .............. 20/20 — and now a CI job
playwright, production standalone ...... NOT green — D40 and D41
migrations from an empty database ...... OK
inventory ledger integrity ............. 0 drift
```

### Never successfully run — do not claim these work

- **The E2E suite against a production build.** Two defects block it, D40 and D41. The CI job
  deliberately runs against `next dev` and says so.
- **A live payment gateway.** The card option is visibly disabled, not faked.
- **Anything deployed.** There is no environment; CI builds and scans images without pushing.
- **A load test**, and **an independent security review**.

### The two habits that keep finding things

1. **Audit the endpoint before building the screen.** Eight passes, eight sets of defects, no
   exceptions. The eighth was over categories/brands and users/roles — the two areas the roadmap
   itself called "not load-bearing" — and found eleven, five of them security-sensitive.
2. **Run it, do not typecheck it.** Two defects on 2026-08-31 survived a clean `tsc` *and* a clean
   lint and died the moment a browser loaded the page: a function passed from a server component
   into a client one, and a serializer field typed as an object that is really a string.

## What to do next

In order, and none of it is "build a screen":

1. **A real payment gateway.** Nothing prepaid can be sold without one.
2. **D40 and D41** — the two production-build defects keeping E2E off a production run in CI. D40 is
   narrowed to one sentence; D41 is not diagnosed at all.
3. **Settle VAT.** No code waits on it any more; the first real sale does.
4. **Deploy something.** Every remaining item on the go-live list needs an environment to be true of.

Details and the lesson from each session are in `session-history.md`; the decisions the owner still
owes are in `open-questions.md`.
