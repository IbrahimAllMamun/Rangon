"use client";

/**
 * Route-transition state for the whole app.
 *
 * Why this exists: in the App Router a `loading.tsx` only renders when the
 * navigation crosses into a segment that has one. It does **not** render when
 * the URL changes within the same segment — `/shop?category=men` →
 * `/shop?category=women`, `/admin/orders?status=PAID`, page 2 of a list. React
 * keeps the old screen on the page while the server re-renders, so a slow API
 * call looks exactly like a frozen UI: the click registered, nothing moved.
 *
 * Two signals drive the indicator:
 *
 *   1. `navigate()` wraps `router.push` in a transition, so `isPending` is
 *      React's own answer to "is the next screen still loading" — exact, no
 *      guessing. Use it for programmatic pushes (filters, sort, search).
 *   2. A capture-phase click listener on the document catches every `<Link>`,
 *      because Next has no public "navigation started" event and a Link tells
 *      no one but itself. Arrival is detected from the URL actually changing.
 *
 * The pending flag can never wedge: it clears on arrival, and a hard timeout
 * clears it even if an arrival signal is somehow missed. A stuck overlay would
 * be worse than the freeze it replaces.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { RouteTransitionIndicator } from "@/components/brand/route-transition-indicator";

/** Longest a transition may hold the indicator before we assume we missed the end. */
const MAX_PENDING_MS = 10_000;

interface RouteTransition {
  /** A navigation is in flight and the next screen is not ready yet. */
  pending: boolean;
  /** Push a URL and report pending until the new screen commits. */
  navigate: (href: string) => void;
  /** Mark a navigation as started (for non-anchor triggers). */
  start: () => void;
}

const RouteTransitionContext = React.createContext<RouteTransition>({
  pending: false,
  navigate: () => {},
  start: () => {},
});

export function useRouteTransition(): RouteTransition {
  return React.useContext(RouteTransitionContext);
}

/** True while any navigation is in flight. Convenience for dimming a region. */
export function useNavigationPending(): boolean {
  return React.useContext(RouteTransitionContext).pending;
}

export function RouteTransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [linkPending, setLinkPending] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setLinkPending(false);
  }, []);

  const start = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLinkPending(false), MAX_PENDING_MS);
    setLinkPending(true);
  }, []);

  const navigate = React.useCallback(
    (href: string) => {
      start();
      startTransition(() => router.push(href));
    },
    [router, start],
  );

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  React.useEffect(() => {
    function onClick(event: MouseEvent) {
      // Anything the browser would not treat as an in-app navigation.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor || !anchor.getAttribute("href")) return;
      if (anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;

      const url = new URL((anchor as HTMLAnchorElement).href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same URL or an in-page hash: nothing streams in, so nothing to report.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      start();
    }

    // Capture phase: this must run before Link's own handler swallows the event.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [start]);

  const pending = linkPending || isPending;
  const value = React.useMemo<RouteTransition>(
    () => ({ pending, navigate, start }),
    [pending, navigate, start],
  );

  return (
    <RouteTransitionContext.Provider value={value}>
      {/* useSearchParams needs a Suspense boundary or every page above it opts
          out of static rendering. Nothing renders here, so the fallback is null. */}
      <React.Suspense fallback={null}>
        <ArrivalListener onArrive={stop} />
      </React.Suspense>
      {children}
      <RouteTransitionIndicator pending={pending} />
    </RouteTransitionContext.Provider>
  );
}

/** The URL changing is the arrival: the new screen has committed. */
function ArrivalListener({ onArrive }: { onArrive: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  React.useEffect(() => {
    onArrive();
  }, [pathname, search, onArrive]);

  return null;
}
