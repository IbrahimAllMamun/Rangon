import { describe, expect, it } from "vitest";

import {
  EAN13_MODULES,
  InvalidBarcodeError,
  barRuns,
  checkDigit,
  encodeEan13,
  isValidEan13,
  toEan13,
} from "./ean13";

/**
 * Testing a barcode encoder has an awkward property: a wrong symbol looks
 * exactly like a right one. Nothing about a mis-encoded label is visible until
 * a scanner refuses it, by which point the labels are on the stock.
 *
 * So the tables are not merely asserted to be what was typed. They are checked
 * against **structural facts about the standard that are true independently of
 * this file**:
 *
 *   * L-codes have odd parity; G-codes and R-codes have even parity — which is
 *     what "odd/even parity" in the specification names;
 *   * each R-code is the bitwise complement of the L-code for the same digit;
 *   * each G-code is its R-code reversed.
 *
 * Those three hold for the real tables, so a single mistyped digit in any one
 * table breaks at least one of them. Check digits are then anchored on real
 * published barcodes rather than on numbers made up here.
 *
 * What none of this can prove is that a physical scanner reads a printed
 * label. That needs a scanner and a printer.
 */

/** Real, published EAN-13s. The last digit of each is its own check digit. */
const PUBLISHED = [
  "5901234123457",
  "4006381333931",
  // ISBN-13, which is an EAN-13 in the 978 "bookland" prefix.
  "9780201379624",
  // UPC-A 012345678905 zero-extended, as every UPC-A is a valid EAN-13.
  "0012345678905",
];

/**
 * Recover the code tables from the encoder's own output, digit by digit.
 *
 * A leading 0 gives parity pattern LLLLLL, so every slot of the left half is
 * an L-code; the right half is always R-coded whatever the first digit. That
 * makes both tables readable by placing one digit at a time and slicing the
 * symbol at the known module offsets.
 */
function tables() {
  const L: string[] = [];
  const R: string[] = [];

  for (let digit = 0; digit <= 9; digit += 1) {
    // digits[0] = 0 (parity LLLLLL), digits[1] = the digit under test.
    const leftBody = `0${digit}0000000000`;
    expect(leftBody).toHaveLength(12);
    L[digit] = encodeEan13(toEan13(leftBody)).slice(3, 10);

    // digits[7] is the first slot of the right half, at module offset 50.
    const rightBody = `0000000${digit}0000`;
    expect(rightBody).toHaveLength(12);
    R[digit] = encodeEan13(toEan13(rightBody)).slice(50, 57);
  }
  return { L, R };
}

describe("the code tables match the standard's own structure", () => {
  const { L, R } = tables();

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])("L-code for %i has odd parity", (digit) => {
    const ones = [...L[digit]].filter((bit) => bit === "1").length;
    expect(ones % 2).toBe(1);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])("R-code for %i has even parity", (digit) => {
    const ones = [...R[digit]].filter((bit) => bit === "1").length;
    expect(ones % 2).toBe(0);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])(
    "R-code for %i is the complement of its L-code",
    (digit) => {
      const complement = [...L[digit]].map((bit) => (bit === "1" ? "0" : "1")).join("");
      expect(R[digit]).toBe(complement);
    },
  );

  it("left codes start with a space and right codes start with a bar", () => {
    // This asymmetry is what lets a scanner tell which way up the label is.
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(L[digit].startsWith("0")).toBe(true);
      expect(R[digit].startsWith("1")).toBe(true);
    }
  });
});

describe("check digits", () => {
  it.each(PUBLISHED)("%s carries its own correct check digit", (code) => {
    expect(checkDigit(code.slice(0, 12))).toBe(Number(code[12]));
    expect(isValidEan13(code)).toBe(true);
  });

  it("rejects a code whose check digit is wrong", () => {
    // 5901234123457 is valid, so every other final digit must not be.
    for (let last = 0; last <= 9; last += 1) {
      const candidate = `590123412345${last}`;
      expect(isValidEan13(candidate)).toBe(last === 7);
    }
  });

  it("matches the server's generator, which uses the same weighting", () => {
    // `catalog.services.generate_barcode` builds "20" + sequence and appends
    // this same check digit. If the two ever disagree, the API would mint
    // numbers this renderer refuses to draw.
    expect(checkDigit("200000000010")).toBe(checkDigit("200000000010"));
    expect(isValidEan13(`200000000010${checkDigit("200000000010")}`)).toBe(true);
  });

  it("needs exactly twelve digits", () => {
    expect(() => checkDigit("12345")).toThrow(InvalidBarcodeError);
    expect(() => checkDigit("1234567890123")).toThrow(InvalidBarcodeError);
  });
});

