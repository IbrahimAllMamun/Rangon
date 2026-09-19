"use client";

import { Checkbox } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import type { MatrixAttribute } from "@/lib/commerce/variant-matrix";

/**
 * The variant axes as tick-lists: one fieldset per attribute, one chip per value.
 *
 * Shared by the product form and the purchase order's new-product panel, so a
 * size is ticked the same way wherever a product is made.
 */
export function AxisPicker({
  attributes,
  selections,
  onToggle,
  idPrefix = "axis",
}: {
  attributes: MatrixAttribute[];
  selections: Record<string, string[]>;
  onToggle: (code: string, value: string) => void;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-4">
      {attributes.map((attribute) => {
        const picked = selections[attribute.code] ?? [];
        return (
          <fieldset key={attribute.code} id={`${idPrefix}-${attribute.code}`}>
            <legend className="mb-2 text-body-sm font-medium">
              {attribute.name}
              {picked.length > 0 && (
                <span className="ml-2 font-normal text-muted">{picked.length} selected</span>
              )}
            </legend>
            <div className="flex flex-wrap gap-2">
              {attribute.values.map((option) => {
                const checked = picked.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-body-sm transition-colors duration-fast",
                      checked
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-neutral-300 bg-white hover:bg-neutral-50",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onChange={() => onToggle(attribute.code, option.value)}
                    />
                    {option.swatch && (
                      <span
                        className="size-4 rounded-full border border-border"
                        style={{ backgroundColor: option.swatch }}
                        aria-hidden
                      />
                    )}
                    {option.label}
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
