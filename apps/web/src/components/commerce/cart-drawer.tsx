"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Minus, Plus, ShoppingBag, Trash2, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import LogoLoader from "@/components/brand/LogoLoader";
import { Button, EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { useCart } from "@/lib/store/cart";
import { money } from "@/lib/format";

export function CartDrawer() {
  const { cart, loading, drawerOpen, setDrawerOpen, update, remove } = useCart();
  const items = cart?.items ?? [];

  return (
    <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/40 animate-fade-in" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col bg-surface shadow-lg animate-slide-in-right focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <Dialog.Title className="text-h4 font-semibold">
              Your cart{cart?.totals?.item_count ? ` (${cart.totals.item_count})` : ""}
            </Dialog.Title>
            {/* Radix warns without this, and a screen reader otherwise opens the
                drawer with nothing but its title to go on. */}
            <Dialog.Description className="sr-only">
              Items in your cart, with quantity controls and the order total.
            </Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close cart">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          {cart?.issues?.length ? (
            <div role="alert" className="border-b border-border bg-[var(--warning-bg)] px-5 py-3">
              <ul className="space-y-1">
                {cart.issues.map((issue, index) => (
                  <li key={index} className="text-body-sm text-[var(--warning)]">
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Two different waits, two different treatments. An empty drawer that
              is still fetching gets the brand loader, because there is nothing
              else to look at. A drawer with items re-pricing after a quantity
              change keeps its rows and dims them — swapping a full cart for a
              spinner loses the shopper's place for a 200 ms round trip. */}
          <div
            className={cn("flex-1 overflow-y-auto px-5", loading && items.length > 0 && "is-stale")}
            aria-busy={loading || undefined}
          >
            {loading && !items.length ? (
              <div className="flex h-40 items-center justify-center">
                <LogoLoader size={64} label="Loading your cart" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<ShoppingBag className="size-10" aria-hidden />}
                title="Your cart is empty"
                description="Browse the shop and add something you like."
                action={
                  <Dialog.Close asChild>
                    <Button asChild>
                      <Link href="/shop">Start shopping</Link>
                    </Button>
                  </Dialog.Close>
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {items.map((item) => (
                  <li key={item.id} className="flex gap-3 py-4">
                    <div className="relative size-20 shrink-0 overflow-hidden rounded-md bg-neutral-100">
                      {item.image && (
                        <Image
                          src={item.image}
                          alt={item.product_name}
                          fill
                          sizes="80px"
                          className="object-cover"
                        />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <Dialog.Close asChild>
                        <Link
                          href={`/product/${item.product_slug}`}
                          className="line-clamp-2 text-body-sm font-medium hover:text-brand-600"
                        >
                          {item.product_name}
                        </Link>
                      </Dialog.Close>
                      {item.variant_label && (
                        <p className="text-caption text-muted">{item.variant_label}</p>
                      )}
                      <p className="tabular mt-1 text-body-sm font-semibold">
                        {money(item.unit_price)}
                      </p>

                      <div className="mt-2 flex items-center gap-2">
                        <div className="inline-flex items-center rounded-md border border-neutral-300">
                          <button
                            type="button"
                            onClick={() => void update(item.id, item.quantity - 1)}
                            className="grid size-8 place-items-center text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
                            aria-label={`Decrease quantity of ${item.product_name}`}
                            disabled={loading}
                          >
                            <Minus className="size-3.5" aria-hidden />
                          </button>
                          <span className="tabular w-9 text-center text-body-sm" aria-live="polite">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => void update(item.id, item.quantity + 1)}
                            className="grid size-8 place-items-center text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
                            aria-label={`Increase quantity of ${item.product_name}`}
                            disabled={loading || item.quantity >= item.available}
                          >
                            <Plus className="size-3.5" aria-hidden />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => void remove(item.id)}
                          className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-[var(--error)]"
                          aria-label={`Remove ${item.product_name}`}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>

                      {item.available < item.quantity && (
                        <p className="mt-1 text-caption text-[var(--error)]">
                          Only {item.available} left in stock
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {items.length > 0 && (
            <div className="border-t border-border px-5 py-4">
              <dl className="space-y-1.5 text-body-sm">
                <Row label="Subtotal" value={money(cart?.totals.subtotal)} />
                {Number(cart?.totals.discount_total ?? 0) > 0 && (
                  <Row
                    label="Discount"
                    value={`− ${money(cart?.totals.discount_total)}`}
                    tone="success"
                  />
                )}
                {Number(cart?.totals.tax_total ?? 0) > 0 && (
                  <Row label="VAT" value={money(cart?.totals.tax_total)} />
                )}
              </dl>

              <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
                <span className="text-body font-semibold">Total</span>
                <span className="tabular text-h4 font-bold">{money(cart?.totals.grand_total)}</span>
              </div>
              <p className="mt-1 text-caption text-muted">Delivery calculated at checkout.</p>

              <Dialog.Close asChild>
                <Button asChild size="lg" full className="mt-4">
                  <Link href="/checkout">Checkout</Link>
                </Button>
              </Dialog.Close>
              <Dialog.Close asChild>
                <Button asChild variant="ghost" full className="mt-2">
                  <Link href="/cart">View full cart</Link>
                </Button>
              </Dialog.Close>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success";
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular ${tone === "success" ? "text-[var(--success)]" : ""}`}>{value}</dd>
    </div>
  );
}
