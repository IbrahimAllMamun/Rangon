"use client";

/**
 * Full-screen logo loader for a wait the user must not act during.
 *
 * Two uses: a route transition that turned out to be slow, and a blocking
 * mutation such as placing an order. Both are cases where the honest answer is
 * "the app is busy, please don't click again" — so the overlay takes the
 * pointer as well as the eye.
 *
 * It never appears for fast work: `useDelayedFlag` holds it back until the wait
 * is real, then keeps it up long enough not to blink. See
 * `route-transition-indicator.tsx` for why both halves matter.
 */

import LogoLoader from "@/components/brand/LogoLoader";
import { cn } from "@/lib/cn";
import { useDelayedFlag } from "@/lib/use-delayed-flag";

export function LogoLoaderOverlay({
  active,
  label = "Loading",
  /** Wait this long before showing, so quick work never flashes a loader. */
  delay,
  size = 88,
  className,
}: {
  active: boolean;
  label?: string;
  delay?: number;
  size?: number;
  className?: string;
}) {
  const visible = useDelayedFlag(active, delay);
  if (!visible) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] grid animate-fade-in place-items-center",
        "bg-[var(--background)]/80 backdrop-blur-[2px]",
        className,
      )}
      style={{ cursor: "progress" }}
    >
      <div className="flex flex-col items-center gap-4">
        {/* LogoLoader carries role="status" and the accessible label. */}
        <LogoLoader size={size} label={label} />
        <p aria-hidden className="text-caption text-muted">
          {label}…
        </p>
      </div>
    </div>
  );
}
