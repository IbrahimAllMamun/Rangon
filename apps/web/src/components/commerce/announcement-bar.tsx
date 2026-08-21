"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { StorefrontBanner } from "@/lib/api/types";

const STORAGE_KEY = "rangon:announcement-dismissed";

/**
 * Layer 1 of the navbar (spec §5).
 *
 * Dismissal is per-browser `localStorage` keyed by the banner id, not per user:
 * storefront visitors are usually anonymous, and a new campaign gets a new id,
 * so it reappears without anyone clearing anything.
 *
 * It renders on the server first and hides on mount if dismissed, rather than
 * waiting for the check — a bar that pops in after hydration shifts the page.
 * It sits *above* the sticky header and scrolls away naturally.
 */
export function AnnouncementBar({ banner }: { banner: StorefrontBanner | null }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!banner?.dismissible) return;
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === banner.id);
    } catch {
      // Private mode or blocked storage: showing the bar is the safe failure.
    }
  }, [banner?.id, banner?.dismissible]);

  if (!banner || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      if (banner) window.localStorage.setItem(STORAGE_KEY, banner.id);
    } catch {
      // Nothing to do — it will simply show again next visit.
    }
  }

  const message = banner.message || banner.title;

  return (
    <div className="relative bg-neutral-950 text-white">
      <div className="container-rangon flex min-h-10 items-center justify-center gap-3 py-2 pr-10 text-center">
        {banner.url ? (
          <Link
            href={banner.url}
            className="text-caption font-medium underline-offset-4 hover:underline"
          >
            {message}
          </Link>
        ) : (
          <p className="text-caption font-medium">{message}</p>
        )}
      </div>

      {banner.dismissible && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-neutral-300 transition-colors duration-fast hover:bg-neutral-800 hover:text-white"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
