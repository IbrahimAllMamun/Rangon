import type { Config } from "tailwindcss";

/**
 * Tailwind reads the Rangon design tokens (src/styles/tokens.css) rather than
 * declaring its own palette. One source of truth — see docs/design-system.md.
 * The default shadcn neutral/primary values are deliberately NOT used.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "var(--brand-50)",
          100: "var(--brand-100)",
          400: "var(--brand-400)",
          500: "var(--brand-500)",
          600: "var(--brand-600)",
          700: "var(--brand-700)",
          DEFAULT: "var(--brand-500)",
        },
        neutral: {
          50: "var(--neutral-50)",
          100: "var(--neutral-100)",
          200: "var(--neutral-200)",
          300: "var(--neutral-300)",
          400: "var(--neutral-400)",
          500: "var(--neutral-500)",
          600: "var(--neutral-600)",
          700: "var(--neutral-700)",
          800: "var(--neutral-800)",
          900: "var(--neutral-900)",
          950: "var(--neutral-950)",
        },
        background: "var(--background)",
        surface: "var(--surface)",
        foreground: "var(--foreground)",
        muted: "var(--muted)",
        border: "var(--border)",
        ring: "var(--ring)",
        success: "var(--success)",
        warning: "var(--warning)",
        error: "var(--error)",
        info: "var(--info)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
      },
      fontSize: {
        "display-xl": ["3.5rem", { lineHeight: "1.05", fontWeight: "700" }],
        "display-lg": ["2.75rem", { lineHeight: "1.1", fontWeight: "700" }],
        h1: ["2.25rem", { lineHeight: "1.15", fontWeight: "700" }],
        h2: ["1.875rem", { lineHeight: "1.2", fontWeight: "700" }],
        h3: ["1.5rem", { lineHeight: "1.25", fontWeight: "650" }],
        h4: ["1.25rem", { lineHeight: "1.3", fontWeight: "600" }],
        "body-lg": ["1.125rem", { lineHeight: "1.55" }],
        body: ["1rem", { lineHeight: "1.5" }],
        "body-sm": ["0.875rem", { lineHeight: "1.45" }],
        caption: ["0.75rem", { lineHeight: "1.4", fontWeight: "500" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      transitionDuration: {
        fast: "140ms",
        normal: "200ms",
        slow: "320ms",
      },
      transitionTimingFunction: {
        rangon: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      aspectRatio: {
        product: "4 / 5",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms cubic-bezier(0.2,0.8,0.2,1)",
        "slide-up": "slide-up 200ms cubic-bezier(0.2,0.8,0.2,1)",
        "slide-in-right": "slide-in-right 200ms cubic-bezier(0.2,0.8,0.2,1)",
      },
    },
  },
  plugins: [],
};

export default config;
