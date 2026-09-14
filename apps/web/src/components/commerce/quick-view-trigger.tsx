"use client";

/**
 * The card action that opens Quick View, as its own client island.
 *
 * `ProductCard` is a server component on purpose — only the wishlist heart is
 * hydrated — so the open state and the dialog live here rather than turning
 * the whole grid into client JavaScript for a button most shoppers never press.
 *
 * What the button says is the decision, not the styling:
 *
 *  - **more than one variant** → "Choose options". The card cannot add to the
 *    cart without guessing a colour or a size, and guessing is how a shopper
 *    ends up returning something.
 *  - **exactly one** → "Add to cart", straight in. A modal that asks nothing
 *    is a modal that wastes a click.
 *  - **sold out** → nothing at all. The card already says so.
 */

import { Loader2, Plus, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { QuickView } from "@/components/commerce/quick-view";
import type { ShopProduct } from "@/lib/api/types";
import { useCart } from "@/lib/store/cart";

export function QuickViewTrigger({ product }: { product: ShopProduct }) {
  const { add } = useCart();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  if (!product.in_stock) return null;

  const sellable = product.variants.filter((variant) => variant.in_stock);
  const single = sellable.length === 1 ? sellable[0] : null;

  async function addSingle() {
    if (!single) return;
    setAdding(true);
    try {
      await add(single.id, 1);
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      {/*
        The box mirrors the image's geometry exactly — `inset-x-0 top-0` plus
        the same `aspect-product` — so the pill sits along the bottom of the
        photograph rather than at the bottom of the whole card, where it would
        cover the price. `pointer-events-none` on the frame keeps the card's
        link clickable everywhere the button is not.

        Revealed on hover on a pointer device, always visible on touch: there
        is no hover on a phone, and a control that only appears on hover is a
        control a phone shopper never finds.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex aspect-product items-end p-2 opacity-100 transition-opacity duration-fast motion-reduce:transition-none sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <button
          type="button"
          onClick={single ? addSingle : () => setOpen(true)}
          disabled={adding}
          className="pointer-events-auto flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900/95 px-3 py-2.5 text-body-sm font-semibold text-white shadow-sm hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] disabled:opacity-60"
        >
          {adding ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : single ? (
            <Plus className="size-4" aria-hidden />
          ) : (
            <SlidersHorizontal className="size-4" aria-hidden />
          )}
          {single ? "Add to cart" : "Choose options"}
        </button>
      </div>

      {!single && <QuickView product={product} open={open} onOpenChange={setOpen} />}
    </>
  );
}
