/**
 * `orders.services.pricing` against Django's own answers: each expected value
 * was printed by `pricing.price_lines` + `pricing.calculate` in the Django
 * API's container, with the same lines.
 */
import { Dec } from '../../src/common/decimal';
import {
  calculate,
  money,
  priceLines,
  PricedVariant,
  resolveTaxRate,
} from '../../src/checkout/pricing';

function variant(price: string, categoryTaxRate: string | null = null, sku = 'S'): PricedVariant {
  return {
    id: sku,
    sku,
    price,
    cost: '1.00',
    productId: 'p',
    productName: 'P',
    categoryId: 'c',
    categoryTaxRate,
    label: async () => '',
  };
}

type Raw = [price: string, quantity: number, categoryRate?: string];

function price(raw: Raw[], coupon: string, mode: string, rate: string, shipping: string) {
  const lines = priceLines(raw.map(([p, q, r], i) => [variant(p, r ?? null, `S${i}`), q, null]));
  const taxRate = resolveTaxRate(lines, rate);
  const order = calculate(lines, {
    couponDiscount: new Dec(coupon),
    shippingTotal: new Dec(shipping),
    taxRate,
    taxMode: mode,
    organisation: [mode, rate],
  });
  return {
    totals: [order.subtotal, order.discountTotal, order.taxTotal, order.grandTotal].map(money),
    lineTax: lines.map((line) => money(line.taxAmount)),
    rate: taxRate.toString(),
  };
}

describe('pricing', () => {
  it('spreads exclusive VAT over lines, the drift on the last', () => {
    expect(
      price(
        [
          ['333.33', 1],
          ['0.10', 3],
          ['1999.99', 2],
        ],
        '0',
        'EXCLUSIVE',
        '0.15',
        '0',
      ),
    ).toEqual({
      totals: ['4333.61', '0.00', '650.04', '4983.65'],
      lineTax: ['50.00', '0.04', '600.00'],
      rate: '0.15',
    });
  });

  it('extracts inclusive VAT from the discounted base', () => {
    expect(
      price(
        [
          ['2450.00', 1],
          ['2450.00', 1],
        ],
        '490.00',
        'INCLUSIVE',
        '0.0733',
        '0',
      ),
    ).toEqual({
      totals: ['4900.00', '490.00', '301.18', '4410.00'],
      lineTax: ['150.59', '150.59'],
      rate: '0.0733',
    });
  });

  it('rounds half-cents up, and never taxes shipping', () => {
    expect(
      price(
        [
          ['0.05', 1],
          ['0.05', 1],
          ['0.05', 1],
        ],
        '0',
        'EXCLUSIVE',
        '0.10',
        '60',
      ),
    ).toEqual({
      totals: ['0.15', '0.00', '0.02', '60.17'],
      lineTax: ['0.01', '0.01', '0.00'],
      rate: '0.1',
    });
  });

  it("takes a category's own rate over the organisation's, the highest present", () => {
    expect(
      price(
        [
          ['100.00', 1, '0.2'],
          ['100.00', 1],
        ],
        '0',
        'EXCLUSIVE',
        '0.05',
        '0',
      ),
    ).toEqual({
      totals: ['200.00', '0.00', '40.00', '240.00'],
      lineTax: ['20.00', '20.00'],
      rate: '0.2',
    });
  });

  it('refuses a discount larger than the subtotal', () => {
    const lines = priceLines([[variant('10.00'), 1, null]]);
    expect(() =>
      calculate(lines, { couponDiscount: new Dec('10.01'), organisation: ['EXCLUSIVE', '0'] }),
    ).toThrow('The discount cannot exceed the order subtotal.');
  });
});
