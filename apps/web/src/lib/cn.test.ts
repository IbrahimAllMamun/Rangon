import { describe, expect, it } from "vitest";

import tailwindConfig from "../../tailwind.config";

import { cn, FONT_SIZES } from "./cn";

describe("cn", () => {
  it("keeps a text colour next to a custom font size", () => {
    // The Button bug: `dark` variant, then the `md` size.
    const classes = cn("bg-neutral-900 text-white", "h-10 px-4 text-body-sm").split(" ");
    expect(classes).toContain("text-white");
    expect(classes).toContain("text-body-sm");
  });

  it("keeps a custom font size next to a text colour", () => {
    // The Badge bug: the base size, then the tone's colour.
    const classes = cn("px-2.5 text-caption", "bg-neutral-100 text-neutral-700").split(" ");
    expect(classes).toContain("text-caption");
    expect(classes).toContain("text-neutral-700");
  });

  it("still lets a later size replace an earlier one, and a later colour an earlier one", () => {
    expect(cn("text-body-sm", "text-body")).toBe("text-body");
    expect(cn("text-white", "text-brand-600")).toBe("text-brand-600");
    expect(cn("text-sm", "text-caption")).toBe("text-caption");
  });

  it("knows every font size the Tailwind config defines", () => {
    const configured = Object.keys(tailwindConfig.theme?.extend?.fontSize ?? {});
    expect([...FONT_SIZES].sort()).toEqual(configured.sort());
  });
});
