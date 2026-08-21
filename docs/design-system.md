# Rangon Fashion Design System

Derived from plan §57–86. Implemented as CSS custom properties in
`apps/web/src/styles/tokens.css` and surfaced to Tailwind in `apps/web/tailwind.config.ts`.
**Never write a raw hex value in a component.**

## Always Do First

- **Invoke the `ui-ux-pro-max-skill` and `frontend-ui-animator`skill** before writing any frontend code, every session, no exceptions.

## Brand

Black + white + Rangon red is the signature. Red means *action, emphasis, identity* — not background.

| Token         | Hex         | Use                           |
| ------------- | ----------- | ----------------------------- |
| `brand-50`  | `#FFF4F1` | subtle tint                   |
| `brand-100` | `#FFE7E1` | soft brand background, badges |
| `brand-400` | `#FF5C33` | highlight, focus glow         |
| `brand-500` | `#FD3807` | **primary action**      |
| `brand-600` | `#E22D04` | hover                         |
| `brand-700` | `#C42503` | active/pressed                |

> `brand-500` is taken from the official logo vector (`logo.svg` → `#FD3807`).
> The build plan quoted `#FB3208` as an eyedropper approximation and said the
> production asset wins. The rest of the ramp is derived from `#FD3807`.
> | `black` | `#000000` | brand foundation, POS header, logo lockup |
> | `white` | `#FFFFFF` | surfaces, logo text |

Neutrals: `neutral-950 #0A0A0A`, `900 #111111`, `800 #1C1C1C`, `700 #2B2B2B`, `600 #525252`,
`500 #737373`, `400 #A3A3A3`, `300 #D4D4D4`, `200 #E5E5E5`, `100 #F5F5F5`, `50 #FAFAFA`.

Semantic (never brand red for errors): `success #16A34A`, `warning #D97706`, `error #DC2626`,
`info #2563EB`, `neutral #737373`. Semantic colours appear in badges, alerts, icons and charts — not as
large decorative areas.

## Surfaces

|            | Background  | Card        | Text        | Muted       | Border      |
| ---------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| Storefront | `#FAFAFA` | `#FFFFFF` | `#111111` | `#737373` | `#E5E5E5` |
| Admin      | `#F5F5F5` | `#FFFFFF` | `#171717` | `#737373` | `#E5E5E5` |
| POS        | `#F5F5F5` | `#FFFFFF` | `#111111` | `#525252` | `#D4D4D4` |

Same design language, different density. Storefront = whitespace + photography. Admin = data density.
POS = contrast + speed.

## Typography

```css
--font-sans:    "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;   /* everything */
--font-display: "Space Grotesk", "Inter", system-ui, sans-serif;            /* headlines only */
```

| Token          | Size / line-height / weight | Use                           |
| -------------- | --------------------------- | ----------------------------- |
| `display-xl` | 56 / 1.05 / 700             | storefront hero (mobile: 36)  |
| `display-lg` | 44 / 1.10 / 700             | campaign heading (mobile: 32) |
| `h1`         | 36 / 1.15 / 700             | page heading                  |
| `h2`         | 30 / 1.20 / 700             | section                       |
| `h3`         | 24 / 1.25 / 650             | subsection                    |
| `h4`         | 20 / 1.30 / 600             | card heading                  |
| `body-lg`    | 18 / 1.55 / 400             | lead                          |
| `body`       | 16 / 1.50 / 400             | default                       |
| `body-sm`    | 14 / 1.45 / 400             | secondary                     |
| `caption`    | 12 / 1.40 / 500             | metadata                      |

Hierarchy comes from weight (400 body, 500 labels/nav, 600 buttons, 700 headings), not from many
colours. No 800/900. Never set Space Grotesk on tables or paragraphs. Financial figures use
`font-variant-numeric: tabular-nums` (`.tabular` utility).

## Spacing, radius, shadow

4 px grid; components default to 8 px increments: `4 8 12 16 20 24 32 40 48 64 80 96`.

Radius `sm 6 · md 8 · lg 12 · xl 16 · 2xl 20 · full 9999`. Controls `md`, cards `lg`, storefront modules
`xl`, pills/avatars `full`.

```css
--shadow-sm: 0 1px 2px rgba(0,0,0,.05);
--shadow-md: 0 4px 12px rgba(0,0,0,.08);
--shadow-lg: 0 12px 30px rgba(0,0,0,.10);
```

Prefer borders and spacing over shadows. Admin cards use borders.

## Components

