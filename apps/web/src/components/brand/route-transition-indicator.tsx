"use client";

/**
 * What the app shows while a route is loading.
 *
 * Two layers, because one loader cannot serve both cases well:
 *
 *   • The bar is immediate. Its whole job is to answer "did my click land?"
 *     within a frame, which is the thing a frozen-feeling UI fails to do.
 *   • The logo takes over only if the wait is real (> LOADER_DELAY_MS). Showing
 *     a full-screen loader for a 90 ms navigation is worse than showing
 *     nothing — it reads as a flash of broken layout.
 *
 * Once the logo is up it stays for MIN_VISIBLE_MS even if the data lands
 * immediately after, so it never appears and vanishes within the same blink.
 *
 * Motion budget per CLAUDE.md §10: fast 120–160 ms, normal 180–240 ms.
 * `prefers-reduced-motion` is handled globally in globals.css, which flattens
 * these animations; the indicator still appears, it just does not move.
 */

import * as React from "react";

import { LogoLoaderOverlay } from "@/components/brand/logo-loader-overlay";

/** Below this, a navigation reads as instant and needs no loader. */
const LOADER_DELAY_MS = 480;

export function RouteTransitionIndicator({ pending }: { pending: boolean }) {
  return (
    <>
      <RouteProgressBar pending={pending} />
      {/* Blocks clicks while the next screen streams in: without this a shopper
          queues three more navigations onto the slow one they are waiting for. */}
      <LogoLoaderOverlay active={pending} delay={LOADER_DELAY_MS} />
    </>
  );
}

/**
 * Indeterminate bar. Eases toward the right and parks short of the end, because
 * it cannot know the real progress — then snaps to full on arrival, which is
 * the part that actually reads as "done".
 *
 * Animates `transform`, never `width`: width animation lays out every frame.
 */
function RouteProgressBar({ pending }: { pending: boolean }) {
  const [phase, setPhase] = React.useState<"idle" | "running" | "done">("idle");

  React.useEffect(() => {
    if (pending) {
      setPhase("running");
      return;
    }
    // Only play the completion if there was something to complete.
    setPhase((current) => (current === "running" ? "done" : "idle"));
  }, [pending]);

  React.useEffect(() => {
    if (phase !== "done") return;
    const timer = setTimeout(() => setPhase("idle"), 240);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "idle") return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[110] h-[3px] overflow-hidden"
    >
      <div
        className={
          phase === "done"
            ? "h-full w-full origin-left scale-x-100 bg-brand-500 opacity-0 transition-[transform,opacity] duration-normal ease-rangon"
            : "route-progress h-full w-full origin-left bg-brand-500"
        }
      />
    </div>
  );
}
