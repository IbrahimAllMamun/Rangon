"use client";

import * as React from "react";

/**
 * `true` only after `active` has held for `delay`, and then for at least
 * `minVisible`.
 *
 * Both halves matter for a loader. Without the delay, work that finishes in
 * 80 ms still flashes a spinner, which reads as a glitch rather than progress.
 * Without the minimum, a loader that appears at 481 ms and leaves at 500 ms is
 * a blink the eye registers as breakage.
 */
export function useDelayedFlag(active: boolean, delay = 480, minVisible = 400): boolean {
  const [visible, setVisible] = React.useState(false);
  const shownAt = React.useRef(0);

  React.useEffect(() => {
    if (active) {
      if (visible) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
      return () => clearTimeout(timer);
    }

    if (!visible) return;
    const remaining = Math.max(0, minVisible - (Date.now() - shownAt.current));
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [active, visible, delay, minVisible]);

  return visible;
}
