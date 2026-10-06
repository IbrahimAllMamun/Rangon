import { Dec } from '../../src/common/decimal';
import { ValidationError } from '../../src/common/errors';
import { lookupDateTime } from '../../src/common/model-lookups';
import { signedMoney } from '../../src/finance/cash-book.service';

/**
 * The cash book's building blocks. Every expected value was printed by Django
 * itself, in the parity stack.
 */
describe('lookupDateTime (DateTimeField.to_python, then make_aware in Asia/Dhaka)', () => {
  const instant = (typed: string) =>
    new Date(Date.parse(lookupDateTime(typed, 'Asia/Dhaka').replace(' ', 'T'))).toISOString();

  it.each([
    ['2026-09-01', '2026-08-31T18:00:00.000Z'],
    ['2026-09-01T10:30:00', '2026-09-01T04:30:00.000Z'],
    ['2026-09-01T10:30:00+06:00', '2026-09-01T04:30:00.000Z'],
    ['2026-09-01 10:30', '2026-09-01T04:30:00.000Z'],
    ['2026-09-15T23:59:59Z', '2026-09-15T23:59:59.000Z'],
    ['20260901', '2026-08-31T18:00:00.000Z'],
    ['2026-9-1', '2026-08-31T18:00:00.000Z'],
    ['2026-09-01T10:30:00.123456-05:30', '2026-09-01T16:00:00.123Z'],
  ])('%j is %s', (typed, utc) => {
    expect(instant(typed)).toBe(utc);
  });

  const refusal = (typed: string) => {
    try {
      lookupDateTime(typed, 'Asia/Dhaka');
    } catch (error) {
      return ((error as ValidationError).details as { non_field_errors: string[] })
        .non_field_errors[0];
    }
    return 'accepted';
  };

  it('tells a date that is none from a datetime that is none from a value that is neither', () => {
    expect(refusal('2026-02-30')).toBe(
      '“2026-02-30” value has the correct format (YYYY-MM-DD) but it is an invalid date.',
    );
    for (const typed of ['2026-02-30T10:00:00', '2026-09-01T25:00:00']) {
      expect(refusal(typed)).toBe(
        `“${typed}” value has the correct format (YYYY-MM-DD HH:MM[:ss[.uuuuuu]][TZ]) but it is an invalid date/time.`,
      );
    }
    for (const typed of ['abc', '01/09/2026']) {
      expect(refusal(typed)).toBe(
        `“${typed}” value has an invalid format. It must be in YYYY-MM-DD HH:MM[:ss[.uuuuuu]][TZ] format.`,
      );
    }
  });
});

describe('signedMoney (f"{amount:+}")', () => {
  it.each([
    ['500.00', '+500.00'],
    ['-20.00', '-20.00'],
    ['0.00', '+0.00'],
    ['-0.00', '-0.00'],
    ['1234567.50', '+1234567.50'],
  ])('%s is %s', (amount, text) => {
    expect(signedMoney(new Dec(amount))).toBe(text);
  });
});
