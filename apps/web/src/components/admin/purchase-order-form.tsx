"use client";

import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { NewProductForm } from "@/components/admin/new-product-form";
import { NewVariantsForm } from "@/components/admin/new-variants-form";
import type { BrandOption, CategoryOption } from "@/components/admin/product-form";
import { SupplierForm, type SupplierRow } from "@/components/admin/supplier-form";
import { VariantPicker, type PickableVariant } from "@/components/admin/variant-picker";
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
  Textarea,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import {
  type DraftLine,
  bumpQuantity,
  groupLines,
  isOrdered,
  lineTotals,
  mergeProductLines,
  orderTotals,
  orderedLines,
  toCreatePayload,
  validateLines,
} from "@/lib/commerce/purchase-order";
import {
  EMPTY_OFFERS,
  type OfferMap,
  fetchSupplierOffers,
  minimumOrderWarning,
  resolveCost,
} from "@/lib/commerce/supplier-prices";
import {
  type ExistingVariant,
  type MatrixAttribute,
  hasSingleVersion,
} from "@/lib/commerce/variant-matrix";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

/** A variant as `GET /products/{id}/` sends it: with its stock at the buyer's branch. */
type CatalogueVariant = ExistingVariant & { product_name: string; label: string };

/** One product's variants, loaded the first time any of them reaches the order. */
interface CatalogueEntry {
  name: string;
  variants: CatalogueVariant[];
  status: "loading" | "ready" | "failed";
}

/** What a line needs from a variant, whichever endpoint it came from. */
interface LineSource {
  id: string;
  sku: string;
  product_name: string;
  label: string;
  cost: string;
}

/**
 * Raise a purchase order (roadmap phase 07 frontend).
 *
 * The endpoints have existed and been tested since the backend was built; what
 * was missing was the screen, so ordering stock meant calling the API by hand.
 *
 * Nothing here touches inventory. A purchase order is a *promise* — stock moves
 * only when goods are received, and that writes `PURCHASE` ledger rows through
 * `inventory.services` and recalculates weighted average cost (ADR-0006,
 * ADR-0008). Receiving lives on the order's detail screen for exactly that
 * reason: it is a different, heavier act than raising the order.
 *
 * Scanning any one variant brings in the whole product -- every size and
 * colour, each with the stock the branch holds -- because a buyer reordering a
 * shirt is deciding the whole size run, not one size. The scanned one starts at
 * 1 and the rest at 0; a line at 0 is not on the order (`isOrdered`), so nobody
 * has to delete the sizes they are not buying.
 */