- **Button** — `primary` (brand-500 → 600 → 700, white text), `secondary` (white, `neutral-300` border),
  `ghost` (transparent → `neutral-100`), `destructive` (`#DC2626`, semantic red — *not* brand red),
  `link`. Sizes `sm 32 · md 40 · lg 44 · xl 52` (POS uses `lg`/`xl`).
- **Input / Select / Textarea** — 40–44 px desktop, 44–48 px touch, 1 px `#D4D4D4` border, radius 8,
  focus `border: brand-500` + `ring: rgba(251,50,8,.18)`. Label + control + error message, always;
  errors are text, never colour alone, and are tied to the field with `aria-describedby`.
- **Badge** — semantic colour + text. `Paid → success`, `Pending → warning`, `Failed → error`,
  `Processing → info`, `Cancelled → error-muted`, `Delivered → success`, `Returned → neutral`.
- **ProductCard** — 4:5 image, optional badge, brand/category, name (2-line clamp), price + compare-at,
  colour swatches. Nothing else.
- **DataTable** — TanStack Table; sticky header, 40 px rows, right-aligned tabular numbers, row
  selection + bulk actions, column visibility, keyboard navigation, per-column filters.
- **StatCard** — label, big tabular value, delta with direction, optional sparkline.
- Empty, loading (skeleton) and error states are part of every data component, not an afterthought.

## Motion

`fast 140ms` (hover, focus, badge), `normal 200ms` (drawer, dropdown, toast), `slow 320ms` (page/gallery
transitions). Easing `cubic-bezier(.2,.8,.2,1)`. Motion is used for cart feedback, drawers/modals,
toasts, gallery changes — never decoration. POS animations are limited to instant feedback.

```css
@media (prefers-reduced-motion: reduce) { *,*::before,*::after {
  animation-duration:.01ms !important; transition-duration:.01ms !important; } }
```

### Storefront motion: what moves, and why

Five touchpoints, no more. The rule of thumb is that four well-chosen animations read as polished and
twenty read as a demo reel.

| What | Motion | Trigger | Why it earns its place |
|---|---|---|---|
| Hero | `rise-in`, 320 ms, staggered 0/60/120/180 ms | Page load | The one place personality is worth paying for. Eyebrow → headline → copy → buttons is the reading order |
| Buttons | `active:scale-[0.97]`, 140 ms | Press | Acknowledges the tap before the network can. Cheapest reassurance on a slow connection |
| Product card | Lift 4 px + shadow, 200 ms; photo `scale-1.03`, 320 ms | Hover | Says "this is one clickable object" — the card rises while the photo pushes in behind it |
| Section headings | Fade + 12 px rise | Scroll into view, once | Paces a long home page instead of dumping it all at once |
| Product grid | Same, staggered 50 ms, **capped at 400 ms** | Scroll into view, once | The cap matters: a 40-product page must not make the last card wait four seconds |

Everything animates `transform` and `opacity` only — both composited, neither able to shift layout, so
CLS stays at zero. Never animate `width`, `height`, `margin` or `top` in this codebase.

**The POS animates nothing.** No hero, no reveals, no entrance. A cashier mid-scan waits for nothing
(`CLAUDE.md` §10, §13). Its pending states are the exception, and they are feedback, not decoration.

#### The resting state must always be visible

The failure mode of an entrance animation is content that never arrives. Three defences, all shipped:

- **`motion-safe:` gates the hero.** The animation applies only when motion is welcome; when it does
  not apply, the element renders normally rather than being held invisible by `animation-fill-mode`.
- **`useScrollReveal` starts visible** when `prefers-reduced-motion` is set, and also when
  `IntersectionObserver` is missing. It unobserves after firing, so a long catalogue is not paying for
  dozens of live observers.
- **A `<noscript>` rule forces `[data-reveal]` visible.** The hidden state is server-rendered, so
  without this a shopper with scripts blocked would get a blank catalogue.

The global reduced-motion block also zeroes `animation-delay` and `transition-delay`, not just
duration. Duration alone is not enough: a staggered entrance holds its from-state for the length of its
delay, so without that line a reduced-motion user watches elements sit invisible and then pop in.

### Waiting: which loader, and when

The brand mark is the only loading animation in the product (`LogoLoader`). What differs is *where*
it appears, and that is decided by how long the wait is and whether the screen is being replaced.

