# Animation Patterns

Patterns organized by priority area. Each entry lists the trigger, the effort level, and working code.

## Contents

- [1. Hero intro](#1-hero-intro)
- [2. Hover interactions](#2-hover-interactions)
- [3. Content reveal](#3-content-reveal)
- [4. Background effects](#4-background-effects)
- [5. Navigation transitions](#5-navigation-transitions)
- [Easing cheat sheet](#easing-cheat-sheet)

---

## 1. Hero intro

### Staggered headline + subhead + CTA
Trigger: page load · Effort: Low

```tsx
<section className="flex flex-col items-start gap-6">
  <h1 className="animate-fade-slide-in opacity-0 [animation-fill-mode:forwards]">
    Build something worth looking at
  </h1>
  <p
    className="animate-fade-slide-in opacity-0 [animation-fill-mode:forwards]"
    style={{ animationDelay: '120ms' }}
  >
    Motion that means something.
  </p>
  <a
    className="animate-fade-slide-in opacity-0 [animation-fill-mode:forwards]"
    style={{ animationDelay: '240ms' }}
  >
    Get started
  </a>
</section>
```

`[animation-fill-mode:forwards]` with a starting `opacity-0` is what stops the flash-then-fade artifact.

### Word-by-word headline reveal
Trigger: page load · Effort: Medium

```tsx
<h1 aria-label={text} className="flex flex-wrap gap-x-[0.25em]">
  {text.split(' ').map((word, i) => (
    <span key={i} className="overflow-hidden">
      <span
        aria-hidden
        className="inline-block animate-rise-in translate-y-full [animation-fill-mode:forwards]"
        style={{ animationDelay: `${i * 60}ms` }}
      >
        {word}
      </span>
    </span>
  ))}
</h1>
```

Keep `aria-label` on the parent and `aria-hidden` on the fragments so screen readers get one clean string.

### Blur-in
Trigger: page load · Effort: Low

```css
@keyframes blur-in {
  from { opacity: 0; filter: blur(12px); transform: scale(0.98); }
  to   { opacity: 1; filter: blur(0);    transform: scale(1); }
}
```

Use on a single hero element only — `filter` on many large elements at once is the most common cause of intro jank.

---

## 2. Hover interactions

### Lift card
Trigger: hover · Effort: Low

```tsx
<div className="transition-transform duration-300 ease-out hover:-translate-y-1 hover:shadow-lg motion-reduce:hover:translate-y-0">
```

Animate `transform`, not `margin`. Shadow changes are cheap; pre-render the shadow on a pseudo-element and animate its opacity if profiling shows paint cost.

### Underline sweep
Trigger: hover · Effort: Low

```tsx
<a className="group relative">
  Link
  <span className="absolute inset-x-0 -bottom-0.5 h-px origin-left scale-x-0 bg-current transition-transform duration-300 ease-out group-hover:scale-x-100" />
</a>
```

### Image zoom in a fixed frame
Trigger: hover · Effort: Low

```tsx
<div className="overflow-hidden rounded-xl">
  <img className="transition-transform duration-500 ease-out hover:scale-105" />
</div>
```

The `overflow-hidden` wrapper keeps the layout box fixed — zero CLS.

### Magnetic button
Trigger: mouse move · Effort: Medium

```tsx
const useMousePosition = (strength = 0.3) => {
  const ref = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setOffset({
      x: (e.clientX - (rect.left + rect.width / 2)) * strength,
      y: (e.clientY - (rect.top + rect.height / 2)) * strength,
    });
  };

  return { ref, offset, onMouseMove, onMouseLeave: () => setOffset({ x: 0, y: 0 }) };
};
```

Apply as `transform: translate(${offset.x}px, ${offset.y}px)`. Skip entirely on touch devices and under reduced motion.

---

## 3. Content reveal

### Scroll reveal with stagger
Trigger: intersection · Effort: Medium

```tsx
const { ref, isVisible } = useScrollReveal(0.15);

<ul ref={ref}>
  {items.map((item, i) => (
    <li
      key={item.id}
      style={{ transitionDelay: `${Math.min(i * 80, 480)}ms` }}
      className={`transition-all duration-500 ease-out ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
      }`}
    />
  ))}
</ul>
```

One observer on the container, delays on the children — not one observer per row.

### Count-up number
Trigger: intersection · Effort: Medium

Use `requestAnimationFrame` with an eased progress value, and set the final value immediately under reduced motion. Reserve the width with `tabular-nums` so the digits do not reflow the layout as they change.

### Skeleton → content
Trigger: data load · Effort: Low

Cross-fade the skeleton out and content in over ~200ms with both absolutely positioned in the same grid cell, so the swap causes no shift.

---

## 4. Background effects

### Drifting gradient
Trigger: continuous · Effort: Low

```css
@keyframes gradient-drift {
  0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
  50%      { transform: translate3d(2%, -2%, 0) scale(1.05); }
}
```

Apply to a blurred, low-opacity blob behind content — animate the blob's `transform`, never `background-position` on a large element.

### Grid / noise overlay
Trigger: static or slow drift · Effort: Low

Keep opacity under ~0.06 and `pointer-events-none`. If it competes with the text, it is too strong.

### Parallax
Trigger: scroll · Effort: Medium

```tsx
useEffect(() => {
  let raf = 0;
  const onScroll = () => {
    raf = requestAnimationFrame(() => setY(window.scrollY * 0.2));
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
}, []);
```

Always `passive: true`, always rAF-throttled, always disabled under reduced motion — parallax is the pattern most likely to cause vestibular discomfort.

---

## 5. Navigation transitions

### Route fade (Next.js App Router)
Trigger: route change · Effort: Medium

```tsx
'use client';
const pathname = usePathname();

<div key={pathname} className="animate-fade-in">{children}</div>
```

Keying on the pathname remounts the wrapper, replaying the entrance. Keep it at 150–250ms — route transitions are the animation users hit most often, so any sluggishness compounds.

### Framer Motion exit animations
Trigger: unmount · Effort: Medium

```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={pathname}
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
    transition={{ duration: 0.2, ease: 'easeOut' }}
  />
</AnimatePresence>
```

This is the case CSS cannot cover — an element removed from the DOM cannot animate out without a library holding it.

### Mobile menu slide
Trigger: click · Effort: Low

Animate `transform: translateX(-100%) → 0` on the panel plus an opacity fade on the backdrop. Trap focus while open and restore it to the trigger on close.

---

## Easing cheat sheet

| Situation | Curve |
|-----------|-------|
| Entrance | `ease-out` / `cubic-bezier(0.16, 1, 0.3, 1)` |
| Exit | `ease-in` / `cubic-bezier(0.4, 0, 1, 1)` |
| Move between two on-screen states | `ease-in-out` |
| Interactive / gestural | spring, or `cubic-bezier(0.34, 1.56, 0.64, 1)` for overshoot |

Never use `linear` for anything that represents physical movement — reserve it for loading spinners and marquees.
