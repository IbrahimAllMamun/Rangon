/**
 * The supplier form keeps its fields across keystrokes.
 *
 * It used to define its `<form>`/`<div>` wrapper as a component *inside*
 * `SupplierForm`. Every keystroke re-rendered the form, which made a new
 * wrapper function, which React treats as a different component type -- so it
 * threw away every input under it and mounted fresh ones. The value survived
 * (it lives in state) but the input being typed into did not, so focus was
 * lost after each letter. Most visible on the purchase order screen's "New
 * supplier", which renders this form nested.
 *
 * The check is DOM identity: after a change, the field must be the very same
 * element, still focused. Plain matchers only: no jest-dom setup is registered.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { SupplierForm } from "./supplier-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

function nameField(): HTMLInputElement {
  return screen.getByLabelText(/Supplier name/) as HTMLInputElement;
}

describe.each([
  ["inside the purchase order (nested)", true],
  ["on its own page", false],
])("SupplierForm %s", (_label, nested) => {
  it("keeps the same input, and focus, while typing", () => {
    render(<SupplierForm nested={nested} />);

    const input = nameField();
    input.focus();
    for (const typed of ["A", "Ac", "Acm", "Acme"]) {
      fireEvent.change(nameField(), { target: { value: typed } });
    }

    expect(nameField()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Acme");
  });

  it("keeps every other field across a keystroke too", () => {
    render(<SupplierForm nested={nested} />);

    const fields = screen.getAllByRole("textbox");
    fireEvent.change(nameField(), { target: { value: "Acme" } });

    const after = screen.getAllByRole("textbox");
    expect(after).toHaveLength(fields.length);
    after.forEach((field, index) => expect(field).toBe(fields[index]));
  });
});

describe("SupplierForm wrapper", () => {
  it("is not a <form> when nested, since nested forms submit natively (D76)", () => {
    const { container } = render(<SupplierForm nested />);
    expect(container.querySelector("form")).toBeNull();
  });

  it("is a <form> on its own page", () => {
    const { container } = render(<SupplierForm />);
    expect(container.querySelector("form")).not.toBeNull();
  });
});
