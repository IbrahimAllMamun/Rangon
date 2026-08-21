"use client";

import { Heart } from "lucide-react";
import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { useWishlist } from "@/lib/store/wishlist";

/**
 * Save/unsave control, top-right of a product image (spec §19).
 *
 * The only client island on an otherwise server-rendered card: everything else
 * about the card can render on the server, but "is this saved" and "toggle it"
 * both need the browser's wishlist state.
 */
export function WishlistHeart({ productId, name }: { productId: string; name: string }) {
  const load = useWishlist((state) => state.load);
  const saved = useWishlist((state) => state.productIds.includes(productId));
  const toggle = useWishlist((state) => state.toggle);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <button
      type="button"
      onClick={() => void toggle(productId)}
      aria-pressed={saved}
      aria-label={saved ? `Remove ${name} from wishlist` : `Save ${name} to wishlist`}
      className={cn(
        "absolute right-2 top-2 z-10 grid size-9 place-items-center rounded-full bg-white/90 shadow-sm backdrop-blur-sm",
        "transition-transform duration-fast ease-rangon hover:scale-110 active:scale-95",
      )}
    >
      <Heart
        className={cn("size-4 transition-colors duration-fast", saved && "fill-brand-500")}
        // Colour is reinforced by fill + aria-pressed, never the only signal.
        style={{ color: saved ? "var(--brand-500)" : "var(--neutral-500)" }}
        aria-hidden
      />
    </button>
  );
}