export function PurchaseOrderForm({
  suppliers: initialSuppliers,
  defaultBranchLabel,
  canCreateProducts,
  categories,
  brands,
  attributes,
  initialVariants = [],
}: {
  suppliers: SupplierRow[];
  defaultBranchLabel: string;
  /**
   * Whether this buyer may create a product inline. Separate from the lists
   * below: a shop's first order has no categories yet, and that is exactly
   * when creating one here matters most.
   */
  canCreateProducts: boolean;
  /** Reference data for creating a product inline. */
  categories: CategoryOption[];
  brands: BrandOption[];
  attributes: MatrixAttribute[];
  /** Lines to start with — "Raise a purchase order" from a product or a stock row. */
  initialVariants?: PickableVariant[];
}) {
  const router = useRouter();

  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [shipping, setShipping] = useState("");
  // What the supplier charges as VAT, typed as a percentage. It is stored
  // per line (the column lives there) but asked for once, because a supplier
  // invoice quotes one VAT figure at the bottom. Blank means none, and the
  // preview then says nothing about VAT at all.
  const [vatPercent, setVatPercent] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(() =>
    // Priced from the catalogue for now; choosing a supplier re-prices every
    // line nobody has typed into, exactly as it does for a picked one. These
    // were asked for by name, so they are not widened to their whole product.
    initialVariants.map((variant) => ({
      key: variant.id,
      variantId: variant.id,
      sku: variant.sku,
      productName: variant.product_name,
      variantLabel: variant.label,
      quantity: "1",
      unitCost: variant.cost,
      discount: "0",
      productId: variant.product,
      onHand: null,
    })),
  );
  const [sendNow, setSendNow] = useState(false);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);
  // This supplier's own price list, keyed by variant. Null until a supplier is
  // chosen; empty once fetched for a supplier we have never bought from.
  const [offers, setOffers] = useState<OfferMap>(EMPTY_OFFERS);
  const [offersLoading, setOffersLoading] = useState(false);
  // Non-null while the inline product form is open; holds the search term
  // that found nothing, so the buyer does not retype the name.
  const [creatingNamed, setCreatingNamed] = useState<string | null>(null);
  // Each product's variants, by product id: what "Add a variant" offers and
  // where a line's stock figure comes from.
  const [catalogue, setCatalogue] = useState<Record<string, CatalogueEntry>>({});
  // The product whose new sizes or colours are being created, if any.
  const [extending, setExtending] = useState<string | null>(null);
  // Said after a scan, so a second scan of the same barcode is visibly a
  // quantity going up rather than nothing happening.
  const [announcement, setAnnouncement] = useState("");

  // Lines added after an await price from the list as it is *then*, not as it
  // was when the request started.
  const offersRef = useRef(offers);
  useEffect(() => {
    offersRef.current = offers;
  }, [offers]);

  const totals = useMemo(
    () => orderTotals(lines, shipping, vatPercent),
    [lines, shipping, vatPercent],
  );
  const lineProblems = useMemo(() => validateLines(lines), [lines]);
  const chosen = useMemo(() => new Set(lines.map((line) => line.variantId)), [lines]);
  const groups = useMemo(() => groupLines(lines), [lines]);
  const orderedCount = useMemo(() => orderedLines(lines).length, [lines]);
  const supplier = suppliers.find((row) => row.id === supplierId);

  /**
   * A line for a variant. What *this* supplier last charged, falling back to
   * the catalogue's cost when we have never bought this from them; the
   * fallback is labelled on the row rather than passed off as a quote.
   */
  function draftLine(
    variant: LineSource,
    productId: string | undefined,
    quantity: string,
    onHand: number | null,
  ): DraftLine {
    return {
      key: variant.id,
      variantId: variant.id,
      sku: variant.sku,
      productName: variant.product_name,
      variantLabel: variant.label,
      quantity,
      unitCost: resolveCost(offersRef.current, variant.id, variant.cost).cost,
      discount: "0",
      productId,
      onHand,
    };
  }

  /**
   * Load a product's variants, with their stock at this branch.
   *
   * `bringIn` puts every one the order does not have yet on it at 0 -- what a
   * scan does the first time it meets a product. Without it the lines already
   * there just learn their stock, and "Add a variant" learns what to offer.
   * Archived variants are retired SKUs: offered nowhere.
   */
  async function loadProduct(productId: string, { bringIn }: { bringIn: boolean }) {
    setCatalogue((current) => ({
      ...current,
      [productId]: { name: current[productId]?.name ?? "", variants: [], status: "loading" },
    }));
    try {
      const product = await apiClient<{ name: string; variants: CatalogueVariant[] }>(
        `/products/${productId}/`,
      );
      setCatalogue((current) => ({
        ...current,
        [productId]: { name: product.name, variants: product.variants, status: "ready" },
      }));

      const stock = new Map(product.variants.map((variant) => [variant.id, variant.stock]));
      const siblings = bringIn
        ? product.variants
            .filter((variant) => variant.status !== "ARCHIVED")
            .map((variant) =>
              draftLine(variant, productId, "0", variant.stock?.on_hand ?? null),
            )
        : [];
      setLines((current) => {
        const known = current.map((line) =>
          line.productId === productId && stock.has(line.variantId)
            ? { ...line, onHand: stock.get(line.variantId)?.on_hand ?? 0 }
            : line,
        );
        return mergeProductLines(
          known,
          productId,
          siblings,
          product.variants.map((variant) => variant.id),
        );
      });
      if (bringIn && siblings.length > 1) {
        setAnnouncement(
          `${product.name}: all ${siblings.length} variants are listed. Give a quantity to the ones you are ordering — those left at 0 are not ordered.`,
        );
      }
    } catch {
      setCatalogue((current) => ({
        ...current,
        [productId]: { name: current[productId]?.name ?? "", variants: [], status: "failed" },
      }));
    }
  }

  // "Raise a purchase order" from a product or stock row: those lines get
  // their stock figures and their products' other variants to offer, but no
  // new lines -- they were asked for by name.
  useEffect(() => {
    const products = new Set(initialVariants.flatMap((variant) => variant.product ?? []));
    for (const productId of products) void loadProduct(productId, { bringIn: false });
    // Once, on mount: these are the lines the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A scan or a pick from the search. */
  function pick(variant: PickableVariant) {
    const describe = `${variant.product_name}${variant.label ? ` ${variant.label}` : ""}`;
    const onOrder = lines.find((line) => line.variantId === variant.id);
    if (onOrder) {
      // Scanning the same barcode again is counting: one more.
      const next = isOrdered(onOrder) ? Number(onOrder.quantity) + 1 : 1;
      setLines((current) => bumpQuantity(current, variant.id));
      setAnnouncement(`${describe}: quantity ${next}.`);
      return;
    }

    const productId = variant.product;
    const entry = productId ? catalogue[productId] : undefined;
    const onHand = entry?.variants.find((row) => row.id === variant.id)?.stock?.on_hand ?? null;
    const line = draftLine(variant, productId, "1", onHand);
    setAnnouncement(`${describe} added.`);

    if (productId && entry) {
      // Already brought in once; the buyer has shaped the list since, so only
      // this variant comes back.
      setLines((current) =>
        mergeProductLines(
          current,
          productId,
          [line],
          entry.variants.map((row) => row.id),
        ),
      );
      return;
    }
    setLines((current) => [...current, line]);
    if (productId) void loadProduct(productId, { bringIn: true });
  }

  /** One of the product's own variants, put back on the order at 1. */
  function addVariant(productId: string, variantId: string) {
    const entry = catalogue[productId];
    const variant = entry?.variants.find((row) => row.id === variantId);
    if (!entry || !variant) return;
    setLines((current) =>
      mergeProductLines(
        current,
        productId,
        [draftLine(variant, productId, "1", variant.stock?.on_hand ?? null)],
        entry.variants.map((row) => row.id),
      ),
    );
  }

  /** New sizes or colours, just created on the product, go straight onto the order. */
  function addExtended(productId: string, created: PickableVariant[]) {
    const entry = catalogue[productId];
    const existing = entry?.variants ?? [];
    const order = [...existing.map((row) => row.id), ...created.map((row) => row.id)];
    setLines((current) =>
      mergeProductLines(
        current,
        productId,
        created.map((variant) => draftLine(variant, productId, "1", 0)),
        order,
      ),
    );
    setExtending(null);
    setAnnouncement(
      `${created.length} new variant${created.length === 1 ? "" : "s"} of ${entry?.name ?? "the product"} added.`,
    );
    // Reload, so the new SKUs are offered and carry their stock (none yet).
    void loadProduct(productId, { bringIn: false });
  }

  /**
   * Put freshly created products onto the order.
   *
   * They go through the same `draftLine` as a picked one, so they pick up this
   * supplier's price if there somehow is one and the catalogue cost otherwise —
   * which for a product created seconds ago is the cost just typed into the
   * form, carried on the variant.
   */
  function addCreated(created: PickableVariant[]) {
    setLines((current) => [
      ...current,
      ...created
        .filter((variant) => !current.some((line) => line.variantId === variant.id))
        .map((variant) => draftLine(variant, variant.product, "1", 0)),
    ]);
    setCreatingNamed(null);
    const products = new Set(created.flatMap((variant) => variant.product ?? []));
    for (const productId of products) void loadProduct(productId, { bringIn: false });
  }

  function setLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  /** A cost the buyer typed is theirs; switching supplier must not discard it. */
  function setUnitCost(key: string, unitCost: string) {
    setLine(key, { unitCost, costTouched: true });
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  function removeGroup(groupKey: string, productId: string | null) {
    setLines((current) =>
      current.filter((line) => (line.productId ?? `variant:${line.variantId}`) !== groupKey),
    );
    if (productId) {
      // Forgotten, so scanning it again brings the whole product back.
      setCatalogue((current) => {
        const next = { ...current };
        delete next[productId];
        return next;
      });
      if (extending === productId) setExtending(null);
    }
  }

  function removeUnordered(groupKey: string) {
    setLines((current) =>
      current.filter(
        (line) => (line.productId ?? `variant:${line.variantId}`) !== groupKey || isOrdered(line),
      ),
    );
  }

  /**
   * Load the chosen supplier's price list, and re-price with it.
   *
   * Switching supplier mid-order is the case worth getting right: the lines
   * already on screen were priced for somebody else, and leaving them would
   * send the new supplier the old one's figures. Lines the buyer typed into are
   * left exactly as typed — see `costTouched`.
   */
  useEffect(() => {
    if (!supplierId) {
      setOffers(EMPTY_OFFERS);
      return;
    }

    let current = true;
    setOffersLoading(true);
    fetchSupplierOffers(supplierId)
      .then((loaded) => {
        if (!current) return;
        setOffers(loaded);
        setLines((existing) =>
          existing.map((line) =>
            line.costTouched
              ? line
              : { ...line, unitCost: resolveCost(loaded, line.variantId, line.unitCost).cost },
          ),
        );
      })
      .catch(() => {
        // A price list that will not load must not block raising the order: the
        // catalogue cost is still a workable default and every line is editable.
        if (current) setOffers(EMPTY_OFFERS);
      })
      .finally(() => {
        if (current) setOffersLoading(false);
      });

    return () => {
      current = false;
    };
  }, [supplierId]);

  /** Choosing a supplier suggests a delivery date from their lead time. */
  function chooseSupplier(id: string) {
    setSupplierId(id);
    const picked = suppliers.find((row) => row.id === id);
    if (picked && !expectedAt) {
      const due = new Date();
      due.setDate(due.getDate() + picked.lead_time_days);
      setExpectedAt(due.toISOString().slice(0, 10));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const found: { field: string; message: string }[] = [];
    if (!supplierId) found.push({ field: "supplier", message: "Choose a supplier." });
    if (lines.length === 0) {
      found.push({ field: "lines", message: "A purchase order needs at least one line." });
    } else if (orderedCount === 0) {
      found.push({
        field: "lines",
        message: "Give at least one line a quantity. Lines left at 0 are not ordered.",
      });
    }
    for (const problem of lineProblems) {
      found.push({ field: "lines", message: problem.message });
    }
    setErrors(found);
    if (found.length) {
      document.getElementById("po-error-summary")?.scrollIntoView({ block: "center" });
      return;
    }

    setSaving(true);
    try {
      const order = await apiClient<{ id: string; number: string }>("/purchase-orders/", {
        method: "POST",
        body: {
          supplier: supplierId,
          lines: toCreatePayload(lines, vatPercent),
          expected_at: expectedAt || null,
          invoice_number: invoiceNumber,
          shipping_total: shipping || "0",
          notes,
        },
      });

      // Sending is a separate, explicit act — the API refuses to send twice, and
      // a draft is the right place to stop if the buyer wants to check it first.
      if (sendNow) {
        await apiClient(`/purchase-orders/${order.id}/send/`, { method: "POST", body: {} });
      }

      router.push(`/admin/purchases/${order.id}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "supplier", message: caught.message }],
        );
      } else {
        setErrors([{ field: "supplier", message: "Could not save. Please try again." }]);
      }
      document.getElementById("po-error-summary")?.scrollIntoView({ block: "center" });
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;
  const problemFor = (key: string) =>
    lineProblems.find((problem) => problem.key === key)?.message;
  const extendingEntry = extending ? catalogue[extending] : undefined;

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <div id="po-error-summary">
        <ErrorSummary errors={errors} title="Could not raise this purchase order" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {addingSupplier ? (
            <SupplierForm
              nested
              onDone={(created) => {
                setSuppliers((current) =>
                  [...current, created].sort((a, b) => a.name.localeCompare(b.name)),
                );
                chooseSupplier(created.id);
                setAddingSupplier(false);
              }}
              onCancel={() => setAddingSupplier(false)}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Supplier" htmlFor="po-supplier" required error={errorFor("supplier")}>
                <div className="flex gap-2">
                  <Select
                    id="po-supplier"
                    value={supplierId}
                    onChange={(event) => chooseSupplier(event.target.value)}
                    invalid={Boolean(errorFor("supplier"))}
                  >
                    <option value="">Choose a supplier…</option>
                    {suppliers
                      .filter((row) => row.status === "ACTIVE" || row.id === supplierId)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                          {row.status === "INACTIVE" ? " (inactive)" : ""}
                        </option>
                      ))}
                  </Select>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setAddingSupplier(true)}
                    className="shrink-0"
                  >
                    New
                  </Button>
                </div>
              </Field>

              <Field
                label="Expected delivery"
                htmlFor="po-expected"
                hint={
                  supplier
                    ? `${supplier.name} usually takes ${supplier.lead_time_days} days.`
                    : "Suggested from the supplier's lead time."
                }
                error={errorFor("expected_at")}
              >
                <Input
                  id="po-expected"
                  type="date"
                  value={expectedAt}
                  onChange={(event) => setExpectedAt(event.target.value)}
                />
              </Field>

              <Field
                label="Supplier invoice number"
                htmlFor="po-invoice"
                error={errorFor("invoice_number")}
              >
                <Input
                  id="po-invoice"
                  value={invoiceNumber}
                  onChange={(event) => setInvoiceNumber(event.target.value)}
                  maxLength={64}
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Branch"
                htmlFor="po-branch"
                hint="Goods are received into your branch."
              >
                <Input id="po-branch" value={defaultBranchLabel} disabled readOnly />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {creatingNamed !== null ? (
            <NewProductForm
              initialName={creatingNamed}
              categories={categories}
              brands={brands}
              attributes={attributes}
              onCreated={addCreated}
              onCancel={() => setCreatingNamed(null)}
            />
          ) : extending && extendingEntry?.status === "ready" ? (
            <NewVariantsForm
              productId={extending}
              productName={extendingEntry.name}
              existing={extendingEntry.variants}
              attributes={attributes}
              onCreated={(created) => addExtended(extending, created)}
              onCancel={() => setExtending(null)}
            />
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1">
                <VariantPicker
                  onPick={pick}
                  exclude={chosen}
                  label="Add a product to this order"
                  onCreateRequest={canCreateProducts ? setCreatingNamed : undefined}
                />
              </div>
              {/* Visible from the start, not only after a search misses: a
                  shop's first order has nothing to search for. */}
              {canCreateProducts && (
                <Button type="button" variant="secondary" onClick={() => setCreatingNamed("")}>
                  <Plus className="size-4" aria-hidden />
                  New product
                </Button>
              )}
            </div>
          )}

          <p className="min-h-5 text-body-sm text-muted" role="status" aria-live="polite">
            {announcement}
          </p>

          {errorFor("lines") && (
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {errorFor("lines")}
            </p>
          )}

          {lines.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-8 text-center text-body-sm text-muted">
              {canCreateProducts
                ? "No lines yet. Scan a barcode, search for a product above, or add a new product. Every size and colour of what you scan comes with it."
                : "No lines yet. Scan a barcode or search for a product above. Every size and colour of what you scan comes with it."}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-body-sm">
                <caption className="sr-only">
                  Purchase order lines, grouped by product. Lines at quantity 0 are not ordered.
                </caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Quantity</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Unit cost</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Discount</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Line total</th>
                    <th scope="col" className="px-3 py-2.5">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                {groups.map((group) => {
                  const entry = group.productId ? catalogue[group.productId] : undefined;
                  const onOrder = new Set(group.lines.map((line) => line.variantId));
                  const addable =
                    entry?.status === "ready"
                      ? entry.variants.filter(
                          (variant) => variant.status !== "ARCHIVED" && !onOrder.has(variant.id),
                        )
                      : [];
                  const ordered = group.lines.filter(isOrdered).length;
                  const unordered = group.lines.length - ordered;
                  const name = entry?.name || group.productName;
                  const canExtend =
                    canCreateProducts &&
                    group.productId !== null &&
                    entry?.status === "ready" &&
                    !hasSingleVersion(entry.variants);
                  return (
                    <tbody key={group.key} className="divide-y divide-border border-t border-border">
                      <tr className="bg-neutral-50">
                        <th scope="rowgroup" colSpan={6} className="px-3 py-2 text-left font-normal">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span className="font-semibold">{name}</span>
                            <span className="text-caption text-muted">
                              {ordered} of {group.lines.length} variant
                              {group.lines.length === 1 ? "" : "s"} ordered
                            </span>
                            {entry?.status === "loading" && (
                              <span className="inline-flex items-center gap-1 text-caption text-muted">
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                Loading its other sizes and colours…
                              </span>
                            )}
                            {entry?.status === "failed" && group.productId && (
                              <span className="text-caption text-[var(--error)]" role="alert">
                                Could not load its other variants.{" "}
                                <button
                                  type="button"
                                  className="font-medium underline"
                                  onClick={() => {
                                    if (group.productId) {
                                      void loadProduct(group.productId, { bringIn: true });
                                    }
                                  }}
                                >
                                  Try again
                                </button>
                              </span>
                            )}
                            <div className="ml-auto flex flex-wrap items-center gap-2">
                              {addable.length > 0 && group.productId && (
                                <Select
                                  aria-label={`Add a variant of ${name}`}
                                  value=""
                                  onChange={(event) => {
                                    if (group.productId && event.target.value) {
                                      addVariant(group.productId, event.target.value);
                                    }
                                  }}
                                  className="h-8 w-auto text-body-sm"
                                >
                                  <option value="">Add a variant…</option>
                                  {addable.map((variant) => (
                                    <option key={variant.id} value={variant.id}>
                                      {variant.label || variant.sku}
                                      {variant.stock ? ` · ${variant.stock.on_hand} in stock` : ""}
                                    </option>
                                  ))}
                                </Select>
                              )}
                              {canExtend && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setExtending(group.productId)}
                                >
                                  <Plus aria-hidden /> New size or colour
                                </Button>
                              )}
                              {unordered > 0 && ordered > 0 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeUnordered(group.key)}
                                >
                                  Remove the {unordered} at 0
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeGroup(group.key, group.productId)}
                                aria-label={`Remove ${name} and all its lines from the order`}
                              >
                                <Trash2 aria-hidden /> Remove product
                              </Button>
                            </div>
                          </div>
                        </th>
                      </tr>
                      {group.lines.map((line) => {
                        const lineTotal = lineTotals(line);
                        const problem = problemFor(line.key);
                        const describe = `${line.productName}${line.variantLabel ? ` ${line.variantLabel}` : ""}`;
                        const offer = offers.get(line.variantId) ?? null;
                        const included = isOrdered(line);
                        const belowMinimum = included
                          ? minimumOrderWarning(offer, line.quantity)
                          : null;
                        return (
                          <tr key={line.key} className={cn(problem && "bg-[var(--error-bg)]")}>
                            <td className="px-3 py-2">
                              <span className={cn("block font-medium", !included && "text-muted")}>
                                {line.variantLabel || line.productName}
                              </span>
                              <span className="font-mono block text-caption text-muted">
                                {line.sku}
                              </span>
                              {/* The hint for how many to order: what is on the
                                  shelf now, at the branch this order is for. */}
                              {line.onHand !== undefined && line.onHand !== null && (
                                <span
                                  className={cn(
                                    "block text-caption",
                                    line.onHand <= 0 ? "text-[var(--warning-text)]" : "text-muted",
                                  )}
                                >
                                  {line.onHand <= 0 ? "Out of stock" : `${line.onHand} in stock`}
                                </span>
                              )}
                              {!included && !problem && (
                                <span className="block text-caption text-muted">
                                  Not on the order at 0
                                </span>
                              )}
                              {problem && (
                                <span role="alert" className="block text-caption text-[var(--error)]">
                                  {problem}
                                </span>
                              )}
                              {/* Where the price came from. A buyer quoting a figure
                                  back at a supplier should know whether that
                                  supplier ever charged it. */}
                              {supplierId && !offersLoading && included && (
                                offer ? (
                                  <span className="block text-caption text-muted">
                                    {offer.supplier_sku ? `Their code ${offer.supplier_sku} · ` : ""}
                                    last paid {money(offer.last_cost)}
                                  </span>
                                ) : (
                                  <span className="block text-caption text-muted">
                                    First order from this supplier — cost is the catalogue&rsquo;s,
                                    not theirs.
                                  </span>
                                )
                              )}
                              {belowMinimum && (
                                <span className="block text-caption text-[var(--warning-text)]">
                                  {belowMinimum}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                value={line.quantity}
                                onChange={(event) =>
                                  setLine(line.key, { quantity: event.target.value })
                                }
                                aria-label={`Quantity for ${describe}`}
                                className="tabular h-8 w-24 text-right text-body-sm"
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                value={line.unitCost}
                                onChange={(event) => setUnitCost(line.key, event.target.value)}
                                aria-label={`Unit cost for ${describe}`}
                                className="tabular h-8 w-28 text-right text-body-sm"
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                value={line.discount}
                                onChange={(event) =>
                                  setLine(line.key, { discount: event.target.value })
                                }
                                aria-label={`Discount for ${describe}`}
                                className="tabular h-8 w-28 text-right text-body-sm"
                              />
                            </td>
                            <td
                              className={cn(
                                "tabular px-3 py-2 text-right font-medium",
                                !included && "text-muted",
                              )}
                            >
                              {money(lineTotal.net)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeLine(line.key)}
                                aria-label={`Remove ${describe}`}
                              >
                                <Trash2 aria-hidden />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:w-2/3">
            <Field
              label="Shipping / other cost"
              htmlFor="po-shipping"
              hint="Counted as a cost in net profit when the goods arrive."
            >
              <Input
                id="po-shipping"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field
              label="Supplier VAT %"
              htmlFor="po-vat"
              hint="What the supplier charges on this invoice. Leave blank if none."
            >
              <Input
                id="po-vat"
                type="number"
                min="0"
                max="100"
                step="0.01"
                inputMode="decimal"
                value={vatPercent}
                onChange={(event) => setVatPercent(event.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Notes" htmlFor="po-notes" className="sm:col-span-2">
              <Textarea
                id="po-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>

          <dl className="ml-auto max-w-sm space-y-1.5 text-body-sm">
            <Row term={`Subtotal (${totals.unitCount} units on ${totals.lineCount} lines)`} value={money(totals.subtotal)} />
            {totals.discountTotal > 0 && (
              <Row term="Discount" value={`− ${money(totals.discountTotal)}`} />
            )}
            {totals.taxTotal > 0 && <Row term="VAT" value={money(totals.taxTotal)} />}
            {totals.shipping > 0 && <Row term="Shipping" value={money(totals.shipping)} />}
            <div className="flex items-baseline justify-between border-t border-border pt-1.5 text-body font-semibold">
              <dt>Grand total</dt>
              <dd className="tabular">{money(totals.grandTotal)}</dd>
            </div>
          </dl>
          <p className="text-caption text-muted">
            The server recalculates every figure from the lines it is sent; this is a preview.
          </p>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-border bg-surface px-4 py-3 sm:-mx-6 sm:px-6">
        <Button type="submit" loading={saving} disabled={lines.length === 0}>
          {sendNow ? (
            <>
              <Send className="size-4" aria-hidden />
              Create and send
            </>
          ) : (
            "Save as draft"
          )}
        </Button>

        <label className="flex items-center gap-2 text-body-sm">
          <Checkbox checked={sendNow} onChange={(event) => setSendNow(event.target.checked)} />
          Send to the supplier straight away
        </label>

        <Button type="button" variant="ghost" className="ml-auto" asChild>
          <Link href="/admin/purchases">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{term}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
