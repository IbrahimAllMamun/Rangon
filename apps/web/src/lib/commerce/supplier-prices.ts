/**
 * What one supplier charges, as opposed to what anyone last charged.
 *
 * The purchase order form used to default every line's unit cost to the
 * variant's `cost` column — the last price paid to *any* supplier, because
 * receiving overwrites it whoever delivered. Ordering from the cheaper of two
 * vendors therefore pre-filled the dearer one's price, and a buyer who took the
 * default was quoting the wrong figure back at them.
 *
 * `/supplier-products/` answers per supplier. One request when the supplier is
 * chosen builds the map below; nothing else on the form needs to know.
 */
import { type Paginated, apiClient } from "@/lib/api/client";

export interface SupplierOffer {
  variant: string;
  last_cost: string;
  supplier_sku: string;
  minimum_order_quantity: number;
  is_preferred: boolean;
  last_purchased_at: string | null;
}

/** variant id -> what this supplier charges for it. */
export type OfferMap = ReadonlyMap<string, SupplierOffer>;

export const EMPTY_OFFERS: OfferMap = new Map();

/**
 * Where a line's unit cost came from, so the form can say so.
 *
 * `catalogue` is the honest label for the old behaviour: it is the last price
 * paid to somebody, and possibly not this supplier. Saying which is what stops
 * a buyer trusting a number that was never quoted to them.
 */
export type CostSource = "supplier" | "catalogue";

export interface ResolvedCost {
  cost: string;
  source: CostSource;
  offer: SupplierOffer | null;
}

/**
 * The cost to put in the box, and why.
 *
 * Falls back to the variant's own cost rather than to zero: a first order from
 * a new supplier still needs a starting figure, and the catalogue's is the best
 * guess available. It is labelled, not disguised.
 */
export function resolveCost(offers: OfferMap, variantId: string, catalogueCost: string): ResolvedCost {
  const offer = offers.get(variantId) ?? null;
  if (offer) return { cost: offer.last_cost, source: "supplier", offer };
  return { cost: catalogueCost, source: "catalogue", offer: null };
}

/**
 * Below the supplier's minimum, or null when it is fine.
 *
 * Advisory on purpose (docs/business-rules.md § 7a): suppliers flex, and
 * refusing the order outright would be a rule nobody stated. The buyer is told
 * and decides.
 */
export function minimumOrderWarning(
  offer: SupplierOffer | null,
  quantity: string,
): string | null {
  if (!offer || offer.minimum_order_quantity <= 1) return null;
  const wanted = Number(quantity);
  if (!Number.isFinite(wanted) || wanted <= 0) return null;
  if (wanted >= offer.minimum_order_quantity) return null;
  return `This supplier's minimum is ${offer.minimum_order_quantity}.`;
}

/** Fetch one supplier's whole price list. One request, built into a map. */
export async function fetchSupplierOffers(supplierId: string): Promise<OfferMap> {
  const page = await apiClient<Paginated<SupplierOffer>>(
    `/supplier-products/?supplier=${encodeURIComponent(supplierId)}&is_active=true&page_size=500`,
  );
  return new Map(page.results.map((offer) => [offer.variant, offer]));
}
