# ADR-0010 — `@radix-ui/react-navigation-menu` for the storefront navbar

**Status:** Accepted · 2026-08-21

## Context

CLAUDE.md §2 forbids adding a dependency without stating why. The storefront navbar needs a
multi-level menu that is fully keyboard-operable (§11, WCAG 2.2 AA).

The navbar shipped today opens its submenu with `group-hover` plus `group-focus-within`
(`app/(storefront)/layout.tsx`). That does open on keyboard — focusing the parent link satisfies
`focus-within` on the `<li>` — but it declares nothing to assistive technology:

- no `aria-expanded` or `aria-controls`, so a screen reader is never told a menu opened;
- `Escape` does not close the panel;
- no arrow-key movement between items;
- the panel stays open for as long as focus is anywhere inside the `<li>`, with no focus return.

Hand-rolling roving `tabindex`, focus trapping, hover intent and dismissal is a well-known source of
subtle accessibility bugs, and this component appears on every storefront page.

## Decision

Use `@radix-ui/react-navigation-menu` for the desktop primary navigation.

The project already ships nine Radix packages (`dialog`, `dropdown-menu`, `popover`, `select`,
`tabs`, `tooltip`, `label`, `separator`, `slot`), all at the 1.x/2.x line. This adds a tenth from the
same family, with the same styling approach and no new transitive runtime.

Related choices that do **not** need a new dependency:

- the mobile drawer keeps `@radix-ui/react-dialog`, already in use;
- the account menu keeps `@radix-ui/react-dropdown-menu`, already in use;
- motion uses the existing `--duration-fast` / `--duration-normal` tokens and the global
  `prefers-reduced-motion` handling in `styles/globals.css`. No animation library is added.

## Consequences

- Arrow keys, `Escape`, `aria-expanded`/`aria-controls`, focus return and hover intent are correct by
  construction rather than by review.
- Radix renders real `<a>` elements, so navigation stays crawlable (spec §34) and server-rendered.
- Bundle cost is small and scoped to the storefront layout; the primary nav is the only client
  component in the header shell.
- Radix `NavigationMenu` has opinions about its own DOM structure and viewport positioning. A mega
  menu that must escape the header's stacking context uses the library's viewport slot rather than a
  hand-placed absolute panel. Note that the header carries `backdrop-blur-sm`, which makes it the
  containing block for `position: fixed` descendants — any overlay must portal out, as the mobile
  drawer already does.
- If Radix is ever removed, the seam is `components/commerce/primary-nav.tsx`; the navigation data
  contract in `docs/architecture/navigation.md` is independent of it.
