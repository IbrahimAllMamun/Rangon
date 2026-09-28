/**
 * The variant matrix behind the admin product form.
 *
 * A product is described by the attribute *values* it comes in — "Black, White"
 * × "S, M, L" — and the sellable rows are the cartesian product of those picks.
 * Keeping the maths here rather than in the component means it can be tested
 * without a DOM, which matters because the interesting rule is not the product
 * itself but what happens when someone un-ticks a value.
 *
 * The rule: **un-ticking never destroys a row someone has invested in.** A row
 * with a saved id keeps existing; it is marked `unselected` and shown in amber
 * so it can be dealt with deliberately. Deletion is always an explicit act,
 * never a side effect of editing a checkbox — the row may carry stock, a price
 * override, or sales history the ledger still references.
 */

export interface MatrixAttribute {
  /** The attribute's id, when known — needed to add a value to it inline. */
  id?: string;
  code: string;
  name: string;
  kind: string;
  values: { value: string; label: string; swatch: string }[];
}

/** A variant as the API returns it on `GET /products/{id}/`. */
export interface ExistingVariant {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price: string;
  compare_at_price: string | null;
  cost: string;
  status: string;
  attributes: {
    attribute_code: string;
    attribute_name: string;
    value: string;
    label: string;
    swatch: string;
  }[];
  stock: {
    on_hand: number;
    reserved: number;
    available: number;
    /** False when the branch has never received it: Adjust may lower, not raise. */
    received?: boolean;
  } | null;
}

export type RowState =
  /** Ticked, and already saved. */
  | "existing"
  /** Ticked, not saved yet — `generate-variants` will create it. */
  | "new"
  /** Saved, but its values are no longer ticked. Kept, flagged, never auto-deleted. */
  | "unselected";

export interface MatrixRow {
  /** Stable across re-renders and independent of attribute order. */
  key: string;
  /** attribute code -> value */
  combination: Record<string, string>;
  /** attribute code -> human label for that value */
  labels: Record<string, string>;
  existing: ExistingVariant | null;
  state: RowState;
}

/**
 * Guard against a mis-click generating thousands of SKUs. 5 attributes with 4
 * values each is already 1,024 rows; nobody means that.
 */
export const MAX_MATRIX_ROWS = 250;

/** Order-independent identity for a combination of attribute values. */
export function combinationKey(combination: Record<string, string>): string {
  return Object.keys(combination)
    .sort()
    .map((code) => `${code}=${combination[code]}`)
    .join("|");
}

/**
 * Identity of a saved variant: its *whole* set of attribute values.
 *
 * This is deliberately the same test `catalog.services.generate_variants` uses
 * server-side (a frozenset of every linked value). Matching on a subset would
 * let two saved rows collapse onto one matrix row — one of them would simply
 * disappear from the table — and would disagree with what the API considers
 * "already exists" when the form saves.
 */
function variantKey(variant: ExistingVariant): string {
  const combination: Record<string, string> = {};
  for (const attribute of variant.attributes) {
    combination[attribute.attribute_code] = attribute.value;
  }
  return combinationKey(combination);
}

/** How many rows `buildMatrix` would produce for these picks, before capping. */
export function matrixSize(selections: Record<string, string[]>): number {
  const groups = Object.values(selections).filter((values) => values.length > 0);
  return groups.reduce((total, values) => total * values.length, groups.length ? 1 : 0);
}

/**
 * Whether this product is sold in one version only: a live SKU with no options.
 *
 * The CSV import has always made these, and since business-rules.md § 7a.6 the
 * purchase order and this form can too. `generate_variants` refuses to give
 * such a product sizes or colours until that SKU is archived.
 */
export function hasSingleVersion(existing: ExistingVariant[]): boolean {
  const live = existing.filter((variant) => variant.status !== "ARCHIVED");
  return live.length > 0 && live.every((variant) => variant.attributes.length === 0);
}

/** Whether any live SKU has sizes or colours — then it cannot become one version. */
export function hasOptions(existing: ExistingVariant[]): boolean {
  return existing.some(
    (variant) => variant.status !== "ARCHIVED" && variant.attributes.length > 0,
  );
}

/**
 * The rows to render: every ticked combination, plus every saved variant whose
 * combination is no longer ticked.
 *
 * `single` asks for the one row with no options — the empty combination, whose
 * key is the same `""` a saved optionless variant has, so the saved one is
 * matched rather than shown as "not selected".
 */
export function buildMatrix(
  selections: Record<string, string[]>,
  attributes: MatrixAttribute[],
  existing: ExistingVariant[],
  single = false,
): MatrixRow[] {
  const codes = single
    ? []
    : Object.keys(selections).filter((code) => selections[code].length > 0);
  const byCode = new Map(attributes.map((attribute) => [attribute.code, attribute]));

  const labelFor = (code: string, value: string) =>
    byCode.get(code)?.values.find((option) => option.value === value)?.label ?? value;

  // Cartesian product, built iteratively so the row order is stable: the first
  // attribute varies slowest, which is what a human reading the table expects.
  let combinations: Record<string, string>[] = codes.length || single ? [{}] : [];
  for (const code of codes) {
    const next: Record<string, string>[] = [];
    for (const partial of combinations) {
      for (const value of selections[code]) {
        next.push({ ...partial, [code]: value });
      }
    }
    combinations = next;
    if (combinations.length > MAX_MATRIX_ROWS) {
      combinations = combinations.slice(0, MAX_MATRIX_ROWS);
      break;
    }
  }

  const savedByKey = new Map(existing.map((variant) => [variantKey(variant), variant]));
  const used = new Set<string>();

  const rows: MatrixRow[] = combinations.map((combination) => {
    const key = combinationKey(combination);
    const saved = savedByKey.get(key) ?? null;
    if (saved) used.add(saved.id);

    const labels: Record<string, string> = {};
    for (const [code, value] of Object.entries(combination)) {
      labels[code] = labelFor(code, value);
    }
    return { key, combination, labels, existing: saved, state: saved ? "existing" : "new" };
  });

  // Saved rows that fell outside the ticked set. They are appended rather than
  // dropped: the row may hold stock, a price the shop has advertised, or sales
  // the ledger still points at.
  for (const variant of existing) {
    if (used.has(variant.id)) continue;

    const combination: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (const attribute of variant.attributes) {
      combination[attribute.attribute_code] = attribute.value;
      labels[attribute.attribute_code] = attribute.label;
    }
    rows.push({ key: `saved:${variant.id}`, combination, labels, existing: variant, state: "unselected" });
  }

  return rows;
}

/**
 * The `selections` payload `POST /products/{id}/generate-variants/` expects,
 * limited to combinations that do not exist yet.
 *
 * The service skips combinations it already has, so sending everything would
 * also be correct — but sending nothing when there is nothing to create lets
 * the caller skip the request entirely.
 */
export function pendingSelections(rows: MatrixRow[]): Record<string, string[]> {
  const selections: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.state !== "new") continue;
    for (const [code, value] of Object.entries(row.combination)) {
      const values = (selections[code] ??= []);
      if (!values.includes(value)) values.push(value);
    }
  }
  return selections;
}

/** Values to tick when an existing product is opened for editing. */
export function selectionsFromVariants(existing: ExistingVariant[]): Record<string, string[]> {
  const selections: Record<string, string[]> = {};
  for (const variant of existing) {
    for (const attribute of variant.attributes) {
      const values = (selections[attribute.attribute_code] ??= []);
      if (!values.includes(attribute.value)) values.push(attribute.value);
    }
  }
  return selections;
}
