import { describe, expect, it } from "vitest";

import { SITE_NAME, pageTitle } from "./seo";

/** How many times the shop name appears in a finished title. */
const brandCount = (title: string) =>
  title.toLowerCase().split(SITE_NAME.toLowerCase()).length - 1;

describe("pageTitle", () => {
  it("appends the shop name to a page's own name", () => {
    expect(pageTitle("Classic Oxford Shirt").absolute).toBe(
      "Classic Oxford Shirt | Rangon Fashion",
    );
  });

  it("does not append it twice when the title already carries it", () => {
    // D4: the seed wrote the suffix into `seo_title` while the root layout's
    // template appended it as well.
    expect(pageTitle("Classic Oxford Shirt | Rangon Fashion").absolute).toBe(
      "Classic Oxford Shirt | Rangon Fashion",
    );
  });

  it("catches the separator a person actually types", () => {
    // A merchant reaches for a dash as readily as a pipe, and the old form hint
    // asked them to remember a rule instead.
    for (const typed of [
      "Oxford Shirt - Rangon Fashion",
      "Oxford Shirt — Rangon Fashion",
      "Oxford Shirt, Rangon Fashion",
      "Oxford Shirt Rangon Fashion",
    ]) {
      expect(brandCount(pageTitle(typed).absolute)).toBe(1);
    }
  });

  it("ignores the case somebody typed it in", () => {
    expect(brandCount(pageTitle("Oxford Shirt | RANGON FASHION").absolute)).toBe(1);
  });

  it("falls back to the shop name alone when there is nothing specific", () => {
    expect(pageTitle("").absolute).toBe(SITE_NAME);
    expect(pageTitle("   ").absolute).toBe(SITE_NAME);
    expect(pageTitle(null).absolute).toBe(SITE_NAME);
    expect(pageTitle(undefined).absolute).toBe(SITE_NAME);
  });

  it("still suffixes an own-brand product, because that is not a duplicate", () => {
    // "Rangon Fashion Tote Bag" carries the shop name in the product name
    // itself. The suffix is the site identifier, not a repeat of the product,
    // so it belongs — this is the one case where the name appears twice and
    // should.
    expect(pageTitle("Rangon Fashion Tote Bag").absolute).toBe(
      "Rangon Fashion Tote Bag | Rangon Fashion",
    );
  });

  it("never appends to a title that already ends with the shop name", () => {
    for (const input of [
      "Classic Oxford Shirt | Rangon Fashion",
      "Rangon Fashion",
      "Oxford Shirt - rangon fashion",
    ]) {
      expect(pageTitle(input).absolute).toBe(input.trim());
    }
  });
});