| Wait | Treatment | Why |
|---|---|---|
| 0–480 ms | Progress bar at the top of the viewport, nothing else | Answers "did my click land?" within a frame. A full loader for a 90 ms navigation reads as a glitch |
| > 480 ms, whole screen changing | `LogoLoaderOverlay` — brand mark over a dimmed, blurred page, pointer blocked | The destination is not there yet, and a second click would queue another navigation onto the slow one |
| > 480 ms, one region changing | `PendingRegion` — the region dims in place, mark centred over it | Filtering a list is not an arrival. Replacing the grid with a loader throws away the reader's place and relayouts the page |
| Route segment streaming | `loading.tsx` → `LogoLoaderScreen` | Next's own Suspense boundary; the same mark, so all three surfaces agree |
| Blocking mutation (checkout) | `LogoLoaderOverlay`, 350 ms delay, held through the redirect | Money is moving; the loader must not blink off between the response and the confirmation page |

Two rules govern every loader: **delay before showing** (~480 ms, 350 ms for known-slow work) so fast
work never flashes one, and **a minimum visible time** (~400 ms) so it cannot appear and vanish within
a blink. Both live in `useDelayedFlag`.

`LogoLoader`'s keyframes live in `styles/globals.css` under `.logo-loader`, **not** in a `<style jsx>`
block inside the component, and not inside `@layer components`. Two separate reasons, both found the
hard way:

- Turbopack applies styled-jsx's generated class names but never injects its CSS, so under
  `next dev --turbopack` the loader rendered as a dead, unstyled shape — animating nothing.
- Tailwind tree-shakes `@layer components`, and the content glob did not include `.jsx`, so the rules
  were stripped from the bundle while the class names survived. Same silent failure, different cause.

Plain global CSS is immune to both. `speed` still works: the component writes `--ll-duration` and
`--ll-delay` inline. Reduced motion needs an explicit `animation-name: none` on the fill paths — the
global flattening rule would otherwise leave the mark parked on its `opacity: 0` keyframe, i.e.
invisible.

**Same-segment navigations are the trap.** `loading.tsx` fires only when a navigation crosses into a
segment that has one. Changing just the query string — `/shop?category=…`, `/admin/orders?status=…`,
page 2 — re-renders the same segment with no Suspense boundary, so React holds the old screen on
display until the server answers. Untreated, that is indistinguishable from a frozen app. Route those
pushes through `useRouteTransition().navigate` and wrap the affected region in `PendingRegion`.

The POS is exempt from arrival animation: no route fade, no content transition. A cashier mid-scan
waits for nothing (`CLAUDE.md` §10, §13).

## Imagery

Product images 4:5, consistent treatment, `next/image` with responsive `sizes`, descriptive alt text
built from product + variant, blur placeholder, `priority` only on the hero and the first product image.

## Accessibility

WCAG 2.2 AA: visible focus ring on every interactive element, 4.5:1 text contrast (brand red on white is
3.6:1 → **never** use brand red for body text; it is for fills with white text, where it passes for large
text and UI components), semantic landmarks, labelled icon-only buttons, dialogs with focus trap and
`Esc`, full keyboard operation of the POS, `৳` and Bengali text verified in every numeric component.

## Logo

Official vectors live in `public/brand/logo/`; `src/components/brand/logo.tsx` is the only component
allowed to render them.

| Surface                                | Variant              | Asset                       |
| -------------------------------------- | -------------------- | --------------------------- |
| Storefront navbar (white)              | `full-on-light`    | `logo_full_dark.svg`      |
| Storefront footer (near-black)         | `vertical-on-dark` | `logo_vertical_light.svg` |
| Admin sidebar, POS header (near-black) | `full-on-dark`     | `logo_full_light.svg`     |
| Browser tab, app icon                  | `symbol`           | `logo.svg`                |

Naming reads as *the colour of the wordmark*, so `_dark` goes on white and `_light` goes on black.
`Logo` takes a **height** and derives the width from the asset's own aspect ratio, so the mark cannot
be stretched. Clear space ≥ 0.25 × symbol height. Never rotate, recolour, shadow, gradient, place on
busy imagery, or re-set the wordmark in a font.
Details: [`apps/web/public/brand/BRAND-ASSETS.md`](../apps/web/public/brand/BRAND-ASSETS.md).

## QA checklist per UI feature

```text
[ ] tokens only (no raw hex)      [ ] focus states visible       [ ] empty state
[ ] logo used correctly           [ ] contrast checked           [ ] loading state
[ ] type scale respected          [ ] mobile + desktop tested    [ ] error state
[ ] 4px spacing grid              [ ] keyboard path works        [ ] long text + big numbers
[ ] button hierarchy clear        [ ] reduced motion respected   [ ] ৳ / Bengali text renders
```
