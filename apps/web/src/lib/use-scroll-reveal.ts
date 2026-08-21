"use client";

import * as React from "react";

/**
 * Reveal an element the first time it scrolls into view.
 *
 * Two things this must never do, both of which are easy to get wrong:
 *
 *  - **Strand content invisible.** If the user prefers reduced motion, the
 *    element starts visible and no observer is ever created. The resting state
 *    is "shown", not "hidden", so a JS failure cannot leave a blank shop.
 *  - **Keep observing forever.** It unobserves on first intersection, so a long
 *    catalogue page is not paying for dozens of live observers as it scrolls.
 *
 * Server components cannot call hooks — wrap markup in `<Reveal>` instead.
 */
export function useScrollReveal<T extends HTMLElement = HTMLDivElement>(threshold = 0.1) {
  const ref = React.useRef<T>(null);
  // Lazy initialiser: read the media query before the first paint, so a
  // reduced-motion user never sees the hidden state even for one frame.
  const [isVisible, setIsVisible] = React.useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  React.useEffect(() => {
    if (isVisible) return; // already shown, or motion is reduced
    const node = ref.current;

    // No IntersectionObserver (old browser, odd webview): show it rather than
    // hide it. Content is the point; the animation is the garnish.
    if (!node || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setIsVisible(true);
        observer.unobserve(entry.target);
      },
      // Fire slightly before the element reaches the fold so the motion is
      // finishing as it arrives, rather than starting once it is already read.
      { threshold, rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, isVisible]);

  return { ref, isVisible };
}
