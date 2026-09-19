"use client";

import { PackagePlus } from "lucide-react";
import { useMemo, useState } from "react";

import { AxisPicker } from "@/components/admin/axis-picker";
import type { PickableVariant } from "@/components/admin/variant-picker";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorSummary,
  Field,
  Input,
  Select,
  Skeleton,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { declaredAxes, resolveVariantAxes } from "@/lib/commerce/category-attributes";
import { type CategoryNode, orderCategories } from "@/lib/commerce/categories";
import { MAX_MATRIX_ROWS, type MatrixAttribute, matrixSize } from "@/lib/commerce/variant-matrix";
import { useCategoryAttributes } from "@/lib/use-category-attributes";

export interface NewProductResult {
  variants: PickableVariant[];
  quantity: string;
  unitCost: string;
}

/**
 * Make a product where its goods arrive: on the purchase order.
 *
 * The product form and the purchase order used to be two doors for one job,
 * and only the purchase order's carried the cost the goods were bought at
 * (D72). This panel asks for exactly what a delivery needs -- a name, a
 * category, the sizes or colours that came, a selling price and what they
 * cost -- and `POST /products/quick-create/` makes the product and every
 * combination in one transaction. The variants come back as order lines.
 *
 * The product is sellable at the counter once received and hidden online until
 * someone gives it photographs on the product form (business-rules §4.0b).
 *
 * A `<form>` of its own, so Enter in the name field submits this panel. It
 * only works because the purchase order around it is *not* a form (D81).
 */
export function NewProductPanel({
  categories,
  brands,
  attributes,
  onCreated,
  onCancel,
}: {
  categories: CategoryNode[];
  brands: { id: string; name: string }[];
  /** Every variant-defining attribute; the category narrows it. */
  attributes: MatrixAttribute[];
  onCreated: (result: NewProductResult) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const category = useCategoryAttributes(categoryId);
  const axes = useMemo(
    () => resolveVariantAxes(attributes, declaredAxes(category.rows), []),
    [attributes, category.rows],
  );
  // Only what is still offered counts: ticking Size, then switching to a
  // category without it, must not send a size nobody can see.
  const chosen = useMemo(() => {
    const offered = new Set(axes.map((axis) => axis.code));
    return Object.fromEntries(
      Object.entries(selections).filter(([code, values]) => offered.has(code) && values.length),
    );
  }, [axes, selections]);
  const count = Math.max(matrixSize(chosen), 1);

  function toggle(code: string, value: string) {
    setSelections((current) => {
      const picked = current[code] ?? [];
      return {
        ...current,
        [code]: picked.includes(value) ? picked.filter((item) => item !== value) : [...picked, value],
      };
    });
  }

  function validate() {
    const found: { field: string; message: string }[] = [];
    if (!name.trim()) found.push({ field: "name", message: "Give the product a name." });
    if (!categoryId) found.push({ field: "category", message: "Choose a category." });
    if (!(Number(price) > 0)) {
      found.push({ field: "price", message: "Set a selling price above zero." });
    }
    if (cost === "" || !(Number(cost) >= 0)) {
      found.push({ field: "cost", message: "Enter what each one cost, or 0 if they were free." });
    }
    const each = Number(quantity);
    if (!Number.isInteger(each) || each < 1) {
      found.push({ field: "quantity", message: "Quantity must be a whole number of 1 or more." });
    }
    if (count > MAX_MATRIX_ROWS) {
      found.push({
        field: "selections",
        message: `That makes ${count} variants. Narrow it to ${MAX_MATRIX_ROWS} or fewer.`,
      });
    }
    return found;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (found.length) return;

    setSaving(true);
    try {
      const made = await apiClient<{ variants: PickableVariant[] }>("/products/quick-create/", {
        method: "POST",
        body: {
          name: name.trim(),
          category: categoryId,
          brand: brandId || null,
          selections: chosen,
          price,
          cost,
        },
      });
      onCreated({ variants: made.variants, quantity, unitCost: cost });
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
        <form onSubmit={submit} noValidate className="space-y-4" aria-label="New product">
          <ErrorSummary errors={errors} title="Could not create this product" />

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Product name"
              htmlFor="np-name"
              required
              error={errorFor("name")}
              className="sm:col-span-3"
            >
              <Input
                id="np-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                invalid={Boolean(errorFor("name"))}
                autoComplete="off"
                autoFocus
              />
            </Field>

            <Field label="Category" htmlFor="np-category" required error={errorFor("category")}>
              <Select
                id="np-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                invalid={Boolean(errorFor("category"))}
              >
                <option value="">Choose a category…</option>
                {orderCategories(categories).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Brand" htmlFor="np-brand" error={errorFor("brand")}>
              <Select id="np-brand" value={brandId} onChange={(event) => setBrandId(event.target.value)}>
                <option value="">No brand</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {categoryId &&
            (category.loading && category.rows === null ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-3/4" />
              </div>
            ) : (
              <div className="space-y-2">
                {category.failed && (
                  <p role="alert" className="text-body-sm text-muted">
                    Could not load this category&rsquo;s options, so every one is offered.{" "}
                    <button
                      type="button"
                      onClick={category.reload}
                      className="underline hover:text-brand-600"
                    >
                      Try again
                    </button>
                  </p>
                )}
                <AxisPicker
                  attributes={axes}
                  selections={selections}
                  onToggle={toggle}
                  idPrefix="np-axis"
                />
                {errorFor("selections") && (
                  <p role="alert" className="text-body-sm text-[var(--error)]">
                    {errorFor("selections")}
                  </p>
                )}
              </div>
            ))}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Selling price"
              htmlFor="np-price"
              required
              error={errorFor("price")}
              hint="Every variant; change any of them later on the product."
            >
              <Input
                id="np-price"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                invalid={Boolean(errorFor("price"))}
                className="tabular"
              />
            </Field>
            <Field
              label="Cost each"
              htmlFor="np-cost"
              required
              error={errorFor("cost")}
              hint="What the supplier charges; this becomes the line's unit cost."
            >
              <Input
                id="np-cost"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                invalid={Boolean(errorFor("cost"))}
                className="tabular"
              />
            </Field>
            <Field
              label="Quantity of each"
              htmlFor="np-quantity"
              required
              error={errorFor("quantity")}
              hint="Adjust single lines after adding them."
            >
              <Input
                id="np-quantity"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                invalid={Boolean(errorFor("quantity"))}
                className="tabular"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving}>
              <PackagePlus className="size-4" aria-hidden />
              {count === 1 ? "Create and add 1 line" : `Create and add ${count} lines`}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <p className="text-caption text-muted">
              It stays off the storefront until it has photographs.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
