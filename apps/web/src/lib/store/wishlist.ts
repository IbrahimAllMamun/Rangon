/**
 * Client-side wishlist state.
 *
 * Like the cart, this is a cache of what the server said. The wishlist lives
 * behind a customer account, so an anonymous visitor simply gets an empty one —
 * a 401 here is an expected answer, not an error worth showing.
 */
"use client";

import { create } from "zustand";

import { ApiError, apiClient } from "@/lib/api/client";
import type { ShopProduct } from "@/lib/api/types";

interface WishlistEntry {
  id: string;
  product: ShopProduct;
}

interface WishlistState {
  /** Product ids the shopper has saved. */
  productIds: string[];
  loaded: boolean;
  signedIn: boolean;
  /** The in-flight request, so concurrent callers share it instead of
   *  each firing their own. A product grid mounts one `WishlistHeart` per
   *  card — without this, a page of 8 products fires 8 identical requests
   *  in the same tick. */
  inFlight: Promise<void> | null;
  load: () => Promise<void>;
  toggle: (productId: string) => Promise<void>;
}

export const useWishlist = create<WishlistState>((set, get) => ({
  productIds: [],
  loaded: false,
  signedIn: false,
  inFlight: null,

  load: () => {
    if (get().loaded) return Promise.resolve();
    const existing = get().inFlight;
    if (existing) return existing;

    const request = (async () => {
      try {
        const entries = await apiClient<WishlistEntry[]>("/shop/wishlist/");
        set({
          productIds: entries.map((entry) => entry.product.id),
          loaded: true,
          signedIn: true,
        });
      } catch (error) {
        // 401/403 means "not signed in", which is a normal state for a storefront.
        const status = error instanceof ApiError ? error.status : 0;
        set({ productIds: [], loaded: true, signedIn: status !== 401 && status !== 403 });
      } finally {
        set({ inFlight: null });
      }
    })();

    set({ inFlight: request });
    return request;
  },

  toggle: async (productId: string) => {
    const saved = get().productIds.includes(productId);
    // Optimistic: the heart must respond to the tap, and the only cost of being
    // wrong is a count that corrects itself on the next load.
    set({
      productIds: saved
        ? get().productIds.filter((id) => id !== productId)
        : [...get().productIds, productId],
    });
    try {
      if (saved) {
        await apiClient(`/shop/wishlist/?product=${productId}`, { method: "DELETE" });
      } else {
        await apiClient("/shop/wishlist/", { method: "POST", body: { product: productId } });
      }
    } catch {
      set({
        productIds: saved
          ? [...get().productIds, productId]
          : get().productIds.filter((id) => id !== productId),
      });
    }
  },
}));
