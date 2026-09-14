"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Checkbox, Skeleton } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";

/** One attribute a category uses, as `GET /categories/{id}/attributes/` answers. */
export interface CategoryAttribute {
  id: string;
  code: string;
  name: string;
  kind: string;
  is_variant_defining: boolean;
  is_required: boolean;
  /** Which category in the chain declared it — a parent, usually. */
  declared_by: string;
  values: { id: string; value: string; label: string; display: string; swatch: string }[];
}

/**
 * The specifications a product states: Material and Fit on a shirt, Sole on a
 * shoe, Skin type on a serum.
 *
 * Two things distinguish it from the variant matrix above it, and both are the
 * point of the feature:
 *
 *  1. **It never creates a SKU.** A spec is one fact about the product, so
 *     ticking three of them adds three facts, not eight rows. The API refuses
 *     a variant-defining attribute here for the same reason.
 *  2. **The category decides what is offered.** A handbag is never asked for a
 *     Shoe size. `CategoryAttribute` has held that answer since the first
 *     migration and nothing but the seed had ever read it.
 *
 * The list reloads whenever the category changes, which on the create form is
 * before anything has been saved — so it is a client fetch rather than
 * server-rendered data.
 */
export function ProductSpecPicker({
  categoryId,
  selected,
  onChange,
  error,
}: {
  categoryId: string;
  selected: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const [attributes, setAttributes] = useState<CategoryAttribute[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!categoryId) {
        setAttributes(null);
        setFailed(false);
        return;
      }
      setLoading(true);
      setFailed(false);
      try {
        const rows = await apiClient<CategoryAttribute[]>(
          `/categories/${categoryId}/attributes/`,
          { signal },
        );
        if (signal?.aborted) return;
        setAttributes(rows.filter((row) => !row.is_variant_defining));
      } catch (caught) {
        if (signal?.aborted) return;
        // An abort is the next keystroke, not a failure.
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFailed(caught instanceof ApiError || caught instanceof Error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [categoryId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function toggle(valueId: string) {
    onChange(
      selected.includes(valueId)
        ? selected.filter((item) => item !== valueId)
        : [...selected, valueId],
    );
  }

  if (!categoryId) {
    return (
      <p className="text-body-sm text-muted">
        Choose a category first — it decides which specifications this product can state.
      </p>
    );
  }

  if (loading && attributes === null) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  }

  if (failed) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-body-sm text-[var(--error)]">
          Could not load this category&rsquo;s specifications.
        </p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!attributes?.length) {
    return (
      <p className="text-body-sm text-muted">
        This category has no specification attributes yet. Add them on{" "}
        <a className="underline hover:text-brand-600" href="/admin/taxonomy">
          Taxonomy
        </a>
        , then link them to the category.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-body-sm text-[var(--error)]">
          {error}
        </p>
      )}

      {attributes.map((attribute) => {
        const chosen = attribute.values.filter((value) => selected.includes(value.id));
        return (
          <fieldset key={attribute.code}>
            <legend className="mb-2 flex flex-wrap items-center gap-2 text-body-sm font-medium">
              {attribute.name}
              {attribute.is_required && (
                <Badge tone="warning">Expected for {attribute.declared_by}</Badge>
              )}
              {chosen.length > 0 && (
                <span className="font-normal text-muted">{chosen.length} selected</span>
              )}
            </legend>
            <div className="flex flex-wrap gap-2">
              {attribute.values.map((value) => {
                const checked = selected.includes(value.id);
                return (
                  <label
                    key={value.id}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-body-sm transition-colors duration-fast",
                      checked
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-neutral-300 bg-white hover:bg-neutral-50",
                    )}
                  >
                    <Checkbox checked={checked} onChange={() => toggle(value.id)} />
                    {value.swatch && (
                      <span
                        className="size-4 rounded-full border border-border"
                        style={{ backgroundColor: value.swatch }}
                        aria-hidden
                      />
                    )}
                    {value.display || value.label || value.value}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
