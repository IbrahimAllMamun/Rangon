---
name: frontend-ui-animator
description: Add purposeful, performant motion to a web frontend — hero intros, hover feedback, scroll reveals, background atmosphere, and navigation transitions — using CSS/Tailwind first and Framer Motion or GSAP only when orchestration demands it. Use this skill whenever the user mentions animation, motion, transitions, "make it feel alive", "add polish", scroll effects, fade-ins, stagger, parallax, hover states, micro-interactions, or says a page feels static, flat, or boring — even if they never say the word "animate". Also use it when reviewing an existing UI for jank, layout shift, or missing reduced-motion support.
---

# Frontend UI Animator

Motion should earn its place. Every animation either communicates something (state changed, this is clickable, content arrived) or it is noise that costs frames and attention.

**You don't need animations everywhere.** A page with four well-chosen animations reads as polished. The same page with twenty reads as a demo reel.

## Priority order

When time or budget is limited, work down this list and stop when the page feels right.

| # | Area | Purpose |
|---|------|---------|
| 1 | Hero intro | First impression, brand personality |
| 2 | Hover interactions | Feedback, discoverability |
| 3 | Content reveal | Guide attention, reduce cognitive load |
| 4 | Background effects | Atmosphere, depth |
| 5 | Navigation transitions | Spatial awareness, continuity |

Anything below #3 is optional. Never let #4 or #5 land before #1–#3 are solid.

## Workflow

Run these phases in order. Finish each before starting the next — planning against an unread codebase produces animations that fight existing styles.

### Phase 1 — Analyze

1. **Scan structure.** Enumerate pages in `app/` (or `pages/`, `src/routes/`) and components in `components/`.
2. **Check existing setup.** Read `tailwind.config.*` for keyframes/animation utilities already defined, and the global stylesheet for existing transitions and any `prefers-reduced-motion` block.
3. **Check dependencies.** Read `package.json` for `framer-motion`, `motion`, `gsap`, `@react-spring/*`, `react-intersection-observer`, `lenis`. Use what is installed before proposing anything new — an unnecessary dependency is a real cost to the user.
4. **Classify candidates.** Map each component to one of the five priority areas.

**Output:** an animation audit table. Template in `references/component-checklist.md`.

### Phase 2 — Plan

1. Assign a specific pattern to each component (see `references/animation-patterns.md`).
2. Name the trigger for each: load, scroll-into-view, hover, or click.
3. Estimate effort — Low (CSS/Tailwind only), Medium (custom hook), High (library required).
4. Propose a phased rollout, quick wins first, and confirm the plan with the user before writing code. Motion is taste-dependent; a 30-second check-in beats rewriting twelve components.

**Output:** a component → animation → trigger → effort table.

### Phase 3 — Implement

1. Extend the Tailwind config with keyframes and animation utilities — presets in `references/tailwind-presets.md`.
2. Add the reduced-motion block to global CSS **before** adding animations, not after.
3. Create reusable hooks (`useScrollReveal`, `useMousePosition`) only when more than one component needs them.
4. Apply patterns component by component.

### Phase 4 — Verify

- Visual QA each animation in the browser.
- Toggle `prefers-reduced-motion: reduce` and confirm the page is fully usable and still readable — reveal-on-scroll elements must end visible, never stuck at `opacity: 0`.
- Check CLS: nothing animated may reserve or release layout space.
- Scroll the full page and watch for jank; confirm observers disconnect on unmount.

## Performance rules

Animate only what the compositor can handle off the main thread.

```css
/* DO — compositor-friendly */
transform: translateY(20px) scale(1.02);
opacity: 0.5;
filter: blur(4px);          /* cheap in small doses; expensive on large surfaces */

/* DON'T — these trigger layout on every frame */
margin-top: 20px;
height: 100px;
width: 200px;
top: 40px;
```

Additional rules that matter in practice:

- Prefer `transform: translate()` over animating `left`/`top`.
- Use `will-change` sparingly and remove it after the animation; it permanently promotes layers.
- Keep entrance durations in the 200–600ms range. Longer feels sluggish, shorter feels like a glitch.
- Use `ease-out` for entrances, `ease-in` for exits, spring/`cubic-bezier` for interactive gestures.
- Cap stagger delays so the last item never waits more than ~600ms: `Math.min(i * 100, 600)`.

## Trigger reference

| Trigger | Implementation |
|---------|----------------|
| Page load | CSS animation with `animation-delay` for stagger |
| Scroll into view | `IntersectionObserver` or `react-intersection-observer` |
| Hover | Tailwind `hover:` utilities or CSS `:hover` |
| Click / tap | State-driven with `useState` |

## Core patterns

**Staggered children**

```tsx
{items.map((item, i) => (
  <div
    key={item.id}
    style={{ animationDelay: `${Math.min(i * 100, 600)}ms` }}
    className="animate-fade-slide-in opacity-0 [animation-fill-mode:forwards]"
  />
))}
```

**Scroll reveal hook** — unobserve after firing so the observer does not keep working for the rest of the session.

```tsx
const useScrollReveal = (threshold = 0.1) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(entry.target);
        }
      },
      { threshold, rootMargin: '0px 0px -10% 0px' }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, isVisible };
};
```

Usage:

```tsx
const { ref, isVisible } = useScrollReveal();

<div
  ref={ref}
  className={`transition-all duration-500 ease-out ${
    isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
  }`}
/>
```

More patterns — hero intros, magnetic buttons, parallax, page transitions, background gradients — live in `references/animation-patterns.md`. Read it when implementing anything beyond a fade or slide.

## Choosing the tool

| Need | Use |
|------|-----|
| Fades, slides, stagger, hover, simple loops | CSS keyframes + Tailwind utilities |
| Enter/exit of conditionally rendered elements, layout shifts, drag/gesture | Framer Motion |
| Multi-step timelines, scroll-scrubbed sequences, SVG morphing | GSAP (only if already installed) |

Do not install a library to do what a keyframe does. Reach for Framer Motion when React unmounts an element and it needs to animate out — that is the case CSS genuinely cannot cover.

## Accessibility (required)

Ship this in global CSS with every animation task:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

The global block neutralizes duration but does not fix elements whose *resting* state is hidden. Any JS-driven reveal must also respect the query:

```tsx
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const [isVisible, setIsVisible] = useState(prefersReduced);
```

Also: never convey information through motion alone, keep looping background effects subtle enough to ignore, and avoid large parallax or zoom effects, which can trigger vestibular discomfort.

## Reference files

- `references/animation-patterns.md` — full pattern library by priority area, with code
- `references/component-checklist.md` — audit table template and per-component checklist
- `references/tailwind-presets.md` — drop-in keyframes and animation utilities for `tailwind.config`
