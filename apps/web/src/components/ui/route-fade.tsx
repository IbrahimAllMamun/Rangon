"use client";

/**
 * Fades page content in when a new route arrives.
 *
 * Keyed by pathname, which is what makes the CSS animation replay: React tears
 * down the old subtree and mounts the new one, so the arriving screen reads as
 * *arriving* rather than snapping into place mid-scroll.
 *
 * Deliberately not applied to the POS. A cashier scanning items should never
 * wait on a fade (CLAUDE.md §10, §13), and the register is one screen anyway.
 *
 * Query-string changes do not remount this — pathname is unchanged — which is
 * correct: filtering a list is not an arrival, and PendingRegion already speaks
 * for it.
 */

import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

export function RouteFade({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <div key={pathname} className={cn("route-fade", className)}>
      {children}
    </div>
  );
}
