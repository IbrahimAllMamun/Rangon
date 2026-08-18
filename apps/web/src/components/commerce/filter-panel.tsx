"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, Label, Select } from "@/components/ui/primitives";
import { money } from "@/lib/format";
import { useRouteTransition } from "@/lib/navigation/route-transition";

interface Facets {
  brands: { slug: string; name: string; count: number }[];
  attributes: {
    code: string;
    name: string;
    kind: string;
    values: { value: string; label: string; swatch: string; count: number }[];
  }[];
  price: { min: string; max: string };
}

const SORTS = [
  { value: "relevance", label: "Most relevant" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "name_asc", label: "Name: A–Z" },
];

export function FilterPanel({ facets }: { facets: Facets | null }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const { navigate, pending } = useRouteTransition();
  const [open, setOpen] = useState(false);

  function apply(mutate: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    next.delete("page"); // a new filter always returns to page 1
    // `navigate`, not `router.push`: this changes only the query string, so
    // Next re-renders the same segment and no `loading.tsx` fires. Routing it
    // through the transition is what turns a dead click into visible progress.
    navigate(`${pathname}?${next.toString()}`);
  }

  function toggle(key: string, value: string) {
    apply((next) => {
      const current = next.getAll(key);
      next.delete(key);
      const remaining = current.filter((entry) => entry !== value);
      if (remaining.length === current.length) remaining.push(value);
      for (const entry of remaining) next.append(key, entry);
    });
  }

  const activeCount = [...params.keys()].filter(
    (key) => key.startsWith("attr_") || ["brand", "price_min", "price_max", "in_stock"].includes(key),
  ).length;

  const body = facets ? (
    <div className="space-y-6">
      <div>
        <Label htmlFor="sort">Sort by</Label>
        <Select
          id="sort"
          className="mt-1.5"
          value={params.get("sort") ?? "relevance"}
          onChange={(event) => apply((next) => next.set("sort", event.target.value))}
        >
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value}>
              {sort.label}
            </option>
          ))}
        </Select>
      </div>

      <fieldset>
        <legend className="text-body-sm font-semibold">Availability</legend>
        <label className="mt-2 flex items-center gap-2 text-body-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--brand-500)]"
            checked={params.get("in_stock") === "true"}
            onChange={(event) =>
              apply((next) =>
                event.target.checked ? next.set("in_stock", "true") : next.delete("in_stock"),
              )
            }
          />
          In stock only
        </label>
      </fieldset>

      {facets.brands.length > 0 && (
        <fieldset>
          <legend className="text-body-sm font-semibold">Brand</legend>
          <div className="mt-2 space-y-1.5">
            {facets.brands.map((brand) => (
              <label key={brand.slug} className="flex items-center gap-2 text-body-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--brand-500)]"
                  checked={params.getAll("brand").includes(brand.slug)}
                  onChange={() => toggle("brand", brand.slug)}
                />
                <span className="flex-1">{brand.name}</span>
                <span className="tabular text-caption text-muted">{brand.count}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {facets.attributes.map((attribute) => (
        <fieldset key={attribute.code}>
          <legend className="text-body-sm font-semibold">{attribute.name}</legend>

          {attribute.kind === "COLOR" ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {attribute.values.map((value) => {
                const active = params.getAll(`attr_${attribute.code}`).includes(value.value);
                return (
                  <button
                    key={value.value}
                    type="button"
                    onClick={() => toggle(`attr_${attribute.code}`, value.value)}
                    aria-pressed={active}
                    title={`${value.label} (${value.count})`}
                    className={`size-8 rounded-full border-2 transition-transform duration-fast ${
                      active ? "border-brand-500 scale-110" : "border-neutral-300"
                    }`}
                    style={{ backgroundColor: value.swatch || "var(--neutral-200)" }}
                  >
                    <span className="sr-only">
                      {value.label} ({value.count})
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {attribute.values.map((value) => {
                const active = params.getAll(`attr_${attribute.code}`).includes(value.value);
                return (
                  <button
                    key={value.value}
                    type="button"
                    onClick={() => toggle(`attr_${attribute.code}`, value.value)}
                    aria-pressed={active}
                    className={`min-w-11 rounded-md border px-3 py-2 text-body-sm transition-colors duration-fast ${
                      active
                        ? "border-brand-500 bg-brand-50 font-semibold text-brand-700"
                        : "border-neutral-300 hover:bg-neutral-100"
                    }`}
                  >
                    {value.label}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
      ))}

      <fieldset>
        <legend className="text-body-sm font-semibold">Price</legend>
        <p className="mt-1 text-caption text-muted">
          {money(facets.price.min)} – {money(facets.price.max)}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            aria-label="Minimum price"
            placeholder="Min"
            defaultValue={params.get("price_min") ?? ""}
            onBlur={(event) =>
              apply((next) =>
                event.target.value ? next.set("price_min", event.target.value) : next.delete("price_min"),
              )
            }
            className="h-10 w-full rounded-md border border-neutral-300 px-2 text-body-sm"
          />
          <span aria-hidden className="text-muted">
            –
          </span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Maximum price"
            placeholder="Max"
            defaultValue={params.get("price_max") ?? ""}
            onBlur={(event) =>
              apply((next) =>
                event.target.value ? next.set("price_max", event.target.value) : next.delete("price_max"),
              )
            }
            className="h-10 w-full rounded-md border border-neutral-300 px-2 text-body-sm"
          />
        </div>
      </fieldset>

      {activeCount > 0 && (
        <Button
          variant="secondary"
          full
          onClick={() => {
            const next = new URLSearchParams();
            const q = params.get("q");
            const category = params.get("category");
            if (q) next.set("q", q);
            if (category) next.set("category", category);
            navigate(`${pathname}?${next.toString()}`);
          }}
        >
          Clear filters ({activeCount})
        </Button>
      )}
    </div>
  ) : (
    <p className="text-body-sm text-muted">Filters unavailable.</p>
  );

  return (
    <>
      <div className="lg:hidden">
        <Button variant="secondary" full onClick={() => setOpen((value) => !value)}>
          <SlidersHorizontal aria-hidden />
          Filters {activeCount > 0 && `(${activeCount})`}
        </Button>
        {open && (
          <div className="mt-4 rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-body font-semibold">Filters</h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close filters">
                <X aria-hidden />
              </Button>
            </div>
            {body}
          </div>
        )}
      </div>

      {/* The controls stay live while results reload — shoppers pick two
          filters in a row and blocking the second one is worse than waiting.
          The feedback belongs on the results, which dim in place. */}
      <aside className="hidden lg:block" aria-label="Product filters" aria-busy={pending || undefined}>
        <h2 className="sr-only">Filters</h2>
        {body}
      </aside>
    </>
  );
}
