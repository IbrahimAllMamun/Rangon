/**
 * Code 128, written out rather than pulled in, for the reasons `ean13.ts`
 * gives: it must print as vector (a canvas-drawn barcode is a soft-edged
 * bitmap by the time a thermal printer sees it), and the standard is fixed
 * and small enough to test against.
 *
 * Code 128 is what an order number needs and EAN-13 cannot hold: letters and
 * a hyphen (`RGN-POS-000123`). Every USB and Bluetooth scanner reads it out
 * of the box and types it back exactly, which is the whole point -- a receipt
 * scanned into a search field finds its order.
 *
 * The encoding, for the reader who has to check this:
 *
 * ```text
 *   quiet  start  symbol x n  check  stop  quiet
 *          (11)   (11 each)  (11)   (13)
 * ```
 *
 * Every symbol is 11 modules: three bars and three spaces, each 1-4 modules
 * wide. Three code sets share the 103 data values: set B is printable ASCII
 * (value = character code - 32), set C is a pair of digits (value 00-99), and
 * each set has a value that switches to the other. Set C halves the width of a
 * run of digits, which on a 75 mm receipt matters: `RGN-POS-000123` comes to
 * 167 modules instead of 200. The check symbol is the start value plus each
 * symbol's value times its position, modulo 103.
 */

/**
 * The 106 symbols by value, as "1" (bar) and "0" (space) per module: values
 * 0-102 are data and switches, 103-105 the start codes for sets A, B and C.
 * Taken from the specification's table (as `python-barcode` carries it) and
 * checked structurally in `code128.test.ts`.
 */
export const SYMBOLS = [
  "11011001100", "11001101100", "11001100110", "10010011000", "10010001100", "10001001100",
  "10011001000", "10011000100", "10001100100", "11001001000", "11001000100", "11000100100",
  "10110011100", "10011011100", "10011001110", "10111001100", "10011101100", "10011100110",
  "11001110010", "11001011100", "11001001110", "11011100100", "11001110100", "11101101110",
  "11101001100", "11100101100", "11100100110", "11101100100", "11100110100", "11100110010",
  "11011011000", "11011000110", "11000110110", "10100011000", "10001011000", "10001000110",
  "10110001000", "10001101000", "10001100010", "11010001000", "11000101000", "11000100010",
  "10110111000", "10110001110", "10001101110", "10111011000", "10111000110", "10001110110",
  "11101110110", "11010001110", "11000101110", "11011101000", "11011100010", "11011101110",
  "11101011000", "11101000110", "11100010110", "11101101000", "11101100010", "11100011010",
  "11101111010", "11001000010", "11110001010", "10100110000", "10100001100", "10010110000",
  "10010000110", "10000101100", "10000100110", "10110010000", "10110000100", "10011010000",
  "10011000010", "10000110100", "10000110010", "11000010010", "11001010000", "11110111010",
  "11000010100", "10001111010", "10100111100", "10010111100", "10010011110", "10111100100",
  "10011110100", "10011110010", "11110100100", "11110010100", "11110010010", "11011011110",
  "11011110110", "11110110110", "10101111000", "10100011110", "10001011110", "10111101000",
  "10111100010", "11110101000", "11110100010", "10111011110", "10111101110", "11101011110",
  "11110101110", "11010000100", "11010010000", "11010011100",
] as const;

/** The stop symbol with its two-module termination bar: 13 modules. */
export const STOP = "1100011101011";

const START_B = 104;
const START_C = 105;
/** In set B: carry on in set C. */
const TO_C = 99;
/** In set C: carry on in set B. */
const TO_B = 100;

/** Empty modules each side: the specification asks for at least ten. */
export const QUIET_ZONE = 10;

export class InvalidCode128Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCode128Error";
  }
}

/** How many digits run from `start`. */
function digitRun(text: string, start: number): number {
  let end = start;
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
  return end - start;
}

/**
 * The symbol values for `text`, start and check included, stop not.
 *
 * Set C is used for a run of digits long enough to pay for the switch: four
 * at the start or the end of the text, six in the middle. An odd run gives its
 * first digit to set B. Only printable ASCII can be encoded; anything else
 * throws rather than drawing a symbol that scans as something else.
 */
export function code128Values(text: string): number[] {
  if (!text) throw new InvalidCode128Error("There is nothing to encode.");
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char.length !== 1 || code < 32 || code > 126) {
      throw new InvalidCode128Error(`"${char}" cannot be drawn in Code 128 set B or C.`);
    }
  }

  const values: number[] = [];
  const leading = digitRun(text, 0);
  let setC = leading >= 4 && leading % 2 === 0;
  values.push(setC ? START_C : START_B);

  let index = 0;
  while (index < text.length) {
    if (setC) {
      if (digitRun(text, index) >= 2) {
        values.push(Number(text.slice(index, index + 2)));
        index += 2;
        continue;
      }
      values.push(TO_B);
      setC = false;
      continue;
    }
    const run = digitRun(text, index);
    const atEnd = index + run === text.length;
    if (run >= (atEnd || index === 0 ? 4 : 6)) {
      if (run % 2 === 1) {
        // The odd digit goes in set B, so set C starts on a pair.
        values.push(text.charCodeAt(index) - 32);
        index += 1;
      }
      values.push(TO_C);
      setC = true;
      continue;
    }
    values.push(text.charCodeAt(index) - 32);
    index += 1;
  }

  const sum = values.reduce((total, value, position) => total + value * Math.max(position, 1), 0);
  values.push(sum % 103);
  return values;
}

/** The module pattern for `text`: start, data, check and stop, without quiet zones. */
export function encodeCode128(text: string): string {
  return code128Values(text)
    .map((value) => SYMBOLS[value])
    .join("")
    .concat(STOP);
}

/** The bars of a pattern as runs, for drawing one `<rect>` per bar. */
export function code128Bars(pattern: string): { start: number; width: number }[] {
  const bars: { start: number; width: number }[] = [];
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "1") continue;
    const start = index;
    while (pattern[index + 1] === "1") index++;
    bars.push({ start, width: index - start + 1 });
  }
  return bars;
}
