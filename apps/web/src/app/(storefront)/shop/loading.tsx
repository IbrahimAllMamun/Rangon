import { ProductCardSkeleton } from "@/components/commerce/product-card";

/** Streamed while the listing and its facets are fetched. */
export default function ShopLoading() {
  return (
    <div className="container-rangon py-8 sm:py-10">
      <div className="skeleton h-9 w-64 rounded" />

      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_1fr]">
        <div className="hidden space-y-4 lg:block">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="space-y-2">
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton h-9 w-full rounded" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <ProductCardSkeleton key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
