/**
 * Which key presses and clicks send the register back to its scan field.
 *
 * What it must guarantee: a scanner's characters reach the scan field from
 * anywhere that is not itself a place to type; typing in a field or a dialog
 * is never taken away; Space and Enter on a focused button still press it;
 * and the browser's and the register's shortcuts are left alone.
 */

import { afterEach, describe, expect, it } from "vitest";

import { isBlankClick, isTypingTarget, redirectsToScan } from "./scan-focus";

function key(value: string, extra: Partial<KeyboardEvent> = {}) {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    ...extra,
  };
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("redirectsToScan", () => {
  it("sends a character typed with nothing focused", () => {
    expect(redirectsToScan(key("4"), document.body)).toBe(true);
  });

  it("sends a character typed on a focused button, where it did nothing", () => {
    const root = mount('<button type="button">+</button>');
    expect(redirectsToScan(key("R"), root.querySelector("button"))).toBe(true);
  });

  it("leaves Space and Enter to the focused button", () => {
    const button = mount("<button>Remove</button>").querySelector("button");
    expect(redirectsToScan(key(" "), button)).toBe(false);
    expect(redirectsToScan(key("Enter"), button)).toBe(false);
  });

  it("leaves shortcuts alone", () => {
    expect(redirectsToScan(key("c", { ctrlKey: true }), document.body)).toBe(false);
    expect(redirectsToScan(key("r", { metaKey: true }), document.body)).toBe(false);
    expect(redirectsToScan(key("x", { altKey: true }), document.body)).toBe(false);
    expect(redirectsToScan(key("F2"), document.body)).toBe(false);
    expect(redirectsToScan(key("Escape"), document.body)).toBe(false);
  });

  it("never takes typing away from a field", () => {
    const root = mount(
      '<input id="qty" type="number"><textarea></textarea><select><option>REG-01</option></select>',
    );
    for (const field of root.querySelectorAll("input, textarea, select")) {
      expect(redirectsToScan(key("5"), field)).toBe(false);
    }
  });

  it("never takes typing out of a dialog", () => {
    const root = mount('<div role="dialog"><p>Discount</p></div>');
    expect(redirectsToScan(key("S"), root.querySelector("p"))).toBe(false);
  });

  it("leaves a key another handler has already dealt with, or an IME mid-word", () => {
    expect(redirectsToScan(key("a", { defaultPrevented: true }), document.body)).toBe(false);
    expect(redirectsToScan(key("a", { isComposing: true }), document.body)).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("counts text inputs but not checkboxes or buttons", () => {
    const root = mount(
      '<input type="text"><input type="search"><input type="checkbox"><input type="button" value="x">',
    );
    const [text, search, checkbox, button] = Array.from(root.querySelectorAll("input"));
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(search)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(button)).toBe(false);
  });

  it("counts an input with no type as text", () => {
    expect(isTypingTarget(mount("<input>").querySelector("input"))).toBe(true);
  });
});

describe("isBlankClick", () => {
  const collapsed = { isCollapsed: true } as Selection;

  it("is a click on empty space or plain text", () => {
    const root = mount('<section><h2>Current sale</h2><div id="empty"></div></section>');
    expect(isBlankClick(root.querySelector("h2"), collapsed)).toBe(true);
    expect(isBlankClick(root.querySelector("#empty"), collapsed)).toBe(true);
  });

  it("is not a click on a control, or on anything inside one", () => {
    const root = mount(
      '<button><svg><path id="icon"></path></svg></button><a href="/x">x</a><label>Qty</label>',
    );
    expect(isBlankClick(root.querySelector("#icon"), collapsed)).toBe(false);
    expect(isBlankClick(root.querySelector("a"), collapsed)).toBe(false);
    expect(isBlankClick(root.querySelector("label"), collapsed)).toBe(false);
  });

  it("is not a click that finished selecting text", () => {
    const root = mount("<p>RGN-POS-000026</p>");
    expect(isBlankClick(root.querySelector("p"), { isCollapsed: false } as Selection)).toBe(false);
  });
});
