# ADR-0015 — The NestJS API ports nh3's page sanitiser and parses HTML with parse5's tokenizer

**Status:** Accepted · 2026-10-01 · in use from phase 4 part 5b of the port (site pages)

## Context

Site page bodies (About, Contact, the policies, the shop's own pages) are HTML from the admin's
rich-text editor. Django cleans every body before storing it, in `content.rich_text.sanitize`,
which calls `nh3.clean` and then trims trailing empty paragraphs ([ADR-0012](0012-storefront-footer-and-site-pages.md)).
It is the XSS boundary for page bodies.

nh3 0.3.7 is a Python binding to Rust code: ammonia 4.1.4 cleans a tree that html5ever 0.39 parses,
and rust-url 2.5.8 with idna 1.1 decides which links stay. A body the NestJS API stores must be
byte for byte what Django stores, or the two APIs disagree about the same page.

Node has no binding to ammonia. The JavaScript sanitisers (DOMPurify, sanitize-html) parse
differently, filter differently and serialise differently. One of them would never answer as nh3
does. Hand-written regex sanitising is how XSS filters fail, which is why Django uses a parser.

Two facts shaped the choice:

- **html5ever 0.39 follows the HTML standard of 2025**, where `<select>` lost its own insertion
  modes and keeps `<p>`, `<div>` and `<hr>` as content. parse5 8.0.1, the reference JavaScript
  parser, still builds the old tree. Its tree builder cannot be used as it is.
- **The tokenizer stage is the same** in both. The tokenizer standard has not changed, and parse5
  exports its tokenizer as a separate class.

## Decision

**Port the pipeline nh3 runs, from its source, and use parse5 only for its tokenizer.**

- `src/common/html5ever.ts` is html5ever's tree builder, ported statement by statement from
  `tree_builder/{mod,rules,tag_sets}.rs`, with ammonia's `rcdom` as its sink. html5ever's own
  quirks are kept: its default scope leaves out MathML `annotation-xml`, its special tags are HTML
  ones only, it discards one leading byte-order mark, and a parse error between a `<pre>` and its
  first line feed keeps the line feed.
- `src/content/rich-text.ts` is ammonia's `clean_dom` with the settings Django passes, html5ever's
  serializer (written without recursion, as rcdom's is), and Django's trim.
- `src/common/rust-url.ts` decides whether a link parses as rust-url parses it. It ports the steps
  that can fail: scheme, user info, host, port. rust-url departs from the URL standard there
  (`tel://@` parses; a backslash ends any port), and those departures are kept. The IDNA step is
  Node's UTS #46 mapping plus the checks idna makes and Node's does not: Punycode labels refused
  before decoding, decoded labels checked again, and the Bidi Rule (RFC 5893).
  `src/common/bidi-class.ts` is Unicode 17's Bidi_Class, generated from `DerivedBidiClass.txt`.
- **parse5 (8.0.1) is a runtime dependency** of the Nest API. It was added to `package.json` on
  2026-10-01, with its own dependency `entities`. Both ship ES modules only; the compiled API
  (CommonJS on Node 22) requires them directly, and jest transforms them.

The proof is differential, as for the CSV reader and the date parser. Before the port was
committed, nh3 cleaned 150,000 generated fragments in the Django container. They cover tables and
foster parenting, formatting-element soup, `<select>`, SVG and MathML, raw-text elements,
templates, character references and broken markup. nh3 also checked 520,000 generated links:
internationalised and Punycode hosts, bidi labels, IPv4 and IPv6, ports and user info. The port's
output differed on none. `test/unit/rich-text.spec.ts` keeps a curated set, with values nh3 printed.

## Consequences

- **One dependency for HTML, used for tokenizing only.** A parse5 upgrade can change only how text
  becomes tokens; the corpus comparison should be re-run before one is taken.
- **The port is tied to nh3's version.** An nh3, ammonia or html5ever upgrade in `apps/api` needs
  the same comparison, and the port changed where the Rust code changed.
- **The sanitiser is no faster than nh3 on hostile input,** and no slower. Both are quadratic on
  some pathological bodies within the 200,000-character limit; the port's worst measured case is
  2.9 s against nh3's 8.9 s. In Node the parse blocks the event loop while it runs, so the stack of
  open elements counts element names: 40,000 nested `<div>`s take 0.2 s, not 24.
- **Node 22's `URL.canParse` is not used.** Once V8 optimises the call, it refuses some hosts that
  `new URL` parses (`https://ä.com`); the link check uses `new URL`.
