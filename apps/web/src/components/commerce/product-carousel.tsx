"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * A row of product cards that scrolls sideways: the homepage carousel.
 *
 * The cards are rendered by the server and passed in as children, so
 * `ProductCard` stays a server component; only the row's scrolling lives
 * here. It is native horizontal scrolling with snap points -- a swipe on a
 * phone, a trackpad, Shift+wheel -- plus previous/next buttons.
 *
 * What it deliberately does not do:
 *  - move by itself. Autoplay takes the row away from someone reading it
 *    and needs a pause control to be usable at all (WCAG 2.2.2).
 *  - hide the next card. A narrow screen shows part of it, which is what
 *    says "there is more this way".
 *  - disable a button at the end. A disabled button drops keyboard focus
 *    onto the page; `aria-disabled` keeps it where the reader left it.
 *
 * Tabbing through the cards scrolls each into view by itself, so a keyboard
 * needs no special handling. The buttons appear once the row has been
 * measured and there is something to scroll to: without JavaScript they
 * would do nothing, and the row still scrolls.
 */
export function ProductCarousel({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode[];
}) {
  const track = React.useRef<HTMLUListElement>(null);
  const [edges, setEdges] = React.useState({ scrollable: false, atStart: true, atEnd: true });

  const measure = React.useCallback(() => {
    const node = track.current;
    if (!node) return;
    // A pixel of slack: fractional widths leave scrollLeft a hair short.
    const atStart = node.scrollLeft <= 1;
    const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
    setEdges({ scrollable: node.scrollWidth > node.clientWidth + 1, atStart, atEnd });
  }, []);

  React.useEffect(() => {
    const node = track.current;
    if (!node) return;
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure]);

  function page(direction: -1 | 1) {
    const node = track.current;
    if (!node) return;
    if ((direction < 0 && edges.atStart) || (direction > 0 && edges.atEnd)) return;
    // Most of a screen, so the card at the edge stays in view as a landmark.
    // Instant when motion is reduced: `scrollBy` ignores the CSS that the
    // global reduced-motion block sets.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollBy({
      left: direction * node.clientWidth * 0.9,
      behavior: reduced ? "auto" : "smooth",
    });
  }

  const headingId = `${id}-heading`;

  return (
    <section aria-labelledby={headingId} className="container-rangon py-10 sm:py-14">
      <div className="mb-5 flex items-end justify-between gap-4">
        <h2 id={headingId} className="font-display text-h2">
          {title}
        </h2>
        {edges.scrollable && (
          <div className="flex shrink-0 gap-2">
            <ArrowButton
              label="Previous products"
              disabled={edges.atStart}
              onClick={() => page(-1)}
              controls={id}
            >
              <ChevronLeft className="size-5" aria-hidden />
            </ArrowButton>
            <ArrowButton
              label="Next products"
              disabled={edges.atEnd}
              onClick={() => page(1)}
              controls={id}
            >
              <ChevronRight className="size-5" aria-hidden />
            </ArrowButton>
          </div>
        )}
      </div>

      {/* `-mx-2 px-2`: a card lifts on hover and draws its surface 8px
          outside its box (`-m-2 p-2`), which a scrolling box would otherwise
          clip at both ends. `relative` keeps any `sr-only` text inside the
          scroll box, where it cannot widen the page (design-system.md). */}
      <ul
        id={id}
        ref={track}
        className={cn(
          "relative -mx-2 flex snap-x snap-mandatory scroll-px-2 gap-4 overflow-x-auto px-2 py-3",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {/* A list, so a screen reader says how many there are and which one
            it is on ("3 of 8") without any labelling here. */}
        {React.Children.map(children, (child) => (
          <li
            // A phone shows one card and most of the next; four across from
            // `lg`, as in the product grids below.
            className="w-[72%] shrink-0 snap-start sm:w-[calc((100%-2rem)/2.4)] md:w-[calc((100%-2rem)/3)] lg:w-[calc((100%-3rem)/4)]"
          >
            {child}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArrowButton({
  label,
  disabled,
  onClick,
  controls,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  controls: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-controls={controls}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={cn(
        "grid size-11 place-items-center rounded-full border border-neutral-300 bg-surface text-neutral-900",
        "transition-colors duration-fast hover:bg-neutral-100",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
        "aria-disabled:cursor-default aria-disabled:text-neutral-400 aria-disabled:hover:bg-surface",
      )}
    >
      {children}
    </button>
  );
}
