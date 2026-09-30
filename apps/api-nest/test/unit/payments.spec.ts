/**
 * The webhook's building blocks. The capture path itself is proven against
 * Django by the parity harness (parity/payment-cases.ts) and its races.
 */
import { RouteNotMatched, strParam } from '../../src/common/errors';
import { PyFloat } from '../../src/common/python';
import { installBigIntJson } from '../../src/http/request-body';
import { ManualProvider, NoWebhooks, PaymentProviders } from '../../src/payments/providers';

describe('the provider registry', () => {
  it('ships `manual` alone, which takes no webhooks', () => {
    const providers = new PaymentProviders();
    expect(providers.get('manual')).toBeInstanceOf(ManualProvider);
    expect(() => providers.get('manual')?.parseWebhook(Buffer.alloc(0), {})).toThrow(NoWebhooks);
    expect(providers.get('sslcommerz')).toBeUndefined();
    // A plain object would find this on its prototype.
    expect(providers.get('__proto__')).toBeUndefined();
  });
});

describe('`str` path converter', () => {
  it.each(['manual', 'pay pal', 'পে'])('accepts %p', (value) => {
    expect(strParam(value)).toBe(value);
  });

  it.each(['pay/pal', ''])('refuses %p, as the URL resolver does', (value) => {
    expect(() => strParam(value)).toThrow(RouteNotMatched);
  });
});

describe('a Python float written as JSON', () => {
  beforeAll(() => installBigIntJson());

  it.each([
    [3.0, '3.0'],
    [12.5, '12.5'],
    [1e16, '1e+16'],
    [0.0001, '0.0001'],
    [0.00001, '1e-05'],
  ])('%p is json.dumps %p', (value, text) => {
    expect(JSON.stringify({ value: new PyFloat(value) })).toBe(`{"value":${text}}`);
  });

  it('refuses NaN, which is not JSON', () => {
    expect(() => JSON.stringify(new PyFloat(NaN))).toThrow();
  });
});
