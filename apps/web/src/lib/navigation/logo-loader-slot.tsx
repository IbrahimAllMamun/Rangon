"use client";

/**
 * One logo loader on screen at a time.
 *
 * Three different things draw the brand mark while the app is busy, and nothing
 * stopped them doing it at once:
 *
 *   • `LogoLoaderScreen`, rendered by every `loading.tsx` as Next's Suspense
 *     fallback. It appears as soon as a segment starts streaming.
 *   • `PendingRegion`, which dims a region in place and centres a loader over
 *     it. It reads the global navigation flag, so it fires for *any*
 *     navigation, not only same-segment ones.
 *   • `LogoLoaderOverlay`, the full-screen blocker, after `LOADER_DELAY_MS`.
 *
 * Cross a segment boundary slowly and all three conditions hold together: the
 * overlay draws a mark at `z-100` over a `loading.tsx` mark, with the region's
 * mark under that — and because the overlay tints and blurs what is behind it,
 * the extra ones showed through as washed-out ghosts rather than being hidden.
 * That is the "second loader behind the first, blurred out" this exists to fix.
 *
 * The rule: a loader draws unless something **more specific** is already
 * drawing. A route's own `loading.tsx` beats a region, and a region beats the
 * global overlay — the more local the loader, the better it tells the reader
 * which part of the screen they are waiting for. The overlay keeps its real
 * job either way: it still blocks clicks, it just stops drawing a second mark.
 *
 * Ranks compare, never coincide, so this cannot deadlock into showing nothing:
 * the highest rank present always draws.
 */

import * as React from "react";

export type LoaderRank = "overlay" | "region" | "screen";

const RANK: Record<LoaderRank, number> = { overlay: 1, region: 2, screen: 3 };

type Counts = Record<LoaderRank, number>;

const EMPTY: Counts = { overlay: 0, region: 0, screen: 0 };

const LogoLoaderSlotContext = React.createContext<{
  counts: Counts;
  add: (rank: LoaderRank, delta: number) => void;
}>({ counts: EMPTY, add: () => {} });

export function LogoLoaderSlotProvider({ children }: { children: React.ReactNode }) {
  const [counts, setCounts] = React.useState<Counts>(EMPTY);

  const add = React.useCallback((rank: LoaderRank, delta: number) => {
    setCounts((prev) => ({ ...prev, [rank]: Math.max(0, prev[rank] + delta) }));
  }, []);

  const value = React.useMemo(() => ({ counts, add }), [counts, add]);

  return (
    <LogoLoaderSlotContext.Provider value={value}>{children}</LogoLoaderSlotContext.Provider>
  );
}

/**
 * Announce that a loader of this rank is on screen, for as long as `active`.
 *
 * Returns whether something more specific is already drawing, so the caller can
 * stand down. Claiming and reading are one hook on purpose: a loader that
 * reads without claiming would let a less specific one draw alongside it.
 */
export function useLogoLoaderSlot(rank: LoaderRank, active = true): { outranked: boolean } {
  const { counts, add } = React.useContext(LogoLoaderSlotContext);

  React.useEffect(() => {
    if (!active) return;
    add(rank, 1);
    return () => add(rank, -1);
  }, [rank, active, add]);

  const outranked = (Object.keys(RANK) as LoaderRank[]).some(
    (other) => RANK[other] > RANK[rank] && counts[other] > 0,
  );

  return { outranked: active && outranked };
}
