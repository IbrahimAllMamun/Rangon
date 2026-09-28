/**
 * What the register sends to be priced (`POST /pos/quote/`) and to be sold
 * (`POST /pos/sales/`).
 *
 * One builder for both, so the total the cashier reads out and the sale that
 * gets recorded are always asked for the same way. Nothing here computes a
 * figure: a coupon code and a percentage go to the server as they were typed,
 * and the server says what they come to (docs/business-rules.md §3.3).
 */
import type { PaymentMethod, PosQuote, PosQuoteIssue } from "@/lib/api/types";
import type { DiscountMode, PosApprovalState, PosLine } from "@/lib/store/pos";

/** The part of the register's state that decides the price. */
export interface BasketState {
  lines: PosLine[];
  customerId: string | null;
  orderDiscount: number;
  orderDiscountMode: DiscountMode;
  couponCode: string;
  approval: PosApprovalState | null;
}

export interface BasketRequest {
  lines: { variant: string; quantity: number; line_discount: string }[];
  customer: string | null;
  manual_discount: string;
  manual_discount_percent: string | null;
  coupon_code: string;
  approval_token: string;
}

export interface TenderRequest {
  method: PaymentMethod;
  amount: string;
  tendered_amount?: string;
  reference: string;
  account: string | null;
}

export interface SaleRequest extends BasketRequest {
  payments: TenderRequest[];
  register: string;
  note: string;
  /** The total the register showed; the server refuses a sale that would record another. */
  expected_total: string;
}

/** The body of a quote, or null when there is nothing to price. */
export function basketRequest(state: BasketState): BasketRequest | null {
  if (!state.lines.length) return null;
  const discount = Number.isFinite(state.orderDiscount) ? Math.max(0, state.orderDiscount) : 0;
  const percent = state.orderDiscountMode === "PERCENT";
  return {
    lines: state.lines.map((line) => ({
      variant: line.variantId,
      quantity: line.quantity,
      line_discount: line.discount.toFixed(2),
    })),
    customer: state.customerId,
    // One or the other, never both: the server refuses the pair.
    manual_discount: percent ? "0.00" : discount.toFixed(2),
    manual_discount_percent: percent && discount > 0 ? discount.toFixed(2) : null,
    coupon_code: state.couponCode.trim(),
    approval_token: state.approval?.token ?? "",
  };
}

/** A stable key for a basket: two equal baskets are one quote. */
export function basketKey(request: BasketRequest | null): string {
  return request ? JSON.stringify(request) : "";
}

/** The sale is the quote the cashier accepted, plus how it was paid. */
export function saleRequest(
  basket: BasketRequest,
  sale: { payments: TenderRequest[]; register: string; note: string; expectedTotal: string },
): SaleRequest {
  return {
    ...basket,
    payments: sale.payments,
    register: sale.register,
    note: sale.note,
    expected_total: sale.expectedTotal,
  };
}

/** The figures in the register's totals panel. */
export interface ShownTotals {
  subtotal: number;
  couponCode: string;
  couponOff: number;
  manualOff: number;
  taxTotal: number;
  taxInclusive: boolean;
  total: number;
  /** The server's answer for the basket on screen, not a stand-in. */
  settled: boolean;
}

function fromQuote(quote: PosQuote, settled: boolean): ShownTotals {
  return {
    subtotal: Number(quote.subtotal),
    couponCode: quote.coupon?.code ?? "",
    couponOff: Number(quote.coupon_discount),
    manualOff: Number(quote.manual_discount),
    taxTotal: Number(quote.tax_total),
    taxInclusive: quote.tax_mode === "INCLUSIVE",
    total: Number(quote.grand_total),
    settled,
  };
}

/**
 * What the totals panel shows while the server's answer may be on its way.
 *
 * The answer for this basket, whenever there is one. Until it lands, a basket
 * with nothing that changes the price -- no coupon, no discount, no VAT last
 * time -- is shown at shelf price, which is exactly what the server will say,
 * so the usual scan updates the total at once. A basket with a coupon or a
 * discount keeps the last answer instead: a figure that ignored them would
 * jump up and back down on every scan.
 */
export function shownTotals(
  state: BasketState,
  quote: PosQuote | null,
  current: boolean,
): ShownTotals {
  if (quote && current) return fromQuote(quote, true);

  const discounted =
    Boolean(state.couponCode.trim()) ||
    state.orderDiscount > 0 ||
    state.lines.some((line) => line.discount > 0);
  const taxed = Boolean(quote && Number(quote.tax_total) > 0);
  if (quote && (discounted || taxed)) return fromQuote(quote, false);

  const subtotal = state.lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity - line.discount,
    0,
  );
  return {
    subtotal,
    couponCode: "",
    couponOff: 0,
    manualOff: 0,
    taxTotal: 0,
    taxInclusive: false,
    total: subtotal,
    settled: false,
  };
}

/** A discount that a manager's approval would let through. */
export function approvalIssue(quote: PosQuote | null | undefined): PosQuoteIssue | undefined {
  return quote?.issues.find((issue) => issue.field === "discount" && Boolean(issue.details.requires));
}

export function issueFor(
  quote: PosQuote | null | undefined,
  field: PosQuoteIssue["field"],
): PosQuoteIssue | undefined {
  return quote?.issues.find((issue) => issue.field === field);
}

/** "Discount (10%)" when the cashier gave a percentage; the amount itself is the server's. */
export function discountLabel(mode: DiscountMode, value: number): string {
  if (mode === "PERCENT" && value > 0) {
    return `Discount (${Number(value.toFixed(2))}%)`;
  }
  return "Discount";
}
