import { Dec } from '../../src/common/decimal';
import { exchangeSettlement } from '../../src/pos/pos-exchanges.service';

/**
 * What an exchange settles to (business rules 2.6): the returned goods' worth
 * pays for the new sale up to its total, and the rest is paid or given back.
 */
const settle = (credit: string, total: string) => {
  const s = exchangeSettlement(new Dec(credit), new Dec(total));
  return {
    applied: s.applied.toFixed(2),
    toPay: s.toPay.toFixed(2),
    toGiveBack: s.toGiveBack.toFixed(2),
  };
};

describe('an exchange settles', () => {
  it('dearer goods: the credit is spent and the customer pays the difference', () => {
    expect(settle('886.93', '2790.00')).toEqual({
      applied: '886.93',
      toPay: '1903.07',
      toGiveBack: '0.00',
    });
  });

  it('cheaper goods: the sale is paid for and the rest is given back', () => {
    expect(settle('886.93', '450.00')).toEqual({
      applied: '450.00',
      toPay: '0.00',
      toGiveBack: '436.93',
    });
  });

  it('the same worth: nothing changes hands', () => {
    expect(settle('890.00', '890.00')).toEqual({
      applied: '890.00',
      toPay: '0.00',
      toGiveBack: '0.00',
    });
  });

  it('goods worth nothing (already refunded): the new sale is paid in full', () => {
    expect(settle('0.00', '720.00')).toEqual({
      applied: '0.00',
      toPay: '720.00',
      toGiveBack: '0.00',
    });
  });
});
