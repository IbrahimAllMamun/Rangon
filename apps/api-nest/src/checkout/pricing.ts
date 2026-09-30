/**
 * `orders.services.pricing` and `core.money`: the one place totals are computed.
 *
 *     line_total     = round(unit_price * quantity) - line_discount
 *     subtotal       = sum(line_total)
 *     discount_total = coupon_discount + manual_discount
 *     taxable_base   = subtotal - discount_total
 *     EXCLUSIVE: tax = round(base * rate);             grand = base + tax + shipping
 *     INCLUSIVE: tax = round(base * rate / (1 + rate)); grand = base + shipping
 *
 * `round` is `core.money.quantize`: two places, half up. Every intermediate
 * step runs in Python's default decimal context (`Dec`: 28 digits, half even),
 * so a division lands on the digit Django's does before it is rounded.
 * Money stays a Decimal from the database to the response.
 */
import Decimal from 'decimal.js';

import { Dec } from '../common/decimal';
import { ValidationError } from '../common/errors';

export const ZERO = new Dec('0.00');

/** `quantize`: two decimal places, half up -- what a shopkeeper expects. */
export function quantize(value: Dec | string | number): Dec {
  return new Dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Python `str(Decimal)` of a quantized amount: always two places, and a
 * negative zero keeps its sign ("-0.00"), which decimal.js's `toFixed` drops.
 */
export function money(value: Dec): string {
  const text = value.toFixed(2);
  return value.isZero() && value.isNeg() && !text.startsWith('-') ? `-${text}` : text;
}

/** What pricing needs to know about a variant on a line. */
export interface PricedVariant {
  id: string;
  sku: string;
  price: string;
  cost: string;
  productId: string;
  productName: string;
  categoryId: string;
  /** The category's own VAT override, or null. */
  categoryTaxRate: string | null;
  /** `variant.label`, read only when a line's text is needed. */
  label: () => Promise<string>;
}

export interface PricedLine {
  variant: PricedVariant;
  quantity: number;
  unitPrice: Dec;
  unitCost: Dec;
  lineDiscount: Dec;
  taxAmount: Dec;
}

export function lineGross(line: PricedLine): Dec {
  return quantize(line.unitPrice.times(line.quantity));
}

export function lineTotal(line: PricedLine): Dec {
  return quantize(lineGross(line).minus(line.lineDiscount));
}

/** `quantize(sum(line.line_total for line in lines))`. */
export function subtotalOf(lines: PricedLine[]): Dec {
  return quantize(lines.reduce((sum, line) => sum.plus(lineTotal(line)), ZERO));
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotal: Dec;
  couponDiscount: Dec;
  manualDiscount: Dec;
  discountTotal: Dec;
  taxRate: Dec;
  taxTotal: Dec;
  taxMode: string;
  shippingTotal: Dec;
  grandTotal: Dec;
  couponId: string | null;
}

export function itemCount(order: PricedOrder): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * `resolve_unit_cost`: the branch's weighted average once the variant has
 * been received there; before that (average 0.00 by default, or no row) the
 * variant's own cost -- freezing a zero would book the sale at 100% margin.
 */
export function resolveUnitCost(variant: PricedVariant, averageCost: string | undefined): Dec {
  if (averageCost === undefined || new Dec(averageCost).lte(0)) return quantize(variant.cost);
  return quantize(averageCost);
}

/** `price_lines`: the unit price always from the database, never the client. */
export function priceLines(
  rawLines: [variant: PricedVariant, quantity: number, lineDiscount: Dec | null][],
  costs: Map<string, string> = new Map(),
): PricedLine[] {
  return rawLines.map(([variant, quantity, lineDiscount]) => {
    if (quantity <= 0) throw new ValidationError(`Quantity for ${variant.sku} must be at least 1.`);
    const discount = quantize(lineDiscount ?? ZERO);
    const gross = quantize(new Dec(variant.price).times(quantity));
    if (discount.gt(gross)) {
      throw new ValidationError(`Discount on ${variant.sku} exceeds the line value.`, {
        details: { sku: variant.sku, line_total: money(gross), discount: money(discount) },
      });
    }
    return {
      variant,
      quantity,
      unitPrice: quantize(variant.price),
      unitCost: resolveUnitCost(variant, costs.get(variant.id)),
      lineDiscount: discount,
      taxAmount: ZERO,
    };
  });
}

/**
 * `resolve_tax_rate`: a category override wins over the organisation default,
 * and a mixed basket takes the highest rate present -- the conservative choice.
 */
export function resolveTaxRate(lines: PricedLine[], organisationRate: string): Dec {
  const rates = lines
    .map((line) => line.variant.categoryTaxRate)
    .filter((rate): rate is string => rate !== null)
    .map((rate) => new Dec(rate));
  const fallback = new Dec(organisationRate);
  if (!rates.length) return fallback;
  // Python's `max()` answers the first of equal values.
  return [...rates, fallback].reduce((best, rate) => (rate.gt(best) ? rate : best));
}

/** `calculate`: every order-level figure once, in a fixed order. */
export function calculate(
  lines: PricedLine[],
  options: {
    couponDiscount?: Dec;
    manualDiscount?: Dec;
    shippingTotal?: Dec;
    taxRate?: Dec;
    taxMode?: string;
    couponId?: string | null;
    organisation: readonly [mode: string, rate: string];
  },
): PricedOrder {
  const subtotal = subtotalOf(lines);
  const couponDiscount = quantize(options.couponDiscount ?? ZERO);
  const manualDiscount = quantize(options.manualDiscount ?? ZERO);
  const discountTotal = quantize(couponDiscount.plus(manualDiscount));
  if (discountTotal.gt(subtotal)) {
    throw new ValidationError('The discount cannot exceed the order subtotal.', {
      details: { subtotal: money(subtotal), discount: money(discountTotal) },
    });
  }
  const taxableBase = quantize(subtotal.minus(discountTotal));

  const [organisationMode, organisationRate] = options.organisation;
  const mode = options.taxMode ?? organisationMode;
  const rate = options.taxRate ?? resolveTaxRate(lines, organisationRate);

  // INCLUSIVE: the base already contains the tax, so it is extracted, not added.
  const taxTotal =
    mode === 'INCLUSIVE'
      ? quantize(taxableBase.times(rate).div(new Dec(1).plus(rate)))
      : quantize(taxableBase.times(rate));

  // Spread across the lines for the receipt; rounding drift lands on the last.
  if (!taxTotal.isZero() && !taxableBase.isZero()) {
    let allocated = ZERO;
    lines.forEach((line, index) => {
      if (index === lines.length - 1) {
        line.taxAmount = quantize(taxTotal.minus(allocated));
      } else {
        const share = quantize(taxTotal.times(lineTotal(line).div(taxableBase)));
        line.taxAmount = share;
        allocated = allocated.plus(share);
      }
    });
  } else {
    for (const line of lines) line.taxAmount = ZERO;
  }

  const shippingTotal = quantize(options.shippingTotal ?? ZERO);
  // Shipping is never taxed; under INCLUSIVE adding the tax again would charge it twice.
  const grandTotal =
    mode === 'INCLUSIVE'
      ? quantize(taxableBase.plus(shippingTotal))
      : quantize(taxableBase.plus(taxTotal).plus(shippingTotal));

  return {
    lines,
    subtotal,
    couponDiscount,
    manualDiscount,
    discountTotal,
    taxRate: rate,
    taxTotal,
    taxMode: mode,
    shippingTotal,
    grandTotal,
    couponId: options.couponId ?? null,
  };
}
