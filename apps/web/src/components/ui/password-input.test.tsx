/**
 * The show/hide toggle on `PasswordInput`.
 *
 * Every password field in the product goes through this component, so these
 * cover the parts that are easy to get subtly wrong and impossible to see in a
 * screenshot: what a screen reader is told, and whether a revealed password
 * stays revealed after the field is cleared.
 *
 * **The caret is not covered here, deliberately.** jsdom does not collapse an
 * input's selection the way a browser does on a real pointer click, so a test
 * written for it passed identically with the fix removed -- a guard that guards
 * nothing. It lives in `e2e/critical-flows.spec.ts` instead, where the
 * behaviour actually exists.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { PasswordInput } from "./primitives";

/** The field, by id — it has no visible label of its own here. */
const field = () => document.getElementById("pw") as HTMLInputElement;
const toggle = () => screen.getByRole("button", { name: "Show password" });

/** A controlled wrapper, which is how every real caller uses it. */
function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  return (
    <>
      <PasswordInput
        id="pw"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="button" onClick={() => setValue("")}>
        clear
      </button>
    </>
  );
}

describe("PasswordInput", () => {
  it("starts masked", () => {
    render(<Harness />);

    expect(field().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("reveals and re-masks the value", () => {
    render(<Harness initial="hunter2-and-then-some" />);

    fireEvent.click(toggle());
    expect(field().type).toBe("text");
    expect(field().value).toBe("hunter2-and-then-some");

    fireEvent.click(toggle());
    expect(field().type).toBe("password");
  });

  it("keeps one stable accessible name and moves only the pressed state", () => {
    // The name deliberately does not flip to "Hide password": a control that
    // renames *and* changes state announces itself twice over.
    render(<Harness initial="a-password" />);

    fireEvent.click(toggle());

    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /hide password/i })).toBeNull();
  });

  it("hides the icon from the accessibility tree", () => {
    // The button is already named; a second label would compete with it.
    render(<Harness />);

    const icon = toggle().querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("re-masks when the field is cleared, so the next value is not revealed", () => {
    // The real case: a successful submit empties the form. Leaving the toggle
    // on would reveal whatever is typed next without anyone asking.
    render(<Harness initial="a-password" />);
    fireEvent.click(toggle());
    expect(field().type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "clear" }));

    expect(field().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("is reachable by keyboard", () => {
    // It was written with `tabIndex={-1}` first, to keep the tab path short.
    // That denies a keyboard-only user a control everyone else gets, and
    // WCAG 2.1.1 asks that all functionality be keyboard operable -- checking
    // what you typed is functionality.
    render(<Harness />);

    expect(toggle().getAttribute("tabindex")).toBeNull();
  });

  it("does not steal the caret from the field", () => {
    // Found in a browser, not here: clicking the toggle focused the button, so
    // the next keystroke went nowhere until the person clicked back in. The
    // component prevents the default on `mousedown` to keep the caret put.
    render(<Harness initial="a-password" />);
    const prevented = fireEvent.mouseDown(toggle());

    // `fireEvent` returns false when a handler called preventDefault.
    expect(prevented).toBe(false);
  });

  it("leaves autocomplete alone, so password managers and paste still work", () => {
    // WCAG 2.2 "Accessible Authentication": the field must stay fillable and
    // pasteable. The toggle must not be a reason that stops being true.
    render(
      <PasswordInput id="pw" autoComplete="current-password" defaultValue="" />,
    );

    expect(field().getAttribute("autocomplete")).toBe("current-password");
  });
});
