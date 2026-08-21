"use client";

import { Loader2, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/primitives";
import { type Paginated, apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
import { money } from "@/lib/format";

export interface PickableVariant {
  id: string;
  sku: string;
  barcode: string | null;
  product_name: string;
  label: string;
  price: string;
  cost: string;
}

/** How long to wait after the last keystroke before searching. */
const DEBOUNCE_MS = 220;

/**
 * Find a variant by SKU, barcode or product name.
 *
 * Debounced for the same reason the POS scan field is (D12): a keyboard-wedge
 * scanner types a 13-character barcode in about 100 ms, and searching per
 * keystroke issues a request per character.
 *
 * Deliberately hits `GET /variants/?search=` rather than the POS grid search.
 * The POS endpoint needs `sales.create` — which a stock manager may not hold —
 * and shows only ACTIVE products, whereas a buyer routinely orders stock for a
 * product that has not been published yet.
 */
export function VariantPicker({
  onPick,
  exclude,
  label = "Add a product",
  autoFocus,
}: {
  onPick: (variant: PickableVariant) => void;
  /** Variant ids already on the order, so they can be shown as unavailable. */
  exclude?: Set<string>;
  label?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickableVariant[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Only the newest search may write results: a slow early request must not
  // overwrite a fast later one.
  const requestId = useRef(0);

  const [search, cancelSearch] = useDebouncedCallback(async (term: string) => {
    const id = ++requestId.current;
    setSearching(true);
    setError(null);
    try {
      const page = await apiClient<Paginated<PickableVariant>>(
        `/variants/?search=${encodeURIComponent(term)}&page_size=20`,
      );
      if (id === requestId.current) setResults(page.results);
    } catch {
      if (id === requestId.current) {
        setResults([]);
        setError("Could not search. Try again.");
      }
    } finally {
      if (id === requestId.current) setSearching(false);
    }
  }, DEBOUNCE_MS);

  useEffect(() => {
    function onClickAway(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, []);

  function onChange(value: string) {
    setQuery(value);
    setOpen(true);
    if (value.trim().length < 2) {
      cancelSearch();
      setResults(null);
      setSearching(false);
      return;
    }
    search(value.trim());
  }

  function pick(variant: PickableVariant) {
    onPick(variant);
    setQuery("");
    setResults(null);
    setOpen(false);
    cancelSearch();
  }

  const listId = "variant-picker-results";

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1.5 block text-body-sm font-medium" htmlFor="variant-search">
        {label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input
          id="variant-search"
          value={query}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            // Enter on an exact single match is the scanner's path.
            if (event.key === "Enter") {
              event.preventDefault();
              if (results?.length === 1) pick(results[0]);
            }
          }}
          placeholder="Scan a barcode, or type a SKU or product name"
          autoComplete="off"
          autoFocus={autoFocus}
          className="pl-9"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {searching && (
          <Loader2
            className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted"
            aria-hidden
          />
        )}
      </div>

      {/* Screen readers get the count; sighted users see the list. */}
      <p className="sr-only" role="status">
        {results === null ? "" : `${results.length} matching products`}
      </p>

      {open && (results !== null || error) && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching products"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
        >
          {error && (
            <li className="px-4 py-3 text-body-sm text-[var(--error)]" role="alert">
              {error}
            </li>
          )}
          {!error && results?.length === 0 && (
            <li className="px-4 py-3 text-body-sm text-muted">
              Nothing matches “{query}”. Check the SKU, or create the product first.
            </li>
          )}
          {results?.map((variant) => {
            const already = exclude?.has(variant.id) ?? false;
            return (
              <li key={variant.id} role="option" aria-selected={false} aria-disabled={already}>
                <button
                  type="button"
                  disabled={already}
                  onClick={() => pick(variant)}
                  className={cn(
                    "flex w-full items-baseline gap-3 px-4 py-2.5 text-left",
                    already ? "cursor-not-allowed opacity-50" : "hover:bg-neutral-50",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium">
                      {variant.product_name}
                      {variant.label ? ` — ${variant.label}` : ""}
                    </span>
                    <span className="font-mono block text-caption text-muted">{variant.sku}</span>
                  </span>
                  {already ? (
                    <span className="shrink-0 text-caption text-muted">On the order</span>
                  ) : (
                    <>
                      <span className="tabular shrink-0 text-caption text-muted">
                        cost {money(variant.cost)}
                      </span>
                      <Plus className="size-4 shrink-0 text-brand-600" aria-hidden />
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
