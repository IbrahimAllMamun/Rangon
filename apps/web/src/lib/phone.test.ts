import { describe, expect, it } from "vitest";

import {
  formatPhone,
  isValidPhone,
  searchDigits,
  toCanonical,
  toInputValue,
  toSubscriber,
} from "./phone";

/** Every spelling of one subscriber that a person might actually type. */
const SPELLINGS = [
  "01712345678",
  "1712345678",
  "8801712345678",
  "+8801712345678",
  "008801712345678",
  "+880 1712-345678",
  "0171 234 5678",
  " (0171) 234-5678 ",
  // The country code with the local form pasted after it, which is what
  // somebody produces by typing `880` and then pasting their own number.
  "88001712345678",
  "+88001712345678",
];

describe("toSubscriber", () => {
  it("reduces every spelling of one number to the same ten digits", () => {
    for (const spelling of SPELLINGS) {
      expect(toSubscriber(spelling)).toBe("1712345678");
    }
  });

  it("accepts each operator prefix in use", () => {
    for (const operator of ["13", "14", "15", "16", "17", "18", "19"]) {
      expect(toSubscriber(`0${operator}12345678`)).toBe(`${operator}12345678`);
    }
  });

  it("refuses numbers that are not Bangladeshi mobiles", () => {
    // 011 was Citycell and is withdrawn; 010 and 012 were never issued.
    expect(toSubscriber("01112345678")).toBe("");
    expect(toSubscriber("01012345678")).toBe("");
    // A Dhaka landline, and a corporate short number.
    expect(toSubscriber("029612345")).toBe("");
    expect(toSubscriber("+8809610003030")).toBe("");
    // Too short, too long, and not a number at all.
    expect(toSubscriber("0171234567")).toBe("");
    expect(toSubscriber("017123456789")).toBe("");
    expect(toSubscriber("not a phone")).toBe("");
  });

  it("survives null, undefined and empty", () => {
    expect(toSubscriber(null)).toBe("");
    expect(toSubscriber(undefined)).toBe("");
    expect(toSubscriber("")).toBe("");
  });
});

describe("toCanonical", () => {
  it("is what the database stores", () => {
    expect(toCanonical("01712345678")).toBe("8801712345678");
  });

  it("collapses every spelling onto one string, which is the whole point", () => {
    expect(new Set(SPELLINGS.map(toCanonical)).size).toBe(1);
  });

  it("is empty for anything it cannot read, never a guess", () => {
    expect(toCanonical("029612345")).toBe("");
    expect(toCanonical("")).toBe("");
  });
});

describe("isValidPhone", () => {
  it("agrees with toSubscriber", () => {
    expect(isValidPhone("+8801712345678")).toBe(true);
    expect(isValidPhone("0171234567")).toBe(false);
  });
});

describe("toInputValue", () => {
  it("leaves the ten subscriber digits in the box whatever was pasted", () => {
    for (const spelling of SPELLINGS) {
      expect(toInputValue(spelling)).toBe("1712345678");
    }
  });

  it("keeps a half-typed number, because typing is not an error", () => {
    expect(toInputValue("171")).toBe("171");
    expect(toInputValue("17123")).toBe("17123");
  });

  it("collapses the prefixes as they are typed from the left", () => {
    // Somebody typing `8801712345678` one key at a time passes through `880`,
    // which must vanish so the next digit starts the subscriber number.
    expect(toInputValue("8")).toBe("8");
    expect(toInputValue("88")).toBe("88");
    expect(toInputValue("880")).toBe("");
    expect(toInputValue("8801")).toBe("1");
    expect(toInputValue("0")).toBe("");
    expect(toInputValue("01")).toBe("1");
  });

  it("never lets the box hold more than a subscriber number", () => {
    expect(toInputValue("017123456789999")).toHaveLength(10);
  });

  it("caps after stripping the prefix, not before it", () => {
    // The cap must not eat a digit off the end of a pasted local number. An
    // 11-character `01712345678` is a complete number, and truncating it to ten
    // characters first leaves nine digits once the trunk `0` comes off — which
    // is what a `maxLength` on the input did, and it failed only in a browser.
    expect(toInputValue("01712345678")).toBe("1712345678");
    expect(toInputValue("+8801712345678")).toBe("1712345678");
  });

  it("drops everything that is not a digit", () => {
    expect(toInputValue("+880 (171) 234-5678 ext")).toBe("1712345678");
  });
});

describe("formatPhone", () => {
  it("renders a number a human can read back", () => {
    expect(formatPhone("8801712345678")).toBe("+880 1712-345678");
    expect(formatPhone("01712345678")).toBe("+880 1712-345678");
  });

  it("leaves a frozen order snapshot alone rather than guessing at it", () => {
    // Historical orders keep whatever spelling they were given, and an order
    // already placed is never rewritten.
    expect(formatPhone("029612345")).toBe("029612345");
    expect(formatPhone("")).toBe("");
    expect(formatPhone(null)).toBe("");
  });
});

describe("searchDigits", () => {
  it("returns digits that are a substring of the stored canonical number", () => {
    const stored = toCanonical("01712345678");
    for (const typed of ["01712345678", "+8801712345678", "1712345678", "345678", "0171"]) {
      const digits = searchDigits(typed);
      expect(digits).not.toBe("");
      expect(stored).toContain(digits);
    }
  });

  it("refuses a query that is only a prefix, which would match everyone", () => {
    expect(searchDigits("880")).toBe("");
    expect(searchDigits("0")).toBe("");
    expect(searchDigits("+880")).toBe("");
    expect(searchDigits("00880")).toBe("");
    expect(searchDigits("8800")).toBe("");
    expect(searchDigits("")).toBe("");
  });
});
