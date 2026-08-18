/**
 * Client-side cart state.
 *
 * This is a *cache* of what the server said, never the source of truth: every
 * mutation round-trips and the server's totals replace whatever is here
 * (docs/business-rules.md §3.1).
 */
"use client";

import { create } from "zustand";

import { apiClient } from "@/lib/api/client";
import type { Cart } from "@/lib/api/types";

interface CartState {
  cart: Cart | null;
  loading: boolean;
  error: string | null;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  load: () => Promise<void>;
  add: (variantId: string, quantity?: number) => Promise<void>;
  update: (itemId: string, quantity: number) => Promise<void>;
  remove: (itemId: string) => Promise<void>;
  applyCoupon: (code: string) => Promise<void>;
  removeCoupon: () => Promise<void>;
}

async function run<T>(
  set: (partial: Partial<CartState>) => void,
  work: () => Promise<T>,
): Promise<T | undefined> {
  set({ loading: true, error: null });
  try {
    const result = await work();
    set({ cart: result as Cart, loading: false });
    return result;
  } catch (error) {
    set({
      loading: false,
      error: error instanceof Error ? error.message : "Something went wrong.",
    });
    return undefined;
  }
}

export const useCart = create<CartState>((set) => ({
  cart: null,
  loading: false,
  error: null,
  drawerOpen: false,

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),

  load: async () => {
    await run(set, () => apiClient<Cart>("/shop/cart/"));
  },

  add: async (variantId, quantity = 1) => {
    const result = await run(set, () =>
      apiClient<Cart>("/shop/cart/", {
        method: "POST",
        body: { variant: variantId, quantity },
      }),
    );
    if (result) set({ drawerOpen: true });
  },

  update: async (itemId, quantity) => {
    await run(set, () =>
      apiClient<Cart>("/shop/cart/", {
        method: "PATCH",
        body: { item: itemId, quantity },
      }),
    );
  },

  remove: async (itemId) => {
    await run(set, () =>
      apiClient<Cart>(`/shop/cart/?item=${itemId}`, { method: "DELETE" }),
    );
  },

  applyCoupon: async (code) => {
    await run(set, () =>
      apiClient<Cart>("/shop/cart/coupon/", { method: "POST", body: { code } }),
    );
  },

  removeCoupon: async () => {
    await run(set, () => apiClient<Cart>("/shop/cart/coupon/", { method: "DELETE" }));
  },
}));

export function useCartCount(): number {
  return useCart((state) => state.cart?.totals?.item_count ?? 0);
}
