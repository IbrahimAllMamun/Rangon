"use client";

import { Minus, Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Card, EmptyState, Input, Spinner } from "@/components/ui/primitives";
import { money } from "@/lib/format";
import { useCart } from "@/lib/store/cart";

export function CartPageContent() {
  const { cart, loading, error, load, update, remove, applyCoupon, removeCoupon } = useCart();
  const [code, setCode] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !cart) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (!cart || cart.items.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        description="Once you add something, it will appear here."
        action={
          <Button asChild>
            <Link href="/shop">Browse the shop</Link>
          </Button>
        }
      />
    );
  }

  async function submitCoupon(event: React.FormEvent) {
    event.preventDefault();
    setCouponError(null);
    try {
      await applyCoupon(code);
      setCode("");
    } catch {
      setCouponError("That coupon could not be applied.");
    }
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
      <div>
        {cart.issues.length > 0 && (
          <div role="alert" className="mb-4 rounded-md border border-[var(--warning)] bg-[var(--warning-bg)] p-4">
            <h2 className="text-body-sm font-semibold text-[var(--warning)]">
              Some items need your attention
            </h2>
            <ul className="mt-1 space-y-1">
              {cart.issues.map((issue, index) => (
                <li key={index} className="text-body-sm">
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {cart.items.map((item) => (
              <li key={item.id} className="flex gap-4 p-4">
                <Link
                  href={`/product/${item.product_slug}`}
                  className="relative size-24 shrink-0 overflow-hidden rounded-md bg-neutral-100"
                >
                  {item.image && (
                    <Image src={item.image} alt="" fill sizes="96px" className="object-cover" />
                  )}
                </Link>

                <div className="min-w-0 flex-1">
                  <Link
                    href={`/product/${item.product_slug}`}
                    className="text-body font-medium hover:text-brand-600"
                  >
                    {item.product_name}
                  </Link>
                  <p className="text-body-sm text-muted">
                    {item.variant_label} · {item.sku}
                  </p>
                  <p className="tabular mt-1 text-body font-semibold">{money(item.unit_price)}</p>

                  <div className="mt-3 flex items-center gap-3">
                    <div className="inline-flex items-center rounded-md border border-neutral-300">
                      <button
                        type="button"
                        onClick={() => void update(item.id, item.quantity - 1)}
                        className="grid size-9 place-items-center hover:bg-neutral-100"
                        aria-label={`Decrease quantity of ${item.product_name}`}
                      >
                        <Minus className="size-4" aria-hidden />
                      </button>
                      <span className="tabular w-10 text-center">{item.quantity}</span>
                      <button
                        type="button"
                        onClick={() => void update(item.id, item.quantity + 1)}
                        className="grid size-9 place-items-center hover:bg-neutral-100 disabled:opacity-40"
                        aria-label={`Increase quantity of ${item.product_name}`}
                        disabled={item.quantity >= item.available}
                      >
                        <Plus className="size-4" aria-hidden />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => void remove(item.id)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-body-sm text-neutral-600 hover:bg-neutral-100 hover:text-[var(--error)]"
                    >
                      <Trash2 className="size-4" aria-hidden /> Remove
                    </button>
                  </div>
                </div>

                <p className="tabular shrink-0 text-body font-semibold">
                  {money(Number(item.unit_price) * item.quantity)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <Card className="p-4">
          <h2 className="text-h4">Summary</h2>

          <form onSubmit={submitCoupon} className="mt-4">
            <label htmlFor="coupon" className="text-body-sm font-medium">
              Coupon code
            </label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="coupon"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="RANGON10"
                invalid={Boolean(couponError)}
              />
              <Button type="submit" variant="secondary" disabled={!code.trim()}>
                Apply
              </Button>
            </div>
            {couponError && (
              <p className="mt-1 text-caption font-medium text-[var(--error)]">{couponError}</p>
            )}
            {cart.coupon_code && (
              <p className="mt-2 flex items-center justify-between rounded-md bg-[var(--success-bg)] px-3 py-2 text-body-sm">
                <span className="font-medium text-[var(--success)]">{cart.coupon_code} applied</span>
                <button
                  type="button"
                  onClick={() => void removeCoupon()}
                  className="text-caption underline"
                >
                  Remove
                </button>
              </p>
            )}
          </form>

          <dl className="mt-4 space-y-2 border-t border-border pt-4 text-body-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular">{money(cart.totals.subtotal)}</dd>
            </div>
            {Number(cart.totals.discount_total) > 0 && (
              <div className="flex justify-between text-[var(--success)]">
                <dt>Discount</dt>
                <dd className="tabular">− {money(cart.totals.discount_total)}</dd>
              </div>
            )}
            {Number(cart.totals.tax_total) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">VAT</dt>
                <dd className="tabular">{money(cart.totals.tax_total)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between border-t border-border pt-3">
              <dt className="text-body font-semibold">Total</dt>
              <dd className="tabular text-h3 font-bold">{money(cart.totals.grand_total)}</dd>
            </div>
          </dl>
          <p className="mt-1 text-caption text-muted">Delivery calculated at checkout.</p>

          {error && (
            <p role="alert" className="mt-3 text-body-sm text-[var(--error)]">
              {error}
            </p>
          )}

          <Button asChild size="lg" full className="mt-4">
            <Link href="/checkout">Checkout</Link>
          </Button>
        </Card>
      </aside>
    </div>
  );
}
