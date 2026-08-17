# Brand assets

These are the **official Rangon Fashion vectors**, copied from the project's
`/logo` folder. They are the authoritative mark — never recreate the wordmark in
a font, and never redraw the symbol (plan §57.2, §82.15).

## Files and where each one is used

| File | Wordmark colour | Use it on | Used by |
|---|---|---|---|
| `logo_full_dark.svg` | dark | **light** backgrounds | Storefront navbar, mobile menu |
| `logo_full_light.svg` | white | **dark** backgrounds | Admin sidebar, POS header |
| `logo_vertical_dark.svg` | dark | light backgrounds | A4 invoices, light splash |
| `logo_vertical_light.svg` | white | dark backgrounds | Storefront footer |
| `logo.svg` | — (symbol only) | anywhere | Browser tab / favicon, app icon, compact lockups |

Naming reads as *"the colour of the wordmark"*, not *"the background"* — so
`_dark` goes on white, `_light` goes on black. `src/components/brand/logo.tsx`
exposes this as unambiguous variant names (`full-on-light`, `vertical-on-dark`, …)
so a page cannot pick the wrong one by accident.

## Geometry

| Asset | viewBox | Aspect ratio |
|---|---|---|
| full | 1107.19 × 207.01 | 5.348 |
| vertical | 908.81 × 795.83 | 1.142 |
| symbol | 239.46 × 206.16 | 1.161 |

`Logo` takes a **height** and derives the width from these ratios, so the mark
can never be stretched or squashed.

## Brand colour

The official vectors use **`#FD3807`**. The build plan quoted `#FB3208` as an
eyedropper approximation and stated the production asset is the source of truth —
so `--brand-500` in `src/styles/tokens.css` is `#FD3807`, and the hover/active
shades are derived from it (`#E22D04`, `#C42503`).

## Rules

- Clear space around the logo ≥ 0.25 × symbol height (the component adds padding).
- Never stretch, compress, rotate, recolour, shadow, gradient, or place the mark
  on a busy photograph.
- Only `src/components/brand/logo.tsx` may render the logo. Nothing else should
  reference these files directly.

## Still to produce

- `favicon/favicon.ico` (32×32 + 16×16 raster fallback for old browsers — the
  SVG favicon covers every current browser)
- `favicon/icon-192.png`, `icon-512.png` for add-to-home-screen
- `social/og-image.png` (1200×630) for link previews
