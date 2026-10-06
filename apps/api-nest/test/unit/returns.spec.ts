import { money } from '../../src/checkout/pricing';
import { returnShares } from '../../src/orders/returns.service';

/**
 * What a return gives back for each line: `_line_paid` and the rounding in
 * `orders.services.returns.request_return`. The expected figures were printed
 * by the Django code itself, in the parity stack.
 */
describe('returnShares', () => {
  const tee = { line_total: '890.00', tax_amount: '0.00', quantity: 1, returning: 1 };
  const shares = (
    order: [subtotal: string, discount: string, mode: string],
    lines: [lineTotal: string, tax: string, bought: number, returning: number][],
  ) => {
    const split = returnShares(
      { subtotal: order[0], discount_total: order[1], tax_mode: order[2] },
      lines.map(([line_total, tax_amount, quantity, returning]) => ({
        line_total,
        tax_amount,
        quantity,
        returning,
      })),
    );
    return [money(split.total), ...split.shares.map(money)];
  };

  it('rounds once for the request, and the last line carries the odd paisa', () => {
    const split = returnShares(
      { subtotal: '2670.00', discount_total: '20.00', tax_mode: 'EXCLUSIVE' },
      [tee, tee, tee],
    );
    expect(money(split.total)).toBe('2650.00');
    expect(split.shares.map(money)).toEqual(['883.33', '883.33', '883.34']);
    expect(
      shares(
        ['2670.00', '20.00', 'EXCLUSIVE'],
        [
          ['890.00', '0.00', 1, 1],
          ['890.00', '0.00', 1, 1],
        ],
      ),
    ).toEqual(['1766.67', '883.33', '883.34']);
  });

  it('adds the VAT that sat on top of a line, and leaves alone the VAT inside it', () => {
    const lines: [string, string, number, number][] = [
      ['4900.00', '150.00', 2, 1],
      ['890.00', '150.00', 1, 1],
    ];
    expect(shares(['5790.00', '33.33', 'EXCLUSIVE'], lines)).toEqual([
      '3545.77',
      '2510.90',
      '1034.87',
    ]);
    expect(shares(['5790.00', '33.33', 'INCLUSIVE'], lines)).toEqual([
      '3320.77',
      '2435.90',
      '884.87',
    ]);
  });

  it('gives back some of a line for some of its units', () => {
    expect(
      shares(
        ['300.00', '100.00', 'INCLUSIVE'],
        [
          ['100.00', '0.00', 3, 1],
          ['100.00', '0.00', 3, 2],
          ['100.00', '0.00', 7, 3],
        ],
      ),
    ).toEqual(['95.24', '22.22', '44.44', '28.58']);
  });

  it('takes no discount off an order whose subtotal is nothing', () => {
    expect(shares(['0.00', '20.00', 'EXCLUSIVE'], [['4900.00', '0.00', 2, 2]])).toEqual([
      '4900.00',
      '4900.00',
    ]);
  });

  it('gives back nothing for a sale discounted to nothing', () => {
    expect(shares(['1000.00', '1000.00', 'EXCLUSIVE'], [['1000.00', '0.00', 3, 1]])).toEqual([
      '0.00',
      '0.00',
    ]);
  });

  it('lets the last line fall below its own share', () => {
    expect(
      shares(
        ['0.03', '0.01', 'INCLUSIVE'],
        [
          ['0.01', '0.00', 1, 1],
          ['0.01', '0.00', 1, 1],
          ['0.01', '0.00', 1, 1],
        ],
      ),
    ).toEqual(['0.02', '0.01', '0.01', '0.00']);
  });
});
