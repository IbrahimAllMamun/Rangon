"use client";

import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";

import type { PickableVariant } from "@/components/admin/variant-picker";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { BrandOption, CategoryOption } from "@/components/admin/product-form";
import { declaredAxes } from "@/lib/commerce/category-attributes";
import {
  type DraftProblem,
  type NewProductDraft,
  axesFor,
  blankDraft,
  toProductPayload,
  toVariantsPayload,
  validateDraft,
} from "@/lib/commerce/new-product";
import { type MatrixAttribute, matrixSize } from "@/lib/commerce/variant-matrix";
import { cn } from "@/lib/cn";
import { useCategoryAttributes } from "@/lib/use-category-attributes";

/**
 * Create a product without leaving the purchase order.
 *
 * The picker used to dead-end on "Nothing matches — create the product first",
 * which meant abandoning a half-filled order, building the product on another
 * screen, and coming back to start the lines again. The order is the reason the
 * product exists, so this is where making one belongs.
 *
 * An inline panel rather than a modal, matching `SupplierForm` directly above
 * it in the same form — the two do the same job for the two things a buyer
 * discovers is missing mid-order (CLAUDE.md §10: reuse, do not invent a
 * per-page visual language).
 *
 * What it deliberately does not collect:
 *
 *  - **Stock.** Goods arrive by receiving this order, which is what carries the
 *    cost paid into the ledger (business-rules.md § 4.0a). A figure typed here
 *    would be the zero-cost door D72 closed.
 *  - **A retail price, necessarily.** A buyer knows what they are paying and
 *    often not yet what they will charge. The product is created `DRAFT`, and
 *    `publish` refuses anything with nothing priced above zero (D75), so an
 *    unpriced draft cannot reach the storefront by accident.
 */
