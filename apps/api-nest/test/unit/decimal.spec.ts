import { dropPercent, VariantRow } from '../../src/catalog/product-payload.service';
import { Dec, maxDecimal, minDecimal, pyRound } from '../../src/common/decimal';

const variant = (price: string, compareAtPrice: string | null, status = 'ACTIVE'): VariantRow => ({
  id: price,
  productId: 'p',
  sku: price,
  name: '',
  price,
  compareAtPrice,
  status,
  links: [],
});

describe("money with Python's decimal context", () => {
  it('round() ties to even', () => {
    expect(pyRound(new Dec('2.5'))).toBe(2);
    expect(pyRound(new Dec('3.5'))).toBe(4);
    expect(pyRound(new Dec('-2.5'))).toBe(-2);
  });

  it('min/max answer the original text', () => {
    expect(minDecimal(['1290.00', '990.00', '990.0'])).toBe('990.00');
    expect(maxDecimal(['1290.00', '1290'])).toBe('1290.00');
  });

  it('drop_percent: deepest real reduction, inactive variants included, zero and below-price ignored', () => {
    expect(
      dropPercent([
        variant('1200.00', '1500.00'),
        variant('1000.00', '3000.00', 'ARCHIVED'),
        variant('1100.00', '0.00'),
        variant('1300.00', '1250.00'),
      ]),
    ).toBe(67);
    expect(dropPercent([variant('100.00', null)])).toBe(0);
  });
});
