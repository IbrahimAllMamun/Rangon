/**
 * Which loader draws the brand mark when several of them want to.
 *
 * The bug: crossing a segment boundary slowly made all three fire together —
 * the route's `loading.tsx`, the region that dims in place, and the global
 * overlay — so the overlay's mark sat at `z-100` over the others, tinting and
 * blurring them into ghosts behind it. These pin the resolution rather than the
 * markup, because the rule is the fix: the most specific loader wins, and the
 * ones it outranks stand down.
 */

import { act, render, renderHook } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { LogoLoaderSlotProvider, type LoaderRank, useLogoLoaderSlot } from "./logo-loader-slot";

/** A mounted loader of `rank`, so another hook can observe being outranked. */
function Claimant({ rank, active = true }: { rank: LoaderRank; active?: boolean }) {
  useLogoLoaderSlot(rank, active);
  return null;
}

/**
 * Render `rank` alongside whatever else is on screen and report whether it
 * would stand down.
 */
function outrankedWith(rank: LoaderRank, others: React.ReactNode, active = true) {
  const { result } = renderHook(() => useLogoLoaderSlot(rank, active), {
    wrapper: ({ children }) => (
      <LogoLoaderSlotProvider>
        {others}
        {children}
      </LogoLoaderSlotProvider>
    ),
  });
  return result.current.outranked;
}

describe("useLogoLoaderSlot", () => {
  it("lets a lone loader draw, whatever its rank", () => {
    for (const rank of ["overlay", "region", "screen"] as LoaderRank[]) {
      expect(outrankedWith(rank, null)).toBe(false);
    }
  });

  it("stands the global overlay down for a route's own loading screen", () => {
    // The reported case: the overlay drew a second mark on top of the
    // `loading.tsx` one and blurred it.
    expect(outrankedWith("overlay", <Claimant rank="screen" />)).toBe(true);
  });

  it("stands the global overlay down for a region loader", () => {
    expect(outrankedWith("overlay", <Claimant rank="region" />)).toBe(true);
  });

  it("stands a region down for a route's own loading screen", () => {
    // `loading.tsx` renders *inside* the region, so the region was dimming the
    // loading screen and centring a third mark over it.
    expect(outrankedWith("region", <Claimant rank="screen" />)).toBe(true);
  });

  it("never stands the most specific loader down", () => {
    expect(
      outrankedWith(
        "screen",
        <>
          <Claimant rank="region" />
          <Claimant rank="overlay" />
        </>,
      ),
    ).toBe(false);
  });

  it("ignores a claimant that is not currently showing", () => {
    // `active` is the loader's own visibility: PendingRegion holds off until
    // the wait is real, and must not silence the overlay before then.
    expect(outrankedWith("overlay", <Claimant rank="screen" active={false} />)).toBe(false);
  });

  it("reports nothing for a loader that is not itself showing", () => {
    expect(outrankedWith("overlay", <Claimant rank="screen" />, false)).toBe(false);
  });

  it("gives the mark back when the more specific loader unmounts", () => {
    // A `loading.tsx` fallback is torn down the moment the segment commits; if
    // the overlay stayed silenced after that, a slow *same-segment* navigation
    // straight afterwards would show no mark at all.
    function Harness({ screen }: { screen: boolean }) {
      const { outranked } = useLogoLoaderSlot("overlay");
      return (
        <>
          {screen && <Claimant rank="screen" />}
          <span data-testid="state">{String(outranked)}</span>
        </>
      );
    }

    const { getByTestId, rerender } = render(
      <LogoLoaderSlotProvider>
        <Harness screen />
      </LogoLoaderSlotProvider>,
    );
    expect(getByTestId("state").textContent).toBe("true");

    act(() => {
      rerender(
        <LogoLoaderSlotProvider>
          <Harness screen={false} />
        </LogoLoaderSlotProvider>,
      );
    });
    expect(getByTestId("state").textContent).toBe("false");
  });

  it("counts claimants rather than tracking one, so two regions do not cancel", () => {
    // Two PendingRegions can be on one screen. The overlay must stay silent
    // until *both* are gone, not the first.
    function Harness({ regions }: { regions: number }) {
      const { outranked } = useLogoLoaderSlot("overlay");
      return (
        <>
          {Array.from({ length: regions }, (_, i) => (
            <Claimant key={i} rank="region" />
          ))}
          <span data-testid="state">{String(outranked)}</span>
        </>
      );
    }

    const { getByTestId, rerender } = render(
      <LogoLoaderSlotProvider>
        <Harness regions={2} />
      </LogoLoaderSlotProvider>,
    );
    expect(getByTestId("state").textContent).toBe("true");

    act(() => {
      rerender(
        <LogoLoaderSlotProvider>
          <Harness regions={1} />
        </LogoLoaderSlotProvider>,
      );
    });
    expect(getByTestId("state").textContent).toBe("true");

    act(() => {
      rerender(
        <LogoLoaderSlotProvider>
          <Harness regions={0} />
        </LogoLoaderSlotProvider>,
      );
    });
    expect(getByTestId("state").textContent).toBe("false");
  });
});
