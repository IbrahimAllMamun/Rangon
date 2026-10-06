import { Invalid } from '../../src/common/drf';
import { cleanChannels } from '../../src/promotions/coupons-admin.service';

/**
 * The back office's coupons. Every expected value was printed by Django
 * itself (`CouponSerializer().validate_channels`), in the parity stack.
 */
describe('cleanChannels (validate_channels)', () => {
  it.each([
    [null, []],
    ['', []],
    [[], []],
    [
      ['ONLINE', 'POS', 'ONLINE'],
      ['POS', 'ONLINE'],
    ],
    [
      ['OTHER', 'SOCIAL', 'PHONE', 'ONLINE', 'POS'],
      ['POS', 'ONLINE', 'PHONE', 'SOCIAL', 'OTHER'],
    ],
  ])('%j is stored as %j', (value, stored) => {
    expect(cleanChannels(value)).toEqual(stored);
  });

  const refusal = (value: unknown): string => {
    try {
      cleanChannels(value);
    } catch (error) {
      if (error instanceof Invalid) return error.details[0]?.message ?? '';
      throw error;
    }
    return 'accepted';
  };

  it.each([
    ['POS', 'Choose where the coupon can be used.'],
    [{ POS: true }, 'Choose where the coupon can be used.'],
    [0, 'Choose where the coupon can be used.'],
    [false, 'Choose where the coupon can be used.'],
    [['POS', 1], 'Choose where the coupon can be used.'],
    [['POS', null], 'Choose where the coupon can be used.'],
    [[['POS']], 'Choose where the coupon can be used.'],
    [['POS', 'WEB', 'APP', 'APP'], 'Not a sales channel: APP, WEB.'],
    [['pos'], 'Not a sales channel: pos.'],
    [['Zed', 'alpha', 'Ünï', '_x'], 'Not a sales channel: Zed, _x, alpha, Ünï.'],
  ])('%j is refused: %s', (value, message) => {
    expect(refusal(value)).toBe(message);
  });
});
