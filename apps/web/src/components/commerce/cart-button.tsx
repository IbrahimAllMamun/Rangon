"use client";

import { ShoppingBag } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { CartDrawer } from "@/components/commerce/cart-drawer";
import { useCart } from "@/lib/store/cart";

export function CartButton() {
  const { load, setDrawerOpen } = useCart();
  const count = useCart((state) => state.cart?.totals?.item_count ?? 0);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="relative rounded-md p-2 text-neutral-700 transition-colors duration-fast hover:bg-neutral-100"
        aria-label={count > 0 ? `Cart, ${count} item${count === 1 ? "" : "s"}` : "Cart, empty"}
      >
        <ShoppingBag className="size-5" aria-hidden />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[18px] items-center justify-center rounded-full bg-brand-500 px-1 text-[11px] font-semibold leading-[18px] text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      <CartDrawer />
      <noscript>
        <Link href="/cart" className="p-2 text-body-sm underline">
          Cart
        </Link>
      </noscript>
    </>
  );
}
