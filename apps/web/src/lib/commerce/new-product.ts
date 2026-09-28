/**
 * Creating a product from inside the purchase order form.
 *
 * A buyer who is ordering something the catalogue has never carried used to hit
 * a dead end: the variant picker said "Nothing matches — create the product
 * first", and creating it meant leaving the half-filled order, going to
 * Products, building the product, and coming back. The order was the reason the
 * product existed, so the order is where it should be possible to make one.
 *
 * Two rules shape what this collects.
 *
 *  1. **No stock, ever.** Goods arrive by receiving the order being raised;
 *     that is what carries the cost paid into the ledger (business-rules.md
 *     § 4.0a). The drawer captures what the product *is*, not what is on hand.
 *  2. **Cost is required, retail price is not.** At the moment of ordering a
 *     buyer knows what they are paying and often not yet what they will charge.
 *     Demanding a retail price here would get a made-up one. The product is
 *     created unpublished, and `publish` refuses a product with nothing priced
 *     above zero (D75), so an unpriced draft cannot reach the storefront by
 *     accident.
 *
 * A product comes in versions — sizes, colours, every combination a SKU — or
 * in **one version only** (`single`): a lipstick in one shade, a one-size bag.
 * The second used to be impossible here and on the full product form alike,
 * because `generate_variants` needs at least one value; the API now builds a
 * single SKU on request (business-rules.md § 7a.6).
 */
import { type MatrixAttribute, matrixSize, MAX_MATRIX_ROWS } from "@/lib/commerce/variant-matrix";

export interface NewProductDraft {
  name: string;
  categoryId: string;
  brandId: string;
  /** attribute code -> ticked values. Ignored when `single`. */
  selections: Record<string, string[]>;
  /** One SKU, no sizes or colours. */
  single: boolean;
  cost: string;
  price: string;
}

export interface DraftProblem {
  field: string;
  message: string;
}

export function blankDraft(name = ""): NewProductDraft {
  return {
    name,
    categoryId: "",
    brandId: "",
    selections: {},
    single: false,
    cost: "",
    price: "",
  };
}

/** Whether a string is a usable money amount: present, numeric, not negative. */
function isMoney(value: string): boolean {
  if (value.trim() === "") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

export function validateDraft(draft: NewProductDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];

  if (!draft.name.trim()) {
    problems.push({ field: "name", message: "A product name is required." });
  }
  if (!draft.categoryId) {
    problems.push({ field: "category", message: "Choose a category — it decides the axes below." });
  }

  const rows = draft.single ? 1 : matrixSize(draft.selections);
  if (rows === 0) {
    problems.push({
      field: "selections",
      message: "Tick at least one value, or choose “One version only” for a single SKU.",
    });
  } else if (rows > MAX_MATRIX_ROWS) {
    problems.push({
      field: "selections",
      message: `That selection asks for ${rows} variants. Narrow it to ${MAX_MATRIX_ROWS} or fewer.`,
    });
  }

  // Cost is what the order is about, so it is the one number that must be real.
  if (!isMoney(draft.cost)) {
    problems.push({ field: "cost", message: "Enter what this supplier charges, per unit." });
  }
  // Price may be blank; a number that is present must still make sense.
  if (draft.price.trim() !== "" && !isMoney(draft.price)) {
    problems.push({ field: "price", message: "A retail price must be zero or more, or left blank." });
  }

  return problems;
}

/**
 * The `POST /products/` body.
 *
 * `status: "DRAFT"` and no `published` flag: goods that are on order are not
 * sellable, and nothing here has a photograph, a description or a price yet.
 * Receiving is what prompts publishing.
 */
export function toProductPayload(draft: NewProductDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    category: draft.categoryId,
    brand: draft.brandId || null,
    status: "DRAFT",
  };
}

/** The `POST /products/{id}/generate-variants/` body. */
export function toVariantsPayload(draft: NewProductDraft): Record<string, unknown> {
  // The endpoint requires a price. Blank means "not decided", which is 0 on an
  // unpublishable draft rather than a guess that would look authoritative.
  const price = draft.price.trim() === "" ? "0.00" : draft.price;
  if (draft.single) return { single: true, price, cost: draft.cost };
  return {
    selections: Object.fromEntries(
      Object.entries(draft.selections).filter(([, values]) => values.length > 0),
    ),
    price,
    cost: draft.cost,
  };
}

/** How many SKUs submitting this draft would create. */
export function skuCount(draft: NewProductDraft): number {
  return draft.single ? 1 : matrixSize(draft.selections);
}

/**
 * An existing category with this name, so typing one that exists picks it
 * rather than creating a second with the same slug.
 */
export function findCategory<T extends { name: string }>(
  categories: readonly T[],
  name: string,
): T | undefined {
  const wanted = name.trim().toLocaleLowerCase();
  return categories.find((category) => category.name.trim().toLocaleLowerCase() === wanted);
}

/** Axes to offer: what the category declares, else everything usable. */
export function axesFor(
  all: MatrixAttribute[],
  declared: readonly string[],
): MatrixAttribute[] {
  const usable = all.filter((attribute) => attribute.values.length > 0);
  if (declared.length === 0) return usable;
  const keep = new Set(declared);
  return usable.filter((attribute) => keep.has(attribute.code));
}
