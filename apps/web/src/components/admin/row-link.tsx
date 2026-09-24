import Link from "next/link";

/**
 * Makes a whole table row (or list item) open one record.
 *
 * The row stays a plain `<tr>` and its main cell keeps a real `<Link>`, whose
 * `::after` is stretched over the row. Clicking anywhere on the row follows the
 * link, and middle-click, "open in new tab", keyboard focus and screen readers
 * all keep working. That wouldn't be true of an `onClick` + `router.push` row.
 *
 * The row needs `ROW_LINK_ROW`, which makes it the positioned ancestor (the
 * pointer cursor comes from the link itself). Any
 * other button or link in the row needs `ROW_LINK_ABOVE`, or the stretched link
 * covers it.
 */
export const ROW_LINK_ROW = "group/row relative hover:bg-neutral-50";

/** Lifts a secondary control above the stretched link so it stays clickable. */
export const ROW_LINK_ABOVE = "relative z-10";

export function RowLink({
  href,
  className = "font-medium text-brand-600",
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`${className} after:absolute after:inset-0 after:content-[''] group-hover/row:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--ring)]`}
    >
      {children}
    </Link>
  );
}
