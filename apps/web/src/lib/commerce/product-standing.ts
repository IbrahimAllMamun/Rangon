/**
 * Where a product stands, as one badge: draft, archived, counter only, or
 * published. Read from the pair `status` + `published` rather than
 * `published` alone -- an archived product can still carry `published`.
 * The products list and the homepage carousel both say it this way.
 */
export function standing(product: { status: string; published: boolean }): {
  label: string;
  tone: "success" | "info" | "warning" | "neutral";
  title: string;
} {
  if (product.status === "DRAFT") {
    return {
      label: "Draft",
      tone: "warning",
      title: "Not on the storefront and not at the counter. Publish it to start selling.",
    };
  }
  if (product.status === "ARCHIVED") {
    return { label: "Archived", tone: "neutral", title: "Retired. Kept so history resolves." };
  }
  if (!product.published) {
    return {
      label: "Counter only",
      tone: "info",
      title: "Sells at the POS, hidden from the storefront.",
    };
  }
  return { label: "Published", tone: "success", title: "Live on the storefront and at the counter." };
}
