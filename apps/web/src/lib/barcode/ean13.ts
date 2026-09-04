/**
 * EAN-13 encoding, written out rather than pulled in.
 *
 * Two reasons this is not a dependency (CLAUDE.md section 2):
 *
 * 1. **It must print as vector, not raster.** Every popular barcode library
 *    draws to a canvas, which fixes the bars at screen resolution — roughly
 *    96 DPI. A label printed from that is a scaled-up bitmap, and the blurred
 *    module edges are exactly what a scanner fails on. Emitting the module
 *    pattern lets the caller render `<rect>`s, which a 300 DPI printer renders
 *    at 300 DPI.
 * 2. **The standard is fixed and small**, so it can be tested against
 *    published barcodes instead of trusted. See `ean13.test.ts`.
 *
 * The encoding, for the reader who has to check this:
 *
 * A symbol is 95 modules — a module being the width of the narrowest bar.
 *
 * ```text
 *   101  ddddddd x6   01010   ddddddd x6  101
 *   ^                 ^                   ^
 *   start guard       centre guard        end guard
 * ```
 *
 * Only twelve digits are drawn. The **first digit is not encoded at all**: it
 * is carried by the *pattern* of odd/even parity chosen for digits 2-7, which
 * is why a 13-digit number fits in twelve 7-module slots. Digits 8-13 always
 * use the R table, whose codes begin with a bar rather than a space, and that
 * asymmetry is what lets a scanner read the label upside down.
 */

/** Left-hand odd parity. */
const L_CODE = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
] as const;

/** Left-hand even parity. */
const G_CODE = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
] as const;

/** Right-hand. Always even parity, always starts with a bar. */
const R_CODE = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
] as const;

/**
 * Which of digits 2-7 use even parity, indexed by the first digit.
 *
 * `L` is odd, `G` is even. First digit 0 is all-odd, which is why a 12-digit
 * UPC-A is just an EAN-13 with a leading zero.
 */
const PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
] as const;

const START_GUARD = "101";
const CENTRE_GUARD = "01010";
const END_GUARD = "101";

/** Total modules in a well-formed symbol: 3 + 42 + 5 + 42 + 3. */
export const EAN13_MODULES = 95;

export class InvalidBarcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBarcodeError";
  }
}

/**
 * The check digit for the first twelve digits of an EAN-13.
 *
 * Weights alternate 1, 3 starting at 1 for the leftmost digit. This mirrors
 * `catalog.services.generate_barcode` on the server; the two must agree, or a
 * number the API considers valid would be refused here.
 */
export function checkDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) {
    throw new InvalidBarcodeError("A check digit needs exactly 12 digits.");
  }
  let total = 0;
  for (let index = 0; index < 12; index += 1) {
    total += Number(first12[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (total % 10)) % 10;
}

/** Whether a 13-digit string carries its own correct check digit. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return checkDigit(code.slice(0, 12)) === Number(code[12]);
}

/**
 * Complete a 12-digit body into a full EAN-13 by appending its check digit.
 * A 13-digit input is returned unchanged if it already checks out.
 */
export function toEan13(code: string): string {
  const digits = code.replace(/\D/g, "");
  if (digits.length === 12) return `${digits}${checkDigit(digits)}`;
  if (digits.length === 13) {
    if (!isValidEan13(digits)) {
      throw new InvalidBarcodeError(
        `${digits} is 13 digits but its check digit is wrong; it would not scan.`,
      );
    }
    return digits;
  }
  throw new InvalidBarcodeError(`An EAN-13 needs 12 or 13 digits, not ${digits.length}.`);
}

/**
 * The module pattern for a barcode, as a 95-character string of "1" (bar) and
 * "0" (space).
 *
 * Throws rather than drawing a wrong symbol: a label that scans as the wrong
 * product is worse than a label that was never printed, because nothing about
 * it looks wrong until it is on the shelf.
 */
export function encodeEan13(code: string): string {
  const digits = toEan13(code);
  const parity = PARITY[Number(digits[0])];

  let left = "";
  for (let index = 0; index < 6; index += 1) {
    const digit = Number(digits[index + 1]);
    left += parity[index] === "L" ? L_CODE[digit] : G_CODE[digit];
  }

  let right = "";
  for (let index = 0; index < 6; index += 1) {
    right += R_CODE[Number(digits[index + 7])];
  }

  const pattern = `${START_GUARD}${left}${CENTRE_GUARD}${right}${END_GUARD}`;

  // Cheap insurance against a table typo shipping as an unscannable label.
  if (pattern.length !== EAN13_MODULES) {
    throw new InvalidBarcodeError(
      `Encoded ${pattern.length} modules instead of ${EAN13_MODULES}; the tables are wrong.`,
    );
  }
  return pattern;
}

/**
 * The pattern as runs of consecutive bars, ready to become `<rect>`s.
 *
 * Returned as `{ start, width }` in modules so the caller picks the physical
 * scale. Merging adjacent bars here rather than emitting 95 rects keeps the
 * printed SVG small when a sheet carries 65 of them.
 */
export function barRuns(code: string): { start: number; width: number }[] {
  const pattern = encodeEan13(code);
  const runs: { start: number; width: number }[] = [];

  let index = 0;
  while (index < pattern.length) {
    if (pattern[index] === "0") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < pattern.length && pattern[index] === "1") index += 1;
    runs.push({ start, width: index - start });
  }
  return runs;
}
