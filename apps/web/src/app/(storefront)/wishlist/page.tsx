import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ProductCard } from "@/components/commerce/product-card";
import { Button, EmptyState } from "@/components/ui/primitives";
import { apiServer, isAuthenticated } from "@/lib/api/client";
import type { ShopProduct } from "@/lib/api/types";

export const metadata: Metadata = {
  title: "Wishlist",
  robots: { index: false, follow: false },
};

export default async function WishlistPage() {
  if (!(await isAuthenticated())) redirect("/login?next=/wishlist");

  let items: { id: string; product: ShopProduct }[] = [];
  let error: string | null = null;
  try {
    items = await apiServer<{ id: string; product: ShopProduct }[]>("/shop/wishlist/");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load your wishlist.";
  }

  return (
    <div className="container-rangon py-12">
      <h1 className="font-display text-h1">Wishlist</h1>

      {error ? (
        <p role="alert" className="mt-6 text-body-sm text-[var(--error)]">
          {error}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          description="Save items you like and they will wait for you here."
          action={
            <Button asChild>
              <Link href="/shop">Browse the shop</Link>
            </Button>
          }
        />
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <ProductCard key={item.id} product={item.product} />
          ))}
        </div>
      )}
    </div>
  );
}
