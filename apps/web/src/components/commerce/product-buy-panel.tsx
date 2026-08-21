"use client";

import { Check, Minus, Plus, ShoppingBag } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge, Button } from "@/components/ui/primitives";
import type { ShopProduct, ShopVariant } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { buildAxes, findVariant } from "@/lib/commerce/variants";
import { money } from "@/lib/format";
import { useCart } from "@/lib/store/cart";

/**
 * Variant selection + add to cart.
 *
 * Selection is **controlled** by `ProductDetail`, because picking a colour also
 * moves the gallery (docs/architecture/product-media.md §4).
 *
 * Availability shown here is advisory; the server re-checks stock under a lock
 * at checkout (docs/business-rules.md §1.4). Options are never hidden — a
 * shopper needs to see that the size exists before concluding it does not.
 */
export function ProductBuyPanel({
  product,
  selected,
  onSelect,
}: {
  product: ShopProduct;
  selected: ShopVariant | null;
  onSelect: (variant: ShopVariant) => void;
}) {
  const { add, loading } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  // Group the variant-defining attributes so we can render one row per axis.
  const axes = useMemo(() => buildAxes(product.variants), [product.variants]);

  const rating = product.reviews?.average ?? null;
  const max = selected?.available ?? 0;
  const compareAt = selected?.compare_at_price ? Number(selected.compare_at_price) : 0;
  const price = selected ? Number(selected.price) : Number(product.price_min);
  const onSale = compareAt > price;

  async function handleAdd() {
    if (!selected) return;
    await add(selected.id, quantity);
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  }

  return (
    <div className="lg:sticky lg:top-24 lg:self-start">
      {product.brand && (
        <p className="text-caption uppercase tracking-wide text-muted">{product.brand.name}</p>
      )}
      <h1 className="font-display mt-1 text-h1">{product.name}</h1>

      {rating !== null && product.reviews?.count ? (
        <p className="mt-2 text-body-sm text-muted">
          {rating.toFixed(1)} ★ · {product.reviews.count} review
          {product.reviews.count === 1 ? "" : "s"}
        </p>
      ) : null}

      <div className="mt-4 flex items-baseline gap-3">
        <p className="tabular text-h2 font-bold">{money(price)}</p>
        {onSale && (
          <>
            <p className="tabular text-body-lg text-muted line-through">{money(compareAt)}</p>
            <Badge tone="brand">Save {money(compareAt - price)}</Badge>
          </>
        )}
      </div>

      {product.short_description && (
        <p className="mt-4 text-body text-neutral-700">{product.short_description}</p>
      )}

      <div className="mt-6 space-y-5">
        {axes.map((axis) => (
          <fieldset key={axis.code}>
            <legend className="text-body-sm font-semibold">
              {axis.name}
              {/* The chosen value is printed, so a swatch is never the only
                  carrier of the answer (CLAUDE.md §11). */}
              {selected?.attributes[axis.code] && (
                <span className="ml-2 font-normal text-muted">
                  {selected.attributes[axis.code].label}
                </span>
              )}
            </legend>

            <div className="mt-2 flex flex-wrap gap-2">
              {axis.values.map((value) => {
                const candidate = findVariant(product.variants, selected, axis.code, value.value);
                const isSelected = selected?.attributes[axis.code]?.value === value.value;
                const state = availability(candidate);
                const reason = describe(value.label, state);

                if (axis.kind === "COLOR") {
                  return (
                    <button
                      key={value.value}
                      type="button"
                      onClick={() => candidate && onSelect(candidate)}
                      disabled={state === "dead"}
                      aria-pressed={isSelected}
                      aria-label={reason}
                      title={reason}
                      className={cn(
                        "relative size-10 rounded-full border-2 transition-transform duration-fast",
                        isSelected ? "border-brand-500 scale-110" : "border-neutral-300",
                        state !== "fits" && "opacity-40",
                      )}
                      style={{ backgroundColor: value.swatch || "var(--neutral-200)" }}
                    />
                  );
                }

                return (
                  <button
                    key={value.value}
                    type="button"
                    onClick={() => candidate && onSelect(candidate)}
                    disabled={state === "dead"}
                    aria-pressed={isSelected}
                    aria-label={reason}
                    className={cn(
                      "min-w-12 rounded-md border px-4 py-2.5 text-body-sm font-medium transition-colors duration-fast",
                      isSelected
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-neutral-300 hover:bg-neutral-100",
                      // Struck through only when it cannot be bought at all.
                      state === "dead" && "text-neutral-400 line-through",
                      state === "soldOut" && "text-neutral-400",
                    )}
                  >
                    {value.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <div>
          <label htmlFor="quantity" className="text-body-sm font-semibold">
            Quantity
          </label>
          <div className="mt-2 inline-flex items-center rounded-md border border-neutral-300">
            <button
              type="button"
              onClick={() => setQuantity((value) => Math.max(1, value - 1))}
              className="grid size-11 place-items-center text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
              aria-label="Decrease quantity"
              disabled={quantity <= 1}
            >
              <Minus className="size-4" aria-hidden />
            </button>
            <input
              id="quantity"
              type="number"
              min={1}
              max={Math.max(max, 1)}
              value={quantity}
              onChange={(event) =>
                setQuantity(Math.min(Math.max(1, Number(event.target.value) || 1), Math.max(max, 1)))
              }
              className="tabular h-11 w-14 border-x border-neutral-300 text-center text-body [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button
              type="button"
              onClick={() => setQuantity((value) => Math.min(max || 1, value + 1))}
              className="grid size-11 place-items-center text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
              aria-label="Increase quantity"
              disabled={quantity >= max}
            >
              <Plus className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      <div aria-live="polite" className="mt-4 text-body-sm">
        {!selected ? null : selected.available <= 0 ? (
          <p className="font-medium text-[var(--error)]">Out of stock</p>
        ) : selected.available <= 5 ? (
          <p className="font-medium text-[var(--warning)]">
            Only {selected.available} left in stock
          </p>
        ) : (
          <p className="text-[var(--success)]">In stock</p>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <Button
          size="lg"
          full
          onClick={handleAdd}
          loading={loading}
          disabled={!selected || selected.available <= 0}
        >
          {added ? (
            <>
              <Check aria-hidden /> Added to cart
            </>
          ) : (
            <>
              <ShoppingBag aria-hidden /> Add to cart
            </>
          )}
        </Button>
      </div>

      {selected && <p className="mt-3 text-caption text-muted">SKU: {selected.sku}</p>}
    </div>
  );
}

/**
 * Four states, not two: "out of stock" and "we do not make that combination"
 * are different facts, and a shopper deserves to be told which one they hit.
 *
 *  - `fits`    — buyable with the current picks
 *  - `soldOut` — the combination exists but has no stock; still clickable, so
 *                the shopper can land on it and read why
 *  - `dead`    — nothing carries this value at all; the only disabled state
 */
type Availability = "fits" | "soldOut" | "dead";

function availability(candidate: ShopVariant | undefined): Availability {
  if (!candidate) return "dead";
  return candidate.in_stock ? "fits" : "soldOut";
}

function describe(label: string, state: Availability): string {
  if (state === "fits") return label;
  if (state === "soldOut") return `${label} — out of stock`;
  return `${label} — not available`;
}
