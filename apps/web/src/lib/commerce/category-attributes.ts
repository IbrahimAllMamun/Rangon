/**
 * Which attributes the product form offers, and why the answer is not simply
 * "the ones the category declares".
 *
 * `CategoryAttribute` says a handbag uses Colour and Material and a trainer
 * uses Shoe size — which is the whole point of scoping the form to it, so a
 * merchant editing shoes is not shown Shade, Volume and Capacity. But the
 * variant half of that form is not a preference list: it is the only control
 * over rows that already exist, may hold stock, and are referenced by the
 * inventory ledger and by order history. Hiding an axis a product is already
 * built on would leave those rows visible in the matrix (`buildMatrix` appends
 * every saved variant whatever is ticked) and un-editable, with no fieldset to
 * untick them from and no label for their values.
 *
 * Hence `resolveVariantAxes`, and the two rules it exists for.
 */
import type { MatrixAttribute } from "@/lib/commerce/variant-matrix";

/** One attribute a category uses, as `GET /categories/{id}/attributes/` answers. */
export interface CategoryAttributeRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  is_variant_defining: boolean;
  is_required: boolean;
  /** Which category in the chain declared it — a parent, usually. */
  declared_by: string;
  values: { id: string; value: string; label: string; display: string; swatch: string }[];
}

/**
 * The variant axes to offer for this category and this product.
 *
 * @param all      every variant-defining attribute in the shop, as the form is handed them
 * @param declared codes the category declares (its variant-defining half)
 * @param inUse    codes the product's saved variants are already built on
 *
 * Two rules, both about not making things impossible:
 *
 * 1. **A category that declares nothing offers everything.** Otherwise a
 *    newly-created category — or the seeded parents, which declare nothing
 *    because the seed wires attributes to leaves — could never be given a
 *    single variant, and the failure would look like a broken form rather than
 *    missing configuration.
 * 2. **An axis a product already uses is always offered**, declared or not.
 *    Re-filing a product into a category that does not declare Colour must not
 *    strand the colours it is already sold in.
 */
export function resolveVariantAxes(
  all: MatrixAttribute[],
  declared: readonly string[],
  inUse: readonly string[],
): MatrixAttribute[] {
  const offered = all.filter((attribute) => attribute.values.length > 0);
  if (declared.length === 0) return offered;

  const keep = new Set([...declared, ...inUse]);
  return offered.filter((attribute) => keep.has(attribute.code));
}

/** The attribute codes a product's saved variants are built on. */
export function axesInUse(
  variants: { attributes: { attribute_code: string }[] }[],
): string[] {
  const codes = new Set<string>();
  for (const variant of variants) {
    for (const attribute of variant.attributes) codes.add(attribute.attribute_code);
  }
  return [...codes];
}

/** The codes of the variant-defining half of a category's attributes. */
export function declaredAxes(rows: CategoryAttributeRow[] | null): string[] {
  return (rows ?? []).filter((row) => row.is_variant_defining).map((row) => row.code);
}

/** The specification half — everything that does not build a SKU. */
export function declaredSpecs(rows: CategoryAttributeRow[] | null): CategoryAttributeRow[] {
  return (rows ?? []).filter((row) => !row.is_variant_defining);
}
