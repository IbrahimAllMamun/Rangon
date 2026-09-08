"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { cn } from "@/lib/cn";
// Pure helpers live in a non-client module so the server components that render
// this footer can call them — see the note at the top of lib/paging.ts.
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "@/lib/paging";

/** `1 … 4 5 6 … 20` — first, last, and a window around the current page. */
function pageWindow(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set([1, total, current, current - 1, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((n) => pages.add(n));
  if (current >= total - 2) [total - 1, total - 2, total - 3].forEach((n) => pages.add(n));

  const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (const [index, value] of sorted.entries()) {
    if (index > 0 && value - sorted[index - 1] > 1) out.push("gap");
    out.push(value);
  }
  return out;
}

const CONTROL = [
  // 44px on touch, 36px once there is a pointer — the same step Input and Select
  // in ui/primitives take, so controls line up across the admin.
  "inline-flex h-11 min-w-11 items-center justify-center rounded-md px-2 text-body-sm",
  "sm:h-9 sm:min-w-9",
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
].join(" ");

/**
 * Pagination footer for the admin list screens.
 *
 * Page links are real `<Link>`s, so they deep-link, middle-click and work before
 * hydration; only the rows-per-page `<select>` needs JavaScript. Every existing
 * query parameter is carried across, which is what keeps a status tab or a search
 * term alive when you move to page 2.
 *
 * The current page is marked with neutral-900, not brand red: CLAUDE.md §10
 * reserves red for actions, and the surrounding filter pills already use the same
 * dark chip for "this one is selected".
 */
export function Pagination({
  count,
  page,
  pageSize,
  query = {},
  unit = "rows",
  className,
}: {
  /** Total matching rows, from the API's `count`. */
  count: number;
  page: number;
  pageSize: number;
  /** The route's current search params, so filters survive a page change. */
  query?: Record<string, string | undefined>;
  /** Plural noun for the summary line — "orders", "products". */
  unit?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const selectId = React.useId();

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const firstRow = count === 0 ? 0 : (current - 1) * pageSize + 1;
  const lastRow = Math.min(current * pageSize, count);

  const href = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") next.set(key, value);
      }
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      const search = next.toString();
      return search ? `${pathname}?${search}` : pathname;
    },
    [pathname, query],
  );

  // A page far into the old page size rarely exists in the new one, and DRF
  // answers an out-of-range page with 404 rather than an empty list — so resize
  // always returns to page 1.
  function changePageSize(value: string) {
    router.push(
      href({
        page_size: Number(value) === DEFAULT_PAGE_SIZE ? null : value,
        page: null,
      }),
    );
  }

  if (count === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-border px-4 py-2.5",
        className,
      )}
    >
      <p className="text-caption text-muted">
        Showing <span className="tabular font-medium text-foreground">{firstRow}</span>–
        <span className="tabular font-medium text-foreground">{lastRow}</span> of{" "}
        <span className="tabular font-medium text-foreground">{count}</span> {unit}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-caption text-muted">
            Rows per page
          </label>
          <select
            id={selectId}
            value={pageSize}
            onChange={(event) => changePageSize(event.target.value)}
            className={cn(
              "h-11 rounded-md border border-neutral-300 bg-white px-2 text-body-sm sm:h-9",
              "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-[var(--ring)]",
            )}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        {totalPages > 1 && (
          <nav aria-label="Pagination" className="flex items-center gap-1">
            <Step
              href={href({ page: current - 1 === 1 ? null : String(current - 1) })}
              disabled={current === 1}
              label="Previous page"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Step>

            {pageWindow(current, totalPages).map((entry, index) =>
              entry === "gap" ? (
                <span
                  key={`gap-${index}`}
                  aria-hidden
                  className="px-1 text-caption text-muted"
                >
                  …
                </span>
              ) : (
                <Link
                  key={entry}
                  href={href({ page: entry === 1 ? null : String(entry) })}
                  aria-current={entry === current ? "page" : undefined}
                  aria-label={`Page ${entry}`}
                  className={cn(
                    CONTROL,
                    "tabular font-medium",
                    entry === current
                      ? "bg-neutral-900 text-white"
                      : "border border-border bg-surface hover:bg-neutral-100",
                  )}
                >
                  {entry}
                </Link>
              ),
            )}

            <Step
              href={href({ page: String(current + 1) })}
              disabled={current === totalPages}
              label="Next page"
            >
              <ChevronRight className="size-4" aria-hidden />
            </Step>
          </nav>
        )}
      </div>
    </div>
  );
}

/**
 * Previous/next. At either end this renders a real `<span aria-disabled>` rather
 * than a dead link — a disabled anchor still takes focus and still navigates.
 */
function Step({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        aria-label={label}
        className={cn(CONTROL, "border border-border bg-neutral-100 text-neutral-400")}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(CONTROL, "border border-border bg-surface hover:bg-neutral-100")}
    >
      {children}
    </Link>
  );
}
