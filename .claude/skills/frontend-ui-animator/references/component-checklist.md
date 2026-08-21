# Component Audit Checklist

## Phase 1 output — audit table

Produce one row per component worth animating. Leave out components that should stay still; the list of what you deliberately skipped is worth a sentence at the end.

| Component | Location | Priority area | Current motion | Proposed | Trigger | Effort |
|-----------|----------|---------------|----------------|----------|---------|--------|
| `Hero` | `components/hero.tsx` | 1 — Hero intro | none | Staggered fade + slide | Load | Low |
| `FeatureCard` | `components/feature-card.tsx` | 2 — Hover | `transition-colors` | Lift + image zoom | Hover | Low |
| `StatsRow` | `components/stats.tsx` | 3 — Reveal | none | Count-up + stagger | Scroll | Medium |
| `PageShell` | `app/layout.tsx` | 5 — Navigation | none | Route fade | Route change | Medium |

## Phase 2 output — rollout plan

Group by wave so the user can stop after any wave and still have a coherent result.

- **Wave 1 (quick wins, CSS only):** hero stagger, hover states, reduced-motion block
- **Wave 2 (hooks):** scroll reveals, count-ups
- **Wave 3 (optional):** background gradient, route transitions

## Discovery checklist

- [ ] Framework and router identified (Next.js App/Pages, Vite SPA, Remix, Astro)
- [ ] `tailwind.config.*` read — existing `keyframes` / `animation` entries noted
- [ ] Global CSS read — existing `prefers-reduced-motion` block present or absent
- [ ] `package.json` read — animation libraries already installed
- [ ] Server vs client components identified (hooks require `'use client'`)
- [ ] Above-the-fold components distinguished from below-the-fold

## Per-component checklist

Before marking a component done:

- [ ] Only `transform`, `opacity`, and `filter` are animated
- [ ] Element has a defined resting state — no permanent `opacity: 0` if JS fails
- [ ] `animation-fill-mode: forwards` set where the end state must persist
- [ ] Duration between 150ms and 600ms
- [ ] Easing matches direction (out for enter, in for exit)
- [ ] Stagger capped so the last item starts within ~600ms
- [ ] No layout property changes → no CLS
- [ ] `IntersectionObserver` unobserves after firing and disconnects on unmount
- [ ] Scroll listeners are `passive` and rAF-throttled
- [ ] Reduced motion verified — content visible, usable, and not merely fast
- [ ] Hover effects have a keyboard-visible equivalent (`focus-visible:`)
- [ ] Touch devices are not left waiting on a hover-only affordance

## Phase 4 verification script

1. Hard reload with an empty cache; watch the intro at 4× CPU throttle in DevTools.
2. Scroll the full page once slowly, once fast; the Performance panel should show no long tasks over 50ms attributable to animation.
3. Enable reduced motion (DevTools → Rendering → Emulate CSS media feature) and repeat both passes.
4. Run Lighthouse; CLS should be unchanged from the pre-animation baseline.
5. Tab through the page — every hover affordance should also appear on focus.
