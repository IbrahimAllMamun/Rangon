/**
 * Keeping the register's scan field ready without the mouse.
 *
 * A barcode scanner is a keyboard: it types the code and presses Enter. It
 * only works while the scan field has focus, and focus leaves it all the time
 * at a counter -- a click on a line's quantity button, on the basket, on a
 * blank part of the screen. The scan then typed into nothing, or worse, its
 * Enter pressed whatever button still had focus, and the cashier reached for
 * the mouse to click back into the field.
 *
 * So a character typed anywhere that is not itself a place to type is sent to
 * the scan field, and so is a click on nothing in particular. These are the
 * rules for which is which; the register wires them to the window.
 */

/** Input types that hold text. A checkbox or a button does not. */
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "number",
  "tel",
  "email",
  "url",
  "password",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Elements a click on means "I meant this", so it must not steal focus. */
const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, [role="button"], ' +
  '[role="link"], [role="checkbox"], [role="menuitem"], [role="option"], [role="tab"], ' +
  '[role="dialog"], [role="alertdialog"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Somewhere the keyboard is already typing: never taken away from. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type.toLowerCase());
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  // A dialog owns its keys: a coupon code typed there must stay there.
  return Boolean(target.closest('[role="dialog"], [role="alertdialog"]'));
}

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "defaultPrevented"
>;

/**
 * Whether a key press belongs in the scan field instead of where it landed.
 *
 * Only a printable character, with no Ctrl, Cmd or Alt (those are the
 * browser's and the register's shortcuts). Never Space or Enter: on a focused
 * button those *are* the button, and a keyboard user relies on them.
 */
export function redirectsToScan(event: KeyLike, target: EventTarget | null): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key.length !== 1 || event.key === " ") return false;
  return !isTypingTarget(target);
}

/**
 * Whether a click landed on nothing in particular -- the basket's empty
 * space, a heading, the gap between panels -- rather than on a control.
 * Selecting text is not a click on nothing either: the cashier is copying.
 */
export function isBlankClick(target: EventTarget | null, selection: Selection | null): boolean {
  if (!(target instanceof Element)) return false;
  if (selection && !selection.isCollapsed) return false;
  return !target.closest(INTERACTIVE);
}
