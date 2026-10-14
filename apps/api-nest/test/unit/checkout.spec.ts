/**
 * Checkout's building blocks against their originals: DRF 3.15's field
 * answers (printed by DRF in the Django API's container) and the Celery task
 * message Celery 5.4 itself wrote to Redis for `send_order_email.delay(...)`.
 */
import { decimalField, dictField, EMPTY, Invalid, SKIP, uuidField } from '../../src/common/drf';
import { PyFloat } from '../../src/common/python';

function run(field: { run(data: unknown, partial: boolean): unknown }, value: unknown): unknown {
  try {
    return field.run(value, false);
  } catch (error) {
    if (error instanceof Invalid) return error.details.map((detail) => detail.message);
    throw error;
  }
}

describe('DecimalField(max_digits=14, decimal_places=2, allow_null=True)', () => {
  const field = decimalField(14, 2, { required: false, allowNull: true });
  it.each([
    ['44.105', ['Ensure that there are no more than 2 decimal places.']],
    ['1e20', ['Ensure that there are no more than 14 digits in total.']],
    ['abc', ['A valid number is required.']],
    ['4410.0', '4410.00'],
    ['  12 ', '12.00'],
    ['1_000', '1000.00'],
    ['-0', '-0.00'],
    ['0.001', ['Ensure that there are no more than 2 decimal places.']],
    ['123456789012.34', '123456789012.34'],
    ['1234567890123.4', ['Ensure that there are no more than 12 digits before the decimal point.']],
    ['NaN', ['A valid number is required.']],
    ['', null],
    [new PyFloat(4410.5), '4410.50'],
    [true, ['A valid number is required.']],
  ])('%p', (value, expected) => {
    expect(run(field, value)).toEqual(expected);
  });

  it('leaves a missing value out of the validated data', () => {
    expect(field.run(EMPTY, false)).toBe(SKIP);
  });
});

describe('UUIDField', () => {
  const field = uuidField();
  it.each([
    [5, '00000000-0000-0000-0000-000000000005'],
    ['abc', ['Must be a valid UUID.']],
    ['{12345678-1234-5678-1234-567812345678}', '12345678-1234-5678-1234-567812345678'],
    [new PyFloat(1.5), ['Must be a valid UUID.']],
    [true, '00000000-0000-0000-0000-000000000001'],
  ])('%p', (value, expected) => {
    expect(run(field, value)).toEqual(expected);
  });
});

describe('DictField', () => {
  const field = dictField();
  it.each([
    [[1], ['Expected a dictionary of items but got type "list".']],
    ['x', ['Expected a dictionary of items but got type "str".']],
    [{ a: 1 }, { a: 1 }],
  ])('%p', (value, expected) => {
    expect(run(field, value)).toEqual(expected);
  });
});