export function NewProductForm({
  initialName,
  categories,
  brands,
  attributes,
  defaultCost,
  onCreated,
  onCancel,
}: {
  /** Whatever the buyer typed into the picker before finding nothing. */
  initialName: string;
  categories: CategoryOption[];
  brands: BrandOption[];
  attributes: MatrixAttribute[];
  /** Seeded into the cost box; the buyer is here because they are buying. */
  defaultCost?: string;
  onCreated: (variants: PickableVariant[], productName: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<NewProductDraft>(() => ({
    ...blankDraft(initialName),
    cost: defaultCost ?? "",
  }));
  const [errors, setErrors] = useState<DraftProblem[]>([]);
  const [saving, setSaving] = useState(false);

  // The category decides which axes are offered, exactly as on the product
  // form: a shoe states a Size, a bag states a Capacity, and offering both to
  // both is how a catalogue becomes unsearchable.
  const category = useCategoryAttributes(draft.categoryId);
  const axes = useMemo(
    () => axesFor(attributes, declaredAxes(category.rows)),
    [attributes, category.rows],
  );
  const rowCount = matrixSize(draft.selections);

  function set<K extends keyof NewProductDraft>(key: K, value: NewProductDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleValue(code: string, value: string) {
    setDraft((current) => {
      const picked = current.selections[code] ?? [];
      const next = picked.includes(value)
        ? picked.filter((item) => item !== value)
        : [...picked, value];
      return { ...current, selections: { ...current.selections, [code]: next } };
    });
  }

  async function submit() {
    const found = validateDraft(draft);
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      // 1. The product row, as a draft.
      const product = await apiClient<{ id: string; name: string }>("/products/", {
        method: "POST",
        body: toProductPayload(draft),
      });

      // 2. Its sellable rows. The service skips combinations it already has, so
      //    a retried submit cannot double up.
      const generated = await apiClient<{ variants: PickableVariant[] }>(
        `/products/${product.id}/generate-variants/`,
        { method: "POST", body: toVariantsPayload(draft) },
      );

      onCreated(generated.variants ?? [], product.name);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "name", message: caught.message }]);
      } else {
        setErrors([{ field: "name", message: "Could not create the product. Please try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>New product</CardTitle>
      </CardHeader>
      <CardContent>
        {/* A `<div>`, not a `<form>`: this always renders inside the purchase
            order's own form, and nested forms are invalid HTML. React builds
            them regardless — it writes the DOM through the API, not the parser
            — so the markup reads fine while the browser submits natively and
            reloads the page, losing the order. That is D76, which shipped on
            this screen with the inline supplier form. */}
        <div className="space-y-4">
          <ErrorSummary errors={errors} title="Could not create this product" />

          <p className="text-body-sm text-muted">
            Created as a draft and added straight to this order. It reaches the storefront when you
            publish it — stock arrives when you receive the delivery.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Product name" htmlFor="np-name" required error={errorFor("name")}>
              <Input
                id="np-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                invalid={Boolean(errorFor("name"))}
                autoComplete="off"
                autoFocus
              />
            </Field>

            <Field label="Category" htmlFor="np-category" required error={errorFor("category")}>
              <Select
                id="np-category"
                value={draft.categoryId}
                onChange={(event) => set("categoryId", event.target.value)}
                invalid={Boolean(errorFor("category"))}
              >
                <option value="">Choose a category…</option>
                {categories.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Brand" htmlFor="np-brand">
              <Select
                id="np-brand"
                value={draft.brandId}
                onChange={(event) => set("brandId", event.target.value)}
              >
                <option value="">No brand</option>
                {brands.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Unit cost"
              htmlFor="np-cost"
              required
              hint="What this supplier charges. Receiving confirms it."
              error={errorFor("cost")}
            >
              <Input
                id="np-cost"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={draft.cost}
                onChange={(event) => set("cost", event.target.value)}
                invalid={Boolean(errorFor("cost"))}
                className="tabular"
              />
            </Field>

            <Field
              label="Retail price"
              htmlFor="np-price"
              hint="Optional — leave blank and set it before publishing."
              error={errorFor("price")}
            >
              <Input
                id="np-price"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={draft.price}
                onChange={(event) => set("price", event.target.value)}
                invalid={Boolean(errorFor("price"))}
                className="tabular"
                placeholder="Not decided yet"
              />
            </Field>
          </div>

          <fieldset>
            <legend className="text-body-sm font-medium">
              Which versions does it come in?
            </legend>
            <p className="mb-2 text-caption text-muted">
              {draft.categoryId
                ? "Tick the values it is sold in. Every combination becomes a SKU on this order."
                : "Choose a category first — it decides which axes apply."}
            </p>

            {errorFor("selections") && (
              <p role="alert" className="mb-2 text-body-sm text-[var(--error)]">
                {errorFor("selections")}
              </p>
            )}

            {category.failed && (
              <p role="alert" className="mb-2 text-body-sm text-muted">
                Could not load this category&rsquo;s axes, so every axis is offered.{" "}
                <button type="button" onClick={category.reload} className="underline">
                  Try again
                </button>
              </p>
            )}

            {draft.categoryId && (
              <div className="space-y-3">
                {axes.map((attribute) => {
                  const picked = draft.selections[attribute.code] ?? [];
                  return (
                    <div key={attribute.code}>
                      <p className="mb-1 text-caption uppercase text-muted">
                        {attribute.name}
                        {picked.length > 0 && (
                          <span className="ml-2 normal-case">{picked.length} selected</span>
                        )}
                      </p>
                      {/* Same chip as the product form's matrix picker: one
                          visual language for one action (CLAUDE.md §10). */}
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
                                onChange={() => toggleValue(attribute.code, option.value)}
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
                    </div>
                  );
                })}
              </div>
            )}

            {rowCount > 0 && (
              <p className="mt-3 text-body-sm" aria-live="polite">
                {rowCount} SKU{rowCount === 1 ? "" : "s"} will be created and added to this order.
              </p>
            )}
          </fieldset>

          {draft.price.trim() === "" && rowCount > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-[var(--warning)]/10 p-3 text-body-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
              <span>
                No retail price yet, so this stays unpublished until one is set. That is deliberate —
                a product priced at zero would be sold for nothing.
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={submit} loading={saving}>
              Create and add to order
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
