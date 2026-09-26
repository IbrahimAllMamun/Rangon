# ADR-0012 — The footer and site pages are content, edited in the admin

**Status:** Accepted · 2026-09-26

## Context

Until now the storefront footer was code: its Help and Company columns, its tagline and bottom bar
were literals in `app/(storefront)/layout.tsx`, and only a "Shop" column came from data
(`NavigationItem`, `placement=FOOTER`). About, Contact and the four policy pages were hardcoded copy,
and the Contact page advertised a placeholder phone number. There was no address in the footer, no
social profile anywhere, and no map.

The owner asked for all of it to be editable from the admin: the pages' text, the contact page with a
Google map, the social profiles with a show/hide tick and a custom order, the footer's links, and the
full address under the logo. Four decisions were taken with the owner (2026-09-26):

1. The address under the logo is the **storefront's** address, which may differ from the registered
   one printed on receipts.
2. Official brand marks may be used for social links, as an exception to "Lucide icons only".
3. **Owners and managers** edit the pages, including privacy and terms.
4. Pages are written in a **rich-text editor**, not as structured headings and paragraphs.

## Decision

**Four content shapes in the `content` app, one public payload for the footer.**

| Shape | What it holds |
|---|---|
| `SiteSettings` (one row, `key="default"`) | tagline, the storefront's address / phone / email, opening hours, map embed URL and "open in Maps" link, copyright line, bottom note, WhatsApp-button switch |
| `SocialLink` (one row per platform, made by migration) | URL, `is_visible`, `position` |
| `SitePage` (slug-addressed) | title, search description, **sanitised HTML** body, `is_published`, `is_system` |
| `NavigationItem`, `placement=FOOTER` | the link columns: a `GROUP` row is a column heading, its children are the links |

- **Contact fields fall back.** A blank storefront address, phone or email uses the organisation's, so
  a shop whose details are the same fills in nothing and a fresh install still shows something true.
  The fallback is resolved in the API (`serialise_site`); the storefront never chooses between the
  two sources.
- **Footer columns reuse `NavigationItem`** rather than a new menu model — ADR-0009's reasoning
  holds: `placement` already separates header from footer, and ordering, scheduling, audit, the
  `move` endpoint and cache busting come for free. Three types are added: `GROUP` (a column heading,
  footer-only, top level, at most four), `PAGE` (follows a `SitePage`; hidden while it is unpublished)
  and `CATEGORY_LIST` (expands to the live top-level categories, so a "Shop" column follows the
  catalogue). Every footer link must sit in a column.
- **Social links are a fixed checklist.** One row per platform, created empty and hidden. There is no
  create or delete: a platform cannot be listed twice, and a channel nobody set up is never advertised.
  URLs must be `https://` on the platform's own domain; a WhatsApp number becomes a `wa.me` link. The
  floating WhatsApp button reads its number from here, falling back to the build-time
  `NEXT_PUBLIC_WHATSAPP_NUMBER` only when no WhatsApp link exists at all.
- **Page bodies are HTML, sanitised on write with `nh3`** (Rust's `ammonia`), allow-listing exactly
  what the editor produces: `p br h2 h3 strong em u s a ul ol li blockquote hr`, `href` only, schemes
  `http https mailto tel` plus relative. The storefront renders the stored HTML as-is. The admin editor
  is **TipTap 3** with code and code blocks switched off, so it cannot produce anything the server
  would strip.
- **Maps are Google's embed URL only.** The admin pastes Google's `<iframe>` code; the API keeps only
  its `src`, and only if it is `https://www.google.com/maps/embed…` (or the keyless
  `/maps?…&output=embed`). The storefront's CSP gains exactly `frame-src https://www.google.com`.
  Nothing an admin pastes is ever rendered.
- **Standard pages keep their URLs** (`/about`, `/contact`, `/policies/*`) and cannot be deleted, only
  unpublished. Pages the shop adds live at `/pages/<slug>`.
- **One request for the footer**: `GET /shop/site/`, a constant five queries, cached by Next under
  the `site` tag with a static fallback (the old footer) if the API is down. Pages are
  `GET /shop/pages/<slug>/`, tagged `page:<slug>`. Saving any of it revalidates on commit.
- **Permissions**: reading is `settings.view`; writing is the new `content.site_manage` (owner, admin,
  manager), except the footer columns, which are navigation items and stay under
  `content.navigation_manage`.
- A data migration (`content.0003`) writes today's footer and page copy verbatim, so the storefront
  looks the same the moment it starts reading from the API — without `seed_demo`, which production
  does not run.

## Alternatives rejected

- **Structured page bodies (headings + paragraphs as JSON).** No dependency and no HTML at all, but the
  owner chose rich text (decision 4): lists, links and emphasis in policies are the norm.
- **Markdown.** Needs a renderer *and* a sanitiser on the storefront, and asks a shop manager to learn
  a syntax.
- **Sanitising in the browser (DOMPurify).** The browser is not a trust boundary; a PATCH with a token
  bypasses any client-side cleaning. The server is the only place the rule can hold.
- **A dedicated `FooterColumn`/`FooterLink` model.** Duplicates `NavigationItem`'s ordering, scheduling,
  audit and revalidation for no new capability.
- **Copying the organisation's contact details into `SiteSettings`.** Two copies drift; the fallback
  keeps one source until the shop deliberately wants a different storefront value.
- **Accepting any iframe or map URL.** A pasted iframe is arbitrary HTML, and an arbitrary `src` is an
  arbitrary third party framed into the shop.

## Consequences

- Two new dependencies, each stated here as CLAUDE.md §2 requires: `nh3` (API, the sanitiser) and
  `@tiptap/react` / `@tiptap/starter-kit` / `@tiptap/pm` (admin bundle only — the storefront ships none
  of it).
- `/shop/navigation/`'s `footer` key now returns columns (`GROUP` nodes with children) instead of a
  flat list. The storefront reads `/shop/site/` for the footer.
- A privacy policy or terms page that cannot be loaded renders an error, **not** a copy baked into the
  build: showing stale legal text is worse than showing none.
- Brand marks are inlined SVG paths from Simple Icons (CC0), not a runtime dependency. LinkedIn
  withdrew its mark from Simple Icons, so LinkedIn uses Lucide's glyph.
- A new permission code reaches an existing database's roles when `sync_permissions()` runs. Since
  2026-09-26, `migrate` runs it ([permissions.md](../permissions.md)), so deploying is enough.
