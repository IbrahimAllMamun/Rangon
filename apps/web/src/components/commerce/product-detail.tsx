"use client";

import { useMemo, useState } from "react";

import { ProductBuyPanel } from "@/components/commerce/product-buy-panel";
import { ProductGallery } from "@/components/commerce/product-gallery";
import type { ShopProduct, ShopVariant } from "@/lib/api/types";
import { colourAxisCode, defaultVariant, findVariant } from "@/lib/commerce/variants";

/**
 * Owns the two pieces of state the gallery and the buy panel share.
 *
 * They are siblings with no common client parent, so neither could drive the
 * other; this thin wrapper is that parent. Deliberately not Zustand — CLAUDE.md
 * reserves that for app-wide state, and this is two components on one page. The
 * route above stays a server component, so metadata and JSON-LD are untouched.
 *
 * Colour and image move together in both directions (product-media.md §4):
 *  - picking a colour moves the main image to that colour's first photo;
 *  - clicking another colour's thumbnail selects that colour, repairing the
 *    other axes the same way the swatches do.
 * Shared images (`color: null`) never change the selection.
 */
export function ProductDetail({ product }: { product: ShopProduct }) {
  const [selected, setSelected] = useState<ShopVariant | null>(() => defaultVariant(product));
  const [activeImage, setActiveImage] = useState(0);

  const colourCode = useMemo(() => colourAxisCode(product), [product]);

  /** First image showing a colour, or -1 when that colour has no photograph. */
  function firstImageOf(colourValue: string | undefined): number {
    if (!colourValue) return -1;
    return product.images.findIndex((image) => image.color?.value === colourValue);
  }

  function selectVariant(variant: ShopVariant) {
    setSelected(variant);
    if (!colourCode) return;
    const index = firstImageOf(variant.attributes[colourCode]?.value);
    if (index >= 0) setActiveImage(index);
  }

  function selectImage(index: number) {
    setActiveImage(index);

    const colour = product.images[index]?.color;
    // A shared image — flat-lay, size chart — belongs to every colour and must
    // not move the selection.
    if (!colour || !colourCode) return;
    if (selected?.attributes[colourCode]?.value === colour.value) return;

    const variant = findVariant(product.variants, selected, colourCode, colour.value);
    if (variant) setSelected(variant);
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
      <ProductGallery
        images={product.images}
        productName={product.name}
        activeIndex={activeImage}
        onSelect={selectImage}
      />
      <ProductBuyPanel product={product} selected={selected} onSelect={selectVariant} />
    </div>
  );
}
