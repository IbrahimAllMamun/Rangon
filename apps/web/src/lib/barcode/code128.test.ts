import { describe, expect, it } from "vitest";

import {
  InvalidCode128Error,
  STOP,
  SYMBOLS,
  code128Bars,
  code128Values,
  encodeCode128,
} from "./code128";

/**
 * As with EAN-13, a wrong symbol looks exactly like a right one, so the table
 * is held to facts about the standard that are true independently of this
 * file, and the encoder to patterns a real decoder has read.
 *
 * The fixed patterns below were rendered and decoded by zbar (the reader
 * behind most Linux and Android scanning) when this file was written, along
 * with 295 random strings of digits, letters, hyphens and slashes; every one
 * came back as the text it encoded.
 */

/** Bar and space widths of a symbol, in modules: "11011001100" is 2 1 2 2 2 2. */
function widths(pattern: string): number[] {
  return pattern.match(/1+|0+/g)!.map((run) => run.length);
}

describe("the Code 128 symbol table", () => {
  it("has the 103 data values and three start codes", () => {
    expect(SYMBOLS).toHaveLength(106);
  });

  it("draws every symbol in 11 modules, three bars and three spaces", () => {
    for (const symbol of SYMBOLS) {
      expect(symbol).toMatch(/^[01]{11}$/);
      expect(symbol.startsWith("1")).toBe(true);
      expect(symbol.endsWith("0")).toBe(true);
      expect(widths(symbol)).toHaveLength(6);
    }
  });

  it("keeps every element 1 to 4 modules wide, and its bars an even number of modules", () => {
    for (const symbol of SYMBOLS) {
      const runs = widths(symbol);
      expect(runs.every((width) => width >= 1 && width <= 4)).toBe(true);
      // The parity the standard builds in: bars come to an even width.
      expect((runs[0]! + runs[2]! + runs[4]!) % 2).toBe(0);
    }
  });

  it("never gives two values the same symbol", () => {
    expect(new Set(SYMBOLS).size).toBe(SYMBOLS.length);
  });

  it("ends on the stop symbol and its termination bar", () => {
    expect(widths(STOP)).toEqual([2, 3, 3, 1, 1, 1, 2]);
  });
});

describe("encoding", () => {
  it("writes an order number's letters in set B and its digits as pairs in set C", () => {
    // Start B, "RGN-POS-" as character - 32, switch to C, 00 01 23, check.
    expect(code128Values("RGN-POS-000123")).toEqual([
      104, 50, 39, 46, 13, 48, 47, 51, 13, 99, 0, 1, 23, 8,
    ]);
  });

  it("starts in set C when the text opens on an even run of digits", () => {
    expect(code128Values("1234")).toEqual([105, 12, 34, 82]);
  });

  it("gives an odd run's first digit to set B, so set C starts on a pair", () => {
    expect(code128Values("12345")).toEqual([104, 17, 99, 23, 45, 53]);
  });

  it("draws the patterns a decoder reads back", () => {
    expect(encodeCode128("A")).toBe("1101001000010100011000100010110001100011101011");
    expect(encodeCode128("1234")).toBe("110100111001011001110010001011000100100111101100011101011");
    expect(encodeCode128("RGN-POS-000123")).toBe(
      "11010010000110001011101101000100010111000110100110111001110111011010001110110110111010001001101110010111011110110110011001100110110011101101110100011001001100011101011",
    );
  });

  it("fits an order number on a receipt: 167 modules is 42 mm at 0.25 mm", () => {
    expect(encodeCode128("RGN-POS-000123")).toHaveLength(167);
  });

  it("refuses what neither set can draw, rather than drawing something else", () => {
    expect(() => encodeCode128("")).toThrow(InvalidCode128Error);
    expect(() => encodeCode128("৳1290")).toThrow(InvalidCode128Error);
    expect(() => encodeCode128("a\tb")).toThrow(InvalidCode128Error);
  });

  it("splits a pattern into the bars to draw", () => {
    expect(code128Bars("1101001")).toEqual([
      { start: 0, width: 2 },
      { start: 3, width: 1 },
      { start: 6, width: 1 },
    ]);
  });
});
