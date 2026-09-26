# Roadmap & Status

Phase order follows §85 of the build plan. **Do not reorder casually** — the storefront must not be
built before the product/variant/inventory/order architecture is stable.

Legend: ✅ done and verified · 🟡 partial (gap stated) · ⬜ not started · ❌ declined, with the reason stated

**Verified** means it was actually executed. The evidence, and the date it was produced, is in
[§ Verification log](#verification-log). Anything not in that log is written but unproven — see
[§ Still unproven](#still-unproven) and say so rather than implying otherwise.

Last updated: **2026-09-26**.

**The storefront footer and site pages are now edited in the admin** (Storefront → Footer & pages,
[ADR-0012](architecture/decisions/0012-storefront-footer-and-site-pages.md)). The footer shows the
full address under the logo, contact details, opening hours, the shop's social profiles in its chosen
order, and up to four link columns (a "Top categories" entry follows the catalogue by itself). About,
Contact and the four policies are written in a rich-text editor (TipTap), sanitised server-side with
`nh3`; the shop can add its own pages under `/pages/`. The Contact page embeds Google Maps (CSP
`frame-src` allows that origin only). A migration writes today's footer and page copy, so nothing
changes visually until someone edits it. Verified: pytest 1441 passed; vitest 362; tsc and lint
clean; and a browser pass as owner — social links saved, normalised and reordered by keyboard,
map generated and previewed, a policy edited in the editor and seen on the storefront, footer checked
at 1280 and 375. Two bugs were found and fixed in that browser pass, neither visible to a type check:
a constant exported from a `"use client"` module arrived in a server page as a client reference, and
the editor waited on toolbar state that TipTap only reports after the editor has mounted. Not yet
verified: tag-based revalidation end to end (the preview had no `WEB_REVALIDATE_URL`; the signals
and allow-list are unit-tested).

**[D95–D102](#known-defects): walking two screens nobody had used, and measuring five more security
controls, found eight defects — three of them the kind a customer or a till would notice.** An
account a person *named* was never checked, so a POS sale at one branch could land in another
branch's drawer and a cheque could be paid out of cash (D95). The order-tracking link, open to
anyone holding it, returned the shop's own record — staff emails, the reasons they typed, the
drawer each payment went into (D97). A parcel could be dispatched and delivered while its order
sat at CONFIRMED with the goods still counted on the shelf (D98). And `security.md`'s CSRF
double-submit token had never been built: with an owner's cookies, a request from another origin
changed an account (D101). CORS and CSP held exactly as documented. Details in
[§ Two screens walked, five controls audited](#two-screens-walked-five-controls-audited-eight-defects-fixed-d95d102-2026-09-24).

**[D89](#known-defects) and [D90](#known-defects): `Idempotency-Key` was accepted and ignored on
every finance and inventory endpoint, and where it *was* honoured the race recovery had never
worked.** Measured on `main`: the same key posted twice moved a cash balance **+2000 instead of
+1000**, and took **two** units off the shelf instead of one — and because both rows are honest
ledger entries, `verify_accounts` and `verify_inventory` reconciled afterwards and nothing flagged
it. Then the fix's own concurrency test found the second one: four simultaneous POS sale retries
sharing a key raised **`TransactionManagementError` three times out of four**, because the
`IntegrityError` was caught inside the outer `atomic()` with no savepoint, so the recovery query
could not run. That catch had been there since the feature was written. Details in
[§ D89 and D90 fixed](#d89-and-d90-fixed-a-retry-that-doubled-and-a-recovery-that-never-ran-2026-09-22).

**[D88](#known-defects): every rate limit could be bypassed with one header, and the audit trail
recorded whatever address the caller typed.** `X-Forwarded-For` is written by the client; DRF's stock
throttles key on the whole of it when `NUM_PROXIES` is unset, and `AuditContextMiddleware` took its
left-most entry. Measured against `main`: **40 wrong-password posts to `/auth/login/`, none refused**,
each logged under a different address of the caller's choosing — against a control that was refused
at the eleventh. Both now resolve the caller through `core.ip.client_ip`, which counts
`DJANGO_TRUSTED_PROXY_HOPS` entries from the **right**. The same 40 attempts are now refused at the
eleventh and Redis holds 3 buckets where it held 120. Found by auditing a control rather than by a
complaint, which is the fourth time that has paid. Details in
[§ D88 fixed](#d88-fixed-the-rate-limits-were-decorative-2026-09-21).

**[D6](#known-defects) is fixed and `mypy .` now blocks.** 271 errors in 41 files to **0 in 152**,
and the trailing `|| echo` is off the CI step, so the next error to arrive fails the build instead of
printing a warning nobody reads. Most of the 271 were one sentence repeated: DRF types `request.user`
as `User | AnonymousUser`, and a view guarded by `IsAuthenticated` has already ruled out half of it —
`core.requests.AuthedRequest` says that once, at 87 handlers. One annotation
(`MONEY_FIELD: dict[str, Any]`) accounted for 80 on its own. Two real defects fell out of the pass:
saving an address on a customer account with no customer row answered **500**, and `seed_demo` read
`ShippingMethod…first().pk` unguarded. Details in
[§ D6 fixed](#d6-fixed-and-the-type-gate-now-blocks-2026-09-21).

**[D40](#known-defects) is worked around, and a production build is 42/42 for the first time.**
`router.refresh()` fetches the new payload and discards it, the more reliably the heavier the page:
`/admin/expenses` measured 0/5, 0/5, 2/5 and 0/8 on one build while every write landed every time.
The root cause is still unknown and upstream, so the fix verifies rather than hopes —
`AdminLayout` stamps a `data-render-id` per server render and `refreshAfterWrite()` reloads only
when that stamp does not move. 8/8 where the bare call was 0/8. Six hypotheses died on the way,
including both that the morning's audit had nominated. [D77](#known-defects) closes as the same
defect. Details in
[§ D40 worked around](#d40-worked-around-and-the-admin-stopped-lying-after-a-write-2026-09-21).

**Every defect in this file was checked against the code on 2026-09-21, and two of the five open
rows were understating themselves.** 89 rows carrying 87 distinct defect numbers — 84 struck
through, 5 open — **2 by the end of the day**, once D40 and D77 were worked around and D6 fixed.
No struck-through fix was found to have regressed, and all 82 distinct fixes are present in the
layer each row names. What the audit changed is the open half.
**[D6](#known-defects) is 271 mypy errors in 41 files, not the 98 in 29 this file has claimed since
2026-08-18** — nothing broke, the gate simply runs with `|| echo` and never blocked, so five weeks
of new code accumulated errors unopposed. *(Fixed the same day: 0 errors, and the `|| echo` is
gone.)* And **[D40](#known-defects)
is app-wide, not one screen**: driven against a real production build, `router.refresh()` applied in
0 of 5 runs on `/admin/expenses`, 2 of 6 on brands, 4 of 6 on categories, and failed on the
stock-count sheet — while every write landed, every time. That makes [D77](#known-defects) the same
defect rather than a second one, across **63 `router.refresh()` call sites**. A production build now
runs **40/42 E2E**, and both failures are D40. Two numbering faults were fixed on the way: `D43` had
been issued to two unrelated defects (now `D43a`/`D43b`) and `D47` was listed twice. Full evidence
in [§ Every defect audited against the code](#every-defect-audited-against-the-code-2026-09-21).

**The audit trail and the stock ledger can be read now.** Both were complete APIs that everything
wrote to and nothing read back: the trail was unreadable without database access, and
`/admin/inventory` showed each figure but not the movements behind it. `/admin/audit` and
`/admin/inventory/movements` read them, every stock row links to its own history, and a ledger row
names the order, return, purchase order or count that caused it. Auditing the endpoints first found
that **the audit log was the one staff list with no branch scoping** ([D85](#known-defects)): an
accountant assigned to one branch could read every other branch's refunds, payments and stock
adjustments. Rules in [§ 1.9](business-rules.md#19-reading-the-ledger) and
[§ 8.1](business-rules.md#81-reading-the-trail).

**Changing a password now signs the account out everywhere, at once.** It did not: every session
already open kept working for up to fourteen days, so a cashier who changed a password they thought
someone else knew left that someone signed in, and an owner's reset from `/admin/staff` did the same
([D86](#known-defects)). `docs/operations/security.md` had listed "logout everywhere on password
change" as an account-takeover control all along. The current-password check also ran at the
general 600-a-minute rate and left no trace of a wrong guess ([D87](#known-defects)). Every staff
role can change its own password at `/admin/account` now — until today only an owner could, for
anyone. Rules in [§ 7.1a](business-rules.md#71a-your-own-password-and-your-sessions).

**The seed command could put the README's password on a production database, and did.**
`scripts/rebuild-local-prod.sh` runs `seed_demo --reset` against `config.settings.prod`, which gives
every role an account opening with `rangon12345` — printed in the public README — and that stack has
been published through the Cloudflare tunnel. The only guard was a comment reading "never reaches
production" ([D79](#known-defects)). Production settings now refuse the seed unless the operator opts
in for the one command and brings a password of their own, and the rebuild script stops before its
teardown if none is set.

**Auditing `purchase-orders/` found five defects that were still on `main`**, three of them money:
a purchase order with money paid against it could be cancelled, after which the payment was on no
list anywhere ([D80](#known-defects)); cancel and send decided against a stale copy, so a cancel could
land on an order a delivery was posting ([D81](#known-defects)); negative shipping, a discount above
its line and a variant named twice were stored ([D82](#known-defects)); one order line named twice in a
delivery kept only its last quantity ([D83](#known-defects)); and `generate-variants/` — which the
purchase order's new-product form calls — built SKUs on a specification attribute and skipped values
it did not know ([D84](#known-defects)). Every test was run against `main` as it stood first: ten of
twelve failed with the defect itself, and the two that passed are the controls. See
[§ 7c of business-rules.md](business-rules.md#7c-raising-and-cancelling-a-purchase-order).

Before that, **2026-09-18**. Two passes on 09-18.

**The second built the door out.** `TransactionType.PURCHASE_RETURN` had existed since the first
migration — scored in the sign table, accepted by the ledger — with **no service and no caller**, so
faulty goods could not be sent back at all. Meanwhile [§ 4](business-rules.md#4-costing-and-profit)
had always claimed a purchase return moves the weighted average cost: a documented rule with nothing
behind it. Both halves exist now, and the money side is a **credit, not a refund** — `grand_total`
never moves, `credited_total` accumulates beside `paid_total`, and payables subtract it. Rules in
[§ 7b](business-rules.md#7b-returning-goods-to-a-supplier).

Two defects fell out of writing the tests first. The overpayment guard ([D62](#known-defects)) read
`grand_total − paid_total` and knew nothing of credits, so goods could be sent back and the original
total still paid — handing the supplier money for stock sitting in their own warehouse. And the
payment badge, seen on real seeded data, read **partially paid** on a 925,030 order where nothing had
been paid and 3,600 had been credited.

Before that, the 09-18 pass closed the loop the owner described at the start:
purchase, receive, and the product is in the catalogue ready to go live.

Receiving now says what arrived that nobody can buy yet. A buyer creating a product from the order
that is buying it leaves it `DRAFT` with the retail price deferred, and nothing used to mention it
afterwards — the goods landed, the draft sat there, and the only way to notice was to go looking. The
purchase order screen now lists them, refuses to publish anything priced entirely at zero
([D75](#known-defects)) and links to where the price is set. The products list gained the third state
it had been collapsing: `status` and `published` are independent, the storefront needs both and the
POS grid needs only `status`, so an active unpublished product is not hidden — it sells at the
counter. It is badged *Counter only* now instead of *Hidden*, with filters for each state.

Building it found [D77](#known-defects): **receiving stock left the screen showing the un-received
state in 3 runs out of 5.** Pre-existing, affecting send and cancel equally. Two explanations were
tested and both were wrong; it is worked around with a real reload rather than explained, and that is
written down as such.

Before that, **2026-09-17**. Four passes on 09-17.

**The fourth made a purchase order able to create the product it is ordering.** The variant picker
used to dead-end — "Nothing matches, create the product first" — so a buyer had to abandon a
half-filled order, build the product on another screen and start the lines again. It now offers to
create it inline, scoped to the axes the chosen category declares, and puts the generated SKUs
straight onto the order. Rules in
[§ 7a.6 of business-rules.md](business-rules.md#7a6-creating-a-product-from-a-purchase-order).

Building it turned up two defects, both found only by driving a real browser. A product with every
variant at zero could be **published and sold for nothing** ([D75](#known-defects)) — which had to
be fixed first, because the new flow deliberately lets a buyer defer the retail price. And the
inline **"New supplier" button on the same screen had never worked**: nested `<form>` elements made
the page submit natively and reload, creating nothing and destroying the order the buyer was
halfway through ([D76](#known-defects)). The new product form had the identical bug before it
shipped.


**The third built `SupplierProduct`**, the piece that had no representation at all: nothing in the
schema joined a supplier to a product. `PurchaseOrderItem` points at a variant and `PurchaseOrder`
points at a supplier, and no row connected them — so the purchase order form defaulted every line to
`ProductVariant.cost`, the last price paid to *anyone*, and ordering from the cheaper of two vendors
pre-filled the dearer one's price. A variant now carries one offer per supplier, with their part
number, their lead time, their minimum and what they last charged; the list builds itself, because
receiving a delivery upserts the offer inside the same transaction as the ledger write. One supplier
per variant is preferred, enforced by a partial unique index. Rules in
[§ 7a of business-rules.md](business-rules.md#7a-supplier-pricing), which also sets out the three
cost fields and why they are not interchangeable.

The demo data had carried a second supplier since it was written and never bought anything from it,
so none of this would have been visible in the product — `Chattogram Leather Co.` now second-sources
every third line at 8% under. Same class of gap as [D54](#known-defects), fixed the same way.


**The second found that nobody could sign in.** The owner reported a white screen at the admin
login, and it was not the login page's fault: `middleware.ts` sends a per-request CSP nonce, Next
stamps that nonce at render time, and a page prerendered at *build* time carries none — so every
script on it is refused, 32 of them on `/login` alone. `/`, `/cart`, `/checkout`, `/about`,
`/brand`, `/contact` and `/policies/*` were all static and all equally dead in the browser;
`/login` was simply the one where it showed, because its form sits behind a `<Suspense>` with no
fallback and therefore rendered nothing at all ([D74](#known-defects)). `/checkout` was the
expensive one — the storefront could not take an order. The root layout now renders every page per
request, and a Playwright spec asserts it in a real browser, because nothing else can see this.

That makes [D16](#known-defects) a fix that re-broke what it fixed: the nonce cured the blank
production page, and only for the pages Next happens to render per request.

**The first closed two money bugs hiding behind a redundancy the owner spotted from the outside.**

**The observation was that adding a product and raising a purchase order do the same job twice**, and
that goods ought to enter through purchasing alone. Auditing the two paths before restructuring
anything found that the product form was not merely a duplicate — it was the *worse* of the two
doors, and the only one that put stock on the shelf without any money behind it.

`ProductForm` took an opening stock figure per variant and posted it to `/inventory/adjust/`. An
adjustment writes units in at the row's existing `average_cost` and never moves it, and that column
is `0.00` on a variant nothing has been received against. So stock created that way was valued at ৳0
by the valuation report and sold at 100% margin by the counter ([D72](#known-defects)) — while the
CSV importer, doing the same job, had always called `receive_stock` with the row's real cost.

Checking how the other half of that figure was read found a second one nobody had recorded: the POS
freezes the branch weighted average onto a sale line, and **online checkout froze
`ProductVariant.cost` instead**, because `price_cart` held the availability snapshots it needed and
never passed them to `price_lines` ([D73](#known-defects)). The same variant, sold twice in one
minute, booked two different costs depending on the channel — under a docstring promising that a
receipt and a web invoice can never disagree.

Both are fixed, with four regression tests that fail against the old code. Opening stock is gone
from the product form and the rule is written down at last, in
[§ 4.0a of business-rules.md](business-rules.md#40a-opening-stock) — it had never been stated
anywhere, which is how the zero-cost path survived this long. The restructure the observation asked
for (purchasing as the origin of goods, a `SupplierProduct` link, inline product creation on the
purchase order) is still ahead; this pass only made the costing correct underneath it.

Before that, **2026-09-15**. The second 09-15 pass did two things.

**The storefront's account surface was withdrawn, on the owner's instruction.** A shopper cannot
create an account — `auth/register/` has never had a screen in front of it — so everything gated on
a signed-in *customer* was theatre: the wishlist heart on every product card toggled optimistically
and rolled back on the 401, the account menu offered a sign-in shoppers had nothing to sign in to,
and the review form could only ever render "Sign in to review". The wishlist is gone outright; the
account menu, the `/account` pages and the review form went with it; `/login` still exists and still
works and is simply not advertised, because staff reach `/admin` and `/pos` by typing the address.
Reviews are now read-only. What was *kept and unadvertised* rather than removed is written down in
[endpoints.md](api/endpoints.md#the-customer-account-endpoints-have-no-caller-deliberately), so the
next endpoint-vs-caller audit does not read it as rot.

**The post-purchase tracking journey was built**, which was Tier 2 #6 and turned out to be the whole
journey rather than one endpoint. It was broken at every step: the footer's Track form 404'd on every
submission ([D67](#known-defects)), the page behind it was a thank-you page with a five-dot progress
bar, and no tracking number had ever been recorded because **nothing had ever created a shipment** —
so `orders.fulfil` was a permission no screen could exercise and the `tracking_url_template` on
`/admin/shipping` could never be filled. Auditing the endpoint first, as this file keeps
recommending, found four defects in a write path that had no `validate()` at all: it was the only
write viewset in the codebase with no branch scope ([D68](#known-defects)), it never consulted the
order's status ([D69](#known-defects)), it let a parcel be created already delivered with no event
behind it ([D70](#known-defects)), and two parcels could claim one courier's tracking number
([D71](#known-defects)). [D66](#known-defects) and [D47](#known-defects) were closed in the same pass.

Before that, **2026-09-15**. The first 09-15 pass made a purchase order payable. Auditing the backlog
against the code found that **`supplier-payments/` was a complete, live, registered API that nothing
called** — so `paid_total` was permanently `0.00`, the payables side of the party ledger could only
grow, and the cash position permanently overstated cash, while phases 07, 35 and 37 were all marked
green. Checking the endpoint before building over it found five defects, three of them money bugs
([D61–D65](#known-defects)): a payment could be recorded against another supplier's order, a supplier
could be overpaid until the order vanished from payables, and a double-click paid twice. The fifth is
why the screen had never been built — the endpoint returned 400 for every request, because the
serializer required a timestamp the service had always defaulted.

That audit also found this file's **"Still API-only (no UI): Nothing"** to be false in five places,
and two defects nobody had recorded: `/admin/products/import` has no permission check (D66) and the
Track-your-order form 404s on every submission (D67).

Before that, **2026-09-14**. The 09-14 pass built **product specification attributes** — the last
item on Tier 1 that waited on nobody. The catalogue sells clothing, shoes, bags *and* cosmetics, and
the only spec fields were the free-text `material` and `care_instructions` columns on `Product`,
which is exactly what §10 of the build plan says not to do. `Attribute.is_variant_defining` had split
the world in two since the first migration and the seed already marked Material, Gender and Fit as
*not* variant-defining — but **nothing could attach one to a product**, so those attributes existed
and were unreachable, and `CategoryAttribute` was read by the seed and by nothing else.
`ProductAttributeValue` is the missing half. Specifications are now stated on the product, scoped by
what the category declares, rendered on the product page and in its JSON-LD `additionalProperty`.
Shoes state a Sole, bags state Dimensions, cosmetics state a Skin type. See
[§ 5a of business-rules.md](business-rules.md#5a-product-attributes-axes-and-specifications).

Reading the rendered page found one more thing, which is the habit this file keeps recommending:
every seeded product carried **"Machine wash cold. Do not bleach."** — on a face serum and on a pair
of leather shoes. Demo data rather than code, like [D54](#known-defects), and fixed the same way.

**2026-09-13** shipped six of Tier 1 in four passes, and this file did not record them until now:

* **Abandoned checkout capture (#1).** The phone is kept the moment it is typed, as one `OPEN` lead
  per person rather than per attempt, canonicalised so `01712…` and `+8801712…` are one row; buying
  closes it by either route, storefront or counter. Nothing can mark a lead recovered by hand and
  nothing can delete one — the recovery rate is the figure the list is judged by.
* **Brand landing pages (#3).** `ShopHomeView` had served eight featured brands with logos since the
  home page was built, and the home page never rendered them; there was no route behind them either.
  `/brand` and `/brand/[slug]` now exist and the slug is forced from the route.
* **The fourth variant state (#5).** `findVariant` collapsed "no such combination" into its fallback
  and threw away which case it was, so a Medium that exists only in Navy looked identical to a Medium
  sold out everywhere. `stale` is now dashed rather than struck, because clicking it works.
* **WhatsApp float button (#4).** Env-gated; renders nothing when unset.
* **Price drops and real co-occurrence (#6).** "Customers also bought" had been same-category,
  exclude-self — a reasonable fallback under a dishonest headline. It now ranks by shared orders.
  Price drops rank by percentage, not cash.
* **Quick View (#7).** A card with more than one variant says "Choose options" instead of guessing.
  It also fixed a defect the pass before had shipped: `pk__in` answers unordered, so the merchandised
  rows arrived unranked and the live home page led "Price drops" with 15% off above a 30%.

Before that, **2026-09-12**, four things the owner could see: the admin sidebar
scrolled away with the page instead of staying put (D56), the storefront header went translucent and
lost its contrast over the black hero (D57), and up to three logo loaders drew on top of each other
during a slow navigation (D58). The fourth was not a defect — the admin header was mostly empty
space, and now carries a breadcrumb and a single identity block instead of three loose elements.

Also on 09-12: **attributes became editable**. `/admin/taxonomy` could list them and nothing
else — no create, no edit, no reordering of a value, no way to set a colour. It now does all
four, and a colour attribute gets a picker and a hex box on every value. Auditing the endpoint
first found two things (D59, D60), one of which was the reason the screen had been read-only.

The same day closed the three CVEs the image scan gates on — two critical Next.js RCEs and a HIGH in
sharp — by moving `next` to 15.5.24 and `sharp` to 0.35.4. **`main` is now green for the first time.**
The three merges before it (#24, #25, #26) all landed with `Build & scan images` red, so that gate had
been failing for weeks; it passes clean as of `ba9aa2f`.

Before that, **2026-09-11**, the dashboard's date filters, which the owner
reported as doing nothing. They were right, and for seven reasons: the presets computed their day
boundaries in UTC while the shop keeps Dhaka time (D49), `7d`/`30d`/`90d` were rolling hours rather
than calendar days (D50), the sales chart dropped days that sold nothing instead of drawing them flat
(D51), `yesterday` and `last_month` overlapped the period after them (D52), an unknown preset showed
thirty days under whatever name was typed (D53), every seeded order carried the instant the seed ran
so every preset returned the same total (D54) — and the admin rendered dates in the server's timezone
rather than the shop's, which headed a 1–31 August statement "31 Jul 2026" (D55).
"This month" and "Last month" now exist as presets; they did not before.

Two of these are worth remembering for how they were found. **D54** is why it looked *completely*
dead, and it was demo data rather than code — the software was fine, the fixture had no past.
**D55** was found only by reading the rendered page: this machine is `Asia/Dhaka`, so it is invisible
here and wrong in the container, and every test passed until one was run under `TZ=UTC`.

Before that, **2026-09-10**, the SMS layer — everything except the gateway
account — and two things it found on the way: the customer was never told their order had been
placed, and every order email carried a tracking link with no origin in front of it.

Before that, **2026-09-09**, across four passes. The first stored phone numbers one way (D48),
which was the last defect that could silently corrupt business data. The second finished phases 06,
26 and 28: a stock adjustment from the inventory screen, the doubled brand in product titles, and
every documented query budget finally asserted — which found the counter's grid search issuing 81
queries per search and the inventory list with no total order. The third recorded two scope
decisions rather than code: **offline POS (23) and the last two trade documents — quotation and the
cheque register (39) — were dropped**, on the owner's decision. The fourth built the two things that
needed nobody's permission and closed the three defects that would each have broken a first
deployment: **a product feed for Meta and Google**, **product import from a spreadsheet**, and
**D8, D14 and D15**. Before that: the walk-in and media defects on 09-01, the POS customer lookup on
09-03, and printable barcode labels on 09-04.

**Every phase is now ✅, or ❌ with the reason written down.** Nothing is left in the "someday"
state that a roadmap accumulates and never resolves. What remains is not building: a payment
gateway, two defects that keep E2E off a production build, and a deployment.

| #   | Phase                                 | Backend | Frontend | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | Project constitution                  | ✅      | —       | `CLAUDE.md`, `docs/`, 8 ADRs, CI workflow (now running — see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 01  | Brand + design system                 | —      | ✅       | Tokens, primitives, three shells. Official logo vectors wired. Route-transition + pending-state system on`LogoLoader` — see [design-system.md](design-system.md#waiting-which-loader-and-when)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 02  | Architecture                          | ✅      | —       | `docs/architecture/*`, ERD, domain model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 03  | Database                              | ✅      | —       | 12 apps, UUID PKs, Decimal money, constraints, migrations apply clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 04  | Auth + RBAC                           | ✅      | ✅       | JWT in httpOnly cookies, 7 roles, branch scoping, audit log, sign-in page. Admin settings can now**edit** the organization and create/edit branches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 05  | Product catalog                       | ✅      | ✅       | Full CRUD API. **Specification attributes shipped 2026-09-14** — `ProductAttributeValue`, a Specifications card on the product form scoped by `GET /categories/{id}/attributes/`, and a spec list on the product page. **Admin create/edit shipped 2026-08-21** — `/admin/products/new` and `/admin/products/[id]`: details, attribute tick-lists, a variant matrix with per-row price/cost/SKU/barcode, opening stock, publish/unpublish, delete-or-archive, and per-colour photography                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 06  | Inventory engine                      | ✅      | ✅       | Ledger, reservations, transfers, WAC,`verify_inventory`. Complete 2026-09-09. `/admin/inventory` gained a per-row **Adjust** action — the row you are looking at is the row that is wrong — alongside the write-off panel, and stock counts and transfers have had screens since phase 39. Building it found the list had no total order, so a corrected row could reshuffle (D13's shape, one table over), and that the expiring filter's ordering was silently discarded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 07  | Suppliers + purchasing                | ✅      | ✅       | PO → receive → ledger → cost recalculation.**Admin screens shipped 2026-08-22** — `/admin/purchases/new` (supplier picker with inline create, debounced variant search, line table, live totals), `/admin/purchases/[id]` (send, cancel, partial receive, delivery history) and `/admin/suppliers` (list + inline create/edit). Receiving is the only step that writes stock, and it goes through `inventory.services`                                                                                                                                                                                                                                                                                                                                                                                  |
| 08  | POS                                   | ✅      | ✅      | Barcode-first register, split payment, hold/resume, receipt, F2/F3/F4/F8 shortcuts. **Customer attach shipped 2026-09-03** — F3 opens a phone lookup over `GET /customers/lookup/`, with inline create when the search finds nobody; an unattached sale still files against the branch's walk-in row |
| 09  | Payments                              | ✅      | ✅       | Generic model + provider registry;`manual` provider (cash/card/MFS/COD) shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 10  | Returns                               | ✅      | ✅       | Full request→approve→receive→restock→refund + POS one-step return. **Admin screens shipped 2026-08-27** — `/admin/returns/[id]` drives approve / reject / receive / refund, with the per-line restock decision made at receipt and an account picker on the refund |
| 11  | Customers                             | ✅      | ✅       | Phone-first identity, addresses, notes, history. **Admin create/edit shipped 2026-08-28** — `/admin/customers/new` and `/admin/customers/[id]`: profile, addresses with a managed default, notes and order history. The endpoint audit that preceded it found four defects — see D24–D27 |
| 12  | Online store                          | ✅      | ✅       | Home, shop, product, cart, checkout, order tracking, account, policies. Browser journey verified end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 13  | Search + filters                      | ✅      | ✅       | Postgres trigram + indexed facets; facet UI with colour swatches; navbar type-ahead suggest (products / categories / popular searches) backed by a`SearchTerm` log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | Cart                                  | ✅      | ✅       | Server-authoritative, re-priced on every read, drawer + full page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | Checkout                              | ✅      | ✅       | Idempotency keys, reservation, COD, server-side totals, error summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 16  | Online payments                       | 🟡      | 🟡       | Abstraction + COD complete.**No live gateway** — the card option is disabled in the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 17  | Orders                                | ✅      | ✅       | Status machine, timeline, admin list + detail with status changes, payment capture, refunds, printable A4 invoice and packing slip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 18  | Shipping                              | ✅      | ✅       | Zones, methods, shipments, courier-ready interface. Checkout picks a method. **Fulfilment shipped 2026-09-15** — a Delivery panel on `/admin/orders/[id]` books a parcel and records tracking updates, and the customer's order page shows the courier, tracking number, a link to the courier's site and the parcel's history. Until then `ShipmentViewSet` had no caller at all: `orders.fulfil` was unreachable through the product and `Courier.tracking_url_template` could never be filled. Auditing it first found four defects — D68–D71. **Admin screens shipped 2026-08-28** — `/admin/shipping`: zones with nested methods, couriers, and a warning when no fallback zone exists. That endpoint audit found four more — D32–D35 |
| 19  | Coupons                               | ✅      | ✅       | Full engine + API; cart can apply/remove. **Admin screens shipped 2026-08-28** — `/admin/coupons`, with a type-aware form and a state column that separates live from scheduled, expired and used up. The endpoint audit found a money race and three validation gaps — D28–D31 |
| 20  | ~~Wishlist~~ + reviews                | ✅      | 🟡       | **Wishlist removed 2026-09-15, owner's decision** — no shopper can create an account (`auth/register/` has no screen), so the heart on every product card toggled optimistically and rolled back on the 401. Reviews are now **read-only** for the same reason: existing ones render, the write form is gone. The API and the moderation queue are untouched; restore both the day customer accounts exist. Everything below describes what was built and is kept as the record. **Wishlist fixed 2026-08-21** — a heart control on the product card (`WishlistHeart`, top-right of the image, optimistic toggle) and a shared `useWishlist` store back the header count and `/wishlist`. **Reviews fixed 2026-08-21** — the section always renders and carries a star-rating form (`ReviewForm`) posting to `POST /shop/products/{slug}/reviews/`. D1 and D2 struck through below **Moderation screen shipped 2026-08-28** — `/admin/reviews` with a status filter, approve/reject and a moderator note. The endpoint audit found three defects — D36–D38 |
| 21  | Dashboard                             | ✅      | ✅       | Server-aggregated KPIs, sales chart with a table alternative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22  | Reports                               | ✅      | ✅       | 8 report endpoints + CSV export, with a reports screen (product performance + CSV download for all seven)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 23  | Offline POS                           | ❌      | ❌       | **Dropped 2026-09-09, owner's decision.** Not deferred — declined. A large build (local queue, sync, conflict resolution on a ledger that must not oversell) against an occasional outage a paper pad already covers for one counter. The design notes stay in `architecture/offline-pos.md` as a record of what was considered, not as a plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 24  | Barcode + printing                    | ✅      | 🟡       | Keyboard-wedge scanning, barcode generation, and **printable label sheets shipped 2026-09-04** — `/admin/labels`, EAN-13 drawn as vector SVG with quiet zones, on A4 65/40/24-up or a 50x25 mm thermal label. Print CSS for 80 mm receipt and A4. No ESC/POS driver |
| 25  | Notifications                         | 🟡      | ✅       | Model, in-app feed API, Celery email tasks.**UI shipped 2026-08-21** — a polling bell in the admin header and `/admin/notifications` with all/unread filtering and mark-as-read. **SMS built 2026-09-10** — provider interface, `console` no-op default, registry, an `SmsMessage` log, segment counting and an allowlist guard, wired to order confirmed / shipped / refunded. Partial only because the **last mile needs an account**: a real gateway is one class and a settings line. See [operations/sms.md](operations/sms.md). The same pass found the customer was never told their order was placed at all, and that every order email carried an unusable relative tracking link |
| 26  | SEO                                   | ✅      | ✅       | Metadata, OG, sitemap, robots, canonicals, JSON-LD product + breadcrumbs. The doubled brand in product titles ([D4](#known-defects)) was fixed 2026-09-09                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 27  | Security                                | Controls implemented, audits and image scans automated **and passing clean as of 2026-09-12**; still **no independent penetration test** |
| 28  | Performance                           | 🟡      | 🟡       | Every list endpoint swept: four N+1s fixed (home 511→29, listing 363→13, purchase orders 156→15, and **POS grid search 81→5** on 2026-09-09) plus a per-keystroke POS request storm. **All ten documented budgets are now asserted** — that table had said "enforced in tests" while two of ten were, which is how the counter's own search sat at nine queries a row. Product detail's budget was raised from an unmeasured 10 to 18 deliberately. Remaining: no load test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 29  | E2E testing                           | ✅      | ✅       | Playwright drives the four critical flows. **20/20 green** against `next dev`, reseeded, 2026-08-31 — and **now a CI job**. **Re-measured 2026-09-21: the suite is 42 specs and a production build passes 40**, with both failures [D40](#known-defects) — the expenses spec it was found on and the stock-count spec, which nobody had connected to it. D41 was fixed 2026-09-09 and D40 was worked around the same day, after which a production build ran **42/42**. **The CI job moved onto a production build on 2026-09-21**: it builds the app and serves it from the standalone `server.js` the image itself runs, so the suite now drives the artefact that ships rather than `next dev` |
| 30  | Deployment                            | 🟡      | 🟡       | Compose prod stack;**CI now runs and is green at `HEAD`**, including the production build and image scans. Still **no live environment**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 31  | Backup/recovery                       | ✅      | —       | Scripts + runbook written, and **the restore has now been rehearsed for real** — 2026-08-22, against a production database that was actually destroyed. See the verification log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 32  | Production launch                     | ⬜      | ⬜       | Blocked on`docs/operations/go-live-checklist.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 33  | Dynamic navigation                    | ✅      | ✅       | Category-driven navbar with a one-table override,`/category/[...slug]` URLs (with a 308 redirect from the old `/shop?category=`), announcement bar, search suggest, admin editors for navigation overrides and banners. Phases N0–N6 done — [architecture/navigation.md](architecture/navigation.md#7-phases); decisions in [ADR-0009](architecture/decisions/0009-category-driven-navigation.md) and [ADR-0010](architecture/decisions/0010-radix-navigation-menu.md). Category reorder + icon (a category-scoped admin screen) not built — see navigation.md §7 N5                                                                                                                                                                                                                                                 |
| 34  | Colour-linked product media           | ✅      | ✅       | Images bind to a colour`AttributeValue` rather than a variant; selecting a colour moves the gallery without hiding any image; clicking another colour's thumbnail repairs the other axes. Phases B1–B3 all done — **B3 landed 2026-08-21** with the admin product form it was blocked on — [architecture/product-media.md](architecture/product-media.md#6-phases)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 35  | Financial accounts + cash book        | ✅      | ✅       | **F1 shipped 2026-08-22.** `finance` app: `Account` (cash/bank/MFS, per branch), append-only `AccountTransaction`, `AccountTransfer`. Balance is a reconciled cache with a `verify_accounts` command, exactly as `Inventory.on_hand` sits over `InventoryTransaction`; an opening balance is an `OPENING` row, not a column. Sales, refunds and supplier payments post inside their service's atomic block — **on capture, never on record**. `/admin/finance` (cash position, accounts, cash book, transfers, manual entries), per-tender account in the POS, account pickers on COD capture and refunds. 61 new tests incl. 4 threaded. [architecture/finance.md](architecture/finance.md) · [ADR-0011](architecture/decisions/0011-append-only-cash-book.md). **Unblocks 36–39**  |
| 36  | Expenses                              | ✅      | ✅       | **F2 shipped 2026-08-27.** `ExpenseCategory` + `Expense` posted through `finance.services.record_expense()` — document and `EXPENSE` cash-book movement in one transaction, so neither can exist without the other. Voiding posts a compensating `ADJUSTMENT`; nothing is deleted. `/admin/expenses` with a period filter, spend tiles, category-wise split, receipt upload and CSV. Nine categories seeded by migration. New permission `finance.expense` (owner/admin/manager/accountant, **not** cashier). 57 tests |
| 37  | Party ledger — receivable / payable  | ✅      | ✅       | **F3 shipped 2026-08-31.** `finance.selectors.party_ledger`, `GET /party-ledger/` and `/admin/finance/parties`: both sides derived from orders and purchase orders, ageing buckets, a net position, and every party expandable to the documents behind its balance. **No balance column on `Customer` or `Supplier`** — a stored balance drifts from the documents it summarises. Needed no answer to D-A: a credit sale is already an order with a balance |
| 38  | Business report → net profit         | ✅      | ✅       | **F4 shipped 2026-08-31**, unblocked by settling VAT. `reports.services.business_summary`, `GET /reports/business-summary/` and `/admin/reports/business`: revenue net of VAT, less refunds, less COGS plus the cost recovered from restocked returns, less expenses, to net profit — with a CSV of the statement |
| 39  | Trade documents                       | ✅      | ✅       | **Damage, stock count and transfer shipped 2026-08-27.** `/admin/inventory` gains a write-off panel and a Branch column; `/admin/inventory/transfers` and `/admin/inventory/counts` are new, with a count sheet that shows variance live. The count was **not** the form work this row promised — `counted_quantity` had no write path at all, so `apply` was a no-op; `record/` and `cancel/` were added and `apply/` now refuses an empty or already-applied sheet. Barcode label sheets shipped 2026-09-04 (`/admin/labels`), as the phase 24 row says. **Quotation and the cheque register were dropped 2026-09-09 on the owner's decision** — both are wholesale instruments, and this shop sells retail: a quotation is how you sell to a business customer, and a cheque register only earns its keep when suppliers are paid by cheque. A cheque can still be recorded today as a payment into a `BANK` account; what is declined is the Pending → Deposited → Cleared / Bounced lifecycle around it. Revisit if the trade changes |

Phases 35–39 come from a signed-in, read-only walk of all 56 screens of the **Bseba ERP**
(`erp.bseba.com`, Dostishop tenant) on 2026-08-21 — written up with a have-it / build-it / decline-it
verdict per feature in [planning/bseba-erp-feature-audit.md](planning/bseba-erp-feature-audit.md).

The finding: Rangon matches or beats that ERP on catalogue, purchasing, POS, returns, stock and
reports — and has a storefront it has no equivalent of — but **has no financial layer at all**. Rangon
records a payment *method* and never which account the money landed in; there are no expenses, no
receivable/payable, and therefore no net profit. That is what 35–39 close.

Deliberately declined, with reasons in the audit: the ERP's marketplace, EMI/instalments, investor
register and attendance/payroll. Also declined, because they break rules this codebase is built on:
typing `Stock QTY` on a product form (CLAUDE.md §3.2), setting sale price inside the goods-receipt
screen with no record of why, and the single-product-no-variants model.

Phases 33 and 34 were designed from external design input reviewed 2026-08-21 (the navbar specification
in `rangon_fashion_dynamic_navbar_design.md` and a read of the Dosti Shop codebase) and implemented
2026-08-21. The wider backlog drawn from that review — CSV import, media library, four-state variant
availability (now partly folded into the buy panel rewrite above), Quick View, Meta feed, and the rest —
is still open and tracked in
[planning/dostishop-feature-review.md](planning/dostishop-feature-review.md).

## Verification log

### Staff personal details, and order search on the screen, 2026-09-25

Asked for: keep more about each member of staff (phone, present and permanent
address, "other important information"), and let the orders list be searched
by order number and narrowed by date.

**Staff.** `StaffProfile` (migration `accounts.0003`) holds designation, joining
date, date of birth, national ID, blood group, both addresses, an emergency
contact and notes; the phone was already on the account and is now a column in
the list. What else counts as "important" was not specified: that set is the
documented default. The rules are [business-rules §7.1b](business-rules.md#71b-personal-details),
with one `DECISION REQUIRED`: only owners (`users.manage`) see any of it, so a
branch manager cannot read their own team's emergency contacts. Clicking a row
on `/admin/staff` now opens `/admin/staff/{id}`, where the account and the
details are read and edited; the list keeps create and activate/deactivate.

Two things were built in because they are easy to get wrong later:
- the audit log records **which** profile fields changed, never their values —
  `audit.view` is a wider circle than `users.manage`, and an address or an ID
  written into the log would have been readable by it;
- the API leaves the `profile` key out for anyone without `users.manage`, and
  the form sends no profile when it received none, so a save cannot erase
  details the person saving could not see.

**Orders.** The API has accepted `search` (number, customer, phone) and
`date_from`/`date_to` since the orders screen was built; the screen sent
neither. It now has the shared filter bar. The new tests pin the date edge that
matters here: an order placed at 00:30 in Dhaka is the 24th, although it is
still the 23rd in UTC.

**Verified by tests, not in a browser.** Nothing had a signed-in admin session
to drive the new staff page. The form's own logic — empty dates sent as null,
the "same as present" copy, no profile sent when none was received, a nested
server error landing under its field — is covered by `staff-form.test.tsx`.
`fieldErrors()` now flattens nested details (`profile.national_id`); it used to
render them as "[object Object]".

```text
backend  tests/api/test_staff_profiles.py        14 new
         tests/api/test_order_list_filters.py     6 new
         full suite                               1326 passed
web      staff-form.test.tsx                      5 new
         client.test.ts                           1 new
         full vitest (TZ=UTC)                     334 passed
gates    ruff, ruff format, makemigrations --check, mypy, tsc, next lint: clean
```

Deploying needs `manage.py migrate` for `accounts.0003_staffprofile`.

### Two screens walked, five controls audited, eight defects fixed (D95–D102), 2026-09-24

Asked for after D91–D94: use the two screens nothing had exercised — the supplier
payment form, and an order's Delivery panel with the customer's parcel view — in
a real browser; measure the next five rows of `security.md`; put secret scanning
in CI. Both screens worked as screens. What they were connected to did not.

**The supplier payment form** passed every path in Chromium: a comma amount and a
three-decimal one refused at the field, more cash than the drawer holds refused
with the balance, a ৳1,000 bank payment recorded with Paid, Outstanding and the
history updated, a double click making one payment. What it *sends* led to D95 —
the account it names was never checked, by it or by anything else:

```text
as staff bound to branch A, naming an account         before        after
  POS sale, takings into B's drawer ................  201           400
  POS sale, card takings into A's cash drawer ......  201           400
  refund out of B's drawer .........................  201           400
  card sale refunded in cash, account left blank ...  out of bank   out of drawer
  supplier payment for B's purchase order ..........  201           403
  supplier payment out of B's drawer ...............  201           400
  cheque paid out of a cash drawer .................  201           400
  GET supplier-payments/ ...........................  every branch  own branch
```

The order and return screens were then walked again as the fix changed them: a
৳10 cash refund of a card sale left the drawer (48,227.66 → 48,217.66) with the
bank untouched; a return refunded from a second cash box (5,000 → 4,110); a COD
remittance landed in the drawer chosen (4,110 → 5,070). The second cash box is
how D96 surfaced — the Accounts screen could not open one.

**The Delivery panel** worked on a packed order: booked with a courier and a
tracking number, the same number refused a second time at the form, dispatch
moving the order to SHIPPED and delivery to DELIVERED, the customer's phone view
showing the parcel, the courier's link and every update. Around it:

```text
parcel on a CONFIRMED order: dispatched, in transit, delivered
  order status ........... CONFIRMED throughout            (D98 -> 409, "pack it first")
  customer's page ........ "We will call you before delivery" over a Delivered parcel
  stock .................. still on the shelf, reserved
GET /shop/orders/RGN-WEB-000003/?token=…  anonymous       (D97)
  events[].actor_email ... manager@rangon.test, owner@rangon.test
  events[].data .......... the typed reason, payment and parcel ids
  also ................... internal_note, created_by_email, payments[].account_name,
                           register, stock_committed
  timeline ............... "PENDING → CONFIRMED", "COD 960.00", "DISPATCHED: …"
after: named keys only; "Order placed · Order confirmed · Being prepared · Packed ·
       Parcel booked with the courier · On its way · Delivered"
```

The walk booked three parcels, and the next `seed_demo --reset` died on them (D102).

**Five controls, measured against a production build and a production-settings API:**

```text
CSRF      "SameSite=Lax + a double-submit token"              no token existed (D101)
            PATCH with the owner's cookies, Origin blog.shop.example ... 200 -> 403
            sign-in, sign-out, password change from another origin ..... 200 -> 403
            same origin, no Origin, any read ........................... unchanged
CORS      "allow-list; wildcard forbidden in production"      holds
            Origin evil / shop.example.evil.com / http:// / null ........ no ACAO
            Origin on the list ....................................... ACAO + credentials
            DJANGO_CORS_ALLOWED_ORIGINS='*' ............ refused at start (corsheaders.E013);
                                                         forced past it, matches nothing
CSP       "nonce + strict-dynamic, no unsafe-inline"          holds
            9 routes incl. a 404 and two redirects: script-src 'self' 'nonce-…'
            'strict-dynamic'; every <script> carries the nonce; a new nonce per request
Errors    "no traces, SQL or settings"                        one path around it (D99)
            unhandled exception -> 500 + request id; IntegrityError -> bare 409
            coupon re-check -> the SQL, in the shopper's cart ............ fixed
Webhooks  "capture needs a verified webhook"                  holds today; latent flaw (D100)
            forged payment.success, manual or unknown provider ....... 404, nothing captured
            verified event for another provider's payment / for ৳1 of ৳1,000 ... captured -> refused
```

Two smaller notes, neither a defect. The CSP matcher's "skip files with an
extension" pattern loses its backslashes inside a plain string, so `robots.txt`
and SVGs get the policy too — harmless, and for an SVG useful. And the dependency
audits in CI are advisory: both end in `|| echo "::warning::…"`, so they have
never failed a build; `security.md` now says so.

**Secret scanning.** gitleaks 8.21.2, pinned and checksum-verified, over every
commit on every branch — 133 non-merge commits across 33 branches: one finding,
a test fixture's password (the rotation a re-seed must leave alone), in two
commits — the one on `main` and its first copy on a feature branch. Both are
accepted by fingerprint in `.gitleaksignore` with the reason. The working tree,
scanned separately, finds the same line and nothing else. CI runs it on every
push and pull request, and a finding fails the build — as it did on its first
run here, because the check before that push had scanned only this clone's
branches and CI's checkout fetches them all.

**Every new test was run against the old code before it was believed.** 28
failed there for the stated reason and 15 controls passed. D101 lives in the web
server, so its proof is the HTTP table above, before and after, plus 46/46 E2E
against the fixed build — every real flow sends `Origin`. One existing test
changed: `test_the_refund_can_name_the_account_it_leaves_from` refunded cash out
of an `OTHER`-kind box, which D95 refuses; it names a second cash box now, which
is what it was about, and a new test pins the refusal.

```text
pytest ................................. 1306 passed        (46 new)
mypy . ................................. clean, 154 source files
ruff check . / format (0.8.4) .......... clean
vitest ................................. 324 passed         (23 new)
Playwright, production build ........... 46 passed
gitleaks, every branch ................. no leaks (1 fixture, 2 commits, by fingerprint)
```

### Three controls audited, four defects fixed (D91–D94), 2026-09-23

Asked for after the D89/D90 pass: take the rest of `security.md`'s control table
and measure it against the code the same way. Three rows were chosen — uploads,
the session, branch scoping — and each was probed over HTTP before anything was
read as settled. Two of the three held up in part and failed in part; the third
failed outright.

**Uploads — one defect, three overclaims.** The first hypothesis was a stored-XSS
polyglot: four image fields had no validation of their own. **It was wrong** —
all four refused a decodable GIF named `.html`, because Django's model-level
extension validator runs. What they lacked was the size cap (an image over it:
**201**) and the four-format allow-list (Pillow decodes ~70, PostScript among
them). The doc also claimed images are re-encoded (nothing re-encodes) and served
from a separate origin (with `USE_S3=0` they are served by Django from the shop's
own). Then the real one — **D91**:

```text
manager uploads receipt.png  ->  stored as expenses/2026/09/receipt.png
anonymous GET /media/expenses/2026/09/receipt.png  ->  200 image/png
```

**Session — D92.** Rotation held: a rotated refresh token is refused. Logout did
not, measured four ways:

```text
logout, live access token ..... 204   refresh afterwards 401   (works)
logout, expired access token .. 401   refresh afterwards 200   (new pair issued)
logout, no access token ....... 401   refresh afterwards 200
```

**Branch scope — D93 and D94**, found by a sweep rather than by reading
viewsets: seed branch B with one of everything, sign in at A as a manager and as
an accountant, and GET all 97 parameter-free routes plainly and with
`?branch=<B>`. Two leaks by id — the transfer list and the returns report — then
a second probe by figure, because aggregate reports carry no ids:

```text
GET reports/<name>/?branch=<B>, as a manager bound to A
  dashboard ............ 200  B's ৳7,777.77 sales and ৳5,603 stock value
  sales ................ 200  ৳7,777.77
  inventory/valuation .. 200  ৳5,603
  expenses ............. 200  ৳3,333.33
  ?branch=<random UUID>  200  every branch's figures
POST stock-transfers/ source=B, target=A, as a manager bound to A
  201, B on_hand 10 -> 8 (and 8 -> 6 as an inventory manager)
```

**Every new test was run against the old code before it was believed.** 45
failed there for the stated reason and 15 controls passed, as controls should.
**Two passed that should not have**, and were rewritten until they failed:
`test_it_is_never_throttled` passed because the test settings empty the default
throttles, so the old view looked unthrottled here while production would have
throttled it; and a 404 for "expense has no receipt" passed because the route did
not exist yet. Now the first asserts the view declares its own empty list, and
the second asserts the endpoint's own message.

```text
pytest ................................. 1250 passed, 4m11s   (1188 + 62 new)
mypy . ................................. clean, 154 source files
ruff check . / format (0.8.4) .......... clean, 216 files
makemigrations --check --dry-run ....... No changes detected
vitest ................................. 290 passed
tsc --noEmit / eslint (changed files) .. clean
```

Verified live, `next dev` against the API: a JPEG uploaded through the proxy as
`IMG_0412.jpg` was stored under a random name and **came back byte-identical**
(same sha256) through `/api/proxy/expenses/{id}/attachment` with `no-store` and
`nosniff`; 401 signed out; 404 on `/media/` under two spellings. JSON and a CSV
export still pass through the changed proxy. Signing out through the real web
route with the access cookie removed left the refresh token dead (401). A report
asked for a random branch id answered 404.

**Left as decisions, not changed silently** (business-rules §7.1): the staff list
spans branches; a non-owner created with no branch sees every branch. **Left as
work** (security.md "Not done"): re-encoding images, and refresh-token reuse
detection.

### D89 and D90 fixed: a retry that doubled, and a recovery that never ran, 2026-09-22

The backlog was empty again — Tier 1 done, Tier 2 waiting on photography, three
of Tier 0's four items not code — so a control was audited instead of a feature
built, which is now the third time that has paid.

**D89, measured on `main` against the running API as the owner:**

```text
balance before ........ 342205.00
POST #1 -> 201   POST #2 -> 201     (same Idempotency-Key)
balance after ......... 344205.00   -- +2000, not +1000

on_hand before ........ 9
write-off #1 -> 201   write-off #2 -> 201
on_hand after ......... 7           -- two units gone, not one
```

CLAUDE.md §7 asks for the header "where a retry could double-charge or
double-deduct". `orders` read it in 3 of 3 view modules and `purchasing` in 1
of 1; **`finance` and `inventory` read it in 0 of 1 each**, and no model in
either app carried the column. The header was accepted, never stored, never
checked. And because both rows a replay leaves behind are honest ledger
entries, `verify_accounts` and `verify_inventory` reconcile afterwards — the
cash book and the shelf are simply wrong, and nothing detects it.

Five operations were exposed: cash movements, account transfers, expenses,
write-offs and stock transfers. Two deliberately need no key and are asserted
rather than argued: `adjust` states an absolute `new_on_hand`, so a replay is a
no-op, and `stock-counts/{id}/apply` is a status transition that answers 409.

**D90 was found by D89's own concurrency test**, which is the reason to write
one. Four simultaneous POS sale retries sharing a key, against `main`:

```text
AssertionError: ['TransactionManagementError("An error occurred in the current
transaction. You can't execute queries until the end of the 'atomic' block.")',
 ... 3 of 4 threads]
```

The `except IntegrityError:` recovery was inside the outer `transaction.atomic()`
with no savepoint, so the error poisoned the transaction and the lookup that was
supposed to return the winner's order could not run. A cashier double-tapping
"Complete sale" on a slow connection got a 500 instead of the receipt. **The
catch had been there since the feature was written and had never worked.**

Three sites had it (POS sale, checkout, refund), one had a pre-check and no
recovery at all (purchase return), and **two were already correct** — the
supplier payment and the webhook dedupe, both of which use an inner `atomic()`.
An earlier draft of this entry said "all four", which was wrong; the two correct
ones are the newest, which suggests whoever wrote them knew.

**The ordering mattered more than the constraint.** The first implementation put
the key check before the row lock only, and the write-off race test caught it:
four retries released together all read nothing, then queued on the lock, and
the losers failed the *stock* check — "Only 0 unit(s) in stock" for a write-off
they had already made. The key is now re-read **after** the lock and **before**
the business validation, in both `inventory.apply_transaction` and
`finance.record_movement`. The cheap pre-check stays, so an obvious replay never
takes a lock at all.

```text
pytest ................................. 1188 passed, 4m27s   (1177 + 11 new)
  of which concurrency ................. 20 passed
mypy . ................................. clean, 154 source files
ruff check . (0.8.4, the pinned one) ... All checks passed
ruff format --check . .................. 212 files already formatted
makemigrations --check --dry-run ....... No changes detected
verify_inventory / verify_accounts ..... consistent, after the probes
```

Re-measured over HTTP after the fix: `+1000` for two posts sharing a key,
`+2000` for two without one (the control — a fix that merged genuinely separate
deposits would be worse than the defect), and `on_hand` down by one, not two.

### D88 fixed: the rate limits were decorative, 2026-09-21

The fifth pass of 09-21, and the first one this file did not ask for: with
Tier 1 empty and Tier 2 down to an item that waits on photography, the backlog
had nothing to hand over. So a control was audited instead of a feature built,
which is the habit that produced D59/D60, D85–D87 and the two defects inside
the D6 pass.

**What was measured, against `main`, with the API and Redis running.**

```text
control: 14 wrong passwords, no header ... 401 x10 then 429 x4   <- the limit works
bypass:  40 wrong passwords, X-Forwarded-For: 203.0.113.$i
                                         ... 401 x40, none refused
redis after the bypass run ............... 120 keys (40 buckets x 3 classes)
audit rows for those 40 attempts ......... 40 distinct attacker-chosen addresses
```

`auth` is 10/min. It is the limit between one address and every password in a
word list, and it did not exist for anyone who sent a header. The same is true
of `checkout` (20/hour), `search` (120/min) and the general `anon` rate.

**Why.** DRF's `BaseThrottle.get_ident`, with `NUM_PROXIES` unset — it never
was — ends at `return ''.join(xff.split()) if xff else remote_addr`. The header
is client-supplied and Nginx *appends* to it rather than replacing it, so the
caller controls a prefix of the throttle key. `AuditContextMiddleware._client_ip`
had the mirror-image fault: it took the **left-most** entry, commented "the
original client", which is exactly the part the client writes.

**The fix is one rule with one implementation.** `core.ip.client_ip` counts
`settings.TRUSTED_PROXY_HOPS` entries from the right — the entries our own
proxies appended — and falls back to `REMOTE_ADDR` when the header holds fewer
than that, because a request that did not come the way we were told is not one
to take a hint from. `core.throttling` subclasses the three DRF throttles to
key on it; the audit middleware calls it directly. A test asserts the two agree
on the same request, because two implementations of this rule is how the defect
came to exist in two places at once.

**The default is 0, and that is the interesting decision.** Too low, callers
share a bucket and honest traffic gets 429s — visible within the hour. Too high,
the limit silently stops applying. `docker-compose.prod.yml` sets 1 beside the
Nginx that is the only service publishing a port; put a CDN in front and it is
2. `docs/operations/security.md` carries the rule and the topology table.

**A first draft of the tests passed against `main` and proved nothing.** It
aimed at `auth/password/change/`, and `ScopedRateThrottle` keys on
`request.user.pk` once the caller is authenticated — so D87's limit was never
reachable this way, and the test was measuring the wrong endpoint. Anonymous
requests are the whole of it. Corrected, and re-expressed without the new
modules, the behaviour tests fail on `main` and their control passes:

```text
test_..._by_changing_the_header ....... assert [401, 401] == [429, 429]
test_..._reach_the_audit_trail ........ assert '203.0.113.9' != '203.0.113.9'
test_control_one_address_is_limited ... passed -- main does limit a caller
                                        who does not vary the header
```

**A second draft passed alone and failed inside the suite**, which is the same
shape of mistake one layer down. `APIView.throttle_classes` is read from
`api_settings` once, at import, so `override_settings(REST_FRAMEWORK=...)` never
reaches a view that is already imported, and the result depended on what had run
first. The tests patch the view's own attribute now.

**Verified live after the fix**, same probe as the measurement above:

```text
40 posts, each a different X-Forwarded-For ... 401 x10 then 429 x30
redis buckets ................................ 3, not 120
hops=1, forged prefix + proxy entry .......... 401 x10 then 429
hops=1, a second real caller ................. 401 -- not collateral damage
audit rows ................................... 198.51.100.7, never 203.0.113.*
```

```text
pytest ................................. 1177 passed, 4m10s   (1161 + 16 new)
mypy . ................................. clean, 154 source files
ruff check . (0.8.4, the pinned one) ... All checks passed
ruff format --check . .................. 211 files already formatted
makemigrations --check --dry-run ....... No changes detected
```

### D6 fixed, and the type gate now blocks, 2026-09-21

The fourth pass of 09-21. The morning's audit had found [D6](#known-defects)
drifted by a factor of nearly three — 271 errors in 41 files, not the 98 in 29
recorded on 2026-08-18 — for one reason: the CI step ran `mypy . || echo`, so it
had never once failed a build.

```text
mypy .  before ......................... 271 errors in 41 files, 151 source files
mypy .  after .......................... Success: no issues found in 152 source files
pytest ................................. 1161 passed, 4m17s   (1158 + 3 new)
ruff check . (0.8.4, the pinned one) ... All checks passed
ruff format --check . .................. 208 files already formatted
makemigrations --check --dry-run ....... No changes detected
```

**The count was never the work.** 189 of the 271 were `arg-type`, and the single
largest group inside that — 81 — was one sentence repeated: DRF types
`Request.user` as `User | AnonymousUser`, and a handler behind `IsAuthenticated`
has already ruled out the second half. `core.requests.AuthedRequest` states that
invariant once and 87 handlers now annotate their request with it. It is a
declaration only: the class is never instantiated, so nothing shadows DRF's
property at runtime.

**Where that trick does not work, and why it matters.** Annotating
`AuthedRequest` on a method that *overrides* a DRF mixin — `create`, `update`,
`list` — produced 12 new `[override]` errors, and they were right: narrowing a
parameter in an override is a Liskov violation however true it happens to be
here, because DRF calls those methods through the base class. Those 12 went back
to `Request`, with `core.requests.actor(request)` inside. 36 call sites use it.

**One annotation was worth 80 errors.** `finance/api/serializers.py` defined
`MONEY_FIELD = {"max_digits": 16, "decimal_places": 2}`, inferred as
`dict[str, int]`; every `DecimalField(**MONEY_FIELD)` below it then drew one
error per `DecimalField` parameter it could not match. Eight lines, 80 errors,
one `: dict[str, Any]`. `RANGON` and `STORAGES` in `config/settings/base.py`
were the same shape and took about ten more with them.

**Two real defects fell out of the pass**, which is the argument for the gate:

* `POST /shop/account/addresses/` answered **500**, not 404, for a signed-in
  CUSTOMER account with no `Customer` row behind it — `IsCustomer` proves the
  role, not the row, and `customers.services.add_address` then read `None.pk`.
  Registration is the only path that creates the row, so any staff-created or
  fixture-made customer account hit it. Now a 404 in the standard envelope,
  with three tests (`tests/api/test_shop.py::TestAccountAddresses`); the first
  of them fails with the old code, against a real `AttributeError`.
* `seed_demo` read `ShippingMethod.objects.filter(code="standard").first().pk`
  inside the online-order loop. The lookup is hoisted, checked once, and says so
  once rather than failing every order separately with an attribute error.

**Behaviour held everywhere else, deliberately.** A nullable FK reads
`obj.fk_id` in five places where mypy can only narrow `obj.fk`; each is
`select_related`, so the swap costs no query. `accounts.services` grew
`storefront_branch()`, which preserves today's behaviour exactly — the
storefront reads stock against `None` when no branch is active, and every
product quietly reads out of stock — and carries the `DECISION REQUIRED` that
raises, rather than changing a business rule as a side effect of a typing pass.
It is now §1.1a of [business-rules.md](business-rules.md).

**Three deliberate `# type: ignore`s remain**, each naming the stub imprecision
it covers: `@action`'s descriptor (a bound call looks like it is missing
`self`), and two serializer fields genuinely named `label`, which is also the
name of `Field.label`. Three *stale* ignores came out — annotations that had
drifted past the errors they were written to silence, which is exactly what a
gate that never blocks produces.

**`mypy .` now blocks.** The `|| echo` is off `.github/workflows/ci.yml`.

### CI drives the artefact that ships, 2026-09-21

The third pass of 09-21, and the follow-up the D40 work left behind: the E2E job
ran against `next dev`, which is not what any customer will ever load.

**Why it mattered more than a workflow tidy.** The one production-only defect
that reached `main` — [D74](#known-defects) — made `/login` and `/checkout`
inert while `tsc`, lint, the backend suite and this very job were all green. A
dev server cannot see that class of fault. [D40](#known-defects) was the second,
and it is what had kept the job on `next dev` since 2026-08-31.

**Three traps between a passing local build and a passing CI job**, each of
which fails in a way that does not name its cause:

* `next.config.ts` sets `output: "standalone"`, and **`next start` refuses to
  serve that build**. The image runs `server.js` directly; the job now does too.
* The standalone output carries the server and its `node_modules` but **not
  `.next/static` or `public`**. Without copying them in, the pages return 200
  and every asset 400s, which reads as a broken app rather than a staging step.
* `server.js` binds `process.env.HOSTNAME`, and **a runner sets that to its own
  hostname**, so the server listens somewhere `127.0.0.1` never reaches. The
  same one-line trap the production image has (`ENV HOSTNAME=0.0.0.0`).

**And one that cost most of the pass, with two wrong diagnoses on the way.**
With the job switched over, the checkout specs failed about half the time —
`POST /shop/cart/` answering **400**, the drawer never opening, and the button
still cheerfully reading *"Added to cart"*, because `ProductBuyPanel.handleAdd`
sets that state without checking whether the add succeeded.

The cause is the suite's own `E2E_SEED_CMD`. `seed_demo --reset` rebuilds the
catalogue and **every variant comes back with a new UUID**; a production server
already running keeps serving the old ones from `.next/cache`, and the API
rightly refuses them. `next dev` never showed this because it does not hold that
cache. The fix is ordering, not code: seed first, start the server after, and do
not reseed underneath it. The job's own "Migrate and seed" step already leaves
the database pristine a few steps earlier, so `E2E_SEED_CMD` is simply not set
here — it exists for running the suite twice against one database locally.

Two diagnoses were wrong before that one was right, and both are worth
recording. The first blamed hydration — a click landing on a button React had
not wired up yet — and a retry that should have fixed that did not: still 50%.
The second *looked* like proof of the stale-id theory and was not: it compared
the API's first variant id against the first UUID in the page HTML, which are
different things, because a product page is full of product, image and category
ids too. Comparing the **set** of current variant ids against the page settled
it in one command: 0 of 4 present after a reseed.

**A spec was genuinely wrong, and a production build is what found it.** The D4
title spec read `page.title()` immediately after a client-side navigation.
`page.title()` is a plain read and does not auto-wait, so it saw the empty title
of `loading.tsx`. Polling `toContain` and then re-reading was not enough either
— the poll saw a good title and the second read saw a different one, failing on
a count of 0. It now polls the property the spec is actually about: the shop's
name appears exactly once, decided by a single read.

**Measured, not assumed — and the last wobble was this machine, not the job.**
Before the ordering fix the checkout specs failed 4 of 6 runs. After it a full
cycle — seed, fresh cache, start, run — reaches **42/42**. Three back-to-back
cycles then went 42, 41, 40, which looked like the fix being unreliable and was
not: `checkout` is a **scoped** throttle at **20/hour** that `DJANGO_THROTTLE_ANON`
does not touch, one suite run spends about four of them, and by then this session
had made 28 checkout attempts and collected 8 `429`s. A CI job gets a fresh Redis
and spends four of twenty. The symptom is worth knowing because it does not look
like throttling from the test's side — it fails as a locator timeout, with
nothing saying 429 — so it is written up in
[.claude/environment.md § 15](../.claude/environment.md).

The habit that got there is the one this file keeps writing down, applied twice
in one afternoon: *read what the running system serves.* Two plausible theories
died against one `curl` of the page and one of the API.

### D40 worked around, and the admin stopped lying after a write, 2026-09-21

The second pass of 09-21. The audit earlier that day found [D40](#known-defects) was app-wide
rather than one screen; this is what came of trying to fix it.

**The root cause was not found, and that is stated plainly rather than implied away.** What was
found is enough to make the screens correct, and enough that the next person does not repeat any of
it.

**Six hypotheses died, including both of the ones this file had been recommending.** The two
untested suspects named in the morning's audit — `RouteTransitionProvider`, which wraps navigations
in `useTransition` and installs a document-level capture-phase click listener, and the
`<PendingRegion key={pathname}>` every admin page renders inside — were the obvious candidates and
both are innocent: removing the provider from the tree entirely still measured **0/5**. So did
Next.js 15.5.25. Also ruled out: `searchParams`, the shape of the submit handler (an awaited POST,
several state writes, `router.refresh()`, one more write in `finally` — **5/5** on a light page),
server render latency to two seconds (**5/5** at every step from 0 to 2000 ms), and
`router.replace()` to the same URL, which Next simply no-ops.

**What it is sensitive to is the weight of the page.** A near-empty page under the identical layout
chain — same root layout, same provider, same shell — applied the refresh **5/5**. A copy of the
real expenses page refreshed by a *plain button*, with the expense form nowhere near it, was
**0/5**: so it is what the page renders, not what the form does. Removing any single section of
that page still failed; removing all of them passed. Cumulative, not one component.

It is also **stochastic, not deterministic**, and the morning's audit called it deterministic on two
samples of five. Across four runs of one build `/admin/expenses` measured 0/5, 0/5, 2/5 and 0/8.
That matters for anyone measuring it next: three runs is not a result.

**So the fix verifies instead of hoping.** `AdminLayout` stamps a fresh `data-render-id` on every
server render. `refreshAfterWrite()` reads it, calls `router.refresh()`, and watches for it to
change: if it does, nothing else happens and the screen stays a single-page app; if it has not
moved inside 1.5 s, the page reloads. **8/8 where the bare call was 0/8**, and 8/8 on the real
expenses screen. Eleven admin components now go through it — every write that moves stock or money,
plus taxonomy, which was one of the measured failures.

`PurchaseActions` loses its own copy of the workaround. [D77](#known-defects) had reached the right
answer in September and applied it to one screen: it now reloads only when the refresh is *measured*
not to have landed, rather than on every send, cancel and receive.

**A production build is 42/42 for the first time.** It was 40/42 that morning, both failures D40 —
the expenses spec it was found on, and the stock-count spec nobody had connected to it. That was the
whole reason the CI job ran against `next dev`. **It was moved the same day** — the job builds
the app and serves the standalone `server.js`, so CI now drives the artefact that ships.

**One thing this pass changed that it did not set out to.** Getting to 42/42 first produced 41/42,
with a *storefront* spec failing that had passed before — and a change that touches only admin
components should not be able to do that. It was real: every request in the run, including the
storefront's own server-side fetches, arrives from one address, and `anon: 60/min` is therefore a
budget for the whole suite rather than for a shopper. The suite already ran close enough to that
limit that which storefront spec collected the 429 depended on how long the admin specs happened to
take, and this change made them take longer. The rate is now read from
`DJANGO_THROTTLE_ANON`, production keeps the same default, and the E2E job alone raises it. Worth
keeping in mind beyond CI: a real shop behind NAT shares one address too.

The lesson, which is the same one this file keeps writing down: **a screen is not evidence that the
write happened, and a green refresh is not evidence that the screen changed.** The only reason any
of this was measurable is that a real browser drove a real production build and compared what the
server sent with what the page showed.

### Every defect audited against the code, 2026-09-21

The whole `## Known defects` table was checked against the codebase rather than against itself.
As it stood: **89 rows carrying 87 distinct defect numbers** — two numbers had been issued twice —
of which 84 rows were struck through as fixed (82 distinct defects) and 5 were open. The result is
that **the fixes are real and the open rows are real — and two of the five open rows understated
what they describe.** No struck-through defect was found to have regressed.

**What was run, on this machine, in this order.**

```text
pytest ................................. 1158 passed, 4m08s      (roadmap said 1097 on 09-18)
ruff check . ........................... All checks passed
ruff format --check . .................. 207 files already formatted   (roadmap said 201)
tsc --noEmit ........................... clean
vitest run (TZ=UTC) .................... 282 passed, 24 files    (roadmap said 260)
mypy . ................................. 271 errors in 41 files  (D6 claimed 98 in 29)
playwright, PRODUCTION standalone ...... 40 passed, 2 failed, 42 specs
```

The stack ran natively — PostgreSQL 16 and Redis on the host, Django on 8000, and for the browser
pass `next build` followed by the standalone `server.js` the production image actually runs, on
4000. §8 of [.claude/environment.md](../.claude/environment.md) is the recipe, and it worked
exactly as written.

**[D6](#known-defects) had drifted by a factor of nearly three, and that is the finding, not the
number.** 98 errors in 29 files was measured 2026-08-18. It is now 271 in 41, across 151 source
files. Nothing regressed a fix; the gate simply never blocked — `mypy . || echo` — so five weeks of
supplier payments, shipments, purchase returns, VAT and the audit readers were written with no
type-checking pressure at all, and the errors accumulated exactly where the new code went:
`finance/api/serializers.py` holds 80 of them. The shape is unchanged, which is the good news:
189 of 271 are `arg-type`. **Corrected while fixing it:** this paragraph first read *"nearly all"* of
that 189 as DRF's `request.user` typed `User | AnonymousUser` where a service wants `User`. 189 is
the `arg-type` total; the `AnonymousUser` group inside it is **81**. It was still the largest single
cause and the first thing fixed, but the smaller number is the true one. Three are now
`unused-ignore` — annotations that have drifted past the errors they were written to silence.
**All 271 are fixed as of 2026-09-21** — see
[§ D6 fixed](#d6-fixed-and-the-type-gate-now-blocks-2026-09-21).

**[D40](#known-defects) is not one screen, and this file said it was.** The row has read
*"Not app-wide … specific to this screen"* since 2026-08-31. Driven against a real production build
with a real browser, on one session and one build:

| Screen | Action | `router.refresh()` applied | Server had the row |
|---|---|---|---|
| `/admin/expenses` | record an expense | **0 of 5** | 5 of 5 |
| `/admin/taxonomy` | create a brand | **2 of 6** | 6 of 6 |
| `/admin/taxonomy` | create a category | **4 of 6** | 6 of 6 |
| `/admin/inventory/counts/[id]` | apply a count | **failed** (E2E) | yes |

Every write landed, every time. Only the screen lied. The original "not app-wide" conclusion was
drawn from the write-off and returns specs passing against the same build — but the defect is
*bimodal*, not screen-bound, so a slow enough screen passes by luck and a fast one fails. That makes
[D77](#known-defects) the same defect rather than a second one, which its own closing line had
already guessed: *"anything else on the admin that relies on `router.refresh()` is suspect until
someone finds it."* There are **63 `router.refresh()` call sites** in
`apps/web/src/components/admin`.

The fourth screen is the one worth stopping on. The stock-count sheet applies a count, writes
`ADJUSTMENT` rows to the ledger, and then keeps showing **"Apply to stock"** — the button for the
thing it has just done. The backend refuses the second click with a 409
(`inventory/api/views.py` checks `status != COUNTING`), so no stock moves twice and this stays a
UI-truthfulness defect rather than a data one. It is still the exact situation D77 refused to
accept for receiving: a ledger screen asserting the opposite of the ledger.

**A production build is now 40/42, and the suite is 42 specs, not 20.** This file has said "18/20
pass, the two are D40 and D41" since 2026-08-31. D41 was fixed 2026-09-09 and no production run has
been recorded since. Both remaining failures are D40 — the expense spec it was found on, and the
stock-count spec, which nobody had connected to it.

**Two numbering faults in this table, both fixed here.** `D43` had been issued twice, to two
unrelated defects — the walk-in customer race and the unreachable uploaded media — and are now
`D43a` and `D43b`. `D47` was listed twice, the same defect in two rows; the complete account is kept
in D47's numeric position and the placeholder dropped. D6's row also carried an unescaped `|` inside
a code span, which had been splitting it into six columns in any Markdown renderer.

**All 84 struck-through rows were checked individually and every fix is present.** Spot-listing the
ones that carry money or authorization, because those are the rows worth distrusting: D24's
per-method permission map, D26's `_demote_other_defaults`, D28's per-customer limit re-checked under
the coupon row lock, D32's `free_over` floor and its data migration, D61's supplier-versus-order
comparison under `select_for_update`, D62's `outstanding` reading `credited_total`, D63's
`idempotency_key` unique index, D64's `UNPAYABLE_STATUSES`, D68's `branch_queryset` on shipments,
D70's `read_only_fields`, D75's zero-price publish guard, D78's `tax_mode`-aware refund, D79's
production seed guard, D80's `paid_total` check, D82's `_check_lines`, D85's audit-log branch scope,
D86's `end_sessions`, and D87's `throttle_scope = "auth"` at 10/min. All present, all in the layer
the row names.

**Two rows need reading with their history, not just their text.** [D1](#known-defects) (wishlist)
and [D2](#known-defects) (review form) are struck through as fixed, and the code they name is gone —
not regressed, but **withdrawn on 2026-09-15** with the storefront's whole account surface. A grep
for `WishlistHeart` finds nothing and should not be read as a regression. [D21](#known-defects) is
struck through as fixed, but the fix is that `node:22-alpine` resolves to a patched base at build
time; it is a floating tag, so that row is true of whatever Alpine ships today rather than settled
for good.

**The habit this file keeps recommending, applied to this file.** "Exists" is not "reachable" and
"rarely touched" is not "sound" — and a defect row is a claim like any other. D6's number was
37 days old and wrong by 173 errors; D40's scope was 21 days old and wrong about the thing that
matters most about it. Both survived because a written figure reads as a measured one. Re-measure a
defect row before building on what it says, the same way an endpoint is checked before building
over it.

### The tracking journey, and the account surface withdrawn, 2026-09-15

Two things worth recording about *how* this pass went, beyond what it built.

**The endpoint audit paid for the ninth time.** `ShipmentViewSet` had nineteen tests and looked
sound. All nineteen exercised zones, methods and the `events` action; **not one** touched shipment
creation, which is where the guards were missing — `ShipmentSerializer` had no `validate()` at all.
Twelve new tests were written first and run against the code as it stood: every one of the twelve
failed, and every failure was a **201 where the request should have been refused**. Nothing was a
test artefact.

**The obvious fix for [D47](#known-defects) was wrong, and looked right.** Deriving the per-run test
database name from `os.getpid()` is the natural move and reproduced the original corruption exactly:
each `docker compose run` gets its own PID namespace, so two containers both start at 1 and collide.
Caught only because the fix was *proven against the failure it claimed to fix* — running the same
two suites concurrently, which is what had failed. Before: 23 passed / 19 errors. After the PID
version: identical. After the random version: 23 passed / 19 passed.

```text
pytest (full suite, container) ........ 995 passed, 1 failed in 561s
  the failure ......................... tests/test_concurrency.py::test_pos_sale_and_online_
                                        checkout_cannot_both_take_the_last_unit. Passes alone
                                        and passes when the concurrency file is run whole; see
                                        the note below, and do NOT read it as green
  of which new ........................ 23 in tests/api/test_shipment_fulfilment.py
vitest ................................ 209 passed, 15 files (6 new: order-fulfilment)
ruff check + ruff format --check ...... clean, 200 files
tsc --noEmit + eslint ................. clean
makemigrations --check --dry-run ...... no changes detected
migration ............................. shipping/0003_shipment_..._courier_tracking_uniq
D47 proven ............................ the concurrent pair that failed now both pass
```

Not verified in a browser. The Delivery panel and the customer's parcel view are written, typechecked
and unit-tested; nobody has signed in and booked a parcel through them. Per this file's own rule, do
not describe them as proven until someone has — and note that three prior passes each found defects
that survived a clean `tsc` and died the moment a browser loaded the page.

### Supplier payments made real, 2026-09-15

The endpoint was audited before the screen was built over it, which is the habit this file keeps
recommending. It found five defects — three of them money bugs — and one of those (D65) is why the
screen had never existed: the API answered 400 to every request.

Every guard was **seen to fail before it was written**. The five new service tests were run against
the old code first and all five failed; the concurrency pair was run before the lock was moved and
the idempotency race surfaced a raw `IntegrityError`, which is what the savepoint fallback now
catches.

```text
pytest (full suite, container) ........ 907 passed in 408s
  of which new ........................ 5 service guards, 5 API-level, 2 concurrency
ruff check + ruff format --check ...... clean, 193 files
makemigrations --check --dry-run ...... no changes detected
migration ............................. purchasing/0003_supplierpayment_idempotency_key
```

One fixture was changed rather than the guard it broke: the original happy-path test paid a `DRAFT`
purchase order, which D64 now refuses, so `_sent_order()` sends it first. The test had been encoding
the bug.

Not verified in a browser. The screen is written and typechecked; nobody has signed in and paid a
supplier through it. Per this file's own rule, do not describe it as proven until someone has —
and note that the two prior passes both found defects that survived a clean `tsc` and died the
moment a browser loaded the page.


Everything below was executed on 2026-08-18 against commit `423cdf4`.

```text
migrations from empty database ........ OK (all 12 apps)
seed_demo --reset ..................... 12 products, 72 variants, 2 POs, 40 orders
ledger integrity (verify_inventory) ... consistent, 0 drift
pytest ................................ 172 passed (160 unit/service/API + 7 concurrency + 5 query budget)
ruff check + ruff format .............. clean
frontend typecheck (tsc --noEmit) ..... clean
vitest (npm run test) ................. 22 passed, 3 files (17 + 5 POS debounce)
production Next build ................. succeeds: `docker compose build web` completes, and CI
                                        runs `npm run build` on every push
storefront / admin / POS served ....... 21 routes checked from the Windows host:
                                        11 storefront 200, 10 admin/POS 307 -> /login (correct)
browser purchase journey .............. shop -> product -> add to cart -> checkout -> COD order
                                        RGN-WEB-000018, 2,450 + 70 = 2,520 BDT, timeline correct,
                                        cart emptied, ledger still consistent afterwards
live POS sale through the web proxy ... RGN-POS-000025 DELIVERED PAID (earlier session)
PRODUCTION STACK RUN LOCALLY ......... 2026-08-19: prod images (api 327MB, web 251MB), gunicorn +
                                        3 workers, DEBUG off, nginx single origin, Celery worker
                                        and beat. `scripts/smoke-test.sh` PASSED for the first time
                                        (7/7). Storefront, cart and add-to-cart verified in a browser.
                                        Page latency 12-70ms warm. Found D16 and D17 doing it.
production page latency ............... measured from the built image on the same machine and API:
                                        / 0.03s · /shop 0.29s · /checkout 0.012s · product 0.11s
                                        (the dev server is 10-80x slower and is not a fair measure)
API query counts after the N+1 sweep .. home 29 · listing 13 · purchase orders 15 · detail 13;
                                        every other list endpoint 4-7
```

Phases 33 (dynamic navigation) and 34 (colour-linked product media) were built and verified on
2026-08-21, against a working tree past `18e418b`:

```text
migrations (catalog 0002-0004, content 0001) .. applied clean, `makemigrations --check` clean
pytest ......................................... 220 passed (37 new: tests/api/test_navigation.py,
                                                  tests/api/test_product_media.py,
                                                  tests/api/test_search_suggest.py)
ruff check + ruff format ....................... clean
frontend eslint (npx eslint src) ............... clean
frontend typecheck (tsc --noEmit) .............. clean, twice (before and after the final fixes)
vitest .......................................... 22 passed, unchanged
browser walk, scripted Playwright container .... mcr.microsoft.com/playwright joined to the
                                                  compose network (the dev container itself cannot
                                                  run it, D7): desktop mega/dropdown menu opens and
                                                  navigates by mouse (hover+click) and by keyboard
                                                  (Tab/Enter) at 1280px; mobile drawer accordion at
                                                  375px; search suggest returns real products,
                                                  categories and a popular term; /category/men
                                                  renders breadcrumbs, subcategory chips, filters,
                                                  wishlist hearts; /shop?category=men 308s to
                                                  /category/men; product detail colour/capacity
                                                  selection and add-to-cart work
```

Two real bugs were caught and fixed by that browser walk, not by pytest or typecheck — worth recording
because they show why the walk matters:

1. `lib/navigation/navigation.ts` (server-only, imports `apiServer`/`next/headers`) was imported from
   the client component `primary-nav.tsx` for one pure helper (`resolveLayout`). Next's bundler correctly
   refused to build it. Fixed by splitting the helper into `lib/navigation/layout.ts`, which has no
   server-only import.
2. `NavigationMenu.Link asChild` around a `next/link` silently swallowed navigation on both mouse click
   and keyboard Enter — no console error, no failed request that Playwright's network listeners would
   catch by exception. Recorded in [navigation.md §7](architecture/navigation.md#a-radix-gotcha-worth-recording)
   with the fix (a plain `<Link>`, panel closed explicitly via controlled state).

Phase 35 (financial accounts and the cash book) was built and verified on 2026-08-22, on
`phase/35-finance-accounts`:

```text
migrations (finance 0001-0002, orders 0003, purchasing 0002) .. applied clean from the existing
                                                  database; `makemigrations --check` clean
pytest ......................................... 308 passed, up from 247 (61 new: 28 in
                                                  tests/test_finance.py, 29 in
                                                  tests/api/test_finance_admin.py, 4 threaded in
                                                  tests/test_concurrency.py)
ruff check + ruff format --check ............... clean (154 files)
frontend eslint (npx eslint src) ............... clean
frontend typecheck (tsc --noEmit) .............. clean, twice
vitest .......................................... 74 passed (5 new: ApiError.fieldErrors)
seed_demo --reset .............................. 12 products, 72 variants, 3 accounts opened
verify_accounts ................................ "Accounts are consistent with the cash book",
                                                  "Every money event names an account"
seeded cash book ............................... 30 rows — 27 SALE_PAYMENT + 3 OPENING — split by
                                                  method across the three accounts:
                                                  Counter Cash Drawer 65,450 · City Bank Current
                                                  515,780 · bKash Merchant 92,250
browser walk, signed in as owner ............... /admin/finance renders the cash position
                                                  (৳673,480 across 3), the accounts table and the
                                                  cash book with each row's reference and running
                                                  balance; a transfer of 25,000 drawer→bank wrote
                                                  ATR-000001 and two ledger rows with the total
                                                  unchanged; overdrawing the drawer was refused
                                                  with INSUFFICIENT_FUNDS and left both balances
                                                  untouched; /admin/finance/[id] filters by
                                                  movement type; the dashboard tiles follow the
                                                  transfer; the POS shows "Goes into Counter Cash
                                                  Drawer" for cash and "Goes into City Bank
                                                  Current" for card, and a split sale
                                                  RGN-POS-000025 (1,000 cash + 1,450 card) posted
                                                  each tender to its own account.
                                                  verify_accounts clean afterwards.
```

Two bugs were caught by that walk and by nothing else — the same lesson phases 33/34 recorded:

1. **`ApiError.fieldErrors()` rendered any business error's `details` as field errors.** Its docstring
   already said "from a VALIDATION_ERROR", but the code never checked the code. An
   `INSUFFICIENT_FUNDS` from the transfer form printed `e6622e4d-…`, `Counter Cash Drawer`,
   `65450.00`, `100000.00` as four separate field errors, each linked to a form field that does not
   exist, instead of the sentence the service wrote. This was **pre-existing and shared** — every
   admin form hit it for any non-validation error. Fixed in `lib/api/client.ts`, with five Vitest
   cases.
2. **The cash-book balance tile counted the filtered rows.** Filtering to "Transfers out" made an
   account with ten movements read "1 movement recorded" beside its unfiltered balance.

Two smaller polish fixes came from looking at it: `InsufficientFunds` now formats its figures
(`৳ 65,450.00`, not `65450.00`) because the message is shown verbatim on a money screen, and the
dashboard no longer labels the MFS tile `Mfs` via `humanise()`.

The concurrency cases are the ones worth naming, because they are the bugs a directly-written
`balance` column would have shipped with: six simultaneous sales into one drawer sum exactly (no lost
update); five concurrent withdrawals against a drawer that covers three succeed **exactly** three
times, the other two raising `INSUFFICIENT_FUNDS`; transfers in opposite directions between the same
pair of accounts do not deadlock; and a capture webhook replayed four times banks the money once.

Also fixed while reseeding: **`seed_demo --reset` has been broken since phase 33** made the category
tree nested. `Category.parent` is `PROTECT`, so `Category.objects.all().delete()` raised
`ProtectedError` on the top-level rows. It now deletes leaves first. This was pre-existing and
unrelated to phase 35 — it simply had not been run since.

### The backup was rehearsed the hard way, 2026-08-22

Not a drill. While updating the production stack for phase 35, the
`rangon-prod_postgres_data` volume was destroyed — along with every local image
except one, which is the signature of a `docker system prune -a --volumes` or a
`compose down -v`. The volume's `CreatedAt` timestamp (`22:58:00Z`) is 14 minutes
after the backup taken at `22:44:48Z`.

```text
before .......... 74 tables · 40 orders · 12 products · 6 users · 169 ledger rows
after the wipe .. 0 tables
pg_restore ...... exit 0
after restore ... 74 tables · 40 orders · 12 products · 6 users · 169 ledger rows
verify_inventory  consistent with the ledger
verify_accounts . consistent with the cash book
```

Three things this settles, and one it does not:

* **The dump format works.** `pg_dump -Fc` from the **db** container (never the
  api container — D14) restored cleanly with
  `pg_restore --no-owner --clean --if-exists`.
* **`backups/` is gitignored and lives on the host**, which is the only reason
  the file outlived the volume. A backup stored in a Docker volume would have
  gone with it.
* **Taking the backup before a deploy is not ceremony.** The 14-minute margin
  is the whole story.

What it does **not** settle: nothing is automated. No schedule, no off-machine
copy, no retention. A single host-local dump taken by hand is one disk failure
from being no backup at all. That remains open.

### CI is real now

`origin` is `github.com/IbrahimAllMamun/Rangon`. The workflow has run **14 times**; the most recent,
run #15 on `423cdf4`, is **green on all four jobs**:

| Job                 | Steps that passed                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Backend             | ruff check · ruff format --check ·`makemigrations --check` · mypy (non-blocking *on that run* — it blocks as of [D6](#known-defects), 2026-09-21) · pytest incl. concurrency |
| Frontend            | `npm ci` · lint · typecheck · **`npm run build`**                                                    |
| Dependency audit    | `pip-audit` · `npm audit`                                                                                    |
| Build & scan images | API image · web image · Trivy HIGH/CRITICAL on both                                                             |

Runs #1–#13 failed or were cancelled while the workflow itself was being fixed (Trivy action version,
`NEXT_PUBLIC_SITE_URL`, requirements). Those were workflow bugs, now fixed — not product regressions.

**CI does not run the frontend tests.** Neither `npm run test` (Vitest) nor `npm run test:e2e`
(Playwright) appears in `ci.yml`. Vitest passes locally and takes seconds — it should be added.

Phase 05's admin product form, the review form (D2), the notification bell (D3) and the CSP nonce
(D16) were built and verified on 2026-08-21:

```text
pytest ......................................... 230 passed (10 new: tests/api/test_product_admin.py)
ruff check + ruff format ....................... clean
frontend typecheck (tsc --noEmit) .............. clean — and it fixed a PRE-EXISTING error: the
                                                 `Select` primitive had no `invalid` prop, which
                                                 `navigation-editor.tsx` was already passing
frontend eslint (npx eslint src) ............... clean
vitest .......................................... 39 passed (17 new: variant-matrix reconcile rules)
production Next build .......................... `docker compose build web` completes; the built
                                                 image contains .next/server/app/(admin)/admin/
                                                 products/new, products/[id] and notifications
CSP verified against the PRODUCTION image ...... Chromium (mcr.microsoft.com/playwright joined to
                                                 rangon-prod_frontend) against the prod stack on
                                                 nginx: exactly ONE Content-Security-Policy header,
                                                 carrying 'nonce-…' 'strict-dynamic' and NEITHER
                                                 'unsafe-inline' NOR 'unsafe-eval'. Six routes
                                                 (/ /shop /cart /wishlist /track /login) plus a
                                                 client-side navigation into a product page all
                                                 render real content — **0 CSP violations, 0 page
                                                 errors**. This is the exact configuration that used
                                                 to render a blank page.
browser walk, all 31 checks (dev stack) ....... apps/web/e2e/browser-walk.mjs: reviews section and
                                                 sign-in prompt for a guest; the review form and its
                                                 five-radio rating for a signed-in shopper; the
                                                 notification bell ("Notifications, 17 unread"), its
                                                 panel and the feed page with its unread filter;
                                                 then the product form end to end — 6 attribute
                                                 groups, 32 tickable values, a 2-row matrix, create,
                                                 redirect to the edit screen, photography section,
                                                 read-only stock with an Adjust action, and publish
                                                 flipping the state to live
```

The dev stack shows two CSP violations the production build does not: Turbopack's own chunk loader
emits a script tag without a nonce, which `'strict-dynamic'` then refuses. Production nonces every
preload link (verified in the served HTML), which is why the count there is zero. The middleware also
adds `'unsafe-eval'` only when `NODE_ENV !== "production"`, because the dev server compiles with
`eval()`.

### Phase 36 verified, 2026-08-27

Executed against a real stack (PostgreSQL 16, Django dev server, `next dev`), seeded with
`seed_demo --reset`:

```text
pytest ................................ 365 passed (was 308 before this phase; +57)
ruff check + ruff format .............. clean
tsc --noEmit .......................... clean
next lint ............................. clean
vitest ................................ 79 passed, 6 files
migrations from the existing database . OK (core 0003, finance 0003 + 0004)
makemigrations --check ................ no changes detected
seed_demo --reset ..................... OK, 9 demo expenses, 12 products, 72 variants
verify_accounts ....................... consistent; every money event names an account
verify_inventory ...................... consistent, 0 drift
browser walk-through .................. signed in as owner at /admin/expenses:
                                        recorded 850.50 -> drawer 65,450.00 fell to 64,599.50,
                                        voided it -> drawer back to 65,450.00 exactly,
                                        overspend refused with the server's own message,
                                        focus moved to the error summary
Playwright ............................ RAN. See below — D7 is environment-specific, not a code defect
```

**Playwright ran for the first time.** On a Linux host with a Chromium already present, the suite
executes: 17 tests (12 desktop + 5 mobile), and every one of them passes **in isolation**. Running
them all sequentially is a different matter — see [D18](#known-defects). Three real bugs in the
specs themselves were found by executing them, and are fixed:

- the shared `signIn()` helper matched two `Sign in` buttons (the login form's, and the storefront
  header's account menu), failing Playwright strict mode on **every** signed-in test;
- the dashboard spec matched two `Revenue` elements (a KPI tile and a table column header);
- the `mobile` project's `testIgnore: /pos|admin/` matched **file paths**, and all the flows live in
  one file, so it never excluded anything — POS and Admin were being run at a phone viewport they
  are explicitly not designed for (CLAUDE.md §10). Now an explicit `@desktop-only` tag.

`PW_CHROMIUM_PATH` was added to `playwright.config.ts` so an environment that already ships a
Chromium can point at it instead of downloading one.

### Phase 39 (part) verified, 2026-08-27

```text
pytest ................................ 385 passed (365 before; +20)
ruff check + ruff format .............. clean
tsc --noEmit / next lint .............. clean
vitest ................................ 79 passed
verify_inventory ...................... consistent after 2 write-offs, a count and 2 transfers
verify_accounts ....................... consistent
Playwright ............................ 2 new specs, passing
browser walk-through .................. write-off 10 -> 8 on the named SKU; count sheet snapshotted
                                        72 lines, variance computed live, saving moved no stock,
                                        applying wrote the adjustment (8 -> 5); transfer moved 3
                                        units DHK1 -> DHK2 with none invented on either side
```

**The roadmap was wrong about stock counts.** This row said "the apply flow exists — form work
only". In fact `counted_quantity` was exposed through a `read_only=True` nested serializer and
written by nothing, so `apply` — which filters on `counted_quantity__isnull=False` — matched zero
rows every time. There were also **no tests for stock counts at all**, at any level, which is why it
went unnoticed. Recorded as [D22](#known-defects).

Two smaller things found by running it: the endpoints doc had `inventory/transfers/` and
`inventory/counts/` when the real routes are top-level `/stock-transfers/` and `/stock-counts/`; and
the inventory table never rendered `branch_code`, so once a transfer existed the same SKU appeared
twice with nothing to tell the rows apart.

### Returns verified, 2026-08-27

```text
pytest ................................ 405 passed (385 before; +20)
ruff / tsc / next lint / vitest ....... clean
verify_inventory / verify_accounts .... consistent
Playwright ............................ 1 new spec, passing
browser walk-through .................. RET-000001 rejected-without-a-reason refused, approved,
                                        received as DAMAGED with a condition note (stock stayed at
                                        18 — a damaged line never returns to sellable), refunded
                                        2,790.00 into a named account, and the REFUND movement
                                        appeared in the cash book
```

**Two gaps closed before the screen was built**, both found by checking the endpoints against the
documented behaviour rather than trusting the "form work only" label:

- The **restock decision could not be made at receipt**, though §2.1 puts it there. It was settable
  only at request time, so a screen would have asked "restock or damaged?" before anyone saw the
  item. `receive/` now takes per-line decisions.
- A **return refund could not name its account**, though an order refund could — and a return is
  exactly the case where which drawer the cash leaves matters.

Also fixed: `seed_demo --reset` died with `ProtectedError` whenever a stock count or transfer
existed, which phase 39 made ordinary. Recorded as [D23](#known-defects), with a regression test that
fails without the fix.

### Customer screens verified, 2026-08-28

Run on a Linux container without Docker — PostgreSQL 16 and the venv were built directly, so the
`docker compose` commands in the README were **not** the ones executed. What ran:

```text
pytest ................................ 427 passed (405 before; +22)
ruff check + ruff format .............. clean
tsc --noEmit .......................... clean
next lint ............................. clean
vitest ................................ 79 passed, 6 files
next build ............................ passes
```

**Four defects were found before a line of UI was written**, by checking the endpoints against the
documented behaviour. All four are proven: reverting the source with the new tests in place fails
**12 of the 22**, and each failure names its defect.

- [D24](#known-defects) — `customers.view` could write an address or a note. An `ACCOUNTANT` holds
  that code deliberately *without* update, and could still write. The action served GET and POST
  under one permission list.
- [D25](#known-defects) — addresses could be created but never edited or deleted. The storefront had
  full CRUD; the admin surface did not, so the edit screen had no endpoints to call.
- [D26](#known-defects) — nothing demoted the previous default address, on either surface. Checkout
  pre-fills from `addresses.first()` under `("-is_default", "-created_at")`, so with two defaults the
  pre-filled delivery address was arbitrary.
- [D27](#known-defects) — an edit could clear both phone and email, producing the unfindable customer
  phone-first identity exists to prevent.

D26 is the one that reached a customer: it is the storefront's own account page, and the wrong
address could have been pre-filled at checkout. Both surfaces now go through `customers.services`,
which holds the invariant under `select_for_update`.

~~**Not verified:** no signed-in browser click-through.~~ **Verified 2026-08-28** — see
[§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### Coupon screens verified, 2026-08-28

Same environment caveat as the customer pass: no Docker daemon, so PostgreSQL 16 and the venv were
built directly and the README's `docker compose` commands were **not** what ran.

```text
pytest ................................ 445 passed (428 before; +17)
ruff check + ruff format .............. clean
tsc --noEmit / next lint / next build . clean
vitest ................................ 79 passed, 6 files
makemigrations --check ................ one new migration, promotions/0002
```

**The audit found a money bug this time**, not just validation gaps — [D28](#known-defects). A coupon
limited to one use per customer could be redeemed twice by placing two orders concurrently:
`redeem()` holds the coupon row lock and re-checks the *total* limit, but the *per-customer* limit was
only ever checked in `validate_coupon`, which runs while the cart is priced — before the lock exists.
Both checkouts passed validation, both redeemed, no refusal.

It is proven rather than argued: `tests/test_concurrency.py` gained
`test_one_customer_cannot_spend_a_one_per_customer_coupon_twice`, which against the old code reports
*"a one-per-customer coupon was redeemed 2 times … refusals: []"*. The fix re-reads the per-customer
count inside the lock `redeem()` already takes, so the existing serialisation does the work.

`usage_limit_per_customer` defaults to **1**. The default configuration was the exposed one.

Three smaller gaps came from the same instance-blind validation as [D27](#known-defects): an edit
checked its payload rather than the resulting coupon ([D29](#known-defects), [D30](#known-defects)),
and free shipping was forced to carry a meaningless amount ([D31](#known-defects)).

~~**Not verified.**~~ **Verified 2026-08-28** — see [§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### Shipping screens verified, 2026-08-28

Same environment caveat: no Docker, so PostgreSQL 16 and the venv were built directly.

```text
pytest ................................ 464 passed (445 before; +19)
ruff check + ruff format .............. clean
tsc --noEmit / next lint / next build . clean
vitest ................................ 79 passed, 6 files
migration repair rehearsed ............ against a probe database holding the bad rows
```

**Shipping had no section in `business-rules.md` at all.** That is the finding behind the other four:
an area nobody wrote down is an area nobody checks, and it was the only area of the system with
neither documented rules nor a single API test. §8a now states the rules, reconstructed from the code
and asserted in `tests/api/test_shipping_admin.py`.

The money one is [D32](#known-defects): `free_over` accepted a negative number, and `price_for()`
returns 0 whenever `subtotal >= free_over` — so one mistyped minus sign makes **every order ship
free**, quietly, forever. [D33](#known-defects) is the durable one: `events` never used the serializer
that already existed, so `status: "BANANA"` was stored with a 201 into an append-only log, and because
that status drives `PACKED → SHIPPED → DELIVERED` the order also stopped progressing.

Unlike the previous migrations, `shipping/0002` **tightens** two constraints, so a database written
before today may hold rows that violate them and `AddConstraint` would fail outright. It repairs
first — clearing a negative `free_over` to NULL, widening a backwards `max_days` — and prints what it
changed rather than doing it silently. **Rehearsed rather than assumed:** a probe database was
migrated to `0001`, seeded with exactly the two bad rows the old API allowed, and migrated forward.
Both were repaired, both constraints then rejected fresh violations, and the probe was dropped.

~~**Not verified.**~~ **Verified 2026-08-28** — see [§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### Review moderation verified, 2026-08-28

```text
pytest ................................ 476 passed (464 before; +12)
ruff check + ruff format .............. clean
tsc --noEmit / next lint / next build . clean
vitest ................................ 79 passed, 6 files
```

I was wrong in the shipping entry to say `content` had no documented rules: reviews are covered in
detail by §6a. What the audit found instead is the opposite problem — **the documentation was right
and the code did not match it.**

§6a states that "a second, later order of the same product earns a second review". The code resolved
the eligible order as simply the most recent one, so a repeat buyer's second attempt always landed on
the order they had already reviewed and was refused ([D36](#known-defects)). They got one review
however many times they bought. `business-rules.md` opens by saying that where code and this document
disagree, "that is a bug in one of them — fix both in the same change"; here the document was the
correct half.

Also [D37](#known-defects) — `int()` on the raw rating, so `"excellent"` escaped as a 500 and `4.7`
was silently stored as `4` — and [D38](#known-defects): moderation wrote no audit entry at all, while
the neighbouring `content` app logs every navigation change. Since the review row holds only the
*latest* moderator and note, reversing a decision erased the previous one, and re-approving a rejected
review wiped the reason it was rejected.

~~**Not verified.**~~ **Verified 2026-08-28** — see [§ The screens were finally used](#the-screens-were-finally-used-2026-08-28).

### The screens were finally used, 2026-08-28

Five verification entries above each ended "no signed-in browser click-through — Docker is
unavailable". **That reasoning was wrong**, and it was repeated four times before anyone checked it.
Docker is how this project *documents* running the stack; it is not what running it requires. The
container has PostgreSQL 16, Python, Node and a pre-installed Chromium, which is enough.

Run natively, the whole stack came up:

```bash
# postgres + redis (redis is not optional: the auth throttle is Redis-backed,
# and without it POST /auth/login/ returns 500)
pg_ctl -D <data> -o '-p 5432 -k /tmp' start
redis-server --daemonize yes --port 6379 --save ''

# api
DATABASE_URL=postgresql://rangon:rangon@127.0.0.1:5432/rangon \
DJANGO_SECRET_KEY=... DJANGO_DEBUG=1 python manage.py runserver 8000 --noreload

# web — API_INTERNAL_URL is the one that matters; it defaults to the compose
# hostname http://api:8000/api/v1, which does not resolve outside compose
API_INTERNAL_URL=http://127.0.0.1:8000/api/v1 npx next dev --port 4000
```

Then a real Chromium (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, the escape hatch
`playwright.config.ts` already provides for via `PW_CHROMIUM_PATH`) signed in as `owner@rangon.test`
and drove the screens:

```text
sign in as owner ....................... /admin
all five screens render signed in ...... 200, correct <h1>, no console errors
create a customer ...................... saved
add an address ......................... saved, and became the default automatically (D26)
add a note ............................. saved, attributed to owner@rangon.test
create a coupon ........................ WALK415942, 15% off
free shipping hides the amount field ... yes (D31), and saved with no value
create a shipping zone ................. saved; cities stored "sylhet, rajshahi" (D34)
a backwards estimate is refused ........ "The longest estimate cannot be shorter…" (D35)
create a shipping method ............... saved, renders "5–7 days"
reject a review with a note ............ note kept
re-approve it .......................... earlier note survived (D38)
the approved review reaches the shop ... count 1, average 4.0
verify_inventory / verify_accounts ..... consistent; every money event names an account
```

13 writes, all landing. The only failing request in the whole run was `401 GET /shop/wishlist` on the
anonymous login page, which is the correct answer for a signed-out wishlist check.

Five of the fixes were confirmed through the UI rather than only in tests: D26, D31, D34, D35 and
D38. **[D7](#known-defects) is also stale** — Playwright's Chromium runs here; the blocker was only
ever the *dev container's* Alpine base.

The lesson is the same one this file keeps recording, turned on itself: a constraint nobody has
tested is not a constraint. "Docker is unavailable, so this cannot be verified" was carried through
four passes and cost five screens their verification, and it took one `ls /opt/pw-browsers` to
disprove.

### Three partials finished, and what finishing them found, 2026-09-09

Phases 06, 26 and 28 are complete. Two of the three were finished by writing the
thing that was missing; the third was finished by measuring what the
documentation had only ever claimed.

```text
pytest                              741 passed
ruff check . && ruff format --check clean, on the pinned 0.8.4
npm run typecheck / lint            clean
npx vitest run                      167 passed in 10 files
npx playwright test                 22 passed
```

**Phase 06 — a stock adjustment from the inventory screen.** A per-row *Adjust*
action, because an adjustment is always about a row somebody is already looking
at, unlike the write-off panel above it which starts from an event. The form
opens inline beneath the row so the two figures stay side by side; admin has no
dialog anywhere and this was not the screen to introduce one. Nothing in it
writes stock — it posts the counted figure and `inventory.services` works out
the difference.

**Phase 26 — [D4](#known-defects).** Fixed at the cause rather than in the seed.

**Phase 28 — the budgets.** Seven of ten rows in
`docs/database/indexing.md` carried a budget under a heading reading "enforced in
tests" and were enforced by nothing. All ten are asserted now, and writing them
found the counter's grid search issuing **81 queries for eight products** —
about nine per row, on the screen a cashier uses on every sale. Both causes were
the trap that document itself describes: `variant.label` joins attribute values
that nothing prefetched, and `Product.primary_image` *filtered* a related
manager, which ignores `prefetch_related` entirely and issues a fresh query per
product. **81 → 5, and flat as the catalogue grows.**

Two documented numbers were wrong rather than merely unenforced. Product detail
was budgeted at 10 against a measured 13, and is flat whatever the variant
count, so the budget was raised to 18 deliberately. `POST /pos/sales/` was
budgeted at 30 and had never been measured: it costs 53 queries for one line and
10 for each line after, which is what a sale that locks and ledgers every line
should cost, and is now guarded per line rather than by a constant.

**The browser found what the tests could not, for the fourth time in this file.**
The adjustment saved correctly, the ledger row was right, and the table came back
showing a *different* product. The inventory list ordered by product name and
variant position, every variant sits at position 0 until somebody reorders them,
and PostgreSQL may return tied rows in any order it likes — so the row just
corrected moved, and the correction looked like it had hit the wrong one. That is
[D13](#known-defects) one table over. The same read found the expiring filter
setting an ordering that the method's own closing `order_by` threw away, so
"expiring" had been sorting by product name.

Worth recording how that was tested, because the obvious test is worthless here:
fetching the page twice and comparing passes whether the bug is present or not,
since an under-specified sort is *allowed* to be stable and simply is on a small
table. The guard asserts the shape instead — the ORDER BY must end in a column
that cannot tie. Both ordering tests were run against the unfixed code to
confirm they fail.

### One number, one spelling, 2026-09-09

D48 is closed. Every customer phone number is stored canonically as `8801XXXXXXXXX`; the rule is in
`core.phone`, applied by the serializers, by `Customer.save()` and by a data migration.

Run against PostgreSQL 16, a Django dev server and `next dev`, all on one machine:

```text
pytest                              712 passed
manage.py makemigrations --check    No changes detected
ruff check . && ruff format --check clean, on the pinned 0.8.4
npm run typecheck                   clean
npm run lint                        no ESLint warnings or errors
npx vitest run                      160 passed in 9 files
npx playwright test                 20 passed
```

Use the pinned `ruff==0.8.4`, not whatever is on `PATH`. A 0.15.x on this
container reported six `RUF059` findings that do not exist in 0.8.4 and
reformatted two files 0.8.4 is happy with, which would have put an unrelated
diff into this change and possibly turned CI red.

The migration was rehearsed against a database carrying the defect rather than an empty one. Two
customers were inserted under `01712345678` and `+8801712345678`, plus a landline (`029612345`) that
no rule can canonicalise, and the migration was applied by `manage.py migrate`:

```text
Ayesha Rahman | 8801712345678 | active   | 4 orders | 5700.00 | Absorbed 1 duplicate record(s)…
Ayesha R.     |               | inactive | 1 order  | 1200.00 | Merged into customer 1111…
Landline Ltd  |               | active   | 0 orders |    0.00 | …could not be read…: 029612345
```

The lifetime figures were absorbed by the survivor, the duplicate was retired rather than deleted,
its note followed the merge, and the number nobody could read was written into `notes` rather than
thrown away.

**A defect this pass survived a clean typecheck, a clean lint and 18 passing unit tests, and died
the moment a browser loaded the page** — the third time this file has recorded that lesson. The
phone input carried `maxLength={10}` on the DOM element. The browser applies that to the raw text
*before* React sees it, so pasting the local form `01711223344` was cut to `0171122334` and only
then had its trunk `0` stripped, leaving nine digits and a number that fails validation. Both
checkout specs failed on it. The cap belongs after normalisation, not before, and there is now a
test that says so.

Chasing that failure to the end also settled **[D41](#known-defects)**, which this file had carried
since 2026-08-31 as "not diagnosed" and as a reason the E2E job cannot run against a production
build. It is not a production-build problem: the spec waited for `getByRole("radio").first()`, which
matches the payment radios as well as the delivery ones, and those render before
`/shop/shipping-options/` has answered. The wait is now scoped to the delivery card. Attribution was
established the only way it can be — by running the same spec on `main`, where it failed
identically.

### E2E made repeatable, and a production-only defect found, 2026-08-28

Ran with `scripts/dev-stack-native.sh` (new) — one command for postgres, redis, api and web.

```text
vitest wired into ci.yml ............... 79 tests now actually protect something
playwright, 3 consecutive full runs .... 15/15, 15/15, 15/15 against next dev
                                         (the 2nd run used to fail, every time)
tsc --noEmit / next lint / vitest ...... clean
```

**[D18](#known-defects)'s diagnosis was wrong.** "The E2E suite is order-coupled" — it is not. Run in
any order against a fresh database, every spec passes. The suite was *not repeatable*, which looks
identical from the outside and is fixed differently: by restoring what the specs consume, not by
reordering anything. Two distinct causes, and the second only became visible after fixing the first:

1. The returns spec approves, receives and refunds the single seeded `REQUESTED` return. A second run
   finds none and waits 60s for a table row that will never appear. `e2e/global-setup.ts` reseeds.
2. Reseeding regenerates every id, but Next kept serving the cached product page, so "add to cart"
   posted a variant that no longer existed — a 200 in the logs and a cart drawer that never opened.

Cause 2 turned out to be a real defect in its own right, [D39](#known-defects): `/api/revalidate`
allowed a `products` tag that **nothing emits**, while the product page tagged `product:<slug>`, which
the endpoint **refused**. The one page the endpoint existed to keep fresh was the one page it could
not touch. That matters beyond tests — restoring a backup behind a running storefront has exactly the
same effect.

**The E2E job is not in CI, deliberately.** Wiring it up meant running the suite against a production
build for the first time, and `Admin › recording an expense…` fails there consistently while passing
consistently in dev ([D40](#known-defects)). The money is fine — the void posts its compensating
adjustment and `verify_accounts` is clean — but the screen is not, and it reproduces with the D39 fix
reverted, so it is pre-existing rather than collateral. Adding a CI job that is knowingly red would
turn every future build red for a defect unrelated to whatever the build is checking, and skipping the
spec to get green is what CLAUDE.md §9 forbids. **Vitest is wired in now; the E2E job is written and
waits on D40.**

Worth stating plainly: five verification passes ran the suite against `next dev` and called it
verified. One run against a production build found a defect none of them could. The gap between "it
works" and "it works the way it ships" was a whole class of bug wide.

### VAT settled, 37 and 38 shipped, D40 narrowed, 2026-08-31

Ran with `scripts/dev-stack-native.sh` (postgres, redis, api, web), plus a production build served
the way the image serves it — `node .next/standalone/server.js`, not `next start`, which Next itself
warns does not work with `output: "standalone"`.

```text
pytest ................................. 551 passed (up from 503)
ruff check + ruff format ............... clean
tsc --noEmit / next lint ............... clean
playwright, dev, reseeded .............. 20/20
playwright, production standalone ...... not green -- D40 and D41 (D41 fixed 2026-09-09)
```

**Verified in a browser, signed in as the owner**, not just typechecked:

```text
VAT card read "Not yet decided"; changing to inclusive 15% raised the
confirmation gate naming 40 seeded orders; "Change it anyway" saved it and
stamped who and when.
A ৳2,950 shelf price then priced as ৳2,950 to the customer with ৳384.78 of VAT
extracted -- through the storefront cart, not just the pricing service.
Business summary: 236,290 − 1,320 = 234,970 net revenue; − 117,800 COGS =
117,170 gross profit; − 197,035 expenses = a 79,865 loss.
Party ledger: ৳68,160 owed across 5 customers, ৳2,296,520 owed to suppliers;
expanding Tasnim Karim listed the three orders (4,250 + 10,150 + 8,400) that
add to her 22,800.
```

**Two defects the reports carried before anything was built over them.** The pattern this file has
been tracking held for an eighth pass:

1. *Revenue counted VAT as turnover.* `dashboard`, `profit_report` and `product_performance` all
   summed `line_total`, which under inclusive pricing contains the tax. Each would have overstated
   revenue, gross profit and margin by exactly the VAT the moment an owner chose inclusive — a defect
   that could not exist until the inclusive half was implemented, and would have shipped with it.
2. *[D20](#known-defects) was only ever fixed at one endpoint.* Every report answers with a plain
   selector dict, so `COERCE_DECIMAL_TO_STRING` never applied and money left as JSON floats on
   `/reports/profit/` and `/reports/dashboard/` too. The frontend types already said `string`. One
   existing test was pinning the bug.

**Two found by running it rather than typechecking it.** The party-ledger page passed a callback prop
from a server component to a client one — clean typecheck, clean lint, and the page failed outright
on first load. And a cashier could read the whole party ledger, because the first cut reused
`finance.view` (which cashiers hold, deliberately, to pick an account for a sale) instead of
`reports.financial`.

**D40 is not what it looked like, and it was two bugs.** Five hypotheses ruled out by experiment, and
then the suite started failing on `next dev` as well — which it had never done — at 18:18 UTC, which
is 00:18 in Dhaka. That was [D42](#known-defects): the screen built its window from the **UTC**
calendar date while the API widened it to the end of that day in the **shop's** timezone, so for the
six hours a day those disagree, an expense vanished from the screen that recorded it. Fixed. What is
left of D40 is the half that only appears in a production build: the money is right, the server is
right, and only `router.refresh()` fails to apply what it fetched.

Worth stating plainly, because it is the second time this pattern has shown up in this file: a defect
that "fails in production and passes in dev" was, for one of its two causes, really "fails after
18:00 UTC and passes before". Environment-shaped explanations are easy to reach for and hard to
disprove; this one held for three days.


### Product specifications verified, 2026-09-14

Built and verified on `claude/roadmap-review-prioritize-6g79qz`, on a Linux container with
PostgreSQL 16 and Redis run natively (`scripts/dev-stack-native.sh`'s topology, Python 3.12).

```text
baseline before any change ..................... 934 passed
migration (catalog 0006) ....................... applied clean, unapplied and re-applied clean,
                                                 `makemigrations --check` clean
pytest ......................................... 959 passed (25 new: 24 in
                                                 tests/api/test_product_specs.py, 1 query-growth
                                                 guard in tests/test_performance.py; plus two
                                                 assertions added to tests/test_seed_reset.py)
ruff check + ruff format --check ............... clean (197 files)
frontend typecheck (tsc --noEmit) .............. clean
frontend eslint (npx eslint src) ............... clean
vitest ......................................... 187 passed, 12 files
seed_demo --reset .............................. 12 products, 72 variants, every product stating
                                                 its category's specifications
query budgets .................................. 20/20 pass. Product detail 13 -> 14 (budget 18);
                                                 the listing, home and feed budgets are unchanged,
                                                 because the spec prefetch is on detail only
storefront read in a browser ................... /product/hydrating-face-serum shows
                                                 "Skin type: Dry, Combination"; leather-formal-shoes
                                                 shows "Sole: Leather"; city-handbag shows
                                                 "Dimensions: 32 x 24 x 12 cm"; classic-oxford-shirt
                                                 shows Material, Gender and Fit. JSON-LD carries
                                                 `additionalProperty` on all four
admin driven in a real Chromium ................ signed in as owner, /admin/products/<shoes>:
                                                 the Specifications card offers exactly Material,
                                                 Gender and Sole (the three non-variant-defining
                                                 attributes the Formal category declares), each
                                                 with its seeded value ticked. Ticked "Sole: Rubber",
                                                 saved with no error summary, reloaded: Leather AND
                                                 Rubber both ticked. Multi-value round-trips
```

**Every guard was seen red before it was seen green.** Each was sabotaged in turn and the matching
test watched fail: the variant-axis refusal (serializer *and* service), the replace-not-append
semantics, the missing-id check, both delete refusals, the `is_variant_defining` side-change guard,
the storefront payload, and the N+1 growth test (`assert 22 == 16`).

Three things the build found, none of them the feature:

1. **The `is_variant_defining` guard was half a guard.** It refused to turn the flag *off* under
   existing variants and let it be turned *on* freely — which now strands spec rows the same way.
   Found by reading the validator before extending it, which is the habit this file keeps
   recommending, not by a failure.
2. **A three-level string prefetch is three queries, and a one-level one is an N+1.** See
   [database/indexing.md](database/indexing.md#the-spec-list-three-ways-to-write-one-prefetch-two-of-them-wrong).
3. **Every seeded product said "Machine wash cold. Do not bleach."** — on a face serum and on leather
   shoes. Caught by reading the rendered page, after 958 tests, a clean `tsc` and a clean lint had all
   passed. Demo data rather than code, like [D54](#known-defects); each product now carries care
   advice that suits it.

**The variant matrix was scoped too, later the same day.** It had been left out of the pass above and
written down as Tier 2 #2, because it changes a screen that works today; it is now done, and the
reasoning is below.

### The variant matrix scoped by category, 2026-09-14

The Specifications card asked the category what was relevant while the *variant matrix above it*
still offered every axis in the shop — editing a pair of shoes showed Shade, Volume and Capacity.
Half a form scoped is worse than none, because it reads as arbitrary.

Two rules make it safe, and both are pinned by tests that were watched fail first
(`lib/commerce/category-attributes.test.ts`, 11 cases):

1. **A category that declares nothing offers everything.** The seed wires attributes to *leaf*
   categories, so a product filed against "Men" — or any category somebody has just created —
   would otherwise have no axis at all and could never be given a variant. That reads as a broken
   form rather than as missing configuration.
2. **An axis the product already uses is always offered**, declared or not. This is the one that
   matters: `buildMatrix` appends every saved variant whatever is ticked, so hiding the fieldset for
   an axis a product is built on would leave those rows visible, unlabelled and un-editable — rows
   that may hold stock and that the ledger and order history still point at. Proven in the browser
   by re-filing the shoes under Handbags, which declares no shoe size: the axis stayed, all four
   matrix rows stayed, and all five ticked values stayed reachable.

A failed lookup falls back to offering everything and says so, rather than blocking the form.

The fetch moved into `ProductForm` and `ProductSpecPicker` became presentational, so **one request
serves both halves** — two would let the axes and the specifications disagree about what the same
category declares.

```text
seen in a browser, signed in as owner
  Leather Formal Shoes (Formal) .. axes: Shoe size, Colour        specs: Material, Gender, Sole
  City Handbag (Handbags) ........ axes: Colour                   specs: Material, Dimensions
  Matte Lipstick (Lipstick) ...... axes: Shade                    specs: Skin type
  re-filed shoes -> Handbags ..... axes: Shoe size, Colour (kept), 4 matrix rows intact
vitest .......................... 198 passed, 13 files (11 new)
tsc --noEmit / eslint src ....... clean
```

Before this, all three of those products offered Size, Shoe size, Colour, Shade, Volume and
Capacity. No backend change: the endpoint added earlier in the day was already the right shape.

### What VAT still needed, and the refund it was hiding, 2026-09-18

The question was narrow — the treatment and the rate have had an input field at `/admin/settings`
since 2026-08-31, so what else does VAT need? Most of the answer is "nothing": the per-category
override, the BIN, the tax line in cart, checkout and the POS receipt, and the per-order frozen
treatment are all built. Checking the last of those found [D78](#known-defects) instead.

A refund was computed from `OrderItem.line_total`, which under `EXCLUSIVE` does not include the
tax — that sits in `tax_amount`, a column nothing was reading:

```text
EXCLUSIVE @ 15%, one item at 1,000
  line_total 1000.00   tax_amount 150.00   customer paid 1150.00
  refund offered                                        1000.00   <- 150 kept

INCLUSIVE @ 15%, one item at 1,000
  line_total 1000.00   tax_amount 130.43   customer paid 1000.00
  refund offered                                        1000.00   <- correct
```

One expression served both treatments and was right in one of them, so no test failed and no
number looked odd. It is latent at the shipped rate of `0.0000`, where the two treatments agree.

```text
pytest tests/test_tax.py ..................... 31 passed (4 new)
pytest -k "return or refund or tax or pos or checkout"  268 passed
pytest (whole suite) ......................... 1059 passed
ruff 0.8.4 check + format --check ............ clean, 200 files
```

Three of the four new tests fail against the old arithmetic. The fourth is the `INCLUSIVE` case,
which passed before and after — it is there because the obvious wrong fix is to add the tax
unconditionally, and nothing else would catch that.

**A note on the ruff version.** This container has ruff 0.15.8; `requirements/dev.txt` pins 0.8.4,
which is what `ci.yml` installs. 0.15.8 reports 8 lint findings and 4 formatting differences across
files nobody has touched. They are not real — under the pinned version the tree is clean. Run the
pinned one before believing a lint result here.

What is genuinely missing is now [gap 11](#gaps-to-close-before-go-live): no VAT return, and a
storefront price with no "incl. VAT" wording beside it.

### VAT made usable: a return to file, a price that says so, 2026-09-18

Go-live gap 11, both halves, plus the thing that had to exist underneath.

**The filing.** `GET /reports/vat/` and `/admin/reports/vat`: output VAT, less
credits on returns, less input VAT, split by rate and broken into calendar months.
Output VAT is the same sum `business_summary` already reported as `vat_collected`,
and a test holds the two to the same answer so they cannot drift.

**The thing underneath.** `PurchaseOrderItem.tax_rate` has existed since the first
migration and `recalculate_totals` has always read it — but `PurchaseLine` had no
such field, so **nothing at any layer could set it**. Every purchase order ever
raised carried `tax_total 0.00`. A VAT return shipped on that would have told the
owner they owed the full output VAT with nothing to reclaim, which is a worse
answer than no report at all. The chain is wired and the purchase order form asks
for one VAT percentage per order.

**The price.** `+ 15% VAT` / `incl. 15% VAT` beside every shop price, and nothing
at a zero rate. Resolved per product server-side, because a category override
replaces the organisation rate and the note has to be true of the price beside it.

### The browser found the one thing the tests could not

Three iterations through the treatments, eleven seconds apart, and the product page
showed the *previous* setting every time:

```text
EXCLUSIVE 15%  ->  (no VAT note)      <- still the 0% it started at
INCLUSIVE 15%  ->  + 15% VAT          <- still EXCLUSIVE
EXCLUSIVE  0%  ->  + 15% VAT          <- still 15%
```

The product page caches against the `products` tag with a 60-second ISR window, and
nothing busted it: before this change the VAT setting touched no storefront page, so
nothing had to. `update_tax_settings` now pings the storefront the same way a menu
edit does. With the ping in place, all eight checks pass:

```text
EXCLUSIVE 15%   product + 15% VAT      listing 12 cards, + 15% VAT
INCLUSIVE 15%   product incl. 15% VAT  listing 12 cards, incl. 15% VAT
EXCLUSIVE 7.5%  product + 7.5% VAT     listing 12 cards, + 7.5% VAT
EXCLUSIVE 0%    product (no note)      listing 0 cards
CSP refusals: 0
```

### The browser found a second thing: a figure that was right and read wrong

The return, against a real sale placed at 15% and purchases carrying the supplier's
VAT, first came back like this:

```text
Taxable sales                          149,790.00
Output VAT charged                         885.00
...
Input VAT paid to suppliers             (2,250.00)
taxable_purchases                    2,632,881.60
```

Every number was correct and the pair was nonsense: 885 on 149,790 is 0.6% where
the rate was 15%, and 2,250 on 2.6M is 0.09%. **"Taxable" had been made to mean
every sale and every purchase in the period**, and the period spans the rate change
— it holds 26 orders priced at zero before the rate was set, and the seeded
purchase history.

A filer dividing one by the other gets a rate the shop never charged. `taxable`
now means the base the tax was actually computed on, and zero-rated supply is
reported *beside* it on both sides rather than folded into it:

```text
Taxable sales                            5,900.00      <- 885.00 is exactly 15%
Output VAT charged                         885.00
VAT credited on completed returns           (0.00)
Input VAT paid to suppliers             (3,000.00)     <- 15% of 20,000.00
VAT given back on goods returned           600.00      <- 15% of 4,000.00
Net VAT payable                         (1,515.00) reclaimable

by rate   15% exclusive   1 order    5,900.00    885.00
           0% exclusive  26 orders 143,890.00      0.00
zero-rated supply: 143,890.00 of sales, 2,619,881.60 of purchases
```

The by-rate table still carries every rate, so nothing is hidden — it is the split
a return is filed by. The 0% row is the seeded history, which is exactly what that
split is for: the period holds both because the rate changed inside it, and each
order kept the rate it was priced under.

**And a third, from #37 merging mid-flight.** Purchase returns landed on main while
this branch was in progress, so the report was claiming input VAT on goods no longer
held. A purchase return credits the *cost*; the tax has to be reclaimed back
separately, dated by `returned_at`.

Two smaller things the same pass caught, both in code written that morning: the
monthly table printed `-615.00` where the statement above it printed `(615.00)` —
two notations for one idea in one screen — and the rate column read `15.0%` where
the storefront reads `15%`. Both now use one helper.

```text
pytest ....................................... 1097 passed
ruff 0.8.4 check + format --check ............ clean, 201 files
tsc --noEmit / next lint ..................... clean
vitest ....................................... 260 passed
```

## Still unproven

Do not describe any of these as working.

| Area                                    | State                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Playwright (`npm run test:e2e`)~~ | **Proven repeatable.** 20/20 against `next dev` with a reseed, 2026-08-31, and in CI from the same day. **The suite is 42 specs now, not 20** (desktop + mobile projects). On 2026-09-21 it ran **40 passed / 2 failed against a production build** — both failures [D40](#known-defects) — and after that fix, **42/42 against a production build**, which is the first time the whole suite has been green against the artefact that actually ships. `apps/web/Dockerfile.dev` is still alpine, so [D7](#known-defects) stands *for the dev container* only |
| ~~Vitest and Playwright in CI~~         | **Both wired in, and the Playwright job now runs against a production build.** Vitest since 2026-08-28; the Playwright job landed 2026-08-31. It used `next dev` because [D40](#known-defects) failed two specs against a real build; with D40 worked around it ran 42/42, and the job was switched on 2026-09-21 — `next build`, then the standalone `server.js`, with `.next/static` and `public` copied in beside it the way the Dockerfile does. `next start` cannot serve a `standalone` build, and the server binds `process.env.HOSTNAME`, so the job overrides it to `0.0.0.0` |
| ~~Admin**write** screens, signed in~~ | **Proven 2026-08-28.** A real Chromium signed in as the owner and drove all five new screens: a customer created, an address and a note added, two coupons created, a zone and a method created, a review rejected and re-approved. 13 writes, all landing. The organization and branch editors are still only read-anonymously-redirected |
| Payment gateway                         | No live provider; the card option is visibly**disabled**, not faked                                                                         |
| ~~Backup restore~~                       | **Proven 2026-08-22, under real conditions** — a `pg_dump -Fc` taken 14 minutes earlier was the only surviving copy of the production database after its volume was destroyed, and `pg_restore` brought back all 74 tables, 40 orders, 12 products, 6 users and 169 ledger rows |
| Load / performance                      | Query budgets **are** asserted — `tests/test_performance.py` and `tests/test_concurrency.py` ran 38 passed on 2026-09-21. What is still missing is a **load test**: a budget is a query count, not a latency under concurrency, and nothing has driven listing, checkout or POS search at peak |
| Security                                | Controls implemented, audits and image scans automated;**no independent penetration test**. 2026-09-21 is the argument for one: auditing a single control found every rate limit bypassable by a header and the audit trail writable by the caller ([D88](#known-defects)), both of which this table and `security.md` had listed as present. **2026-09-23 made the same argument three more times**: auditing uploads, the session and branch scope found receipts public, sign-out not revoking after thirty idle minutes, every report readable for any branch, and stock transferable out of any branch ([D91–D94](#known-defects)) — all four listed as controlled. **2026-09-24 once more**: of five more controls measured, CORS and CSP held, but the CSRF token `security.md` listed had never been built ([D101](#known-defects)), one error path echoed SQL ([D99](#known-defects)), and the order-tracking link returned the staff record ([D97](#known-defects)) |
| Deployment                              | Compose prod stack + green CI;**no live environment** — nothing has ever been deployed                                                     |
| Footer / page cache refresh             | Saving the footer, a social link or a page pings the web app to drop its cache (`site`, `pages`, `page:<slug>`). The signals and the route's allow-list are tested; the round trip is **not** — the 2026-09-26 browser pass had no `WEB_REVALIDATE_URL`. Without it, edits reach the storefront within the 5-minute cache window |

## Known defects

Found by diagnosis on 2026-08-18. None is a data-integrity or money bug; all are user-visible or
process gaps. D1, D2, D3, D4, D5, D10, D11, D12, D13, D16, D17, D41, D43a, D43b, D44, D45, D46, D48
and D49-D60 have since been fixed and are struck through.

**Everything from D49 on was found by a complaint or by an audit, not by diagnosis.**
D88 is the first found with no prompt at all: the backlog had run out of unblocked work, so a
control was audited instead — and the control was decorative.
D49-D55 came from one sentence — the owner said the dashboard's date filters did nothing —
behind which sat seven separate causes, only one of them (D54, the seed) the obvious one.
D56-D58 were three more the owner could see: the sidebar, the header, the loaders. D59 and D60
came out of checking the attribute endpoints before building a screen over them, which is the
habit this file keeps recommending; D60 is the reason that screen had been read-only at all.
**D16 no longer blocks deployment** — the CSP is nonce-based and verified against the production build.

| #        | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                 | Impact                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~D1~~  | ~~**Wishlist cannot be filled.**~~ **Fixed 2026-08-21** — `WishlistHeart` on the product card calls `POST`/`DELETE /shop/wishlist/`; a shared `useWishlist` Zustand store backs it, the header count, and `/wishlist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `apps/web/src/components/commerce/wishlist-heart.tsx`, `apps/web/src/lib/store/wishlist.ts`       | —                                                                                                                                              |
| ~~D2~~  | ~~**Reviews cannot be written.**~~ **Fixed 2026-08-21** — the reviews section now renders unconditionally (hiding it at zero reviews made the form unreachable) and carries `ReviewForm`: a five-radio star group, headline and comment, posting to `POST /shop/products/{slug}/reviews/`. Eligibility stays on the server — the form submits and shows what the API says, rather than re-implementing the verified-purchase rule                                                                                                                                                                                                                                                                                                      | `apps/web/src/components/commerce/review-form.tsx`                                                  | —                                                                                                                                              |
| ~~D3~~  | ~~**Notifications have no UI.**~~ **Fixed 2026-08-21** — a bell in the admin header polls `GET /notifications/count/` every 60s (only while the tab is visible), opens a panel of the eight most recent, and links to `/admin/notifications` with all/unread filtering, per-item and bulk mark-as-read                                                                                                                                                                                                                                                                                                                                                                                                                                  | `apps/web/src/components/admin/notification-bell.tsx`, `app/(admin)/admin/notifications/page.tsx` | —                                                                                                                                              |
| ~~D4~~   | ~~**The brand appears twice in product titles.**~~ **Fixed 2026-09-09** — the seed wrote `seo_title = "<name> | Rangon Fashion"` while the root layout applied `template: "%s | Rangon Fashion"`. The admin form had papered over it with a hint asking merchants not to type the shop name, which is a rule an import or a seed never reads. `lib/seo.pageTitle()` now returns an absolute title and appends the shop name only when it is not already there, so the decision sits in one place rather than in whoever wrote the field. The seed no longer writes the suffix, and the hint says what the field does instead of warning about a defect |
| ~~D5~~  | ~~**The cart drawer dialog has no description.**~~ **Fixed 2026-08-18** — `Dialog.Description` added; the drawer now renders `aria-describedby`, verified in the browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/web/src/components/commerce/cart-drawer.tsx`                                                  | —                                                                                                                                              |
| ~~D6~~   | ~~**mypy reports 271 errors in 41 files, and the gate never blocks.**~~ **Fixed 2026-09-21** — **271 errors in 41 files to 0 in 152**, and the trailing `\|\| echo` is off the CI step, so the next error to arrive fails the build. The count had drifted by a factor of nearly three since 2026-08-18 for exactly that reason. **189 of the 271 were `arg-type`**, and the largest group inside it — 81 — was one sentence repeated: DRF types `Request.user` as `User \| AnonymousUser`, and a handler behind `IsAuthenticated` has already ruled out the second half. `core.requests.AuthedRequest` states that once; 87 handlers use it, and 36 more use `actor(request)` where narrowing an override's parameter would break Liskov. One annotation — `MONEY_FIELD: dict[str, Any]` — was worth 80 on its own. **Two real defects fell out of it**: `POST /shop/account/addresses/` answered 500 for a customer account with no `Customer` row (now 404, three tests), and `seed_demo` read `ShippingMethod…first().pk` unguarded. Three deliberate `# type: ignore`s remain, each naming the stub imprecision it covers; three stale ones came out. See [§ D6 fixed](#d6-fixed-and-the-type-gate-now-blocks-2026-09-21) | `apps/api`, `.github/workflows/ci.yml` | — |
| D7       | **Playwright cannot run in the *dev container*.** `apps/web/Dockerfile.dev` is `node:22-alpine`; Playwright ships no musl browser builds. **Narrowed 2026-08-28** — this was being read as "Playwright cannot run here", which is false: a pre-installed Chromium drove the full signed-in walk-through (see the verification log). The defect is the Alpine dev image alone, and `playwright.config.ts` already carries the `PW_CHROMIUM_PATH` escape hatch |
| ~~D21~~ | ~~**The image scan went red on a base-image CVE.**~~ **Fixed 2026-08-27** — `node:22-alpine` shipped openssl `3.5.7-r0` while Alpine 3.24 already carried the `3.5.8-r0` fix for CVE-2026-14456, so `Build & scan images` failed on every branch through no fault of any diff. The runtime stage now runs `apk upgrade --no-cache`, which is safe to do unconditionally because the gate sets `ignore-unfixed: true` — it only ever fails on a CVE whose fix is already published. Without this, the scan stays red until upstream rebuilds the base image. **The Debian half followed 2026-09-09**, when the same gate went red on the *API* image: `python:3.12-slim-bookworm` shipped libssh2-1 `1.10.0-3+b1` while bookworm-security already carried the `1.10.0-3+deb12u1` fix for CVE-2026-58050 and CVE-2026-7598. `main` had been red on it since 2026-09-08 and no diff had caused it. The runtime stage now runs `apt-get upgrade -y`, which is safe for the reason the Alpine half is: the gate sets `ignore-unfixed: true`, so it only ever fails on a CVE whose fix is published |
| ~~D19~~ | ~~**CSV export 404'd on every report.**~~ **Fixed 2026-08-27** — `?format=csv` is DRF's format-negotiation parameter, and no renderer advertised `csv`, so all eight report endpoints answered 404 and the download links on `/admin/reports` had never worked. A `CSVRenderer` on `BaseReportView` fixes all of them |
| ~~D20~~ | ~~**Computed money left the API as JSON floats.**~~ **Fixed 2026-08-27** — `accounts/cash-position/` returned `661480.0` rather than `"661480.00"`, because it responds with plain selector dicts and DRF encodes `Decimal` as a number. CLAUDE.md §4 forbids float for money, and `CashPosition` in the web app's `types.ts` already declared these as strings. Now serialized through `DecimalField` |
| ~~D22~~ | ~~**A stock count could never be counted.**~~ **Fixed 2026-08-27** — `counted_quantity` was write-protected by a `read_only=True` nested serializer and set by nothing, so `apply` adjusted nothing and silently marked the sheet APPLIED. No test covered stock counts at any level. Added `record/` and `cancel/`, made `apply/` refuse an empty or non-COUNTING sheet, and wrote the first 20 tests the feature has had |
| ~~D23~~ | ~~**`seed_demo --reset` died once a stock count or transfer existed.**~~ **Fixed 2026-08-27** — `StockCountItem` and `StockTransferItem` hold PROTECT references to `ProductVariant`, and `_reset()` deleted the catalogue first. Harmless while those documents were unreachable from the UI; phase 39 made them ordinary. This is the second time the same omission has bitten (phase 36's `Expense` was the first), so it now has a regression test that creates one of each protecting document and resets |
| ~~D18~~ | ~~**The E2E suite is order-coupled.**~~ **Diagnosis corrected and fixed 2026-08-28** — the specs are *not* order-coupled: run in any order against a fresh database they all pass. They were **not repeatable**, which looks identical from outside and is fixed differently. Two causes: (1) the returns spec *consumes* the single seeded `REQUESTED` return, so a second run finds none — `e2e/global-setup.ts` now restores the fixtures; (2) `seed_demo --reset` regenerates every id while Next keeps serving the cached product page, so "add to cart" posted a variant that no longer existed — see [D39](#known-defects). Three consecutive full runs now pass 15/15 against `next dev`, where the second used to fail |
| ~~D8~~   | ~~**Dev and prod web images share one tag.**~~ **Fixed 2026-09-09** — every built service now carries an explicit `image:`: `rangon-api:latest` / `rangon-web:latest` in `docker-compose.yml`, `rangon-api:dev` / `rangon-web:dev` in the dev overlay. Neither file set one, so Compose derived the tag from project + service and `docker compose build web` (production `Dockerfile`) and the dev overlay's build both produced `rangon-web:latest`, the second silently replacing the first. The production runtime deliberately deletes npm, so a later `up -d` without `--build` would start it with `npm run dev` and fail. `api`, `worker` and `beat` had the same collision and were fixed with it | `docker-compose.yml`, `docker-compose.dev.yml` | Was a confusing, self-inflicted breakage after any production build. Also recorded in `.claude/environment.md` §8 |
| D9       | **Seed data has no product images.** Every storefront card and product page renders the "no image available" placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `seed_demo`                                                                                         | The photography-led storefront of`CLAUDE.md` §10 cannot actually be judged                                                                   |
| ~~D16~~ | ~~**The production CSP renders a blank page.**~~ **Fixed 2026-08-21** — `apps/web/src/middleware.ts` mints a per-request nonce and sends the policy itself; Next stamps that nonce onto every script it emits (42 of 42 in the production build), so `script-src` is `'self' 'nonce-…' 'strict-dynamic'` with **no** `unsafe-inline` and **no** `unsafe-eval`. Both nginx configs had their `add_header Content-Security-Policy` **removed** — `add_header` appends, and a browser enforces the intersection of every policy it receives, so a second header would have re-broken hydration. Verified in Chromium against the production image: home page hydrates, 19 product cards, zero CSP violations | `apps/web/src/middleware.ts`, `infrastructure/docker/nginx/**`                                    | —                                                                                                                                              |
| ~~D17~~ | ~~**Nginx sent `/api/proxy/*` and `/api/auth/*` to Django.**~~ **Fixed 2026-08-19** — those prefixes are Next.js route handlers (`/api/proxy/*` attaches the httpOnly token, `/api/auth/*` sets it at login), but the config routed all of `/api/` to the API, so they 404'd. Pages rendered while **every interactive feature was dead**: sign-in, cart, checkout, POS sales, admin actions. Caught by clicking "Add to cart" against the production build                                                                                                                                                                                                                                                                 | `infrastructure/docker/nginx/conf.d/rangon.conf`, `docs/operations/webuzo-deployment.md`          | Would have made the first real deployment look completely broken                                                                                |
| ~~D14~~  | ~~**`backup-db.sh` cannot run in the API container.**~~ **Fixed 2026-09-09** — the API image ships `pg_dump` 15.19 against a PostgreSQL 16.15 server, which aborts with a version mismatch, and the script also resolved the Docker-network host `db`. Pinning a client version into the API image only moves the failure to the next major upgrade, so `backup-db.sh` and `restore-db.sh` now run the client **inside the database container** — where it is the same build as the server, by construction — and stream the bytes to the host, where the AWS CLI and the retention policy are. `BACKUP_VIA=direct` keeps the old path for a managed database, and checks the client major against `server_version_num` first rather than letting libpq produce the error above. Streaming `pg_dump`, `pg_restore --list` and a streamed restore were each run against a real PostgreSQL 16 | `scripts/backup-db.sh`, `scripts/restore-db.sh`, `operations/backups.md` | The backup script is the one thing that must work before anything else does |
| ~~D15~~  | ~~**Production Nginx config would not start.**~~ **Fixed 2026-09-09** — the config used `${RANGON_DOMAIN}` in `server_name` and the TLS certificate paths, but Nginx does not expand environment variables in config files and the file was mounted straight into `conf.d/`. It is now `templates/default.conf.template`, which the official image renders with `envsubst` at start; the prod overlay passes `RANGON_DOMAIN` (required, no default) and sets `NGINX_ENVSUBST_FILTER=RANGON_` so nginx's own `$host`/`$scheme` survive. The name matters: rendering to `default.conf` replaces the stock file, and under any other name the image's default server would win :80 and swallow the ACME challenge. The second half — the `api_static` volume serving `/static/` was never populated — is fixed too: `api` mounts it, and `collectstatic` is step 3b of the release procedure, because a named volume is seeded from the image only on first creation | `infrastructure/docker/nginx/`, `docker-compose.prod.yml` | First deploy using the shipped prod stack failed to start. Sidestepped by the Webuzo topology, which drops that container |
| ~~D10~~ | ~~**N+1s on the three busiest list endpoints.**~~ **Fixed 2026-08-18** — `GET /shop/home/` **511 queries / 2.42 s**, `GET /shop/products/` **363 / 1.29 s**, `GET /purchase-orders/` **156 / 0.58 s**. Common cause: `ProductVariant.label` is a property that joins attribute values, so any serialiser rendering a variant label costs a query per row unless the queryset prefetches that far. Now **29**, **13** and **15**, guarded by growth-based tests                                                                                                                                                                                                                                  | `orders/api/shop_views.py`, `purchasing/api/views.py`                                             | Was the single largest source of slow page loads                                                                                                |
| ~~D12~~ | ~~**POS searched on every keystroke.**~~ **Fixed 2026-08-18** — the scan field fired `/pos/products/?q=` per character with no debounce. A keyboard-wedge scanner types a 13-character barcode in ~100 ms, so **one scan issued 13 parallel requests** at ~700 ms each; six saturated the browser's per-origin connection limit and the `lookup` that Enter fires queued behind them. Now debounced at 220 ms with request cancellation, so a scan issues **none**. Five Vitest cases cover it                                                                                                                                                                                                                              | `apps/web/src/components/pos/register.tsx`                                                          | The register appeared to freeze on every scan — the most severe user-facing defect found                                                       |
| ~~D13~~ | ~~**Admin product list paginated without ordering.**~~ **Fixed 2026-08-18** — Django warned `UnorderedObjectListWarning`; PostgreSQL may return unordered rows in any order, so page 2 could repeat or skip products page 1 already showed. Now `-created_at, pk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/api/catalog/api/views.py`                                                                     | Correctness, not just speed                                                                                                                     |
| ~~D11~~ | ~~**Dev container ran a different Next than CI.**~~ **Fixed 2026-08-18** — `/app/node_modules` is an anonymous volume, so it kept a pre-upgrade install (15.1.4) while the lockfile, image and CI were all on 15.5.23; image rebuilds could not dislodge it. Recorded in [.claude/environment.md](../.claude/environment.md) §7                                                                                                                                                                                                                                                                                                                                                                                                           | `docker-compose.dev.yml`                                                                            | Local behaviour diverged from CI with no signal                                                                                                 |
| ~~D24~~ | ~~**`customers.view` could write.**~~ **Fixed 2026-08-28** — the `addresses` and `notes` actions each served GET *and* POST but declared one permission list, `customers.view`, so the write inherited the read's requirement. `ACCOUNTANT` holds `customers.view` deliberately without update, and could add an address or a note to any customer. `RolePermission` now accepts a per-method mapping and fails closed on an undeclared method; both actions declare `{"GET": [view], "POST": [update]}` |
| ~~D25~~ | ~~**A customer's addresses could be created but never edited or deleted.**~~ **Fixed 2026-08-28** — `CustomerViewSet` exposed `addresses` and `notes` as GET/POST only, and it is the only router registration, so no update or delete route existed on the admin surface. The *storefront* had full CRUD (`AccountAddressView`), making admin strictly weaker than the customer-facing page. Added `addresses/{id}/` (PATCH, DELETE) and `notes/{id}/` (DELETE) |
| ~~D26~~ | ~~**A customer could hold several default addresses.**~~ **Fixed 2026-08-28** — nothing demoted the previous default on either surface. `CustomerAddress` is ordered `("-is_default", "-created_at")` and checkout pre-fills from the first row, so the pre-filled delivery address was whichever row PostgreSQL returned. `customers.services` now owns the invariant under `select_for_update`, and both surfaces go through it |
| ~~D27~~ | ~~**An edit could leave a customer with no phone and no email.**~~ **Fixed 2026-08-28** — `CustomerSerializer.validate()` skipped its contact-detail check whenever `self.instance` was set, so a PATCH clearing both fields produced exactly the unfindable record phone-first identity exists to prevent. The check now runs against the resulting record, on create and update alike |

| ~~D28~~ | ~~**A once-per-customer coupon could be spent twice.**~~ **Fixed 2026-08-28** — `redeem()` re-checked the *total* usage limit under the coupon row lock but never the *per-customer* one, which is checked only in `validate_coupon` — and that runs while the cart is priced, before the lock exists. Two concurrent checkouts both passed validation and both redeemed. `usage_limit_per_customer` defaults to **1**, so the default configuration was the vulnerable one. Proven by a new threaded test that redeemed twice with zero refusals; the per-customer count is now re-read inside the existing lock |
| ~~D29~~ | ~~**An edit could invert a coupon's active window.**~~ **Fixed 2026-08-28** — `validate()` read `starts_at`/`ends_at` from the payload alone, so a PATCH sending only `ends_at` skipped the ordering check. No database constraint covered this, so the coupon was stored with a window `active_coupons` can never satisfy: it silently never applies. Rules are now checked against the resulting coupon |
| ~~D30~~ | ~~**Invalid coupon edits returned 409 instead of a field error.**~~ **Fixed 2026-08-28** — a PATCH changing only `value` skipped the percentage check (which reads `discount_type` from the payload), and a value of 0 was never checked at all. Both reached the database `CheckConstraint` and came back as a generic `CONFLICT` — data was safe and nothing leaked, but the form had no field to attach the message to |
| ~~D31~~ | ~~**A free-shipping coupon had to invent an amount.**~~ **Fixed 2026-08-28** — `value` is meaningless for `FREE_SHIPPING` (the discount is the shipping line being zeroed in `price_cart`), but the `value > 0` constraint applied to every row, so creating one meant submitting a number that would then mislead whoever read the coupon. Migration `0002` exempts the type; the serializer normalises the value to 0 and the form hides the field |

| ~~D32~~ | ~~**A negative `free_over` made every order ship free.**~~ **Fixed 2026-08-28** — `ShippingMethod.price_for()` returns 0 whenever `subtotal >= free_over`, so a negative threshold is satisfied by every order. The API accepted `-100.00` with a 201. A mistyped minus sign would have given away the shipping revenue on every sale, silently. Refused by the serializer and by a new database constraint |
| ~~D33~~ | ~~**A tracking update could write any status string.**~~ **Fixed 2026-08-28** — `ShipmentViewSet.events` read `request.data` directly and never used `ShipmentEventSerializer`, which existed and was only used to render the response. `status: "BANANA"` was stored with a 201. `ShipmentEvent` is append-only and its status drives `PACKED → SHIPPED → DELIVERED`, so the garbage was permanent *and* stopped the order progressing. Input now goes through the serializer |
| ~~D34~~ | ~~**A zone's city list could be a bare string.**~~ **Fixed 2026-08-28** — `cities` is a `JSONField`, so `"Dhaka"` passed. `ShippingZone.matches()` iterates the value, and iterating a string yields characters: the zone matched the city `"d"` and never `"Dhaka"`. It looks correct in the database and silently routes every order to the wrong zone. The serializer now requires a list and stores names normalised |
| ~~D35~~ | ~~**A delivery estimate could read backwards, and a malformed date 500'd.**~~ **Fixed 2026-08-28** — `min_days=5, max_days=2` was accepted and renders to a shopper as "5–2 days"; a non-date `occurred_at` reached the model and escaped as an unhandled `ValidationError` mid-transaction rather than a 400. Both refused now, the day order by a database constraint too |

| ~~D36~~ | ~~**A repeat buyer got one review, ever.**~~ **Fixed 2026-08-28** — §6a says "a second, later order of the same product earns a second review", but the code resolved the eligible order as simply the most recent one. A customer's second attempt therefore always landed on the order they had already reviewed and was refused, however many times they had bought the product. The most recent **unreviewed** eligible order is now chosen. Code and documentation disagreed; both were wrong to leave |
| ~~D37~~ | ~~**A non-numeric rating returned 500.**~~ **Fixed 2026-08-28** — `int(request.data.get("rating", 0))` raised `ValueError` on `"excellent"` and escaped unhandled; `4.7` was silently truncated to `4`, though §6a says ratings are whole numbers. Both are refused as validation errors now |
| ~~D38~~ | ~~**Moderation left no audit trail, and erased its own notes.**~~ **Fixed 2026-08-28** — approving or rejecting decides what the public sees, yet wrote no `AuditLog` entry, while the neighbouring `content` app logs every navigation change. The review row holds only the *latest* moderator and note, so reversing a decision erased the previous one — and `request.data.get("note", "")` wiped a rejection reason on re-approval. Each decision now writes an entry, and an omitted note keeps the existing one |

| ~~D39~~ | ~~**`/api/revalidate` could not bust the one page that needed it.**~~ **Fixed 2026-08-28** — the allow-list permitted `products`, which **nothing emitted**, while the product page tagged `product:<slug>`, which the endpoint **refused**. So the product page was the only page the endpoint could not invalidate: a merchandiser changing a price had no way to force it, and any operation that regenerates ids (a reseed, a restore from backup) left the storefront serving variant ids that no longer existed. The page now emits both tags and the endpoint admits the targeted form, bounded by a slug pattern so the allow-list stays an allow-list |
| ~~D40~~      | ~~**`router.refresh()` does not apply the payload it fetched. App-wide, not one screen.**~~ **Worked around 2026-09-21, not root-caused — and the workaround is verified rather than hoped.** Found 2026-08-28; re-scoped 2026-09-21 against a real production build (`next build`, then the standalone `server.js` the image runs) driven by Chromium. It is not a money bug and not a server bug: every write lands and the server renders the right thing. Only `router.refresh()` fails to apply what it fetched, and **it is stochastic, not deterministic** — `/admin/expenses` measured 0/5, 0/5, 2/5 and 0/8 across four runs of the same build; creating a brand 2/6; a category 4/6; the stock-count sheet failed its E2E spec. The failure rate rises with the weight of the page: a near-empty admin page under the identical layout chain applied it 5/5. **This row previously read "Not app-wide … specific to this screen", which was wrong**, and [D77](#known-defects) is the same defect rather than a second one. **Ruled out by experiment, 2026-09-21:** `RouteTransitionProvider` (removed entirely — still 0/5), the `<PendingRegion>` wrapper it drives, `searchParams`, the shape of the submit handler (an awaited POST, state writes, refresh, a write in `finally` — 5/5 on a light page), server render latency to 2 s (5/5), Next 15.5.25 (still 0/5), and `router.replace()` to the same URL (Next no-ops it). Earlier passes had ruled out the CSP middleware, `next start` vs the standalone server, a stale API response, the query string and sidebar prefetching. Removing any one section of the page still failed; removing all of them passed — cumulative, not one component. **The fix is `refreshAfterWrite()`**: `AdminLayout` stamps a fresh `data-render-id` per server render, the helper refreshes and then checks the stamp moved, and reloads only when it did not. 8/8 where the bare call was 0/8, and 8/8 on the real expenses screen | `apps/web/src/lib/navigation/refresh-after-write.ts`, `apps/web/src/app/(admin)/admin/layout.tsx`, 11 admin components | The root cause is still unknown and upstream: vercel/next.js#77504 reports the same thing and was closed as not planned. The helper is the seam to undo when it is fixed |


| ~~D41~~  | ~~**The storefront checkout specs are unstable.**~~ Found 2026-08-31 against a production build. **Diagnosed and fixed 2026-09-09**, and it was never about the build: the spec waited for `getByRole("radio").first()`, which also matches the **payment** radios. Those render unconditionally, while the delivery card renders no radios until `/shop/shipping-options/` answers. So the wait resolved immediately against "Cash on delivery", `check()` re-checked what was already checked, and "Place order" ran with `shippingId` still empty — failing on "Choose a delivery option". It is a race with the fetch, so it failed *sometimes*, and more often the slower the machine: on a container it failed both viewports in three runs out of three, and the same spec on `main` failed identically, which is what ruled the phone change out. The wait is now scoped to the delivery card. This was recorded as production-only because that is where it happened to be noticed; nothing in it is | `apps/web/e2e/critical-flows.spec.ts` | Was one of the two reasons the E2E job runs against `next dev` rather than a production build. [D40](#known-defects) is the other and is still open |
| ~~D42~~ | ~~**An expense recorded after midnight local time could not be seen.**~~ **Fixed 2026-08-31.** The expenses screen built its date window with `new Date().toISOString()` — the **UTC** date — and the API widens a bare `date_to` to the end of that day in the **shop's** timezone (`Asia/Dhaka`, UTC+6). The two agree for eighteen hours a day and disagree for the other six: at 00:18 in Dhaka the UTC date is still the previous day, so the window closed at 17:59 UTC — twenty minutes *before* the expense that had just been recorded. Between midnight and 06:00 local, an expense vanished from the screen that recorded it, on dev and production alike. Found by the E2E suite starting to fail on dev too, which it had never done, at 18:18 UTC. The window is now sent as exact instants, so there is no calendar day for the two ends to disagree about |
| ~~D43a~~ | ~~**Two counter sales at the same instant broke every later anonymous sale at that branch.**~~ **Fixed 2026-09-01.** `orders.services.pos.walk_in_customer()` resolved the branch's anonymous customer with `get_or_create(is_walk_in=True, name="Walk-in (<code>)")`, and nothing made that pair unique. `get_or_create` is only atomic when a unique constraint backs its lookup: without one, two registers both miss the SELECT, both INSERT, and from then on **every** call raises `MultipleObjectsReturned` — so every anonymous counter sale at that branch fails until someone deletes a row by hand. A till-stopping bug, not a flaky test, and **pre-existing on `main`**. Caught by `test_simultaneous_sales_all_land_in_one_drawer` on a contended machine (that run took 21m45s against ~5m normally); the same suite had passed twice earlier the same day, which is what a race window opening only under load looks like. Fixed by the partial constraint `customers_customer_walk_in_name_uniq`, expand/contract in two migrations — `0002` merges the duplicates an unconstrained database may already hold (orders repointed at the survivor, never deleted — CLAUDE.md §3), `0003` adds the constraint — and an `IntegrityError` re-fetch in the service for the caller that loses the race. **The two migrations cannot be one:** Django runs a migration in a single transaction and PostgreSQL then refuses to `CREATE INDEX` on a table still carrying pending FK trigger events from the repointing (*"cannot CREATE INDEX ... because it has pending trigger events"*). No test could have caught that — a fresh database has no duplicates, so the merge is a no-op and the index builds fine; it only appears on the upgrade path it exists for, and was found by running `migrate` against a database seeded with duplicates. Verified by removing the constraint again: 3 runs, 3 reproductions of the exact `MultipleObjectsReturned` failure; with it, 6 consecutive clean runs of the concurrency suite |
| ~~D43b~~ | ~~**Uploaded media was unreachable in any production build.**~~ **Fixed 2026-09-01** — three faults in one path. (a) Every media URL was `request.build_absolute_uri()`d, but the browser never reaches Django directly: through `/api/proxy/*` the `Host` is `api:8000`, through Nginx it is `localhost` with the port stripped, so the admin was handed `http://api:8000/media/...` and `next/image` answered **400** (the CSP's `img-src 'self'` would have blocked it regardless). URLs are now origin-relative via `core.media.media_url()`, which leaves S3's absolute URLs alone. This covered more than product photography: DRF absolutises **any** raw `FileField`, so category images, brand logos, navigation and banner images and expense receipts carried the same broken host — they now use `core.media.RelativeImageField`/`RelativeFileField`. (b) Nothing served `/media/`: `config/urls.py` mounted it with `static()`, which returns an empty list unless `DEBUG`, so uploads returned `201` and every fetch **404**ed. It is now mounted whenever `USE_S3=0`, Nginx routes `/media/` to the API, and `next.config.ts` rewrites it so the image optimizer — which re-enters the app's own router for a relative `src` — can reach it. (c) No media volume outside the dev overlay, so uploads died with the container | `apps/api/core/media.py`, `apps/api/config/urls.py`, `apps/web/next.config.ts`, `infrastructure/docker/nginx/`, `docker-compose.yml` | The admin could upload photography and never see it; the storefront stayed on placeholders |
| ~~D44~~ | ~~**Every successful DELETE through the proxy returned 500.**~~ **Fixed 2026-09-01** — `/api/proxy/[...path]` built its reply as `new NextResponse(text, { status })`, and a `204` **must** be constructed with a null body; the `Response` constructor throws `Invalid response status code 204` on anything else, the empty string included. So deleting a product image removed the row and *then* 500ed, and the retry 404ed. Found in the running production stack's logs | `apps/web/src/app/api/proxy/[...path]/route.ts` | Every 204-returning endpoint reached from the browser looked broken while having already succeeded |
| ~~D45~~ | ~~**Concurrent counter sales can duplicate the walk-in customer.**~~ **Fixed 2026-09-01** -- `get_or_create(is_walk_in=True, name=...)` was not atomic because nothing backed the lookup with a constraint, so six simultaneous POS sales made two rows and every later anonymous sale at that branch failed with `MultipleObjectsReturned`. Migration `0002` merges any duplicates an unconstrained database already holds and `0003` adds the partial unique index `customers_customer_walk_in_name_uniq` (separate migrations because PostgreSQL refuses to `CREATE INDEX` on a table still carrying `0002`'s pending FK trigger events). `walk_in_customer` now treats losing the race as the answer rather than an error: it catches the `IntegrityError` and re-fetches the winner's row. Covered by `apps/api/tests/test_walk_in_customer.py` | `apps/api/orders/services/pos.py:72`, `apps/api/customers/models.py` | Worse than a flaky test — once two rows exist, *every* later anonymous counter sale at that branch fails until one is deleted by hand |
| ~~D46~~ | ~~**Payable ageing lost a whole day to a clock that stepped backwards.**~~ **Fixed 2026-09-01** — `TestPayableAgeingUsesTerms::test_ageing_runs_from_the_due_date_not_the_order_date` failed intermittently in a full-suite run (`assert 9 == 10`) and passed in isolation. **Not a leaked clock**, which is what it looked like: `freezegun` is in `requirements/dev.txt` but imported nowhere in the repo, nothing patches `timezone.now`, no test passes `as_of`, and a session-long probe confirmed `timezone.now`'s identity never changes. The cause is that `max((now - due).days, 0)` floors towards negative infinity, so **any** backward step of the wall clock costs a full day — `(timedelta(days=10) - timedelta(microseconds=1)).days == 9`. And this clock does step backwards: the same probe caught four steps in one 325 s run (−0.121 ms, −0.215 ms, −4.4 ms, −82 ms), and a targeted measurement put it at ~0.01 % of read-pairs taken ~2 ms apart — the width of the `INSERT` between the fixture's clock read and the selector's. Both sides of the ledger now count **calendar days in the shop's timezone** (`finance.selectors._ageing_days`), which cannot lose a day to sub-second skew. Two regression tests pin the skew with `as_of` and fail on the old code with exactly `assert 9 == 10` and `assert 44 == 45` | `apps/api/finance/selectors.py:212`, `apps/api/tests/test_party_ledger.py` | A reported figure moved for a reason that had nothing to do with the invoice. In the product it also meant `oldest_days` could tick *down* between two page loads, and the same report gave two answers in one afternoon |
| ~~D47~~ | ~~**Two pytest runs on one machine corrupt each other.**~~ **Fixed 2026-09-15.** The test database name is now `rangon_test_<random>` per run rather than the pinned `rangon_test_db`, so two suites sharing one PostgreSQL cannot drop each other's database. **`os.getpid()` does not work and looks like it should** — it was tried first and reproduced the original failure exactly, because each `docker compose run` has its own PID namespace and two containers both start at 1. Verified by running the pair that failed: before, 23 passed / 19 errors; after, 23 passed / 19 passed. `docker-compose.test.yml`'s project name is now `${COMPOSE_PROJECT_NAME:-rangon-test}`, so a second run still shares containers unless you pass `-p`, but sharing them is no longer corrupting | `apps/api/config/settings/test.py`, `docker-compose.test.yml` | It manufactured *plausible* failures in unrelated assertions, which is the expensive kind |
| ~~D48~~  | ~~**The same customer can be filed twice under two spellings of one phone number.**~~ **Fixed 2026-09-09.** There is now one spelling: every customer number is stored canonically as `8801XXXXXXXXX` by `core.phone`, applied in the serializers (so a customer sees a field error against the field they typed in), in `Customer.save()` (so a shell or a management command cannot go round them), and in a data migration that canonicalised what was already stored and merged the rows that turned out to be one person. The counter lookup, the admin search and checkout's returning-guest match all resolve a typed number to its subscriber digits first, so the local form, the international form and the last few digits all find the one record. On screen the `+880` is a fixed prefix beside the box rather than something anyone types. Branch, supplier, courier and organization numbers stay lenient — those are contact details, not identities, and a landline or a hotline there is not a mistake | `apps/api/core/phone.py`, `apps/api/customers/models.py`, `apps/api/customers/migrations/0004_canonical_phone_numbers.py`, `apps/web/src/lib/phone.ts` | Business rules §6.0. The migration was rehearsed against a database carrying the duplicates: two rows merged into one, the lifetime figures absorbed, the duplicate retired rather than deleted, and its notes moved to the survivor |
| ~~D49~~  | ~~**The dashboard's date presets were computed in UTC.**~~ **Fixed 2026-09-11.** `TIME_ZONE` is `Asia/Dhaka` but `DateRange.from_params` derived its day boundaries from a UTC `timezone.now()`, so "today" began at 06:00 local and dropped the night's trade; between midnight and 06:00 it started at 06:00 *yesterday* and reported twenty hours of the previous day as today. `date_from`/`date_to` were always read in local time, so the two controls disagreed about where a day ended. All boundaries now come from `_day_start`/`_day_end` against the current timezone | `apps/api/reports/services.py` | Every dated report, not only the dashboard. Nothing failed — it answered a different question than it was asked |
| ~~D50~~  | ~~**`7d`/`30d`/`90d` were rolling hours, not days.**~~ **Fixed 2026-09-11.** `now - timedelta(days=7)` is 168 hours back to the minute, so `sales_over_time` — which buckets by `TruncDate` — returned eight buckets for "7 days", the first and last of them part-days for no reason a reader could see. They are now N whole calendar days including today | `apps/api/reports/services.py` | — |
| ~~D51~~  | ~~**A day with no sales was missing from the chart rather than flat on it.**~~ **Fixed 2026-09-11.** `sales_over_time` returned only days that traded and `SalesChart` plots exactly what it is given, so a quiet week drew as a straight line between the days either side of it. The series is now zero-filled across the window, server-side, so the chart and the CSV tell the same story (capped at 370 days) | `apps/api/reports/services.py` | — |
| ~~D52~~  | ~~**`yesterday` and `last_month` ended at the next midnight.**~~ **Fixed 2026-09-11.** Every report filters `placed_at__lte`, so an order placed at exactly `00:00:00.000000` counted in both "yesterday" and "today", and in both "last month" and "this month". Both now end on the last instant of their last included day | `apps/api/reports/services.py` | Narrow, but it double-counted real money when it hit |
| ~~D53~~  | ~~**An unknown `range` showed thirty days under the caller's name for it.**~~ **Fixed 2026-09-11.** `presets.get(preset, presets["30d"])` fell back correctly and then echoed the typed value as `range.label`, so `?range=last-month` returned a 30-day window labelled `last-month`. The preset is validated against `DateRange.PRESETS` and the label says what was actually used; the admin narrows the URL parameter with `resolveRange()` before it reaches an API path | `apps/api/reports/services.py`, `apps/web/src/components/admin/date-range-tabs.tsx` | — |
| ~~D54~~  | ~~**Every demo order carried the instant the seed ran.**~~ **Fixed 2026-09-11.** `seed_demo` creates orders through the real services, so all forty landed in the same second — and "Today", "7 days", "30 days" and "90 days" returned identical totals while the sales chart drew a single spike. This is what made the date filter look broken, because to a reader it was. `_backdate_orders` now spreads them over 90 days (`--history-days`), moving each order with its items, payments, timeline, stock ledger and cash book by one shared delta so the ledger still reconciles | `apps/api/core/management/commands/seed_demo.py` | Demo data only — a real shop's orders arrive spread out. The seeder is the one place allowed to move a financial row, for the same reason `--reset` is the one place allowed to delete one |
| ~~D55~~  | ~~**The admin rendered every timestamp in the server's timezone, not the shop's.**~~ **Fixed 2026-09-11.** `dateOnly`/`dateTime` called `toLocaleDateString` with no `timeZone`, so they used whatever the runtime sat in — UTC inside the Next container, the visitor's own zone in the browser. Anything between 00:00 and 06:00 Dhaka displayed as the previous day, and the same instant rendered as two different dates depending on where the component ran. Found by reading the page: the business summary for 1–31 August was headed **"31 Jul 2026 to 31 Aug 2026"**. Both now format in `NEXT_PUBLIC_TIME_ZONE` (defaulting to `Asia/Dhaka`, plumbed through compose and the Dockerfile to match `DJANGO_TIME_ZONE`). The chart's x-axis had the mirror-image bug — `new Date("2026-08-01")` is midnight *UTC*, so a browser behind UTC labelled every bar a day early — and now goes through `calendarDate()`, which formats a day as a day rather than converting an instant | `apps/web/src/lib/format.ts`, `apps/web/src/components/admin/sales-chart.tsx`, `apps/web/Dockerfile`, `docker-compose.yml` | **This machine cannot see it.** The host is `Asia/Dhaka`, so the tests passed locally and failed under `TZ=UTC` — which is what the container runs. The regression tests assert the shop's day, not the runtime's |
| ~~D56~~  | ~~**The admin sidebar scrolled away with the page.**~~ **Fixed 2026-09-12.** The panel was `lg:static`, so above `lg` it sat in normal flow and the whole navigation scrolled up and out of sight with whatever table the reader was scrolling — on a long list there was no nav on screen at all. It is now `lg:sticky lg:top-0 lg:h-screen` with its own `overflow-y-auto` region. Two things `sticky` needs inside a flex row and neither is obvious: `self-start`, or the item stretches to the container's full height and has no room left to stick, and `bottom-auto` to undo the mobile drawer's `inset-y-0`. The nav list needs `min-h-0` for the same family of reason — a flex child's default `min-height: auto` refuses to shrink below its content, so it would grow the panel instead of scrolling inside it | `apps/web/src/components/admin/shell.tsx` | The sidebar scrollbar is hidden (`.scrollbar-none`) at the owner's request. Wheel, touch, keyboard and scroll-into-view-on-focus all still work; only the indicator is gone. Deliberately **not** applied to the main content column, where the scrollbar is the only thing saying there is more page |
| ~~D57~~  | ~~**The storefront header lost contrast over dark sections.**~~ **Fixed 2026-09-12.** It was `bg-surface/95 backdrop-blur-sm`, so the page showed through — and the storefront scrolls over a near-black hero and full-bleed photography, which meant the nav's contrast changed with whatever happened to be under it. Now a solid `bg-surface`, which holds the same ratio over every section (WCAG 1.4.3). The shrink-on-scroll behaviour and the shadow are unchanged | `apps/web/src/components/commerce/site-header.tsx` | The translucent wishlist heart is left alone: it is a small control floating on product photography, not a bar that has to stay legible over everything |
| ~~D58~~  | ~~**Up to three logo loaders drew at once.**~~ **Fixed 2026-09-12.** Three things render the brand mark while the app is busy and nothing stopped them doing it together: a route's `loading.tsx`, `PendingRegion` (which fires on *any* navigation, not only same-segment ones), and the full-screen `LogoLoaderOverlay` after 480 ms. Cross a segment boundary slowly and all three conditions held — and because the overlay tints and blurs what is behind it, the extra marks showed through as washed-out ghosts rather than being hidden, which is exactly how it was reported. A loader now draws only if nothing **more specific** is already drawing: the route's own screen beats a region, a region beats the global overlay. The overlay keeps the job only it does — blocking clicks — and drops its mark, its tint and its blur when outranked | `apps/web/src/lib/navigation/logo-loader-slot.tsx`, `logo-loader-overlay.tsx`, `logo-loader-screen.tsx`, `ui/pending-region.tsx` | Nine tests pin the resolution; five of them fail if the suppression is removed. `LogoLoaderScreen` became a client component to claim its rank |
| ~~D59~~  | ~~**A swatch that is not a colour was stored happily and rendered as nothing.**~~ **Fixed 2026-09-12.** `AttributeValue.swatch` is a plain `CharField(max_length=32)` whose help text says "hex colour" and whose value is written straight into `style={{ backgroundColor }}` on the product form and the media grouper. Nothing validated it, so `navy`, `rgb(0,0,128)` and `#12345` were all accepted and all invisible — the swatch simply vanished and the shopper was left choosing between two identical circles. The serializer now takes `#rgb`, `#rrggbb` or `#rrggbbaa` and lower-cases it, so two spellings of one colour compare equal. Found while building the colour picker, which would otherwise have been the first thing to write a value nothing checked | `apps/api/catalog/api/serializers.py` | Six tests; all six fail with the validator removed |
| ~~D60~~  | ~~**The attributes screen was read-only for a reason the schema contradicts.**~~ **Fixed 2026-09-12.** The panel carried the note "variants reference these values, so editing one rewrites history". `OrderItem` snapshots `sku`, `product_name` and `variant_label` under the comment "history must not move when the catalogue changes" — so renaming a value cannot touch a single order, and the whole screen had been withheld on a premise that was never checked. What is genuinely unsafe is narrower and is now guarded where it lives: `code` is a live facet key (`search.py` matches on `attribute__code`) so it warns rather than forbids, an attribute cannot stop being variant-defining while variants rely on it, and deleting anything in use is refused in a sentence instead of a bare 409 | `apps/web/src/components/admin/attribute-manager.tsx`, `apps/api/catalog/api/views.py` | The read-only note had been there since the screen shipped on 2026-08-31 |
| ~~D61~~ | ~~**A payment to one supplier could be recorded against another supplier's purchase order.**~~ **Fixed 2026-09-15.** `record_supplier_payment()` takes `supplier` and `purchase_order` as independent arguments and never compared them, and `SupplierPaymentSerializer` was a plain `ModelSerializer` with no `validate()`, so both arrived as separately writable client-supplied FKs. A payment to A credited A's ledger while decrementing B's outstanding — two wrong balances from one row. Refused now, under the order lock | `apps/api/purchasing/services.py` | Found by auditing the endpoint before building the screen over it — the eighth time that habit has paid |
| ~~D62~~ | ~~**A supplier could be overpaid, and the order then vanished from payables.**~~ **Fixed 2026-09-15.** The only amount validation was `amount <= 0`, so `paid_total + amount` was uncapped and `outstanding` went negative. Because `finance.selectors` derives payables from `grand_total > paid_total`, an overpaid order silently dropped off the payable list instead of showing as a problem. The customer-money mirror image (`RefundExceedsCaptured`) was guarded all along, which is the tell. Now `PAYMENT_EXCEEDS_OUTSTANDING` (422), decided under `SELECT … FOR UPDATE` taken *before* the balance is read | `apps/api/purchasing/services.py`, `apps/api/core/exceptions.py` | The lock used to be taken after the check; moving it up front is what makes the guard race-free |
| ~~D63~~ | ~~**A double-clicked supplier payment paid twice.**~~ **Fixed 2026-09-15.** `SupplierPayment` had no `idempotency_key`, though `Order` and `Refund` both carry one and CLAUDE.md §7 requires it wherever a retry could double-spend. Added with a unique index, honoured from the `Idempotency-Key` header. Two simultaneous submits are settled by the order lock, and the no-order case falls back to catching the unique violation in a savepoint and returning the winner's row rather than surfacing an `IntegrityError` | `apps/api/purchasing/models.py`, `apps/api/purchasing/services.py` | `refund_order` has the same latent `IntegrityError` shape; worth the same savepoint |
| ~~D64~~ | ~~**A `DRAFT` or `CANCELLED` purchase order could be paid.**~~ **Fixed 2026-09-15.** The service applied a payment on any status, while `finance.selectors` deliberately excludes both from payables — so paying one wrote cash out against a liability the ledger says does not exist, and paying a draft committed money to an order never sent to the supplier. Both refused with `CONFLICT` | `apps/api/purchasing/services.py` | The existing happy-path test paid a `DRAFT` order, so the guard broke it. The fixture was wrong, not the guard — it now sends the order first |
| ~~D65~~ | ~~**The supplier-payment endpoint could not be called at all.**~~ **Fixed 2026-09-15.** `SupplierPayment.paid_at` is non-null, so DRF inferred it as required — while the service had always defaulted it (`when = paid_at or timezone.now()`) and the viewset passed `data.get("paid_at")`. Every request without an explicit timestamp got a 400. Found only by writing the first API-level test the endpoint has ever had | `apps/api/purchasing/api/serializers.py` | A second reason the screen had never been built: the API it needed did not work |
| ~~D66~~ | ~~**`/admin/products/import` has no permission check.**~~ **Fixed 2026-09-15.** The page is 16 lines with no `currentUser()` and no `can()`, while its sibling `/admin/products/new` gates on `products.create` and renders an `ErrorState`. **Not a security hole** — the API refuses correctly (`import_csv` requires `products.create` *and* `inventory.adjust`), so a cashier who opens it can do nothing — but it is the only admin screen that lets an unauthorised user in far enough to be confused by it | `apps/web/src/app/(admin)/admin/products/import/page.tsx` | Found 2026-09-15. Minutes to fix; copy the sibling |
| ~~D67~~ | ~~**The Track-your-order form 404s on every submission.**~~ **Fixed 2026-09-15** with a route handler at `/order`, so the form keeps working without JavaScript; it trims and upper-cases the number, because `Order.number` is matched exactly and Postgres compares case-sensitively. `/track` renders `<form action="/order" method="get">` with a `number` input, but the only route is `order/[number]`, which reads the number from the path segment. There is no `order/page.tsx`, so every shopper who uses the footer's tracking link gets a 404. The page's own comment says a signed token is required as well, so the fix is to build the target route rather than to re-point the form | `apps/web/src/app/(storefront)/track/page.tsx` | Found 2026-09-15, customer-facing. Phase 12 is marked "Browser journey verified end to end" |
| ~~D68~~ | ~~**A manager could ship another branch's order.**~~ **Fixed 2026-09-15.** `ShipmentViewSet` was the only write viewset in the codebase with no `get_queryset` and therefore no `branch_queryset` call, while orders, inventory, purchasing and finance all scope. `MANAGER` holds `orders.fulfil` and is *not* cross-branch, so a manager confined to DHK2 could list, read and create shipments against DHK1's orders. Scoped on `order__branch`, and the `order` field's own queryset is narrowed per request so an order in another branch reads as one that does not exist | `apps/api/shipping/api/views.py` | Found by auditing the endpoint before building the screen over it — the ninth time that habit has paid |
| ~~D69~~ | ~~**A cancelled or refunded order could be handed to a courier.**~~ **Fixed 2026-09-15.** `ShipmentSerializer` was a bare `ModelSerializer` with no `validate()` at all, so the order's status was never consulted. `shipping.services.create_shipment` now refuses anything outside `CONFIRMED`/`PROCESSING`/`PACKED`/`SHIPPED`, under a `select_for_update` on the order so a cancellation committing in the gap loses the race rather than winning it silently | `apps/api/shipping/services.py` | Goods gone, and no money owed for them |
| ~~D70~~ | ~~**A parcel could be created already delivered, with no event behind it.**~~ **Fixed 2026-09-15.** `status`, `dispatched_at` and `delivered_at` were writable on create, so a caller could post a `DELIVERED` shipment that wrote no `ShipmentEvent` and left the order sitting at `PACKED` — the append-only trail was optional. All three are now read-only on the API; a shipment always starts `PENDING` and moves only through `services.record_event`, which also refuses an update to a parcel already `DELIVERED` or `RETURNED` | `apps/api/shipping/api/serializers.py`, `apps/api/shipping/services.py` | A delivery nobody recorded, which no later correction can unpick |
| ~~D71~~ | ~~**Two parcels could claim one courier's tracking number.**~~ **Fixed 2026-09-15** with `shipping_shipment_courier_tracking_uniq`, conditional on a non-blank number because the number usually arrives after the booking does. A tracking number now also requires the courier that issued it — without one it identifies nothing and cannot be turned into a link. The same constraint is what stops a double-clicked fulfilment form booking the same parcel twice | `apps/api/shipping/models.py`, `apps/api/shipping/migrations/0003_*` | Adding the constraint made DRF derive a `UniqueTogetherValidator`, which forces *every* field in it to be required — so both fields had to be re-declared optional and the validator dropped, or the ordinary case (book now, number later) would have been refused |
| ~~D72~~ | ~~**Stock opened from the product form entered the books at zero cost.**~~ **Fixed 2026-09-17.** `ProductForm` collected an opening figure per matrix row and posted it to `/inventory/adjust/`. An adjustment writes the units in at the row's existing `average_cost`, and never moves it — and `average_cost` is `0.00` on a variant nothing has ever been received against. So the stock was valued at ৳0 in the valuation report, and the counter, which freezes the branch average onto the sale line, booked a COGS of zero and reported the whole selling price as profit. The CSV importer had done it correctly since the day it was written, through `receive_stock` with the row's `cost` — two doors into one column, disagreeing. The field is gone: goods enter by receiving a purchase order or by the import, both of which carry the cost paid. `ADJUSTMENT` goes back to meaning a correction to a counted figure | `apps/web/src/components/admin/product-form.tsx`, `apps/web/src/components/admin/variant-matrix-editor.tsx`, `docs/business-rules.md` | Found by auditing the two paths that create a product after the owner observed that adding a product and raising a purchase order were doing the same job twice. The redundancy was real and this was underneath it |
| ~~D73~~ | ~~**The same variant sold at two different costs depending on the channel.**~~ **Fixed 2026-09-17.** `pos.create_pos_sale` builds a cost map from the branch's weighted average and passes it to `pricing.price_lines`; online checkout called the same function with no map at all, so every web order fell through to `ProductVariant.cost` — a free-text field on the product form, not a measurement. `price_cart` already held the availability snapshots it needed and simply never passed them. Two channels, one variant, one minute, two COGS figures, and `pricing.py`'s own docstring claiming a receipt and a web invoice can never disagree. Both now resolve cost through `resolve_unit_cost`, which also treats a `0.00` average as *unknown* rather than *free* and falls back to `variant.cost` — so the stock D72 had already mis-valued stopped selling at 100% margin too | `apps/api/orders/services/checkout.py`, `apps/api/orders/services/pricing.py` | The parity test passes against the buggy code if you receive stock only once: `receive_stock` also updates `ProductVariant.cost`, so both sources agree by coincidence. It takes two receipts at different prices to separate the weighted average from the last cost paid |
| ~~D74~~ | ~~**The CSP nonce made every statically prerendered page inert — no sign-in form, no way into `/admin`.**~~ **Fixed 2026-09-17.** `middleware.ts` mints a nonce per request and sends `script-src 'self' 'nonce-…' 'strict-dynamic'`. Next stamps that nonce at *render* time, so a page prerendered at build time carries none while the response it is served with still demands one. Everything is then refused: the chunk `<script src>` tags, because `'strict-dynamic'` makes browsers ignore `'self'`, and the thirteen inline `self.__next_f.push(...)` tags carrying the RSC payload, which no host-source expression can allow. Measured in Chromium: **32 refusals on `/login`**. `/`, `/login`, `/cart`, `/checkout`, `/about`, `/brand`, `/contact` and `/policies/*` were all static and therefore dead in the browser — `/login` visibly so, because `LoginForm` reads `?next=` through `useSearchParams` and sat behind a `<Suspense>` with **no fallback**, so the boundary rendered literally nothing: a white screen, no form, and no route into the back office at all. `/checkout` was the expensive one. Fixed with `export const dynamic = "force-dynamic"` in the root layout — the only alternative is `'unsafe-inline'`, which is the one thing the nonce exists to avoid. The bare `<Suspense>` gained a real fallback in the same pass, so the next failure of this shape degrades instead of vanishing | `apps/web/src/app/layout.tsx`, `apps/web/src/app/(storefront)/login/page.tsx`, `apps/web/e2e/csp.spec.ts` | D16 recorded this exact failure mode — "the production build renders a blank page" — and the nonce was the fix for it. What D16 missed is that the nonce only reaches pages Next renders per request, so the fix quietly re-broke every page it did not cover. Caught only in a real browser with the header enforced; no unit test can see it, which is why the guard is a Playwright spec |
| ~~D75~~ | ~~**A product priced entirely at zero could be published and sold for nothing.**~~ **Fixed 2026-09-17.** `publish` checked only that variants *exist*. Zero is a legitimate price in the database and deliberately allowed by `catalog_variant_price_gte_0` — a sample, a gift line — but nothing downstream refuses it: `orders.services.pricing` computes `unit_price × quantity`, so a checkout for `0.00` is a perfectly valid order and the goods leave for nothing. Reachable before this branch, because the product form accepts a price of zero ("zero or more") and publishing is one click away. `catalog.services.publish_product` now refuses a product with nothing priced above zero, per product rather than per variant so a free sample beside a priced row still works. The guard had to exist before a purchase order could create products without a retail price | `apps/api/catalog/services.py`, `apps/api/catalog/api/views.py` | The viewset was hand-rolling the error envelope and the audit row too, which is what `BusinessError` and the service layer are for (CLAUDE.md §4). Moving it made the guard a two-line addition |
| ~~D76~~ | ~~**"New supplier" on the purchase order screen created nothing and destroyed the order.**~~ **Fixed 2026-09-17.** `SupplierForm` renders its own `<form>`, and on `/admin/purchases/new` it is rendered *inside* the purchase order's `<form>`. Nested form elements are invalid HTML; React builds them anyway, because it writes the DOM through the API rather than the parser, so the markup reads correctly and the bug is invisible in review. The browser's submission algorithm does not honour the nesting: the click never reaches React's `onSubmit`, `preventDefault` never runs, the page submits natively to `/admin/purchases/new?` and reloads — no supplier created, and every line the buyer had entered gone. Shipped with the screen. `SupplierForm` takes a `nested` prop that renders a plain element with a click handler; the standalone use on `/admin/suppliers` keeps its form and its Enter-to-submit | `apps/web/src/components/admin/supplier-form.tsx`, `apps/web/src/components/admin/purchase-order-form.tsx` | Found only by driving the real browser: the new inline product form had the identical bug, and the navigation to `…/new?` in the trace is what gave both away. No unit test or type check can see it |
| ~~D77~~ | ~~**Receiving stock left the screen showing the un-received state, about half the time.**~~ **Closed 2026-09-21 as [D40](#known-defects), which it always was.** `PurchaseActions` no longer carries its own `window.location.reload()`: it calls `refreshAfterWrite()` like every other admin write, so the reload happens only when the refresh is measured not to have landed, instead of on every send, cancel and receive. `PurchaseActions.act()` called `router.refresh()` after send, cancel and receive. Measured over five runs of the real browser flow: the page still read "Receive goods" and omitted the arrivals panel in **3 of 5**, and it is bimodal — the refresh lands in ~220 ms or never at all, given 45 seconds. The server re-rendered correctly every time (the RSC response carried the new receipt and the new status); the browser discarded it. A manual reload always showed the truth, so the stock was always in the ledger — only the screen lied. **Two explanations were tested and both were wrong**, recorded so the time is not spent again: moving `router.refresh()` after the local state updates so nothing could interrupt its transition (still 2/5), and disabling the admin sidebar's link prefetching, which `force-dynamic` ([D74](#known-defects)) turns into a storm of full server renders (0/5, no better). The workaround is `window.location.reload()` on those three actions — 5/5 at ~915 ms. Two of them write to the inventory ledger, and a screen that says "not received" about stock on the shelf is worse than 300 ms | `apps/web/src/components/admin/purchase-actions.tsx` | Still unexplained: why the client drops a payload it fetched successfully. This row's closing warning — "anything else on the admin that relies on `router.refresh()` is suspect until someone finds it" — was correct, and 2026-09-21 found it: expenses 0/5, brands 2/6, categories 4/6, and the stock-count sheet. Fix [D40](#known-defects) and this reverts to `router.refresh()` |
| ~~D78~~ | ~~**A return refunded the price but kept the VAT.**~~ **Fixed 2026-09-18.** `orders.services.returns.request_return` computed the refund from `OrderItem.line_total` alone. `line_total` is `gross − line_discount`; under the `EXCLUSIVE` treatment the tax is *not* in it — it lives in the separate `tax_amount` column. So at 15% exclusive a customer who paid ৳1,150 for a ৳1,000 item was offered ৳1,000 back and the shop kept the ৳150 of tax it had collected on the shop's behalf. Under `INCLUSIVE` the tax is already inside `line_total` and the same line was correct, which is why it hid: one expression, two treatments, only one of them wrong. **Latent, not live** — `default_tax_rate` ships at `0.0000`, where both treatments agree; it would have gone live the moment a rate was entered at `/admin/settings`. Order *cancellation* was never affected (it refunds `paid_total` directly). The refund now adds the line's frozen `tax_amount` when the **order's own** `tax_mode` is `EXCLUSIVE`, so history refunds under the treatment it was priced with; prorating quantizes once at the end, so a full-line return refunds the line exactly | `apps/api/orders/services/returns.py` | Found by answering "what else does VAT need?" rather than by a failing test. Nothing in 1,058 passing tests touched a refund with a non-zero rate — the suite exercised VAT arithmetic and refund arithmetic, never the two together |
| ~~D79~~ | ~~**`seed_demo` would put the README's password on a production database.**~~ **Fixed 2026-09-19.** `PASSWORD = "rangon12345"` carried the comment "development seed only — never reaches production", and nothing enforced it: `scripts/rebuild-local-prod.sh` ran `seed_demo --reset` against `config.settings.prod` on every rebuild, so owner, manager, cashier, stock and accounts all opened with a password printed in the public README — on a stack that has been published through the Cloudflare tunnel. `--reset` also deletes every order, payment and ledger row, which a production database should not answer to a typo. A `DEMO_SEED` setting now decides: `development` (base) keeps the README password for a laptop; `prod.py` sets `off` unless `DJANGO_ALLOW_DEMO_SEED=1`, and then only with a `DJANGO_DEMO_SEED_PASSWORD` that is not the README one and passes the password validators. The refusal comes before `--reset` is attempted — not merely rolled back by the command's transaction, which is what a first version of the test could not tell apart. A re-seed with a password of its own also replaces the README one on any account an earlier seed left with it, audited; a password someone rotated by hand is left alone. The rebuild script passes the opt-in to the one `exec` and stops **before** `compose down -v` when no password is configured | `apps/api/core/management/commands/seed_demo.py`, `apps/api/config/settings/`, `scripts/rebuild-local-prod.sh` | A database seeded before 2026-09-19 still carries the public password until it is reseeded with one of your own or rotated — [cloudflare-local-setup.md §12](operations/cloudflare-local-setup.md) |
| ~~D80~~ | ~~**A purchase order with money paid against it could be cancelled, and the money vanished from the books.**~~ **Fixed 2026-09-19.** `cancel_purchase_order` checked for receipts and nothing else. The payables selector (business-rules §4.2) drops a `CANCELLED` order and a supplier payment can be neither edited nor deleted (§6b.1b), so an advance against a sent order was, after a cancel, no longer owed, no longer payable and on no list anywhere as money the supplier holds. Refused with `CONFLICT`; until a supplier credit note exists, an order with money against it is received, not cancelled. Cancelling an already-cancelled order — which succeeded and wrote a second audit entry — is refused too | `apps/api/purchasing/services.py` | Found by auditing `purchase-orders/`; the tenth time that habit has paid |
| ~~D81~~ | ~~**Cancel and send decided against the caller's copy of the order.**~~ **Fixed 2026-09-19.** `cancel_purchase_order` read the receipts and wrote the status with no lock between them. A delivery that had locked the order and written its receipt but not committed was invisible to that read, so the cancel found "no receipts", queued behind the delivery's row lock and, once it committed, overwrote `RECEIVED` with `CANCELLED` — stock on the shelf against an order that says it was never placed, and off the payable list. `send` had the same shape against a cancel. Both now `select_for_update` the order first — the lock receiving and paying already take — and decide under it. The regression test forces the interleaving by holding the delivery open at `receive_stock`, and reproduced `{'cancel': 'ok', 'receive': 'ok'}` on the old code | `apps/api/purchasing/services.py`, `apps/api/tests/test_concurrency.py` | — |
| ~~D82~~ | ~~**A purchase order stored money that could not be right.**~~ **Fixed 2026-09-19.** `shipping_total` had no floor, so goods with shipping `-500.00` were stored as a liability 500 short; a line discount had no ceiling, so 2 × 100 less 500 stored a line of −300 that silently cancelled out other lines; the same variant on two lines reached `purchasing_poi_uniq` as a bare 409 with no field; an unknown supplier came back as a 404 for the page. The order form had caught the first three client-side all along — its own comment said "a duplicate variant fails with an opaque 409" — while the API took whatever it was sent. `purchasing.services` refuses all four as `VALIDATION_ERROR` with a field in `details`, so the shell, the seed and the importer meet them too | `apps/api/purchasing/services.py`, `apps/api/purchasing/api/serializers.py` | CLAUDE.md §3.4 |
| ~~D83~~ | ~~**One order line named twice in a delivery kept only its last quantity.**~~ **Fixed 2026-09-19.** The receive view folds the lines into a dict keyed by item, so `[{item, 3}, {item, 4}]` received 4 — not 7, and not an error. The storekeeper counted seven onto the shelf and the ledger said four. Refused now | `apps/api/purchasing/api/serializers.py` | — |
| ~~D84~~ | ~~**`generate-variants/` built SKUs on a specification, and skipped values it did not know.**~~ **Fixed 2026-09-19.** business-rules §5a's first rule — an attribute cannot be both an axis and a specification — was enforced only on the specification side, so `{"material": ["Cotton"]}` made variants on Material while the same product could state Material as a spec: the one state §5a exists to make impossible. And values were matched with `value__in`, erroring only when *none* matched, so `S` and `XXXL` made S alone and said nothing. Both refused; the whole request or none of it. The purchase order's new-product form calls this endpoint | `apps/api/catalog/services.py` | — |
| ~~D85~~ | ~~**The audit log was the one staff list with no branch scoping.**~~ **Fixed 2026-09-19.** `AuditLogViewSet` had a class-level queryset and no `get_queryset`, so no `branch_queryset` call — while orders, inventory, purchasing, finance and shipments all scope. `ACCOUNTANT` holds `audit.view` and is not cross-branch, so an accountant assigned to one branch could list every other branch's refunds, payments, stock adjustments and transfers, with the values before and after. Twenty-five services record the branch on their entries; none of it was being read. A branch-bound reader now sees their branch's entries and the organisation-wide ones (no branch: catalogue, settings, staff, sign-ins) — the second half a documented default, [business-rules §8.1](business-rules.md#81-reading-the-trail) | `apps/api/accounts/api/views.py` | Found by auditing the endpoint before building the screen over it |
| ~~D86~~ | ~~**Changing a password signed nobody out.**~~ **Fixed 2026-09-19.** Neither `PasswordChangeView` nor `update_staff_user` touched a token: every refresh token already issued rotated on for up to fourteen days, and every access token lived out its half hour. A person who changed a password because someone else might know it — the one reason to change it in a hurry — left that someone signed in, and an owner's reset from `/admin/staff` did the same. `docs/operations/security.md` listed "logout everywhere on password change" as an account-takeover control. Both now blacklist every refresh token the account holds (`accounts.services.end_sessions`), and `SIMPLE_JWT["CHECK_REVOKE_TOKEN"]` puts a hash of the password in every token so access tokens die at once too. The refresh endpoint also minted fresh tokens for a deactivated account and never looked at the password claim, which would have reopened the hole: it refuses both now | `apps/api/accounts/services.py`, `apps/api/accounts/api/views.py`, `apps/api/config/settings/base.py` | Tokens issued before the fix carry no claim; a refresh token like that is honoured once and exchanged for one that does, so the rollout signs nobody out beyond, at most, one page load |
| ~~D87~~ | ~~**The current password could be guessed at 600 a minute, silently.**~~ **Fixed 2026-09-19.** `PasswordChangeView` set no throttle scope, so it ran at the general user rate, while the sign-in form is held to ten a minute — and a wrong guess wrote nothing, while a wrong sign-in writes `LOGIN_FAILED`. A stolen session is exactly when someone would try to learn the real password this way. Scoped to `auth` (ten a minute, per account) and audited. `config/settings/test.py` disables throttling and cites `tests/api/test_throttling.py` as where limits are asserted; that file has never existed, so no rate limit had a test until this one | `apps/api/accounts/api/views.py` | — |
| ~~D88~~ | ~~**Every rate limit was bypassable with one header, and the audit trail believed it.**~~ **Fixed 2026-09-21.** `X-Forwarded-For` is written by the client and *appended to* by each proxy, so the caller owns a prefix of it. DRF's `BaseThrottle.get_ident` keys on the whole header when `NUM_PROXIES` is unset — it never was — and `AuditContextMiddleware._client_ip` took its left-most entry, commented *"the original client"*, which is precisely the part the client writes. **Measured on `main`: 40 wrong-password posts to `/auth/login/`, each with a different header, none refused** (control: refused at the eleventh), and all 40 logged under addresses of the caller's choosing. That is `auth` at 10/min — the limit between one address and a word list — plus `checkout` 20/hour, `search` 120/min and the general `anon` rate. D87 was **not** reachable this way: `ScopedRateThrottle` keys on `request.user.pk` once authenticated, and a first draft of the tests aimed there and passed against `main`, proving nothing. Anonymous requests are the whole of it. Fixed with one rule and one implementation — `core.ip.client_ip` counts `DJANGO_TRUSTED_PROXY_HOPS` entries from the **right** and falls back to `REMOTE_ADDR` when the header is shorter than that; `core.throttling` keys the three DRF throttles on it and the audit middleware calls it directly, with a test that the two agree. Default 0 (no proxy, ignore the header); `docker-compose.prod.yml` sets 1 beside the Nginx that is the only service publishing a port. Re-measured after: refused at the eleventh, 3 Redis buckets where there were 120, and the trail records the proxy's entry. See [§ D88 fixed](#d88-fixed-the-rate-limits-were-decorative-2026-09-21) | `apps/api/core/ip.py`, `apps/api/core/throttling.py`, `apps/api/core/middleware.py`, `apps/api/config/settings/base.py`, `docker-compose.prod.yml` | Found by auditing a control, not by a complaint. The limits read as present in `security.md` and in CI the whole time |
| ~~D89~~ | ~~**`Idempotency-Key` was accepted and ignored on every finance and inventory endpoint.**~~ **Fixed 2026-09-22.** CLAUDE.md §7 asks for the header "where a retry could double-charge or double-deduct". `orders` read it in 3 of 3 view modules and `purchasing` in 1 of 1; **`finance` and `inventory` in 0 of 1 each**, and neither app's models carried the column — the header was accepted, never stored, never checked. **Measured on `main`:** the same key posted twice moved a balance **342205.00 → 344205.00** (+2000, not +1000) and took `on_hand` **9 → 7**. Both rows are honest ledger entries, so `verify_accounts` and `verify_inventory` reconcile afterwards and nothing flags it — the same shape as [D88](#known-defects), a control that reads as present. Five operations were exposed: cash movements, account transfers, expenses, write-offs and stock transfers. `adjust` and `stock-counts/apply` need no key (an absolute figure and a status transition) and are asserted rather than argued. **The ordering was the hard part**: the key is re-read *after* the row lock and *before* the business validation, because four retries released together all read nothing up front and the losers then failed the stock check for a write-off they had already made. See [§ D89 and D90](#d89-and-d90-fixed-a-retry-that-doubled-and-a-recovery-that-never-ran-2026-09-22) | `apps/api/finance`, `apps/api/inventory`, `apps/api/core/models.py` | Found by auditing a control, not by a complaint. Third time that has paid |
| ~~D90~~ | ~~**The idempotency race recovery had never worked.**~~ **Fixed 2026-09-22**, and found by D89's own concurrency test. `except IntegrityError:` sat inside the outer `transaction.atomic()` with **no savepoint**, so the error poisoned the transaction and the lookup meant to return the winner's row raised `TransactionManagementError` instead. Four simultaneous POS sale retries sharing a key: **3 of 4 threads raised it**. A cashier double-tapping "Complete sale" on a slow connection got a 500 rather than the receipt — a till-stopping fault in the same family as [D43a](#known-defects). Three sites had it (POS sale, checkout, refund), one had a pre-check and no recovery at all (purchase return), and **two were already correct** (supplier payment, webhook dedupe) — both the newest, which suggests whoever wrote them knew. All four now wrap the claiming insert in an inner `atomic()`. Proven by running the race against `main` before and after | `apps/api/orders/services/{pos,checkout,payments}.py`, `apps/api/purchasing/services.py` | The catch had been there since each feature was written. Nothing had ever exercised it: the concurrency suite tests oversell, not duplicate keys |
| ~~D91~~ | ~~**Expense receipts were public, at guessable URLs.**~~ **Fixed 2026-09-23.** A receipt was stored as `expenses/<year>/<month>/<the uploader's own filename>` and `/media/` served it to anyone: a manager attached `receipt.png`, and an **anonymous** GET of `/media/expenses/2026/09/receipt.png` answered **200** with the image. Phone photos are `IMG_0001`…`IMG_9999` and `/media/` has no rate limit, so the folder could be walked. `USE_S3=1` was no better — storage URLs are unsigned (`querystring_auth: False`). Receipts are now served only by `GET /api/v1/expenses/{id}/attachment/`, which runs the viewset's own permission and branch scope and answers `no-store` + `nosniff`; `/media/` refuses the prefix (`core.media.PRIVATE_PREFIXES`), Nginx refuses it too, and new uploads get a random name. The web proxy passed every body through `.text()`, which would have corrupted the file on the way back — it passes bytes now. Verified live: a JPEG uploaded through the proxy came back byte-identical (same sha256) | `apps/api/core/media.py`, `apps/api/finance/{models,api/views,api/serializers}.py`, `apps/web/src/app/api/proxy/[...path]/route.ts`, both Nginx configs | Receipts were built on the same `FileField` as product photography, and product photography *is* public. The upload was validated with care — size, type, extension — and nobody asked who could download it |
| ~~D92~~ | ~~**Signing out after thirty idle minutes left the session alive for fourteen days.**~~ **Fixed 2026-09-23.** `LogoutView` required a valid access token. The access token and the cookie carrying it both live thirty minutes, so anyone signing out after half an hour away got a **401** — which the web route ignored, clearing the cookies and showing "signed out" while the refresh token stayed good for the rest of its fourteen days. Measured: with a live access token, logout 204 and the refresh token dies; with an expired one or none, logout 401 and the refresh token **mints a new pair**. That is the one case server-side revocation exists for — a token copied off the machine. The refresh token is now the whole credential for signing out: no access token asked for, no throttle (a 429 would leave the token alive), always 204. Verified through the real web route with the access cookie removed: refresh afterwards 401 | `apps/api/accounts/api/views.py` | **No test called `auth/logout/`.** The route's own comment says a cleared cookie alone would leave a usable token in the wild; nothing checked that the call it makes ever succeeded |
| ~~D93~~ | ~~**Every report took `?branch=` at its word.**~~ **Fixed 2026-09-23.** `reports.api.views._branch_for` returned whatever branch was named, with no check, and backed all eleven reports. A manager or accountant confined to one branch read another's sales (৳7,777.77 in the probe), stock valuation, stock movement, expenses, dashboard and business summary by naming it. Worse, an id that matched nothing came back as `None` — which means *every* branch — so **any random UUID** was enough. Now a branch-bound caller naming another branch gets 403 and an unknown id gets 404; owners and admins still report on any branch, closed ones included. The three `?branch=` readers in `finance` already used `resolve_branch`, which is why the reports were the odd one out rather than the rule | `apps/api/reports/api/views.py` | Without the parameter every report scoped correctly, so every test of report scoping passed — and no screen sends the parameter at all (`/admin/reports` and the dashboard pass only `range`), so nobody ever sent it by accident either. It was reachable by anyone who read the API |
| ~~D94~~ | ~~**Anyone holding `inventory.transfer` could move stock out of any branch.**~~ **Fixed 2026-09-23.** `POST stock-transfers/` looked the source branch up bare — `Branch.objects.get(pk=...)` — where every other stock write goes through `resolve_branch`. A manager or inventory manager at branch A sent B's stock to A: **201**, and B's shelf went 10 → 8 → 6. The ledger recorded it faithfully, which is the problem: it is the insider-theft path `security.md` listed as closed. The list was unscoped too — every role at A saw a B → C transfer — because `branch_queryset` could filter on one field and a transfer has two. It takes several now, OR-ed, so each branch sees its own transfers from either end. The source must pass `resolve_branch`; the target may be any **active** branch, since sending stock elsewhere is what a transfer is | `apps/api/inventory/api/views.py`, `apps/api/accounts/services.py` | The only stock write that takes two branches, and the one that did not reuse the helper every single-branch write does |
| ~~D95~~ | ~~**An account the caller named was never checked.**~~ **Fixed 2026-09-24.** `resolve_account` picks the branch's own account of the kind the method implies — but only when nobody names one, and every screen names one when a person picks it. Measured through the API, each **201**: a POS sale at branch A put its takings in **B's** drawer (B 5,000 → 6,000, A's drawer short by the same at the count); a refund came out of B's drawer; a supplier payment for A's order came out of B's drawer; a cheque was paid out of a cash drawer. The supplier payment list was unscoped, and another branch's purchase order could be paid. `finance.check_named_account` now runs in `record_for_reference`, the one choke point sales, refunds and supplier payments share: the account must be the money's branch's, open, and of the method's kind. A cash refund of a card sale now defaults to the drawer, not the bank the card money went into. The screens followed: the order and return screens state how a refund goes back ("Refund as") and offer only the order's branch's accounts of that kind. Three more of the family turned up on the way — supplier payments, discount overrides and manager overrides were audited with no branch, so every branch's auditors read them — and `refund_method` on a return was free text, which mapped to no kind and let any account through | `apps/api/finance/services.py`, `apps/api/orders/services/{payments,pos}.py`, `apps/api/purchasing/{services,api/views}.py`, `apps/api/orders/api/serializers.py`, `apps/web/src/lib/money-accounts.ts`, the order, return and purchase screens | The default path was careful and tested; the explicit path is the one every screen uses, and nothing tested a *wrong* explicit choice. The POS and supplier forms filtered by kind in the browser, which made the rule look enforced |
| ~~D96~~ | ~~**A branch could not open a second account of any kind.**~~ **Fixed 2026-09-24.** `POST /accounts/` answered **400** "The fields branch, kind must make a unique set" for a second drawer, bank account or wallet at a branch that already had a default one — whether the new one was a default or not. The constraint is *conditional*, one default per branch and kind; DRF 3.15.2 builds a validator from it that filters on the condition and never asks whether the new row meets it. The serializer now states its validators; the services already kept the default single | `apps/api/finance/api/serializers.py` | Tests create accounts through the service, never the endpoint, and the demo seed has one account per kind — nobody had opened a second one through the screen until a walk needed one |
| ~~D97~~ | ~~**The customer's order was the shop's own record.**~~ **Fixed 2026-09-24.** `GET /shop/orders/{number}/?token=` — the link in the confirmation message, open to anyone holding it — returned the **staff** serializer. Measured anonymously on a delivered order: every timeline entry named the member of staff who acted (`manager@rangon.test`) and carried its internal `data` — the reason typed on a status change, payment and parcel ids — and the order carried `internal_note`, `created_by_email` and the drawer each payment went into. The signed-in customer's own order was worse: it did not even drop private entries ("Stock reserved"). The checkout confirmation had the same shape. Customer serializers now name every field a customer sees; the timeline is written for the customer from an allow-list of entry types ("Order placed", "On its way", "Delivered") and never repeats what staff typed | `apps/api/orders/api/{serializers,shop_views}.py`, `apps/web/src/lib/api/types.ts` (`CustomerOrder`) | The storefront page read a handful of fields and rendered them, so the page looked right. The leak was in the bytes, which nobody read |
| ~~D98~~ | ~~**A parcel could leave before its order was packed.**~~ **Fixed 2026-09-24.** Booking a parcel early is allowed; dispatching or delivering one moved the order only from PACKED or SHIPPED. Walked in the browser: a CONFIRMED order's parcel was dispatched, moved and delivered while the order stayed **CONFIRMED** — the customer read "We will call you before delivery" above a parcel marked Delivered — and since packing is when goods leave the stock ledger, the delivered goods were still on the shelf, reserved. A parcel booked before a cancellation could leave too. A parcel's first movement now needs the order packed (shipped or delivered, for a split delivery); later updates always record. The Delivery panel says to mark the order packed first | `apps/api/shipping/services.py`, `apps/web/src/components/admin/order-fulfilment.tsx` | Every shipment test used a PACKED order, because that is the order a packer ships. Nothing asked what an earlier one did |
| ~~D99~~ | ~~**A coupon check that failed inside the server showed the shopper why.**~~ **Fixed 2026-09-24.** `price_cart` re-validates the cart's coupon on every read and caught *every* exception into the cart's `issues` as `str(exc)`. A refusal is written for the shopper; a database error is written for a developer — with a forced `ProgrammingError`, the cart carried `SELECT "promotions_coupon"."id"`. A refusal keeps its message; anything else is logged, and the shopper reads that the coupon was removed | `apps/api/orders/services/checkout.py` | The only `str(exc)` in the codebase that reached a response. The handler that keeps internals out of every other response never saw this one: it was caught first |
| ~~D100~~ | ~~**A verified webhook captured whatever the order had pending.**~~ **Fixed 2026-09-24; latent.** Checking the signature is each provider's `parse_webhook`; the view then captured the order's *first* pending payment — whichever provider it was with, whatever amount it was for. With a gateway registered, its event could capture a cash-on-delivery payment, and an event for ৳1 captured ৳1,000 (measured with a stub gateway). Latent because the only registered provider refuses webhooks: a forged one gets **404**, measured. The view now picks the payment made through that provider, and capture needs the amount to match | `apps/api/orders/api/shop_views.py`, `apps/api/orders/services/payments.py` | Written ahead of the first gateway ([gap #2](#gaps-to-close-before-go-live)), with nothing to exercise it |
| ~~D101~~ | ~~**Nothing checked that a write came from the shop's own pages.**~~ **Fixed 2026-09-24.** `security.md` claimed `SameSite=Lax` plus a double-submit token on the cookie-authenticated routes; the token was never built. Measured against a production build with the owner's cookies: a PATCH to `/api/proxy/accounts/{id}` carrying `Origin: https://blog.shop.example` **changed the account (200)**, a sign-in from another origin set a session (login CSRF), and a sign-out from one ended it. `SameSite=Lax` keeps the cookies off a cross-*site* request in a modern browser — but a same-site origin, any subdomain, gets them. Every state-changing route under `/api/proxy` and `/api/auth` now refuses a foreign `Origin` with 403; same-origin writes, reads and requests with no `Origin` are unaffected, and the E2E suite passes against the build | `apps/web/src/lib/api/same-origin.ts`, the proxy and the three auth routes | The claim was written with the design and never measured. The API is token-authenticated, so its tests could not see a gap that lives in the web server |
| ~~D102~~ | ~~**`seed_demo --reset` died once a parcel had been booked.**~~ **Fixed 2026-09-24.** `Shipment` PROTECTs `Order`, and `_reset` did not delete shipments, because nothing created one until the Delivery panel did. The walk that found D98 booked three, and the next reset raised `ProtectedError` | `apps/api/core/management/commands/seed_demo.py` | The fourth time a PROTECT reference has broken the reset — `tests/test_seed_reset.py` records the other three. The reset lists models by hand |
| ~~D103~~ | ~~**`migrate` never granted a new permission code to any role.**~~ **Fixed 2026-09-26 (#61).** `sync_permissions()` ran only from `seed_demo` and the test fixtures, while `permissions.md` said `migrate` ran it. A database migrated but never reseeded — production — would never have given managers `content.site_manage` or `content.navigation_manage`. Found while adding the first | `apps/api/accounts/apps.py` | A `post_migrate` receiver now syncs on every migrate, including one with nothing to apply; `tests/test_permission_sync.py` |
| D104 | **`seed_demo` dies when it has only a few orders.** `_returns` raises the demo returns against the two most recent DELIVERED orders *after* `_backdate_orders` has spread them over `--history-days` (90). With a small `--orders` (5, measured 2026-09-26) both can land outside the 14-day return window, `request_return` raises `PermissionDenied`, and the whole seed rolls back. The default 40 orders is unaffected; `--history-days 0` works around it | `apps/api/core/management/commands/seed_demo.py` `_returns` | Open. Pick orders inside the window, or skip the demo returns when none are |

## Still API-only (no UI)

**This section said "Nothing" from 2026-08-31 until 2026-09-15, and it was wrong.** An audit that
compared every router registration in `config/api_urls.py` against what `apps/web/src` actually
calls found five complete APIs with no frontend caller. The claim had been made by listing the
screens that *had* been built rather than by checking the ones that had not.

| Endpoint | State |
|---|---|
| ~~`supplier-payments/`~~ | **Closed 2026-09-15** — the payment form and history now live on `/admin/purchases/[id]`. It was the worst of the six: `paid_total` could never move, so the payables side of the party ledger only ever grew and the cash position permanently overstated cash. Auditing it first found four money bugs — [D61–D64](#known-defects) |
| ~~`shipments/`~~ | **Closed 2026-09-15** — a Delivery panel on `/admin/orders/[id]` books parcels and records tracking updates, and the customer's own order page shows the courier, the tracking number, a link to the courier's site and the parcel's history. Auditing it first found four defects, one of them a branch-scoping hole — [D68–D71](#known-defects) |
| `auth/register/` | No sign-up screen, **and now deliberately so.** On 2026-09-15 the owner had the storefront's whole account surface withdrawn: the wishlist was removed outright and the account menu, the `/account` pages and the review form went with it, because every one of them was gated on a customer login nobody could obtain. `shop/account/orders/`, `shop/account/addresses/` and `POST shop/products/{slug}/reviews/` are kept and unadvertised — see [endpoints.md](api/endpoints.md#the-customer-account-endpoints-have-no-caller-deliberately). This is the one row on this list that is a decision rather than a gap |
| ~~`auth/password/change/`~~ | **Closed 2026-09-19** — `/admin/account`, reached from the name in the admin header, for every staff role. Auditing it first found two defects, [D86](#known-defects) and [D87](#known-defects). It had not been recorded here at first: the 09-15 audit swept router registrations and so missed the `auth/` sub-routes |
| ~~`permissions/`~~ | **Has its caller, 2026-09-23.** The line above was half wrong: `/admin/staff` *did* show each role, as six clouds of raw codes (`sales.discount_override`) — which answered "what can a manager do" and not "who may refund". It is now one role × permission matrix, read from `/roles/` and `/permissions/`: rows named in words and grouped by area, a column per staff role, Owner shown as "Everything, always" from the API's `holds_every_permission` rather than from its row. A tick or a dash, and "Yes"/"No" to a screen reader. Checked in Chromium at 1440 and 390 px; the phone check found the page scrolling sideways — the matrix's `sr-only` words escaping its scroll box, and the staff table above it doing the same since it was written — fixed with `relative` on both |
| ~~`audit-logs/`~~ | **Closed 2026-09-19** — `/admin/audit`: who, what, when, the values before and after, and the reason, with search, an action filter, a date window and one record's whole history. Auditing it first found it was not branch-scoped — [D85](#known-defects) |
| ~~`inventory-transactions/`~~ | **Closed 2026-09-19** — `/admin/inventory/movements`, and a *History* link on every row of `/admin/inventory`. Each movement names the document behind it. [endpoints.md](api/endpoints.md) had listed the ledger as `inventory/transactions/`, which never existed |

The rule this section has recommended for months is the one that would have caught it, applied to
the section itself: **check each endpoint against what calls it, rather than listing what was
built.** "Exists" is not "reachable".

**Attributes were the exception, and are no longer.** They had a full `ModelViewSet` behind a list
that could only read — the UI was the gap, not the API. Create, edit, reorder and a colour picker
shipped 2026-09-12; [D60](#known-defects) says why the screen had been left read-only.

**`CategoryAttribute` was the reverse of that, and is no longer.** A full model since the first
migration, seeded per category, and read by the seed and by nothing else — no serializer, no
endpoint, no screen. `GET /categories/{id}/attributes/` and the Specifications card shipped
2026-09-14. Worth keeping in mind as a shape: "API-only" is the gap this list was written to track,
but a model with no API at all does not appear on any list, and this one sat there for four weeks
holding the answer to a question the product form was not asking.

The rule that got us here is worth keeping for whatever is built next: **check each endpoint against
the documented behaviour before building over it.** It has now paid for itself eight times — a CSV
export that had never worked, a stock count that could not be counted, a restock decision in the
wrong place, the four customer defects D24–D27, a coupon redeemable twice under a race, an
`is_variant_defining` guard that only guarded one direction, and eleven
more in the two "safe" areas above. "Exists" is not "tested", and "rarely touched" is a reason
nothing has ever exercised the edges, not a reason they are sound.

Recently built, so no longer on this list: **return approve / reject / receive / refund** —
`/admin/returns/[id]`; **damage/write-off, stock counts and stock transfers** —
a write-off panel on `/admin/inventory`, plus `/admin/inventory/transfers` and
`/admin/inventory/counts`; **expenses** — `/admin/expenses`, with a period filter,
category-wise totals, receipt upload, CSV and a void flow; **financial accounts and the cash book** —
`/admin/finance` and `/admin/finance/[id]`, with account create/edit, transfers, manual cash-book
entries, a cash position on the dashboard, a per-tender account in the POS and account pickers on COD
capture and refunds; **organization settings and branch create/edit**
(`/admin/settings`); **product create/edit, variant-matrix generation, publish/unpublish and
per-colour image upload** (`/admin/products/new`, `/admin/products/[id]`); **stock adjustment**, which
the product form writes per variant and, since 2026-09-09, `/admin/inventory` writes per row; the
**notification feed** (`/admin/notifications`); and **purchase orders and suppliers** — create, send,
cancel, partial receive and supplier create/edit (`/admin/purchases/new`, `/admin/purchases/[id]`,
`/admin/suppliers`).

## Gaps to close before go-live

1. **Payment gateway.** Implement a real provider against
   `orders.payments.providers.base.PaymentProvider`, with signature verification and webhook replay
   tests. COD works today; the card option is visibly disabled rather than pretending to work.
2. ~~**The remaining admin *write* screens.**~~ Done. Customers, coupons, return approvals,
   shipping and review moderation shipped 2026-08-28; categories/brands/attributes and users/roles
   followed on 2026-08-31 as `/admin/taxonomy` and `/admin/staff`. Nothing is API-only any more —
   see [§ Still API-only](#still-api-only-no-ui).
3. ~~**Unblock and run E2E**, then wire both Vitest and Playwright into `ci.yml`.~~ Done, and
   **finished 2026-09-21**: Vitest landed 2026-08-28, the Playwright job 2026-08-31, and the job now
   runs against a **production build** rather than `next dev`. That last step waited on
   [D40](#known-defects) and took a workflow edit once D40 was worked around.
4. ~~**Restore rehearsal.**~~ Done 2026-08-22, for real (see the verification log). The script it
   used could not run where the docs pointed it (D14); that is fixed as of 2026-09-09 — both
   scripts now run the client inside the database container, so the version can never drift again.
   What is still missing is **automation**: the dump that saved the database was taken by hand,
   stored only on this machine, on no schedule and with no retention. Schedule it (the script takes
   `BACKUP_S3_BUCKET` and `BACKUP_RETAIN_DAYS`), and keep the restore drill.
5. **Load test** product listing, checkout and POS search at expected peak. The query budgets from
   `docs/database/indexing.md` are no longer part of this item — all eleven are asserted as of
   2026-09-09 — but a budget is a query count, not a latency under concurrency, and nothing has
   driven these paths at peak.
6. ~~**Make mypy mean something** (D6).~~ **Done 2026-09-21** — 271 errors in 41 files to 0 in
   152, and the `|| echo` is off the CI step, so `mypy .` blocks. The count had grown from 98 in 29
   precisely because the step never failed a build; that cannot happen again. Two real defects came
   out of the pass — see [§ D6 fixed](#d6-fixed-and-the-type-gate-now-blocks-2026-09-21).
7. **Independent security review.** Worth more than this line used to suggest: on 2026-09-21 an
   audit of one control found every rate limit bypassable by a forged header and the audit trail
   writable by the caller ([D88](#known-defects)) — both listed as implemented in
   [operations/security.md](operations/security.md), and both green in CI throughout.
8. **An SMS account.** The layer itself shipped 2026-09-10 — provider interface, message log, segment counting, allowlist, and the three messages that earn their cost (confirmed, shipped, refunded). What is left is not code: choose a Bangladeshi aggregator, get a masked sender ID approved (days to weeks), and set `SMS_PROVIDER`. Writing the provider class is an afternoon. [operations/sms.md](operations/sms.md) says what to ask them for.
9. **Favicon raster + OG image** from the official symbol (the SVG favicon is wired), and real
   product photography for the seed (D9).
10. **Eleven owner decisions** are still open — `docs/business-rules.md` carries 11 `DECISION REQUIRED`
    markers — plus the payment-gateway and courier choices. **VAT (D-C) is now settleable in the app**
    at `/admin/settings`, and both treatments are implemented, audited and guarded; the default is
    still exclusive at 0%, which is a placeholder rather than an answer, so it must still be decided
    before the first real sale. **D-A (credit sales) no longer blocks anything** — phase 37 is built
    in a way that works under either answer.

11. ~~**VAT beyond the setting.**~~ **Done 2026-09-18.** Both halves shipped. **(a) The VAT
    return** is `GET /reports/vat/` and `/admin/reports/vat` — output VAT, less credits on returns,
    less input VAT, split by rate and broken into calendar months. Building it found the third
    thing: `PurchaseOrderItem.tax_rate` had existed since the first migration and *nothing at any
    layer could set it*, because `PurchaseLine` had no such field. Every purchase order ever raised
    carried `tax_total 0.00`, so a VAT return built on it would have told the owner they owed the
    full output VAT with nothing to reclaim. The chain is wired and the purchase order form asks
    for the supplier's VAT. **(b) Storefront prices** now carry `+ 15% VAT` or `incl. 15% VAT`
    beside them — product page, listing card and quick view — resolved per product so a category
    override is respected, and nothing at all at a zero rate.

## Decisions owed for phases 35–39

The money layer cannot be designed around an unanswered question, so these four are recorded here as
well as in [business-rules.md](business-rules.md). Each changes the shape of the code, not just the
schedule.

| #   | Decision                                                                     | Blocks                                              | Default if unanswered                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-A | ~~**Does the business sell on credit?**~~ | ~~Phase 37 entirely~~ | **No longer blocking.** Phase 37 shipped 2026-08-31 built so the answer does not change it: receivable is derived from any order carrying a balance, and a credit sale *is* an order carrying a balance. Still worth answering for how the shop is run, but no code waits on it |
| D-B | ~~**A flat list of cash/bank/MFS accounts, or a real chart of accounts?**~~ | ~~Phase 35's schema~~                              | **Built on the default: a flat list**, 2026-08-22. Changing to a chart of accounts is now a migration, not a choice — see [ADR-0011](architecture/decisions/0011-append-only-cash-book.md) |
| D-C | **VAT: inclusive or exclusive, and at what rate?** | ~~Phase 38~~ — now nothing in code | **Implemented both ways and made settleable** at `/admin/settings` 2026-08-31, so phase 38 shipped. The default is still exclusive at 0%, which is a placeholder rather than an answer — settle it before the first real sale, because orders freeze the treatment they were priced under and a report spanning a change mixes two |
| D-D | **Build EMI, investors, marketplace or attendance at all?**            | Nothing — they are declined                        | No. See the audit for why each is a different product                                                                                                                                            |

D-C no longer blocks any code: both treatments are implemented, the setting is on `/admin/settings`,
every change is audited, and changing it once orders exist needs explicit confirmation. What it still
blocks is the *first real sale* — an order priced under the wrong treatment keeps the total it was
given, and no later setting change corrects it.

## What to build next

Reviewed 2026-09-14, against the code rather than against this file — which was the right way round
to do it, because the file was six shipped items out of date. **Re-checked 2026-09-21 the same way,
this time against the defect table**, which was wrong about the two things it is still asked to
prioritise: D6's size and D40's scope. Both rows below now carry measured figures.

The question that orders everything below: **this shop has never traded.** Nothing is deployed, no
real order has ever been placed. So the test for any piece of work is not "is it valuable" but "does
the first real sale wait on it". Most of the backlog does not.

**Tier 1 is now empty.** All seven items shipped on 09-13 and 09-14. That is worth saying plainly,
because it changes what this section is for: there is no longer a queue of work that needs nobody's
permission and no environment. What is left is Tier 0 — three items of which are not code — and the
Tier 2 list below, which is now the real backlog rather than the overflow.

### Tier 0 — the first sale genuinely waits on these

| # | Item | Why it blocks | Whose move |
|---|---|---|---|
| 1 | **Deploy somewhere** | Nothing below can be true of an environment that does not exist. A load test, a backup schedule, a security review and `verify_accounts` against real data all wait here | Needs a server |
| 2 | **Settle VAT** (D-C) | Orders freeze the treatment they were priced under. The default is exclusive at 0% — a placeholder, not an answer — and no later setting change corrects an order already taken | Owner's answer |
| 3 | **Real product photography** (D9) | Every storefront card and product page renders "no image available". A clothing shop with no product images cannot sell, and it makes every demo read as broken | Needs photos |
| 4 | **Automate the backup** | The production database was destroyed once already (2026-08-22) and survived only because a hand-taken dump happened to be 14 minutes old. `scripts/backup-db.sh` takes `BACKUP_S3_BUCKET` and `BACKUP_RETAIN_DAYS`; nothing schedules it | Ours, once deployed |

Tier 0 is four items and **three of them are not code**. That is the honest position.

### Tier 1 — done

All seven shipped. Kept here as the record of what was built and when, not as a queue.

| # | Item | Shipped |
|---|---|---|
| 1 | **Abandoned checkout capture** | 2026-09-13 |
| 2 | **Product spec attributes** | 2026-09-14 |
| 3 | **Brand landing pages** | 2026-09-13 |
| 4 | **WhatsApp float button** | 2026-09-13 |
| 5 | **The fourth (`stale`) variant state** | 2026-09-13 |
| 6 | **Price drops + real "customers also bought"** | 2026-09-13 |
| 7 | **Quick View** | 2026-09-13 |
| — | **Make a purchase order payable** | 2026-09-15 — not on this list; it outranked everything on it |

### Tier 2 — the backlog now, in this order

Nothing here waits on a decision, a provider or an environment, which is what Tier 1 used to mean.
Ordered by value per day of work.

**Five of the seven shipped on 2026-09-15.** What is left:

| # | Item | Why now |
|---|---|---|
| 1 | ~~**[D40](#known-defects) — `router.refresh()` applies the payload it fetched, or does not**~~ | **Worked around 2026-09-21.** Not root-caused — it is upstream and vercel/next.js#77504 was closed as not planned — but the screens are correct now and a production build is 42/42. Six hypotheses ruled out, recorded so nobody repeats them. **The follow-up landed the same day**: the CI E2E job now runs against a production build rather than `next dev`, so the class of defect D40 belongs to — and D74 before it — is finally inside CI's reach |
| 2 | **Media library** | Worth having once there is a real photo library to manage. Before Tier 0 #3 there is nothing to organise |
| 3 | ~~**A reader for `audit-logs/` and `inventory-transactions/`**~~ | **Shipped 2026-09-19** — `/admin/audit` and `/admin/inventory/movements`. Auditing the endpoints first found the audit log unscoped by branch ([D85](#known-defects)) |
| 4 | ~~**Password self-service** (`auth/password/change/`)~~ | **Shipped 2026-09-19** — `/admin/account`. Auditing the endpoint first found that no password change ended a session ([D86](#known-defects)) and that the current password could be guessed at 600 a minute ([D87](#known-defects)) |
| 5 | ~~**[D6](#known-defects) — mypy's 271 errors**~~ | **Fixed 2026-09-21** — 271 in 41 files to 0 in 152, and `mypy .` blocks now that the `\|\| echo` is gone, so the count cannot drift again. It was bulk work rather than hard work, as billed: `core.requests.AuthedRequest` covered 81 of the errors in one sentence and one annotation covered 80 more. The argument for doing it turned out to be the two real defects it surfaced, not the count |
| 6 | ~~**Audit three more security controls**~~ | **Done 2026-09-23** — uploads, the session and branch scope, measured over HTTP. Four defects ([D91–D94](#known-defects)), each fixed with tests proven red first; `tests/api/test_branch_scope.py` now sweeps every GET route for another branch's rows |
| 7 | ~~**A screen for `permissions/`**~~ | **Done 2026-09-23** — the role × permission matrix on `/admin/staff`. The last API without a caller, bar the customer-account endpoints withdrawn on purpose |
| 8 | ~~**Use the two screens nothing had exercised**~~ | **Done 2026-09-24** — the supplier payment form, and the Delivery panel with the customer's parcel view, driven in Chromium. Both screens worked; what they were connected to did not: named accounts never checked ([D95](#known-defects)), a second account impossible to open ([D96](#known-defects)), the customer's payload the staff record ([D97](#known-defects)), parcels leaving unpacked orders ([D98](#known-defects)), and a reset the walk itself broke ([D102](#known-defects)) |
| 9 | ~~**Audit five more security controls**~~ | **Done 2026-09-24** — CSRF, CORS, CSP, error leakage, payment webhooks, against a production build. CORS and CSP held as written. The CSRF token had never existed ([D101](#known-defects)), one error path echoed SQL ([D99](#known-defects)), and the webhook view would have captured the wrong payment once a gateway exists ([D100](#known-defects)) |
| 10 | ~~**Secret scanning in CI**~~ | **Done 2026-09-24** — gitleaks, pinned and checksum-verified, over the whole history, blocking. One fixture accepted by fingerprint in `.gitleaksignore` |

Shipped from this list on 2026-09-15:

| Item | What it turned out to be |
|---|---|
| ~~**Shipment creation and tracking events**~~ | The whole post-purchase journey, not one endpoint. Auditing first found four defects including a branch-scoping hole ([D68–D71](#known-defects)) |
| ~~**[D67](#known-defects) — the Track form**~~ | Same journey, and its front door. Every submission had 404'd since the form was written |
| ~~**[D66](#known-defects) — the import screen's guard**~~ | One page, one check, as billed |
| ~~**[D47](#known-defects) — concurrent pytest runs**~~ | Two causes, and the obvious fix was wrong — see the defect row |
| ~~**Scope the variant matrix by category**~~ | **Done 2026-09-14**, same day it was written down |

### Tier 3 — real, but wait on somebody else

| Item | Why it waits |
|---|---|
| **Payment gateway** | Only prepaid waits on it; **COD works today** and COD is how this market buys. The card option is visibly disabled rather than faked. Needs a provider account, so it is Tier 0-shaped work that cannot start — but it does not block trading |
| **SMS account** | The layer shipped 2026-09-10. What is left is choosing an aggregator and getting a masked sender ID approved (days to weeks). Start the paperwork early; the provider class is an afternoon |

### Skip — and the reason, so it is not re-litigated

| Item | Why not |
|---|---|
| **EMI / instalments** | Real in BD electronics, rare in fashion. Cheap to add later if it ever comes up |
| **Investor list** | A capital-account feature for a business that tracks investors. Ask before building |
| **Attendance / payroll** | HR, not retail. A salary *expense* already captures the money |
| **Marketplace / multi-vendor** | A different product. `Branch` covers the real need |
| **Quotation** (G6) | A wholesale instrument; this shop sells retail. Declined 2026-09-09 |
| **Cheque register** (G7) | `CHEQUE` as a supplier payment method is enough until suppliers are actually paid by cheque. Declined 2026-09-09 |
| **Offline POS** | Declined 2026-09-09 on the owner's decision |
| **Bengali UI toggle** (G9) | Not cheap — every string, twice, forever — and the return is unknown until there is real traffic to measure. Bengali *content* already renders correctly, which is what CLAUDE.md §11 requires. Revisit when someone asks for it |
| **Colour registry** | Normalising `swatch` off `AttributeValue` is tidy and changes nothing a shopper sees |
| **Category icon** | Cosmetic |
| **DataTable upgrade** | `resource-table.tsx` works. Rebuild it when a screen actually needs selection and bulk actions |
| **Search `word_similarity`** | The suggest endpoint and the `SearchTerm` log already shipped. Swapping `trigram_similar` for `word_similarity` is a marginal recall improvement on a 12-product catalogue |
| **Sales-rep attribution** (G11) | There are no sales reps |
| **Backup download from the UI** (G12) | The script exists and has been used in anger. Scheduling it (Tier 0 #4) is the real need; a button is not |

### Three habits to keep

All three earned their place again this pass.

- *Read what the running system serves, not what the code says it will.* D55 — the admin rendering
  every date in the container's UTC — survived a clean `tsc`, a clean lint and 871 passing backend
  tests. It died the moment a browser showed a statement headed "31 Jul 2026".
- *A defect row is a claim, and it ages.* The 2026-09-21 audit re-measured the five open rows
  against the code. D6 was 37 days old and wrong by 173 errors; D40's scope was 21 days old and
  wrong about the only thing that decides how much it matters. Neither had regressed — both had
  simply been written once and read ever since as if the number were live. Re-measure an open
  defect before planning around it, the same way an endpoint is checked before building over it.
- *Prove the test fails first.* Every regression test written on 09-11 and 09-12 was run against the
  old code and seen to fail before the fix landed. A test written after a fix, never seen red, is a
  test of nothing.

And one learned the hard way on 09-12: *a green job is not a green commit.* `gh pr checks` reports
whatever checks exist on a PR, not the checks for the SHA you just pushed — which read as a passing
run for a commit CI had never seen. Query `actions/runs?head_sha=<sha>` instead.
