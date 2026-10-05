/**
 * The counter's building blocks against Django's own answers. Every expected
 * value was printed by the Django API's container (Django 5.1, DRF 3.15),
 * not worked out by hand.
 */
import { quantize } from '../../src/checkout/pricing';
import { decimalField, errorMessages, jsonField, runSerializer } from '../../src/common/drf';
import {
  BadSignature,
  SignatureExpired,
  signingDumps,
  signingLoads,
} from '../../src/common/signing';
import { installBigIntJson, parsePythonJson } from '../../src/http/request-body';

describe('JSONField(required=False), as a held sale reads its payload', () => {
  beforeAll(() => installBigIntJson());
  const fields = { payload: jsonField({ required: false }) };
  const run = async (text: string) => {
    const result = await runSerializer(fields, parsePythonJson(text));
    return JSON.stringify(result.ok ? result.values : errorMessages(result.errors));
  };

  it.each([
    ['{}', '{}'],
    ['{"payload": null}', '{"payload":["This field may not be null."]}'],
    // A float past a double is read as infinity, which `allow_nan=False` refuses.
    ['{"payload": 1e400}', '{"payload":["Value must be valid JSON."]}'],
    ['{"payload": {"a": [1, -1e999]}}', '{"payload":["Value must be valid JSON."]}'],
    // Floats keep Python's form and a long integer its digits, on the way to jsonb.
    [
      '{"payload": {"a": 1.0, "b": [1e3, 12345678901234567890]}}',
      '{"payload":{"a":1.0,"b":[1000.0,12345678901234567890]}}',
    ],
    ['{"payload": "x"}', '{"payload":"x"}'],
    ['{"payload": false}', '{"payload":false}'],
    ['{"payload": []}', '{"payload":[]}'],
  ])('%s', async (body, expected) => {
    expect(await run(body)).toBe(expected);
  });
});

describe("django.core.signing, as a manager's approval is signed", () => {
  const key = 'unit-test-key';
  const salt = 'orders.pos.approval';
  // `signing.dumps(obj, key="unit-test-key", salt="orders.pos.approval")` with `time.time()` patched.
  const tokens: [number, unknown, string][] = [
    [
      1759680000,
      {
        approver: 'a1',
        cashier: 'c1',
        permission: 'sales.discount_override',
        max_percent: '25.00',
      },
      'eyJhcHByb3ZlciI6ImExIiwiY2FzaGllciI6ImMxIiwicGVybWlzc2lvbiI6InNhbGVzLmRpc2NvdW50X292ZXJyaWRlIiwibWF4X3BlcmNlbnQiOiIyNS4wMCJ9:1v5R9U:64Ayrz51avT5sRFDDAZEUdB7PaFvX9jONdRMN_TnYhs',
    ],
    // A fraction of a second is dropped; text outside ASCII is escaped before it is encoded.
    [
      1759680000.9,
      { approver: 'a1', cashier: 'c1', permission: 'ছাড় "x" \\ \n', max_percent: null },
      'eyJhcHByb3ZlciI6ImExIiwiY2FzaGllciI6ImMxIiwicGVybWlzc2lvbiI6Ilx1MDk5Ylx1MDliZVx1MDlhMVx1MDliYyBcInhcIiBcXCBcbiIsIm1heF9wZXJjZW50IjpudWxsfQ:1v5R9U:K5rsVagczpxekSfHqrer-98T0AZ1PMtqxDrMVHHrYk8',
    ],
    [0, {}, 'e30:0:aktHkVOZyC62Yh4zUvlkEiMXEIpueR0T7Ku9gvs9s2E'],
    [
      61,
      [1, 2.5, '😀'],
      'WzEsMi41LCJcdWQ4M2RcdWRlMDAiXQ:z:baZK6skmvFfonqibmT0_ZSRVNsr1LtgL3fdzzxIba-M',
    ],
  ];

  it.each(tokens)('signs at %d as Django does', (now, value, token) => {
    expect(signingDumps(value, { key, salt, now })).toBe(token);
  });

  it.each(tokens)('reads what Django signed at %d', (now, value, token) => {
    expect(signingLoads(token, { key, salt, maxAge: 300, now: Math.floor(now) + 300 })).toEqual(
      value,
    );
  });

  it('refuses a token a second past its age, and one from another key, salt or hand', () => {
    const [now, , token] = tokens[0] as [number, unknown, string];
    expect(() => signingLoads(token, { key, salt, maxAge: 300, now: now + 300.5 })).toThrow(
      SignatureExpired,
    );
    expect(() => signingLoads(token, { key: 'another', salt, now })).toThrow(BadSignature);
    expect(() => signingLoads(token, { key, salt: 'another', now })).toThrow(BadSignature);
    expect(() => signingLoads(token.slice(0, -1), { key, salt, now })).toThrow(BadSignature);
    expect(() => signingLoads(`x${token}`, { key, salt, now })).toThrow(BadSignature);
    expect(() => signingLoads('no-separator', { key, salt, now })).toThrow(BadSignature);
    // A token signed in the future is not expired: its age is negative.
    expect(signingLoads(token, { key, salt, maxAge: 300, now: now - 600 })).toBeDefined();
  });
});

describe('core.money.quantize at the edge of the decimal context', () => {
  it.each([
    ['99999999999999999999999999.99', '99999999999999999999999999.99'],
    ['99999999999999999999999999.994', '99999999999999999999999999.99'],
    ['-99999999999999999999999999.99', '-99999999999999999999999999.99'],
  ])('%s', (value, expected) => {
    expect(quantize(value).toFixed(2)).toBe(expected);
  });

  // `decimal.InvalidOperation`: the result needs more than the context's 28 digits.
  it.each([
    '99999999999999999999999999.995',
    '100000000000000000000000000',
    '-100000000000000000000000000.00',
  ])('%s is refused, as Python refuses it', (value) => {
    expect(() => quantize(value)).toThrow();
  });
});

describe('DecimalField(max_digits=5, decimal_places=2, min_value=0, max_value=100)', () => {
  const fields = {
    percent: decimalField(5, 2, {
      required: false,
      allowNull: true,
      minValue: '0',
      maxValue: '100',
    }),
  };
  const run = async (value: unknown) => {
    const result = await runSerializer(fields, { percent: value });
    return JSON.stringify(result.ok ? result.values : errorMessages(result.errors));
  };

  it.each([
    [100, '{"percent":"100.00"}'],
    ['100.01', '{"percent":["Ensure this value is less than or equal to 100."]}'],
    [-1, '{"percent":["Ensure this value is greater than or equal to 0."]}'],
    ['', '{"percent":null}'],
    ['9.999', '{"percent":["Ensure that there are no more than 2 decimal places."]}'],
  ])('%j', async (value, expected) => {
    expect(await run(value)).toBe(expected);
  });
});
