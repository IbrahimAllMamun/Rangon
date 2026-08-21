/**
 * Variant axis maths shared by the buy panel and the gallery.
 *
 * Both need the same two answers — "what are the axes?" and "which variant do I
 * land on if I change this one thing?" — because clicking a red thumbnail must
 * select red exactly as pressing the red swatch does
 * (docs/architecture/product-media.md §4).
 */
import type { ShopProduct, ShopVariant } from "@/lib/api/types";

export interface Axis {
  code: string;
  name: string;
  kind: "COLOR" | "TEXT";
  values: { value: string; label: string; swatch: string }[];
}

export function buildAxes(variants: ShopVariant[]): Axis[] {
  const axes = new Map<string, Axis>();

  for (const variant of variants) {
    for (const [code, attribute] of Object.entries(variant.attributes)) {
      if (!axes.has(code)) {
        axes.set(code, {
          code,
          name: code.charAt(0).toUpperCase() + code.slice(1).replace(/-/g, " "),
          kind: attribute.swatch ? "COLOR" : "TEXT",
          values: [],
        });
      }
      const axis = axes.get(code)!;
      if (!axis.values.some((value) => value.value === attribute.value)) {
        axis.values.push({
          value: attribute.value,
          label: attribute.label,
          swatch: attribute.swatch,
        });
      }
    }
  }
  return [...axes.values()];
}

/**
 * Pick the variant that keeps every other chosen axis fixed and changes only
 * this one — so choosing "Large" keeps the colour the shopper already picked.
 * Falls back to any variant carrying the value, which repairs the other axes
 * rather than leaving the shopper on a combination that does not exist.
 */
export function findVariant(
  variants: ShopVariant[],
  current: ShopVariant | null,
  code: string,
  value: string,
): ShopVariant | undefined {
  const exact = variants.find((variant) => {
    if (variant.attributes[code]?.value !== value) return false;
    if (!current) return true;
    return Object.entries(current.attributes).every(
      ([otherCode, attribute]) =>
        otherCode === code || variant.attributes[otherCode]?.value === attribute.value,
    );
  });
  if (exact) return exact;

  // Prefer a buyable fallback: landing on an in-stock combination beats landing
  // on the first row that happens to match.
  const carrying = variants.filter((variant) => variant.attributes[code]?.value === value);
  return carrying.find((variant) => variant.in_stock) ?? carrying[0];
}

/** The attribute code images are grouped by, or `null` if the product has no colour axis. */
export function colourAxisCode(product: ShopProduct): string | null {
  const fromImages = product.images.find((image) => image.color)?.color?.code;
  if (fromImages) return fromImages;
  return buildAxes(product.variants).find((axis) => axis.kind === "COLOR")?.code ?? null;
}

export function defaultVariant(product: ShopProduct): ShopVariant | null {
  return product.variants.find((variant) => variant.in_stock) ?? product.variants[0] ?? null;
}
