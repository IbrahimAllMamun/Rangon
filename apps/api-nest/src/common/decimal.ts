/**
 * Money arithmetic, with Python's `decimal` default context.
 *
 * Money never becomes a JavaScript number (CLAUDE.md section 13). PostgreSQL
 * `numeric` arrives as a string and leaves as a string; anything computed in
 * between goes through `Dec`, configured like Python's default context --
 * 28 significant digits, ROUND_HALF_EVEN -- so a division or a `round()` lands
 * on the same digit the Django API does.
 */
import Decimal from 'decimal.js';

export const Dec = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
  // Plain notation for anything a price or a rate can be.
  toExpNeg: -30,
  toExpPos: 30,
});

export type Dec = InstanceType<typeof Dec>;

/** Python `round(value)` on a Decimal: an int, ties to even. */
export function pyRound(value: Dec): number {
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

/**
 * `min()` / `max()` over decimal strings, answering the *original* string.
 *
 * Python's `str(min(prices))` prints the Decimal it was given, so "1290.00"
 * stays "1290.00" rather than becoming "1290".
 */
export function minDecimal(values: string[]): string {
  return values.reduce((best, value) => (new Dec(value).lt(best) ? value : best));
}

export function maxDecimal(values: string[]): string {
  return values.reduce((best, value) => (new Dec(value).gt(best) ? value : best));
}

/**
 * How DRF's JSON encoder writes a Decimal that was put straight into a response
 * dict: `float(value)`. A serializer field would have written a string; a bare
 * Decimal in a dict becomes a JSON number.
 */
export function drfFloat(value: string): number {
  return Number(value);
}
