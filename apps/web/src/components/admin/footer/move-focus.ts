/**
 * Keep keyboard focus on a row after it is moved up or down.
 *
 * Two things take focus away from the button that was pressed: the button
 * becoming disabled (the row reached the top, so "Move up" no longer applies —
 * a disabled element drops focus), and React re-inserting the row's DOM node
 * when the list re-renders in its new order. Either way a keyboard user would
 * be dropped back to the top of the page after every press (WCAG 2.4.3).
 *
 * Move buttons carry ids `move-up-<id>` / `move-down-<id>`; this focuses the
 * one in the same direction, or the other one when that is now disabled.
 */
export function moveButtonId(direction: "up" | "down", id: string): string {
  return `move-${direction}-${id}`;
}

export function focusMoveButton(id: string, direction: "up" | "down"): void {
  const button = (which: "up" | "down") =>
    document.getElementById(moveButtonId(which, id)) as HTMLButtonElement | null;
  const same = button(direction);
  const target = same && !same.disabled ? same : button(direction === "up" ? "down" : "up");
  target?.focus();
}
