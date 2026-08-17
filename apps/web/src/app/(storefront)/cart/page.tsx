import type { Metadata } from "next";

import { CartPageContent } from "@/components/commerce/cart-page-content";

export const metadata: Metadata = {
  title: "Your cart",
  robots: { index: false, follow: false },
};

export default function CartPage() {
  return (
    <div className="container-rangon max-w-5xl py-8 sm:py-12">
      <h1 className="font-display text-h1">Your cart</h1>
      <CartPageContent />
    </div>
  );
}
