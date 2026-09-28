import Link from "next/link";

import { cn } from "@/lib/cn";

export interface FilterTab {
  label: React.ReactNode;
  href: string;
  active: boolean;
  /** Defaults to `href`, which is unique within a set. */
  key?: string;
}

const BASE =
  "px-3 py-1.5 text-body-sm transition-colors duration-fast " +
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]";

/**
 * The one look every admin filter takes.
 *
 * Two shapes on one vocabulary. `chips` -- separate outlined links, as on the
 * reviews screen -- are for the values a list can be narrowed to: a status, a
 * kind, a channel. They wrap onto another line rather than clip, however many
 * there are. `segmented` -- one outlined strip, as on the dashboard -- is for a
 * short ordered scale, the date presets.
 *
 * Both mark the current choice the same way: a brand tint, `brand-700` text
 * (5.4:1) and a brand outline (3.4:1, WCAG 1.4.11), in semibold, so colour is
 * never the only cue (1.4.1). This used to be done five ways, and the most
 * common -- solid black -- was the heaviest thing on any page it sat on,
 * heavier than the page's own heading.
 *
 * Links, not buttons: each is the same list with a different query string,
 * rendered by the server, which can be opened in a new tab or bookmarked.
 * `aria-current="true"` marks the chosen one; "page" would claim it is a
 * different page.
 */
export function FilterTabs({
  label,
  tabs,
  variant = "chips",
  className,
}: {
  /** Names the group for a screen reader, e.g. "Order status". */
  label: string;
  tabs: FilterTab[];
  variant?: "chips" | "segmented";
  className?: string;
}) {
  const segmented = variant === "segmented";
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex flex-wrap",
        segmented ? "rounded-md border border-border bg-surface p-0.5" : "gap-2",
        className,
      )}
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key ?? tab.href}
          href={tab.href}
          aria-current={tab.active ? "true" : undefined}
          className={cn(
            BASE,
            segmented ? "rounded" : "rounded-md border",
            tab.active
              ? cn(
                  "bg-brand-50 font-semibold text-brand-700",
                  segmented ? "ring-1 ring-inset ring-brand-500" : "border-brand-500",
                )
              : cn(
                  "font-medium hover:bg-neutral-100",
                  segmented ? "text-neutral-600" : "border-neutral-300 bg-surface text-neutral-700",
                ),
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
