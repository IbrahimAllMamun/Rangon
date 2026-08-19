import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDebouncedCallback } from "./use-debounced-callback";

const DELAY = 220;

describe("useDebouncedCallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst of calls into one", () => {
    // The scenario this exists for: a wedge scanner typing a barcode.
    const run = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(run, DELAY));
    const [call] = result.current;

    const barcode = "2012345000009";
    act(() => {
      for (let i = 1; i <= barcode.length; i += 1) {
        call(barcode.slice(0, i)); // one keystroke each, faster than the delay
        vi.advanceTimersByTime(8);
      }
    });

    expect(run).not.toHaveBeenCalled(); // nothing fires mid-scan

    act(() => void vi.advanceTimersByTime(DELAY));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(barcode); // and with the complete code
  });

  it("runs once the caller pauses", () => {
    const run = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(run, DELAY));

    act(() => {
      result.current[0]("sh");
      vi.advanceTimersByTime(DELAY);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("sh");

    act(() => {
      result.current[0]("shirt");
      vi.advanceTimersByTime(DELAY);
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("shirt");
  });

  it("cancel drops a queued call", () => {
    // Pressing Enter: the scan is the answer, the half-typed search is not.
    const run = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(run, DELAY));

    act(() => {
      result.current[0]("rgn-cla");
      result.current[1](); // cancel
      vi.advanceTimersByTime(DELAY * 2);
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("does not fire after unmount", () => {
    const run = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(run, DELAY));

    act(() => void result.current[0]("rgn"));
    unmount();
    act(() => void vi.advanceTimersByTime(DELAY * 2));

    expect(run).not.toHaveBeenCalled();
  });

  it("calls the newest callback, not the one captured when queued", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { result, rerender } = renderHook(({ fn }) => useDebouncedCallback(fn, DELAY), {
      initialProps: { fn: stale },
    });

    act(() => void result.current[0]("x"));
    rerender({ fn: fresh });
    act(() => void vi.advanceTimersByTime(DELAY));

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledWith("x");
  });
});
