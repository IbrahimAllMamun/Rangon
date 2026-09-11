"use client";

/**
 * Content that is being replaced by a navigation, without moving.
 *
 * Used where the *page* stays and only a region's data changes — product
 * results after a filter, an admin list after a status tab. Replacing that
 * region with a full-screen loader would throw the reader's place away and
 * relayout the page; dimming it in situ keeps the grid where their eye already
 * is, which is the whole point of spatial continuity.
 *
 * The loader is centred over the region and only appears if the wait is real
 * (see useDelayedFlag). `aria-busy` carries the same news to a screen reader,
 * which cannot see anything dim.
 */

import * as React from "react";

import LogoLoader from "@/components/brand/LogoLoader";
import { cn } from "@/lib/cn";
import { useLogoLoaderSlot } from "@/lib/navigation/logo-loader-slot";
import { useNavigationPending } from "@/lib/navigation/route-transition";
import { useDelayedFlag } from "@/lib/use-delayed-flag";

export function PendingRegion({
  children,
  className,
  label = "Updating results",
  /** Override the global navigation signal (e.g. a local transition). */
  pending: pendingOverride,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
  pending?: boolean;
}) {
  const navigationPending = useNavigationPending();
  const pending = pendingOverride ?? navigationPending;
  const showLoader = useDelayedFlag(pending);

  // A navigation that crosses into a new segment renders that segment's
  // `loading.tsx` *inside* this region — so without this the region dimmed the
  // loading screen and centred a second mark on top of it.
  const { outranked } = useLogoLoaderSlot("region", showLoader);

  return (
    <div className={cn("relative", className)}>
      <div aria-busy={pending || undefined} className={cn(pending && "is-stale")}>
        {children}
      </div>

      {showLoader && !outranked && (
        <div className="pointer-events-none absolute inset-0 flex animate-fade-in items-start justify-center">
          <div className="sticky top-1/3 flex flex-col items-center gap-3">
            <LogoLoader size={64} label={label} />
            <p aria-hidden className="text-caption text-muted">
              {label}…
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
