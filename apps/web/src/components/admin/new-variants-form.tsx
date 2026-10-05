"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { PickableVariant } from "@/components/admin/variant-picker";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import {
  type ExistingVariant,
  type MatrixAttribute,
  buildMatrix,
  hasSingleVersion,
  pendingSelections,
  selectionsFromVariants,
} from "@/lib/commerce/variant-matrix";

/**
 * New sizes or colours for a product that is already on the purchase order.
 *
 * The supplier now has the shirt in navy: the buyer should not have to leave
 * the order, open the product, tick navy, save, and come back to find the new
 * SKUs. Only the product's own axes are offered -- a new *axis* changes what
 * the product is, which is the product form's job -- and only the values it
 * does not use yet.
 *
 * `generate-variants` skips every combination the product already has, so the
 * request carries the product's matrix with the new values ticked into it and
 * creates exactly the rows this panel lists as new.
 */
export function NewVariantsForm({
  productId,
  productName,
  existing,
  attributes,
  onCreated,
  onCancel,
}: {
  productId: string;
  productName: string;
  /** Every variant the product has, archived included, as `GET /products/{id}/` sends them. */
  existing: ExistingVariant[];
  /** Variant-defining attributes with their values (the purchase order page loads them). */
  attributes: MatrixAttribute[];
  onCreated: (variants: PickableVariant[]) => void;
  onCancel: () => void;
}) {
  const axes = useMemo(() => {
    const current = selectionsFromVariants(existing);
    return Object.keys(current).map((code) => {
      const attribute = attributes.find((candidate) => candidate.code === code);
      const fallbackName = existing
        .flatMap((variant) => variant.attributes)
        .find((value) => value.attribute_code === code)?.attribute_name;
      return {
        code,
        name: attribute?.name ?? fallbackName ?? code,
        current: current[code],
        options: (attribute?.values ?? []).filter((option) => !current[code].includes(option.value)),
      };
    });
  }, [existing, attributes]);

  // Priced like the product's other versions until the buyer says otherwise.
  const template = existing.find((variant) => variant.status !== "ARCHIVED") ?? existing[0];
  const [added, setAdded] = useState<Record<string, string[]>>({});
  const [price, setPrice] = useState(template?.price ?? "");
  const [cost, setCost] = useState(template?.cost ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selections = Object.fromEntries(
    axes.map((axis) => [axis.code, [...axis.current, ...(added[axis.code] ?? [])]]),
  );
  const rows = buildMatrix(selections, attributes, existing);
  const fresh = rows.filter((row) => row.state === "new");
  const single = hasSingleVersion(existing) || axes.length === 0;

  // Enter would otherwise submit the purchase order around this panel.
  function submitOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void create();
    }
  }

  function toggle(code: string, value: string) {
    setError(null);
    setAdded((current) => {
      const values = current[code] ?? [];
      return {
        ...current,
        [code]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value],
      };
    });
  }

  async function create() {
    if (!fresh.length) {
      setError("Tick at least one new value.");
      return;
    }
    const priceValue = Number(price);
    const costValue = Number(cost || "0");
    if (price.trim() === "" || !Number.isFinite(priceValue) || priceValue < 0) {
      setError("Enter a selling price of 0 or more.");
      return;
    }
    if (!Number.isFinite(costValue) || costValue < 0) {
      setError("The cost cannot be negative.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await apiClient<{ variants: PickableVariant[] }>(
        `/products/${productId}/generate-variants/`,
        {
          method: "POST",
          body: { selections: pendingSelections(rows), price, cost: cost || "0" },
        },
      );
      onCreated(response.variants ?? []);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create them. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New sizes or colours for {productName}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* A `<div>`, not a `<form>`: this renders inside the purchase order's
            own form, and a nested form submits natively and loses the order
            (D76, the same reason `NewProductForm` is a div). */}
        <div className="space-y-4">
          {single ? (
            <p className="text-body-sm text-muted">
              {productName} is sold as one version, so it has no sizes or colours to add to. To
              sell it in several,{" "}
              <Link
                href={`/admin/products/${productId}`}
                className="text-brand-700 hover:underline"
                target="_blank"
              >
                open the product
              </Link>
              .
            </p>
          ) : (
            <>
              <p className="text-body-sm text-muted">
                Tick what the supplier now has. Each new combination with the sizes and colours{" "}
                {productName} already comes in becomes a SKU and goes on this order.
              </p>

              {axes.map((axis) => (
                <fieldset key={axis.code}>
                  <legend className="mb-1 text-caption uppercase text-muted">
                    {axis.name}
                    <span className="ml-2 normal-case">
                      already: {axis.current.join(", ")}
                    </span>
                  </legend>
                  {axis.options.length === 0 ? (
                    <p className="text-caption text-muted">
                      Every {axis.name.toLowerCase()} set up is in use.{" "}
                      <Link
                        href="/admin/taxonomy"
                        className="text-brand-700 hover:underline"
                        target="_blank"
                      >
                        Add a value
                      </Link>{" "}
                      first.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {axis.options.map((option) => {
                        const checked = (added[axis.code] ?? []).includes(option.value);
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
                              onChange={() => toggle(axis.code, option.value)}
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
                  )}
                </fieldset>
              ))}

              <div className="grid gap-4 sm:grid-cols-2 lg:w-2/3">
                <Field label="Selling price" htmlFor="nv-price" required>
                  <Input
                    id="nv-price"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    onKeyDown={submitOnEnter}
                  />
                </Field>
                <Field label="Cost" htmlFor="nv-cost" hint="What this supplier charges per unit.">
                  <Input
                    id="nv-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={cost}
                    onChange={(event) => setCost(event.target.value)}
                    onKeyDown={submitOnEnter}
                  />
                </Field>
              </div>

              <p className="text-body-sm" role="status" aria-live="polite">
                {fresh.length === 0
                  ? "Nothing new ticked yet."
                  : `Creates ${fresh.length} SKU${fresh.length === 1 ? "" : "s"}: ${fresh
                      .slice(0, 8)
                      .map((row) => Object.values(row.labels).join(" / "))
                      .join(", ")}${fresh.length > 8 ? ` and ${fresh.length - 8} more` : ""}.`}
              </p>
            </>
          )}

          {error && (
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {!single && (
              <Button type="button" onClick={create} loading={saving} disabled={!fresh.length}>
                Create and add to the order
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              {single ? "Close" : "Cancel"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
