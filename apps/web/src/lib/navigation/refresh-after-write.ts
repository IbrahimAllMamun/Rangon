"use client";

/**
 * Refresh the screen after a write, and make sure the refresh actually landed.
 *
 * `router.refresh()` cannot be trusted on its own. It fetches the new payload
 * and then discards it (D40): the server re-renders correctly every time, the
 * RSC response carries the new row, and the browser throws it away. Measured on
 * a production build, the failure rate rises with the weight of the page --
 * a near-empty admin page applies the refresh 5 times out of 5, while
 * `/admin/expenses` has been measured at 0/5, 0/5 and 2/5 across three runs of
 * the same build. It is stochastic, not deterministic, and not specific to one
 * screen. There is no root cause yet; see D40 in docs/roadmap.md for what has
 * been ruled out.
 *
 * So the refresh is verified rather than assumed. `AdminLayout` stamps a fresh
 * `data-render-id` on every server render, so:
 *
 *   - the refresh lands  -> the attribute changes, nothing else happens, and
 *     the screen stays a single-page app (the fast path, a few hundred ms);
 *   - the refresh is lost -> the attribute does not change within the budget
 *     and the page reloads outright (~900 ms, and always right).
 *
 * A screen that says "not received" about stock on the shelf, or omits an
 * expense that has already left the account, is worse than 900 ms. This is the
 * same trade `PurchaseActions` made by hand for D77; it is made once here
 * instead, so there is one place to undo when Next.js is fixed -- at which
 * point the fallback simply stops firing and this keeps working.
 */

import type { useRouter } from "next/navigation";

/** Longest we wait for a refresh to show up before reloading instead. */
const REFRESH_BUDGET_MS = 1500;

/** How often to look. Cheap: one attribute read. */
const POLL_MS = 100;

/** The attribute `AdminLayout` re-stamps on every server render. */
const RENDER_ID = "data-render-id";

function currentRenderId(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(`[${RENDER_ID}]`)?.getAttribute(RENDER_ID) ?? null;
}

/**
 * Ask for fresh server state and do not return until the screen has it.
 *
 * Safe to call from an event handler after an awaited write. Never throws: if
 * anything about the detection goes wrong it falls back to a reload, which is
 * the answer that is always correct.
 */
export async function refreshAfterWrite(
  router: Pick<ReturnType<typeof useRouter>, "refresh">,
): Promise<void> {
  const before = currentRenderId();

  router.refresh();

  // No stamp on the page (a surface that does not render `AdminLayout`, or an
  // older cached document): there is nothing to verify against, so take the
  // answer that cannot be wrong.
  if (before === null) {
    window.location.reload();
    return;
  }

  const deadline = Date.now() + REFRESH_BUDGET_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (currentRenderId() !== before) return; // the refresh landed
  }

  window.location.reload();
}
