/**
 * `core.dates.parse_moment` over CPython 3.12's `fromisoformat` parsers.
 *
 * Expected values printed by the Django API's container (Asia/Dhaka). The
 * port was also checked against some 96,000 generated strings the same way
 * before it was committed; these are the ones that show a quirk.
 */
import { parseMoment } from '../../src/common/dates';
import { ValidationError } from '../../src/common/errors';

const DHAKA = 'Asia/Dhaka';

describe('core.dates.parse_moment', () => {
  it.each([
    ['2026-01-01', false, '2026-01-01 00:00:00+06:00'],
    ['2026-01-01', true, '2026-01-01 23:59:59.999999+06:00'],
    // date.fromisoformat never checks that it reached the end.
    ['2026010112', false, '2026-01-01 00:00:00+06:00'],
    ['2026W01', true, '2025-12-29 23:59:59.999999+06:00'],
    // Any character separates the date from the time, however many bytes.
    ['2026-01-01é10:00', false, '2026-01-01 10:00:00+06:00'],
    ['2026-01-01😀10:00', false, '2026-01-01 10:00:00+06:00'],
    // Fraction digits past six are skipped, and whatever follows them, when an offset comes after.
    ['2026-01-01T10:00:00.1234567x+05:00', false, '2026-01-01 10:00:00.123456+05:00'],
    ['2026-01-01T10:00:00.+05:00', false, '2026-01-01 10:00:00+05:00'],
    // No range check on an offset's minutes.
    ['2026-01-01T10:00+05:99', false, '2026-01-01 10:00:00+06:39'],
    // Zero whole seconds of offset is UTC, its fraction dropped.
    ['2026-01-01T10-00:00:00.5', false, '2026-01-01 10:00:00+00:00'],
    ['2026-01-01T10+00:00:00.5', false, '2026-01-01 10:00:00+00:00'],
    ['2026-01-01T10:00-05:00:00.5', false, '2026-01-01 10:00:00-05:00:00.500000'],
    ['2026-W01-1T10', false, '2025-12-29 10:00:00+06:00'],
    ['2026W011T10', false, '2025-12-29 10:00:00+06:00'],
    ['2026-01-01T100000123', false, '2026-01-01 10:00:00.123000+06:00'],
    ['2026-01-01T10:00:00:5', false, '2026-01-01 10:00:00.500000+06:00'],
    ['2026-01-01T10:00:00,25Z', false, '2026-01-01 10:00:00.250000+00:00'],
    // Dhaka's local mean time, Howrah time, and the summer of 2009 (fold=0).
    ['0001-01-01', false, '0001-01-01 00:00:00+06:01:40'],
    ['1941-10-01', false, '1941-10-01 00:00:00+05:53:20'],
    ['9999-12-31', true, '9999-12-31 23:59:59.999999+06:00'],
    ['2009-06-19T23:30', false, '2009-06-19 23:30:00+06:00'],
    ['2009-06-20T00:30', false, '2009-06-20 00:30:00+07:00'],
    ['2009-12-31T23:30', false, '2009-12-31 23:30:00+07:00'],
    ['  2026-01-01 ', false, '2026-01-01 00:00:00+06:00'],
  ])('%j (end of day %s)', (text, endOfDay, expected) => {
    expect(parseMoment(text, endOfDay, DHAKA)).toBe(expected);
  });

  it.each([
    '2026-01-01T24:00',
    '2026-01-01T10:00+24:00',
    '2026-13-01',
    '2026-W0110',
    '2026-01-01T10:00z',
    '   ',
    '2026-01-01T',
  ])('refuses %j', (text) => {
    expect(() => parseMoment(text, false, DHAKA)).toThrow(ValidationError);
    try {
      parseMoment(text, false, DHAKA);
    } catch (error) {
      const stripped = text.trim();
      expect((error as ValidationError).message).toBe(
        `“${stripped}” is not a date. Use YYYY-MM-DD, or a full timestamp.`,
      );
      expect((error as ValidationError).details).toEqual({ value: stripped });
    }
  });

  it('reads nothing as nothing', () => {
    expect(parseMoment(undefined, false, DHAKA)).toBeNull();
    expect(parseMoment('', true, DHAKA)).toBeNull();
  });
});
