"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

/**
 * Sticky header shell.
 *
 * The header **shrinks; it never hides** (navigation.md §4). Spec §22 suggests
 * hide-on-scroll-down, which contradicts the same spec's "do not hide
 * navigation aggressively" and §40's "no layout shift".
 *
 * Two consequences follow from "no layout shift":
 *
 *  - the header keeps a fixed height. Only the logo scale and inner padding
 *    compress, driven by `data-scrolled`. Animating the height itself would
 *    reflow every pixel of the page beneath it, on every scroll frame.
 *  - scroll state comes from one `IntersectionObserver` sentinel rather than a
 *    scroll listener (spec §32), so nothing runs per frame.
 */
export function SiteHeader({ children }: { children: React.ReactNode }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* Zero-height marker at the top of the document: once it leaves the
          viewport the page has scrolled. */}
      <div ref={sentinel} aria-hidden className="h-px" />
      <header
        data-scrolled={scrolled || undefined}
        className={cn(
          "group sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur-sm",
          "transition-shadow duration-normal ease-rangon data-[scrolled]:shadow-md",
        )}
      >
        {children}
      </header>
    </>
  );
}
