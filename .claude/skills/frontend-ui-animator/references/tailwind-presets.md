# Tailwind Presets

Drop-in keyframes and animation utilities. Merge into the existing `theme.extend` — do not replace it.

## Tailwind v3 (`tailwind.config.ts`)

```ts
import type { Config } from 'tailwindcss';

export default {
  theme: {
    extend: {
      keyframes: {
        'fade-in':        { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-slide-in':  {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-slide-down': {
          from: { opacity: '0', transform: 'translateY(-16px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'rise-in': {
          from: { transform: 'translateY(100%)' },
          to:   { transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to:   { opacity: '1', transform: 'scale(1)' },
        },
        'blur-in': {
          from: { opacity: '0', filter: 'blur(12px)', transform: 'scale(0.98)' },
          to:   { opacity: '1', filter: 'blur(0)',    transform: 'scale(1)' },
        },
        'gradient-drift': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1)' },
          '50%':      { transform: 'translate3d(2%, -2%, 0) scale(1.05)' },
        },
        'shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.6' },
        },
      },
      animation: {
        'fade-in':        'fade-in 400ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fade-slide-in':  'fade-slide-in 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fade-slide-down':'fade-slide-down 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'rise-in':        'rise-in 600ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'scale-in':       'scale-in 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'blur-in':        'blur-in 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'gradient-drift': 'gradient-drift 12s ease-in-out infinite',
        'shimmer':        'shimmer 1.6s infinite',
        'pulse-soft':     'pulse-soft 2.5s ease-in-out infinite',
      },
      transitionTimingFunction: {
        'out-expo':  'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-expo':   'cubic-bezier(0.7, 0, 0.84, 0)',
        'overshoot': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
} satisfies Config;
```

## Tailwind v4 (CSS-first, `globals.css`)

```css
@theme {
  --animate-fade-in: fade-in 400ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  --animate-fade-slide-in: fade-slide-in 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  --animate-scale-in: scale-in 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes fade-slide-in {
  from { opacity: 0; transform: translateY(16px) }
  to   { opacity: 1; transform: translateY(0) }
}
@keyframes scale-in {
  from { opacity: 0; transform: scale(0.96) }
  to   { opacity: 1; transform: scale(1) }
}
```

## Stagger delay utilities

Rather than inline styles everywhere, register a small delay scale and use `delay-*`-style classes:

```ts
transitionDelay: { 75: '75ms', 150: '150ms', 225: '225ms', 300: '300ms', 450: '450ms' },
animationDelay:  { 75: '75ms', 150: '150ms', 225: '225ms', 300: '300ms', 450: '450ms' },
```

For list lengths that are unknown at build time, keep the inline `style={{ animationDelay }}` approach — Tailwind cannot generate arbitrary runtime classes.

## Required global block

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

## Useful Tailwind variants

- `motion-safe:` — apply only when motion is allowed: `motion-safe:animate-fade-slide-in`
- `motion-reduce:` — override a resting state: `motion-reduce:opacity-100 motion-reduce:translate-y-0`
- `group-hover:` / `peer-hover:` — parent- and sibling-driven hover states
- `focus-visible:` — pair with every `hover:` affordance for keyboard parity