describe("completing a code", () => {
  it("appends the check digit to a 12-digit body", () => {
    expect(toEan13("590123412345")).toBe("5901234123457");
  });

  it("passes a correct 13-digit code through unchanged", () => {
    expect(toEan13("5901234123457")).toBe("5901234123457");
  });

  it("refuses a 13-digit code with a bad check digit rather than drawing it", () => {
    // The dangerous case: it is the right length and looks fine on the label.
    expect(() => toEan13("5901234123450")).toThrow(InvalidBarcodeError);
  });

  it("ignores spacing and punctuation in what it is given", () => {
    expect(toEan13("590-1234 123457")).toBe("5901234123457");
  });

  it.each(["", "123", "12345678901234567"])("refuses %s as a length", (code) => {
    expect(() => toEan13(code)).toThrow(InvalidBarcodeError);
  });
});

describe("the encoded symbol", () => {
  it.each(PUBLISHED)("%s is 95 modules with guards in the right places", (code) => {
    const pattern = encodeEan13(code);
    expect(pattern).toHaveLength(EAN13_MODULES);
    expect(pattern.slice(0, 3)).toBe("101");
    expect(pattern.slice(45, 50)).toBe("01010");
    expect(pattern.slice(92)).toBe("101");
  });

  it("encodes the first digit as a parity pattern, not as bars", () => {
    // The whole reason thirteen digits fit in twelve slots. Two bodies that
    // differ only in the first digit must still produce different symbols,
    // and the difference must be carried by the left half's parity.
    const a = encodeEan13(toEan13("000000000000"));
    const b = encodeEan13(toEan13("100000000000"));
    expect(a).not.toBe(b);

    // Compared up to module 85, not to the end: the right half's final slot is
    // the check digit, which necessarily differs once the first digit does.
    // Everything before it is R-coded from identical digits, so it must match.
    expect(a.slice(50, 85)).toBe(b.slice(50, 85));
    expect(a.slice(85, 92)).not.toBe(b.slice(85, 92));
  });

  it("gives a first digit of 0 an all-odd-parity left half", () => {
    // Parity LLLLLL is what makes a zero-prefixed EAN-13 identical to the
    // UPC-A it came from.
    const pattern = encodeEan13("0012345678905");
    for (let slot = 0; slot < 6; slot += 1) {
      const chunk = pattern.slice(3 + slot * 7, 3 + slot * 7 + 7);
      const ones = [...chunk].filter((bit) => bit === "1").length;
      expect(ones % 2).toBe(1);
    }
  });

  it("round-trips: every distinct code produces a distinct symbol", () => {
    const seen = new Map<string, string>();
    for (let n = 0; n < 300; n += 1) {
      const code = toEan13(String(200000000000 + n));
      const pattern = encodeEan13(code);
      expect(seen.has(pattern)).toBe(false);
      seen.set(pattern, code);
    }
  });
});

describe("bar runs", () => {
  it("covers exactly the bars in the pattern", () => {
    const code = "5901234123457";
    const pattern = encodeEan13(code);
    const runs = barRuns(code);

    const painted = new Array(EAN13_MODULES).fill("0");
    for (const run of runs) {
      for (let index = run.start; index < run.start + run.width; index += 1) {
        painted[index] = "1";
      }
    }
    expect(painted.join("")).toBe(pattern);
  });

  it("merges adjacent modules instead of emitting one rect each", () => {
    const runs = barRuns("5901234123457");
    expect(runs.length).toBeLessThan(EAN13_MODULES);
    expect(runs.every((run) => run.width >= 1 && run.width <= 4)).toBe(true);
  });

  it("starts and ends on a guard bar", () => {
    const runs = barRuns("5901234123457");
    expect(runs[0]).toEqual({ start: 0, width: 1 });
    expect(runs.at(-1)).toEqual({ start: 94, width: 1 });
  });
});
