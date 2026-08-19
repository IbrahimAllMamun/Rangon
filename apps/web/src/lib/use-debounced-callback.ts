"use client";

import * as React from "react";

/**
 * Run `callback` only once the caller stops calling for `delay` ms.
 *
 * Written for the POS scan field, where the cost of not having it was severe: a
 * keyboard-wedge scanner types a 13-character barcode in about 100 ms, so
 * searching per keystroke issued 13 parallel requests, saturated the browser's
 * six-connection limit, and delayed the one lookup that mattered. The register
 * appeared to freeze on every scan.
 *
 * Returns the debounced function and a `cancel` for when a newer intent wins —
 * pressing Enter, or clearing the field. The latest `callback` is always the one
 * invoked, so callers need not memoise it.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number,
): [(...args: Args) => void, () => void] {
  const latest = React.useRef(callback);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    latest.current = callback;
  });

  const cancel = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const call = React.useCallback(
    (...args: Args) => {
      cancel();
      timer.current = setTimeout(() => latest.current(...args), delay);
    },
    [cancel, delay],
  );

  // A pending timer must not outlive the component that queued it.
  React.useEffect(() => cancel, [cancel]);

  return [call, cancel];
}
