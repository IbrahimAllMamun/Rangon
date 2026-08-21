/**
 * Storefront product card.
 *
 * Deliberately restrained (plan §68): image, optional badge, brand, name,
 * price, colour swatches. Not every piece of metadata belongs here.
 *
 * Stays a server component: only the wishlist heart needs the browser, so it
 * is the one part hydrated as a client island rather than the whole grid.
 */
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/primitives";
import { WishlistHeart } from "@/components/commerce/wishlist-heart";
import type { ShopProduct } from "@/lib/api/types";
import { Reveal } from "@/components/ui/reveal";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

export function ProductCard({
  product,
  priority = false,
  className,
}: {
  product: ShopProduct;
  priority?: boolean;
  className?: string;
}) {
  const image = product.images[0];
  const hasRange = product.price_min !== product.price_max;
  const onSale = product.variants.some(
    (variant) => variant.compare_at_price && Number(variant.compare_at_price) > Number(variant.price),
  );
  const colours = collectColours(product);

  return (
    <article
      className={cn(
        // Lift on hover: transform + shadow only, so the grid never reflows and
        // neighbouring cards do not move. Pairs with the image zoom below —
        // the card rises, the photo pushes in slightly behind it.
        "group relative transition-[transform,box-shadow] duration-normal ease-rangon",
        "hover:-translate-y-1 hover:shadow-md",
        className,
      )}
    >
      {/* A sibling of the link, not nested inside it — a button inside an
          anchor is invalid HTML and confuses both the browser and a screen
          reader. Absolutely positioned against `article`, which shares the
          image's top-right corner exactly. */}
      <WishlistHeart productId={product.id} name={product.name} />

      <Link
        href={`/product/${product.slug}`}
        className="block focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] rounded-lg"
      >
        <div className="relative aspect-product overflow-hidden rounded-lg bg-neutral-100">
          {image ? (
            <Image
              src={image.url}
              alt={image.alt || product.name}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              priority={priority}
              className="object-cover transition-transform duration-slow ease-rangon group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-caption text-neutral-400">
              No image
            </div>
          )}

          <div className="absolute left-3 top-3 flex flex-col gap-1">
            {!product.in_stock && <Badge tone="dark">Sold out</Badge>}
            {product.in_stock && onSale && <Badge tone="brand">Sale</Badge>}
          </div>
        </div>

        <div className="mt-3 space-y-1">
          {product.brand && (
            <p className="text-caption uppercase tracking-wide text-muted">{product.brand.name}</p>
          )}
          <h3 className="line-clamp-2 text-body-sm font-medium text-neutral-900 group-hover:text-brand-600">
            {product.name}
          </h3>
          <p className="tabular text-body font-semibold text-neutral-900">
            {hasRange
              ? `${money(product.price_min)} – ${money(product.price_max, false)}`
              : money(product.price_min)}
          </p>
        </div>
      </Link>

      {colours.length > 1 && (
        <ul className="mt-2 flex items-center gap-1.5" aria-label="Available colours">
          {colours.slice(0, 5).map((colour) => (
            <li key={colour.label} title={colour.label}>
              <span
                className="block size-3.5 rounded-full border border-neutral-300"
                style={{ backgroundColor: colour.swatch || "var(--neutral-200)" }}
              />
              <span className="sr-only">{colour.label}</span>
            </li>
          ))}
          {colours.length > 5 && (
            <li className="text-caption text-muted">+{colours.length - 5}</li>
          )}
        </ul>
      )}
    </article>
  );
}

function collectColours(product: ShopProduct) {
  const seen = new Map<string, { label: string; swatch: string }>();
  for (const variant of product.variants) {
    const colour = variant.attributes.color ?? variant.attributes.shade;
    if (colour && !seen.has(colour.value)) {
      seen.set(colour.value, { label: colour.label, swatch: colour.swatch });
    }
  }
  return [...seen.values()];
}

export function ProductCardSkeleton() {
  return (
    <div className="space-y-3">
      <div className="skeleton aspect-product rounded-lg" />
      <div className="skeleton h-3 w-1/3 rounded" />
      <div className="skeleton h-4 w-3/4 rounded" />
      <div className="skeleton h-4 w-1/4 rounded" />
    </div>
  );
}

export function ProductGrid({
  products,
  priorityCount = 4,
}: {
  products: ShopProduct[];
  priorityCount?: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
      {products.map((product, index) => (
        // Capped at 400ms total: a 40-product page must not make the last card
        // wait four seconds to exist. Reveal keeps its space from first paint,
        // so this stagger costs nothing in layout shift.
        <Reveal key={product.id} delay={Math.min(index * 50, 400)}>
          <ProductCard product={product} priority={index < priorityCount} />
        </Reveal>
      ))}
    </div>
  );
}
