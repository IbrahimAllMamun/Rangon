import type { Metadata } from "next";

import { CheckoutForm } from "@/components/commerce/checkout-form";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return (
    <div className="container-rangon max-w-6xl py-8 sm:py-12">
      <h1 className="font-display text-h1">Checkout</h1>
      <p className="mt-2 text-body-sm text-muted">
        All prices and totals are confirmed by our server before your order is placed.
      </p>
      <CheckoutForm />
    </div>
  );
}
