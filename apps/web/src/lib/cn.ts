import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The custom `fontSize` keys in `tailwind.config.ts`. Keep the two in step.
 *
 * tailwind-merge only knows Tailwind's stock sizes (`text-sm`, `text-lg`, …).
 * Any other `text-*` class it takes for a text *colour*, so `text-body-sm` and
 * `text-white` looked like the same property and the later one won. Every
 * Button lost its text colour to its size class (white-on-black became
 * black-on-black), and every Badge lost its size to its tone.
 */
export const FONT_SIZES = [
  "display-xl",
  "display-lg",
  "h1",
  "h2",
  "h3",
  "h4",
  "body-lg",
  "body",
  "body-sm",
  "caption",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
    },
  },
});

/** Merge Tailwind classes so a later class always wins over an earlier one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
