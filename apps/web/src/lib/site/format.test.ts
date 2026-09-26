import { describe, expect, it } from "vitest";

import { addressLines, fillYear, isGoogleMapEmbed, telHref } from "./format";

describe("fillYear", () => {
  it("replaces every {year} with the year of the given date", () => {
    expect(fillYear("© {year} Rangon. {year}", new Date("2027-01-01T00:00:00Z"))).toBe(
      "© 2027 Rangon. 2027",
    );
  });

  it("leaves text without the token alone", () => {
    expect(fillYear("All rights reserved.")).toBe("All rights reserved.");
  });
});

describe("telHref", () => {
  it("adds the + a canonical Bangladeshi number is stored without", () => {
    expect(telHref("8801712345678")).toBe("tel:+8801712345678");
  });

  it("keeps a number that already has one, dropping the formatting", () => {
    expect(telHref("+880 1712-345678")).toBe("tel:+8801712345678");
  });

  it("dials a local landline as typed", () => {
    expect(telHref("02-9612345")).toBe("tel:029612345");
  });

  it("gives nothing for nothing", () => {
    expect(telHref("")).toBe("");
  });
});

describe("addressLines", () => {
  it("splits on line breaks and drops blank lines", () => {
    expect(addressLines("Level 3, Bashundhara City\r\n\n  Panthapath, Dhaka 1215 ")).toEqual([
      "Level 3, Bashundhara City",
      "Panthapath, Dhaka 1215",
    ]);
  });
});

describe("isGoogleMapEmbed", () => {
  it.each([
    "https://www.google.com/maps/embed?pb=!1m18!1m12",
    "https://www.google.com/maps?q=Bashundhara+City&output=embed",
  ])("frames Google's embed: %s", (url) => {
    expect(isGoogleMapEmbed(url)).toBe(true);
  });

  it.each([
    "http://www.google.com/maps/embed?pb=1",
    "https://maps.google.com.evil.example/maps/embed?pb=1",
    "https://evil.example/maps/embed",
    "https://www.google.com/maps/place/Dhaka",
    "https://www.google.com/maps?q=Dhaka",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("frames nothing else: %s", (url) => {
    expect(isGoogleMapEmbed(url)).toBe(false);
  });
});
