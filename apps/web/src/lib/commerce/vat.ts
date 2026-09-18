/**
 * What a shop price says about VAT.
 *
 * Under the EXCLUSIVE treatment the catalogue price is not what the shopper
 * pays: the tax goes on at checkout, so a product page quoting a bare
 * `৳ 1,290` promises a total that never arrives. Under INCLUSIVE the price on
 * the label *is* the price, which is worth saying out loud rather than leaving
 * the shopper to wonder.
 *
 * At a zero rate there is nothing to say, and the note disappears — the same
 * rule the memo follows (`memo.ts`): say nothing about VAT where none was
 * charged. That is the state the platform ships in, so most shops will see no
 * note at all until the owner settles the rate.
 *
 * The rate comes from the product's own payload rather than from an
 * organisation-wide setting, because a category can override it
 * (docs/business-rules.md §3.4) and the note has to be true of the price it
 * sits beside.
 */

export interface TaxTreatment {
  /** "EXCLUSIVE" — added at checkout — or "INCLUSIVE" — already in the price. */
  mode: string;
  /** A fraction, as the API stores it: "0.1500" is 15%. */
  rate: string;
}

/** "0.1500" -> 15, "0.0750" -> 7.5, anything unparseable -> 0. */
export function vatRatePercent(rate: string | number | null | undefined): number {
  const value = typeof rate === "string" ? Number.parseFloat(rate) : (rate ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Four decimal places on the column means at most two once it is a
  // percentage, and `15` should never render as `15.00%`.
  return Math.round(value * 10000) / 100;
}

/**
 * The line to put beside a price, or `null` when VAT has nothing to say.
 *
 * Deliberately short: it sits next to the number on a card as well as on the
 * product page, and a sentence there would compete with the price itself.
 */
export function vatNote(tax: TaxTreatment | null | undefined): string | null {
  if (!tax) return null;
  const percent = vatRatePercent(tax.rate);
  if (percent === 0) return null;
  return tax.mode === "INCLUSIVE" ? `incl. ${percent}% VAT` : `+ ${percent}% VAT`;
}
