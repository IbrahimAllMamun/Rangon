"use client";

/**
 * Quick View: choose options without leaving the grid.
 *
 * The problem it solves is narrow and real. A card's "Add to cart" has to pick
 * a variant, and for anything with more than one it can only guess — so a
 * shopper browsing a grid either gets a colour they did not choose or has to
 * open the product page, choose, and come back. Quick View is the third
 * option: the card says "Choose options" and the picker comes to them.
 *
 * A single-variant product needs none of this and does not get it — the card
 * adds straight to the cart, because a modal that asks nothing is a modal that
 * wastes a click.
 *
 * Deliberately not a second product page. It carries the photograph, the
 * price, the axes and one button. Everything else — description, reviews,
 * delivery, the size guide — is a reason to open the real page, and the modal
 * links there rather than growing.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Button } from "@/components/ui/primitives";
import type { ShopProduct, ShopVariant } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { buildAxes, defaultVariant, resolveVariant } from "@/lib/commerce/variants";
import { money } from "@/lib/format";
import { useCart } from "@/lib/store/cart";

export function QuickView({
  product,
  open,
  onOpenChange,
}: {
  product: ShopProduct;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { add } = useCart();
  const [selected, setSelected] = useState<ShopVariant | null>(null);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset each time it opens: a shopper who closed on "Navy / M" and reopened
  // from a different card should not inherit the last pick.
  useEffect(() => {
    if (open) {
      setSelected(defaultVariant(product));
      setFailed(false);
    }
  }, [open, product]);

  const axes = buildAxes(product.variants);
  const image =
    product.images.find(
      (candidate) =>
        candidate.color && selected?.attributes[candidate.color.code]?.value === candidate.color.value,
    ) ?? product.images[0];

  async function addToCart() {
    if (!selected) return;
    setAdding(true);
    setFailed(false);
    try {
      await add(selected.id, 1);
      onOpenChange(false);
    } catch {
      // Stay open and say so. Closing on a failure would look like success.
      setFailed(true);
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/50 animate-fade-in motion-reduce:animate-none" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(48rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-surface p-5 shadow-lg animate-fade-in focus:outline-none motion-reduce:animate-none sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="font-display text-h4">{product.name}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close quick view">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          {/* Radix warns without one, and a screen reader deserves to know what
              this dialog is for beyond its title. */}
          <Dialog.Description className="sr-only">
            Choose options for {product.name} and add it to your cart.
          </Dialog.Description>

          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div className="relative aspect-product overflow-hidden rounded-lg bg-neutral-100">
              {image ? (
                <Image
                  src={image.url}
                  alt={image.alt || product.name}
                  fill
                  sizes="(max-width: 640px) 90vw, 22rem"
                  className="object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-caption text-neutral-400">
                  No image
                </div>
              )}
            </div>

            <div className="min-w-0">
              <p className="tabular text-h3 font-bold">
                {money(selected?.price ?? product.price_min)}
              </p>
              {selected?.compare_at_price &&
                Number(selected.compare_at_price) > Number(selected.price) && (
                  <p className="tabular mt-1 text-body-sm text-muted line-through">
                    {money(selected.compare_at_price)}
                  </p>
                )}

              <div className="mt-4 space-y-4">
                {axes.map((axis) => (
                  <fieldset key={axis.code}>
                    <legend className="text-body-sm font-semibold">
                      {axis.name}
                      {selected?.attributes[axis.code] && (
                        <span className="ml-2 font-normal text-muted">
                          {selected.attributes[axis.code].label}
                        </span>
                      )}
                    </legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {axis.values.map((value) => {
                        const match = resolveVariant(
                          product.variants,
                          selected,
                          axis.code,
                          value.value,
                        );
                        const isSelected =
                          selected?.attributes[axis.code]?.value === value.value;
                        const dead = !match.variant;
                        const soldOut = match.exact && match.variant?.in_stock === false;

                        return (
                          <button
                            key={value.value}
                            type="button"
                            disabled={dead}
                            onClick={() => match.variant && setSelected(match.variant)}
                            aria-pressed={isSelected}
                            aria-label={
                              dead
                                ? `${value.label} — not available`
                                : soldOut
                                  ? `${value.label} — out of stock`
                                  : value.label
                            }
                            className={cn(
                              "min-w-11 rounded-md border px-3 py-2 text-body-sm font-medium",
                              isSelected
                                ? "border-brand-500 bg-brand-50 text-brand-700"
                                : "border-neutral-300 hover:bg-neutral-100",
                              dead && "text-neutral-400 line-through",
                              soldOut && "text-neutral-400",
                              !match.exact && !dead && "border-dashed text-neutral-600",
                            )}
                          >
                            {value.label}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>

              {selected && selected.available > 0 && selected.available <= 5 && (
                <p className="mt-3 text-caption text-[var(--warning)]">
                  Only {selected.available} left
                </p>
              )}
              {selected && selected.available <= 0 && (
                <p className="mt-3">
                  <Badge tone="dark">Sold out</Badge>
                </p>
              )}
              {failed && (
                <p role="alert" className="mt-3 text-body-sm text-[var(--error)]">
                  That could not be added. Please try again.
                </p>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button
                  onClick={addToCart}
                  disabled={!selected || selected.available <= 0 || adding}
                >
                  {adding && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Add to cart
                </Button>
                <Link
                  href={`/product/${product.slug}`}
                  className="text-body-sm font-medium text-brand-600 hover:underline"
                >
                  Full details
                </Link>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
