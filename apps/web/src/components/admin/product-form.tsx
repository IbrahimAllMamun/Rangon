"use client";

import { Check, Eye, EyeOff, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { VariantMatrixEditor, type RowDraft, draftFromRow } from "@/components/admin/variant-matrix-editor";
import {
  Badge,
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
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { ProductValues } from "@/lib/commerce/product-values";
import {
  type ExistingVariant,
  type MatrixAttribute,
  MAX_MATRIX_ROWS,
  buildMatrix,
  combinationKey,
  matrixSize,
  pendingSelections,
  selectionsFromVariants,
} from "@/lib/commerce/variant-matrix";
import { cn } from "@/lib/cn";

export interface CategoryOption {
  id: string;
  name: string;
  parent: string | null;
}

export interface BrandOption {
  id: string;
  name: string;
}

interface FieldError {
  field: string;
  message: string;
}

/**
 * Create and edit a product, with its variant matrix (roadmap phase 05).
 *
 * Until this existed, adding a product meant calling the API by hand. Every
 * endpoint it uses was already built and tested; what was missing was the
 * screen.
 *
 * Two rules shape it:
 *
 *  1. **Stock is never written here.** The matrix collects an opening figure
 *     for a row that does not exist yet and posts it as a reasoned adjustment
 *     through `inventory.services` once the variant has an id. Existing rows
 *     show stock read-only with an Adjust action (CLAUDE.md §3.2).
 *  2. **Un-ticking a value never destroys a row.** See `lib/commerce/variant-matrix.ts`.
 */
export function ProductForm({
  mode,
  productId,
  initial,
  initialVariants,
  categories,
  brands,
  attributes,
  published,
  branchLabel,
  canDelete,
}: {
  mode: "create" | "edit";
  productId?: string;
  initial: ProductValues;
  initialVariants: ExistingVariant[];
  categories: CategoryOption[];
  brands: BrandOption[];
  attributes: MatrixAttribute[];
  published: boolean;
  branchLabel: string;
  canDelete: boolean;
}) {
  const router = useRouter();

  const [values, setValues] = useState<ProductValues>(initial);
  const [selections, setSelections] = useState<Record<string, string[]>>(() =>
    selectionsFromVariants(initialVariants),
  );
  const [variants, setVariants] = useState<ExistingVariant[]>(initialVariants);
  const [defaultPrice, setDefaultPrice] = useState("");
  const [defaultCost, setDefaultCost] = useState("");
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [isPublished, setIsPublished] = useState(published);

  const rows = useMemo(
    () => buildMatrix(selections, attributes, variants),
    [selections, attributes, variants],
  );
  const requested = matrixSize(selections);
  const truncated = requested > MAX_MATRIX_ROWS;

  // A row keeps whatever the user typed; anything untouched falls back to the
  // saved variant, or to the default price/cost above the table.
  const rowDrafts = useMemo(() => {
    const next: Record<string, RowDraft> = {};
    for (const row of rows) {
      next[row.key] = drafts[row.key] ?? draftFromRow(row, defaultPrice, defaultCost);
    }
    return next;
  }, [rows, drafts, defaultPrice, defaultCost]);

  function set<K extends keyof ProductValues>(key: K, value: ProductValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function toggleValue(code: string, value: string) {
    setSelections((current) => {
      const picked = current[code] ?? [];
      const next = picked.includes(value)
        ? picked.filter((item) => item !== value)
        : [...picked, value];
      return { ...current, [code]: next };
    });
    setSaved(false);
  }

  function onDraftChange(key: string, patch: Partial<RowDraft>) {
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? rowDrafts[key]), ...patch },
    }));
    setSaved(false);
  }

  function validate(): FieldError[] {
    const found: FieldError[] = [];
    if (!values.name.trim()) found.push({ field: "name", message: "A product name is required." });
    if (!values.category) found.push({ field: "category", message: "Choose a category." });

    if (truncated) {
      found.push({
        field: "variants",
        message: `That selection asks for ${requested} variants. Narrow it to ${MAX_MATRIX_ROWS} or fewer.`,
      });
    }

    for (const row of rows) {
      const draft = rowDrafts[row.key];
      if (row.state === "unselected") continue;
      if (draft.price === "" || Number(draft.price) < 0 || Number.isNaN(Number(draft.price))) {
        found.push({
          field: "variants",
          message: "Every variant needs a price of zero or more.",
        });
        break;
      }
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
      const payload = {
        ...values,
        brand: values.brand || null,
        slug: values.slug || undefined,
      };

      // 1. The product row itself.
      const product =
        mode === "create"
          ? await apiClient<{ id: string }>("/products/", { method: "POST", body: payload })
          : await apiClient<{ id: string }>(`/products/${productId}/`, {
              method: "PATCH",
              body: payload,
            });

      // 2. Create the combinations that do not exist yet. The service skips any
      //    it already has, so this is safe to re-run.
      const pending = pendingSelections(rows);
      let created: ExistingVariant[] = [];
      if (Object.keys(pending).length > 0) {
        const response = await apiClient<{ variants: ExistingVariant[] }>(
          `/products/${product.id}/generate-variants/`,
          {
            method: "POST",
            body: {
              selections: pending,
              // generate_variants takes one price for the batch; per-row values
              // are applied by the PATCH pass below.
              price: firstPrice(rows, rowDrafts, defaultPrice),
              cost: firstCost(rows, rowDrafts, defaultCost),
            },
          },
        );
        created = response.variants ?? [];
      }

      // Match what came back to the rows that asked for it.
      const createdByKey = new Map(
        created.map((variant) => [
          combinationKey(
            Object.fromEntries(
              variant.attributes.map((attribute) => [attribute.attribute_code, attribute.value]),
            ),
          ),
          variant,
        ]),
      );

      // 3. Apply per-row edits, and open the stock for brand-new rows.
      const openingStock: { variant: string; quantity: number }[] = [];

      for (const row of rows) {
        const draft = rowDrafts[row.key];
        const target = row.existing ?? createdByKey.get(row.key) ?? null;
        if (!target) continue;

        const patch: Record<string, unknown> = {};
        // Compare numerically: the API returns "1450.00" and the input holds
        // "1450", so a string compare would PATCH every row on every save.
        if (draft.price !== "" && !sameMoney(draft.price, target.price)) patch.price = draft.price;
        if (draft.cost !== "" && !sameMoney(draft.cost, target.cost)) patch.cost = draft.cost;
        const compareAt = draft.compareAt === "" ? null : draft.compareAt;
        if (!sameMoney(compareAt, target.compare_at_price)) patch.compare_at_price = compareAt;
        if (draft.sku.trim() && draft.sku.trim() !== target.sku) patch.sku = draft.sku.trim();
        if (draft.barcode.trim() && draft.barcode.trim() !== (target.barcode ?? "")) {
          patch.barcode = draft.barcode.trim();
        }

        if (Object.keys(patch).length > 0) {
          await apiClient(`/variants/${target.id}/`, { method: "PATCH", body: patch });
        }

        const opening = Number(draft.openingStock);
        if (!row.existing && Number.isInteger(opening) && opening > 0) {
          openingStock.push({ variant: target.id, quantity: opening });
        }
      }

      // 4. Opening stock goes through the ledger, never straight onto a column.
      for (const line of openingStock) {
        await apiClient("/inventory/adjust/", {
          method: "POST",
          body: {
            variant: line.variant,
            new_on_hand: line.quantity,
            reason: "Opening stock (product form)",
          },
        });
      }

      setSaved(true);
      setDrafts({});
      if (mode === "create") {
        router.push(`/admin/products/${product.id}`);
      } else {
        router.refresh();
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "name", message: caught.message }]);
      } else {
        setErrors([{ field: "name", message: "Could not save. Please try again." }]);
      }
      // Scrolling the summary into view: the form is long enough that an error
      // at the top is off-screen when the button is at the bottom.
      document.getElementById("product-error-summary")?.scrollIntoView({ block: "center" });
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    if (!productId) return;
    setPublishing(true);
    setErrors([]);
    try {
      const action = isPublished ? "unpublish" : "publish";
      await apiClient(`/products/${productId}/${action}/`, { method: "POST", body: {} });
      setIsPublished(!isPublished);
      if (!isPublished) set("status", "ACTIVE");
      router.refresh();
    } catch (caught) {
      setErrors([
        {
          field: "name",
          message:
            caught instanceof ApiError ? caught.message : "Could not change the published state.",
        },
      ]);
    } finally {
      setPublishing(false);
    }
  }

  async function deleteProduct() {
    if (!productId) return;
    const confirmed = window.confirm(
      "Delete this product? If it has stock or sales it is archived rather than deleted, so history keeps resolving.",
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      await apiClient(`/products/${productId}/`, { method: "DELETE" });
      router.push("/admin/products");
    } catch (caught) {
      setErrors([
        { field: "name", message: caught instanceof ApiError ? caught.message : "Could not delete." },
      ]);
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const variantAttributes = attributes.filter((attribute) => attribute.values.length > 0);

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <div id="product-error-summary">
        <ErrorSummary errors={errors} title="Could not save this product" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Product name" htmlFor="product-name" required error={errorFor("name")}>
              <Input
                id="product-name"
                value={values.name}
                onChange={(event) => set("name", event.target.value)}
                invalid={Boolean(errorFor("name"))}
                autoComplete="off"
              />
            </Field>

            <Field
              label="URL slug"
              htmlFor="product-slug"
              hint="Left blank, one is generated from the name."
              error={errorFor("slug")}
            >
              <Input
                id="product-slug"
                value={values.slug}
                onChange={(event) => set("slug", event.target.value)}
                placeholder="classic-oxford-shirt"
                autoComplete="off"
              />
            </Field>

            <Field label="Category" htmlFor="product-category" required error={errorFor("category")}>
              <Select
                id="product-category"
                value={values.category}
                onChange={(event) => set("category", event.target.value)}
                invalid={Boolean(errorFor("category"))}
              >
                <option value="">Choose a category…</option>
                {orderCategories(categories).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Brand" htmlFor="product-brand" error={errorFor("brand")}>
              <Select
                id="product-brand"
                value={values.brand}
                onChange={(event) => set("brand", event.target.value)}
              >
                <option value="">No brand</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field
            label="Short description"
            htmlFor="product-short"
            hint="One line, shown on cards and in search results."
            error={errorFor("short_description")}
          >
            <Input
              id="product-short"
              value={values.short_description}
              maxLength={320}
              onChange={(event) => set("short_description", event.target.value)}
            />
          </Field>

          <Field label="Description" htmlFor="product-description" error={errorFor("description")}>
            <Textarea
              id="product-description"
              rows={5}
              value={values.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Material" htmlFor="product-material" error={errorFor("material")}>
              <Input
                id="product-material"
                value={values.material}
                onChange={(event) => set("material", event.target.value)}
                placeholder="100% cotton"
              />
            </Field>

            <Field label="Care instructions" htmlFor="product-care" error={errorFor("care_instructions")}>
              <Textarea
                id="product-care"
                rows={2}
                value={values.care_instructions}
                onChange={(event) => set("care_instructions", event.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Status" htmlFor="product-status" error={errorFor("status")}>
              <Select
                id="product-status"
                value={values.status}
                onChange={(event) => set("status", event.target.value as ProductValues["status"])}
              >
                <option value="DRAFT">Draft</option>
                <option value="ACTIVE">Active</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>

            <label className="flex items-center gap-2 pt-7 text-body-sm">
              <Checkbox
                checked={values.featured}
                onChange={(event) => set("featured", event.target.checked)}
              />
              Featured on the homepage
            </label>

            <label className="flex items-center gap-2 pt-7 text-body-sm">
              <Checkbox
                checked={values.is_final_sale}
                onChange={(event) => set("is_final_sale", event.target.checked)}
              />
              Final sale (not returnable)
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variants</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-body-sm text-muted">
            Tick the values this product comes in. Every combination becomes a sellable SKU with its
            own price, barcode and stock.
          </p>

          <div className="space-y-4">
            {variantAttributes.map((attribute) => {
              const picked = selections[attribute.code] ?? [];
              return (
                <fieldset key={attribute.code}>
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
                </fieldset>
              );
            })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:w-1/2">
            <Field
              label="Default price"
              htmlFor="default-price"
              hint="Fills every new row; change any of them below."
            >
              <Input
                id="default-price"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={defaultPrice}
                onChange={(event) => setDefaultPrice(event.target.value)}
              />
            </Field>
            <Field label="Default cost" htmlFor="default-cost" hint="What you pay the supplier.">
              <Input
                id="default-cost"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={defaultCost}
                onChange={(event) => setDefaultCost(event.target.value)}
              />
            </Field>
          </div>

          {errorFor("variants") && (
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {errorFor("variants")}
            </p>
          )}

          <VariantMatrixEditor
            rows={rows}
            attributes={attributes}
            drafts={rowDrafts}
            onDraftChange={onDraftChange}
            onRemoved={(variantId) =>
              setVariants((current) => current.filter((variant) => variant.id !== variantId))
            }
            onAdjusted={() => router.refresh()}
            branchLabel={branchLabel}
            disabled={saving}
            truncated={truncated}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Search engines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="SEO title"
            htmlFor="product-seo-title"
            hint='Do not add "| Rangon Fashion" — the site appends it (D4).'
            error={errorFor("seo_title")}
          >
            <Input
              id="product-seo-title"
              value={values.seo_title}
              maxLength={200}
              onChange={(event) => set("seo_title", event.target.value)}
              placeholder={values.name}
            />
          </Field>

          <Field
            label="SEO description"
            htmlFor="product-seo-description"
            hint="Around 150 characters is what search results show."
            error={errorFor("seo_description")}
          >
            <Textarea
              id="product-seo-description"
              rows={2}
              maxLength={320}
              value={values.seo_description}
              onChange={(event) => set("seo_description", event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-4 py-3 sm:-mx-6 sm:px-6">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Create product" : "Save changes"}
        </Button>

        {mode === "edit" && (
          <Button type="button" variant="secondary" onClick={togglePublish} loading={publishing}>
            {isPublished ? (
              <>
                <EyeOff className="size-4" aria-hidden />
                Unpublish
              </>
            ) : (
              <>
                <Eye className="size-4" aria-hidden />
                Publish
              </>
            )}
          </Button>
        )}

        {mode === "edit" && (
          <Badge tone={isPublished ? "success" : "neutral"}>
            {isPublished ? "Live on the storefront" : "Hidden from the storefront"}
          </Badge>
        )}

        {saved && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-body-sm font-medium text-[var(--success)]"
          >
            <Check className="size-4" aria-hidden /> Saved
          </span>
        )}

        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push("/admin/products")}>
            Cancel
          </Button>
          {mode === "edit" && canDelete && (
            <Button type="button" variant="destructive" onClick={deleteProduct} disabled={saving}>
              <Trash2 className="size-4" aria-hidden />
              Delete
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Do these two money strings mean the same amount? `null` means "not set". */
function sameMoney(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Number(left) === Number(right);
}

/** The price `generate-variants` should use for the batch it is about to create. */
function firstPrice(
  rows: ReturnType<typeof buildMatrix>,
  drafts: Record<string, RowDraft>,
  fallback: string,
): string {
  const row = rows.find((candidate) => candidate.state === "new");
  const price = row ? drafts[row.key]?.price : "";
  return price || fallback || "0";
}

function firstCost(
  rows: ReturnType<typeof buildMatrix>,
  drafts: Record<string, RowDraft>,
  fallback: string,
): string {
  const row = rows.find((candidate) => candidate.state === "new");
  const cost = row ? drafts[row.key]?.cost : "";
  return cost || fallback || "0";
}

/** Categories as a parent-then-child list, so the select reads like the tree. */
function orderCategories(categories: CategoryOption[]): { id: string; label: string }[] {
  const byParent = new Map<string | null, CategoryOption[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parent ?? null) ?? [];
    siblings.push(category);
    byParent.set(category.parent ?? null, siblings);
  }

  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const category of byParent.get(parent) ?? []) {
      out.push({ id: category.id, label: `${"— ".repeat(depth)}${category.name}` });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);

  // Anything whose parent is outside the list (inactive, filtered) would be
  // invisible otherwise.
  for (const category of categories) {
    if (!out.some((entry) => entry.id === category.id)) {
      out.push({ id: category.id, label: category.name });
    }
  }
  return out;
}
