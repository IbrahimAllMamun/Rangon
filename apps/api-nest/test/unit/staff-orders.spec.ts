import { ValidationError } from '../../src/common/errors';
import { searchDigits } from '../../src/common/phone';
import { lookupDate } from '../../src/common/model-lookups';

/**
 * What the staff order list makes of `search`, `date_from` and `date_to`.
 * Every expected value was printed by Django itself, in the parity stack.
 */
describe('searchDigits (core.phone.search_digits)', () => {
  it.each([
    ['017', '17'],
    ['01711000078', '1711000078'],
    ['+8801711000078', '1711000078'],
    ['008801711', '1711'],
    ['880', ''],
    ['0', ''],
    ['00880', ''],
    ['8800', ''],
    ['1711', '1711'],
    ['88001712345678', '1712345678'],
    ['0-17 11', '1711'],
    ['abc', ''],
    ['', ''],
    // Bengali digits are digits, and none of them is a prefix.
    ['০১৭', '০১৭'],
  ])('%j is %j', (typed, digits) => {
    expect(searchDigits(typed)).toBe(digits);
  });

  it('is nothing for no value', () => {
    expect(searchDigits(null)).toBe('');
    expect(searchDigits(undefined)).toBe('');
  });
});

describe('lookupDate (DateField.to_python, for a __date lookup)', () => {
  it.each([
    ['2026-09-01', '2026-09-01'],
    ['2026-9-1', '2026-09-01'],
    ['20260901', '2026-09-01'],
    ['2026-W36-1', '2026-08-31'],
    ['২০২৬-09-01', '2026-09-01'],
    ['2026-09-01\n', '2026-09-01'],
    ['9999-12-31', '9999-12-31'],
  ])('%j is %s', (typed, date) => {
    expect(lookupDate(typed)).toBe(date);
  });

  const refusal = (typed: string) => {
    try {
      lookupDate(typed);
    } catch (error) {
      return ((error as ValidationError).details as { non_field_errors: string[] })
        .non_field_errors[0];
    }
    return 'accepted';
  };

  it.each(['2026-02-30', '2026-13-01', '0000-01-01'])(
    '%j has the format and is no date',
    (typed) => {
      expect(refusal(typed)).toBe(
        `“${typed}” value has the correct format (YYYY-MM-DD) but it is an invalid date.`,
      );
    },
  );

  it.each(['abc', '2026-09-01T00:00:00', '01/09/2026'])('%j has not the format', (typed) => {
    expect(refusal(typed)).toBe(
      `“${typed}” value has an invalid date format. It must be in YYYY-MM-DD format.`,
    );
  });
});
