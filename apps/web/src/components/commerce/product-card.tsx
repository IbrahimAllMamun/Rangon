/**
 * Storefront product card.
 *
 * Deliberately restrained (plan §68): image, optional badge, brand, name,
 * price, colour swatches. Not every piece of metadata belongs here.
 *
 * Stays a server component: only the Quick View trigger needs the browser, so
 * it is the one part hydrated as a client island rather than the whole grid.
 */
import { ImageIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/primitives";
import { QuickViewTrigger } from "@/components/commerce/quick-view-trigger";
import type { ShopProduct } from "@/lib/api/types";
import { Reveal } from "@/components/ui/reveal";
import { cn } from "@/lib/cn";
import { vatNote } from "@/lib/commerce/vat";
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
  const taxNote = vatNote(product.tax);
  const onSale = product.variants.some(
    (variant) => variant.compare_at_price && Number(variant.compare_at_price) > Number(variant.price),
  );
  const colours = collectColours(product);

  return (
    <article
      className={cn(
        // Lift on hover: transform, shadow and a white surface, so the grid
        // never reflows and neighbouring cards do not move. Pairs with the
        // image zoom below — the card rises, the photo pushes in behind it.
        //
        // `-m-2 p-2` gives the raised card room around its content without
        // moving anything at rest: the padding is paid for out of the grid
        // gap, so the photo stays flush with the section heading above it.
        // 8px of padding around the photo's 12px corner makes a 20px outer
        // corner (`rounded-2xl`), so the two curves stay concentric.
        "group relative -m-2 rounded-2xl p-2",
        "transition-[transform,box-shadow,background-color] duration-normal ease-rangon",
        "hover:-translate-y-1 hover:bg-surface hover:shadow-md",
        className,
      )}
    >
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
            // A quiet picture icon rather than the words "No image" in grey
            // (2.3:1, WCAG 1.4.3), which read as broken across a whole grid.
            // Decorative: the product's name is right below.
            <div className="flex h-full items-center justify-center text-neutral-300">
              <ImageIcon className="size-10" strokeWidth={1.25} aria-hidden />
            </div>
          )}

          <div className="absolute left-3 top-3 flex flex-col gap-1">
            {!product.in_stock && <Badge tone="dark">Sold out</Badge>}
            {/* The number, not the word: "40% off" is a reason to look and
                "Sale" is wallpaper. Falls back to the word when the API has
                not sent a percentage (an older cached payload). */}
            {product.in_stock && onSale && (
              <Badge tone="brand">
                {product.drop_percent ? `${product.drop_percent}% off` : "Sale"}
              </Badge>
            )}
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
            {/* Under EXCLUSIVE the card's price is not the checkout price, so
                the card has to say so too — the note cannot wait for the
                product page. Nothing renders at a zero rate. */}
            {taxNote && (
              <span className="ml-1.5 text-caption font-normal text-muted">{taxNote}</span>
            )}
          </p>
        </div>
      </Link>

      {/* A sibling of the link, not nested inside it: a button inside an
          anchor is invalid HTML and confuses both the browser and a screen
          reader. Positioned against the card, inset by the card's `p-2` so it
          shares the image's box. */}
      <QuickViewTrigger product={product} />

      {/* Which colours exist, not a picker: nothing here is selectable, so
          there is no "active" dot to mark. The count says so in words; the
          colour is chosen on the product page. */}
      {colours.length > 1 && (
        <div className="mt-2 flex items-center gap-2">
          <ul className="flex items-center gap-1.5" aria-label="Available colours">
            {colours.slice(0, 5).map((colour) => (
              <li key={colour.label} title={colour.label}>
                <span
                  className="block size-3.5 rounded-full border border-neutral-300"
                  style={{ backgroundColor: colour.swatch || "var(--neutral-200)" }}
                />
                <span className="sr-only">{colour.label}</span>
              </li>
            ))}
          </ul>
          <span className="text-caption text-muted" aria-hidden>
            {colours.length} colours
          </span>
        </div>
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
