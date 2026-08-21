"use client";

import { Heart } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { useWishlist } from "@/lib/store/wishlist";

/**
 * Header wishlist entry point with a live count.
 *
 * Always a real link, so it works before hydration and without JavaScript; the
 * count is an enhancement layered on top.
 */
export function WishlistButton() {
  const load = useWishlist((state) => state.load);
  const count = useWishlist((state) => state.productIds.length);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Link
      href="/wishlist"
      className="relative hidden rounded-md p-2 text-neutral-700 transition-colors duration-fast hover:bg-neutral-100 sm:inline-flex"
      aria-label={count > 0 ? `Wishlist, ${count} item${count === 1 ? "" : "s"}` : "Wishlist"}
    >
      <Heart className="size-5" aria-hidden />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex min-w-[18px] items-center justify-center rounded-full bg-brand-500 px-1 text-[11px] font-semibold leading-[18px] text-white">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
