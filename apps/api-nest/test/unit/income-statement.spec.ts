import { Dec } from '../../src/common/decimal';
import { incomeStatement, type StatementSums } from '../../src/reports/reports.service';

/**
 * The statement's arithmetic (business rules §4.1), on the example the rule is
 * written around: a tee sold for ৳1,150 with ৳150 VAT inside it, which cost
 * ৳600, sold and then returned.
 */
const NOTHING: StatementSums = {
  sold: new Dec('0.00'),
  cogs: new Dec('0.00'),
  returns: new Dec('0.00'),
  returnedVat: new Dec('0.00'),
  cogsReturned: new Dec('0.00'),
  writtenOff: new Dec('0.00'),
  refunds: new Dec('0.00'),
  shippingRefunded: new Dec('0.00'),
  refundsWithoutReturn: new Dec('0.00'),
};
const sums = (given: Partial<Record<keyof StatementSums, string>>): StatementSums => ({
  ...NOTHING,
  ...Object.fromEntries(Object.entries(given).map(([key, value]) => [key, new Dec(value)])),
});
const text = (value: Dec) => value.toFixed(2);

describe('the income statement', () => {
  it('a sale alone: revenue without its VAT, less what the goods cost', () => {
    const day = incomeStatement(sums({ sold: '1000.00', cogs: '600.00' }));
    expect(text(day.grossProfit)).toBe('400.00');
    expect(text(day.returnLosses)).toBe('0.00');
  });

  it('a return on a later day takes back exactly what the sale made, not its VAT too', () => {
    const later = incomeStatement(
      sums({
        returns: '1000.00',
        returnedVat: '150.00',
        cogsReturned: '600.00',
        refunds: '1150.00',
      }),
    );
    expect(text(later.netRevenue)).toBe('-1000.00');
    expect(text(later.grossProfit)).toBe('-400.00');
    expect(text(later.refundAdjustments)).toBe('0.00');
    expect(text(later.returnLosses)).toBe('0.00');
  });

  it('sold and returned in one period: nothing made, nothing lost', () => {
    const period = incomeStatement(
      sums({
        sold: '1000.00',
        cogs: '600.00',
        returns: '1000.00',
        returnedVat: '150.00',
        cogsReturned: '600.00',
        refunds: '1150.00',
      }),
    );
    expect(text(period.grossProfit)).toBe('0.00');
    expect(text(period.returnLosses)).toBe('0.00');
  });

  it('a damaged return: gross profit untouched, the goods lost below it', () => {
    const period = incomeStatement(
      sums({
        sold: '1000.00',
        cogs: '600.00',
        returns: '1000.00',
        returnedVat: '150.00',
        cogsReturned: '600.00',
        writtenOff: '600.00',
        refunds: '1150.00',
      }),
    );
    expect(text(period.grossProfit)).toBe('0.00');
    expect(text(period.returnLosses)).toBe('600.00');
  });

  it('shipping paid back is its own loss, never taken off sales', () => {
    const period = incomeStatement(
      sums({
        returns: '1000.00',
        returnedVat: '150.00',
        cogsReturned: '600.00',
        refunds: '1210.00',
        shippingRefunded: '60.00',
      }),
    );
    expect(text(period.netRevenue)).toBe('-1000.00');
    expect(text(period.refundAdjustments)).toBe('0.00');
    expect(text(period.returnLosses)).toBe('60.00');
  });

  it('a refund typed above or below the goods is an adjustment, either way', () => {
    const over = incomeStatement(
      sums({ returns: '1000.00', returnedVat: '150.00', refunds: '1200.00' }),
    );
    expect(text(over.refundAdjustments)).toBe('50.00');
    const under = incomeStatement(
      sums({ returns: '1000.00', returnedVat: '150.00', refunds: '1100.00' }),
    );
    expect(text(under.refundAdjustments)).toBe('-50.00');
    expect(text(under.returnLosses)).toBe('-50.00');
  });

  it('money given back with no goods behind it is a loss in full', () => {
    const period = incomeStatement(
      sums({ sold: '1000.00', cogs: '600.00', refundsWithoutReturn: '200.00' }),
    );
    expect(text(period.grossProfit)).toBe('400.00');
    expect(text(period.returnLosses)).toBe('200.00');
  });
});
