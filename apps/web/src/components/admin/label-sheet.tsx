"use client";

import {
  CheckCheck,
  Loader2,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { type PickableVariant, VariantPicker } from "@/components/admin/variant-picker";
import { BarcodeSvg } from "@/components/barcode/barcode-svg";
import { Badge, Button, Card, Checkbox, Field, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { isValidEan13 } from "@/lib/barcode/ean13";
import { dateTime, humanise, money } from "@/lib/format";

/**
 * Barcode labels — the printable half of phase 24.
 *
 * The server already minted the *numbers*; nothing had ever drawn them. This
 * turns a set of variants into labels you can put on stock, and the register's
 * existing scan field reads them back.
 *
 * The shop prints on a thermal roll: one sticker per page, 38 x 25 mm unless
 * the roll in the printer says otherwise. The size is stated in millimetres
 * and handed to `@page` as the paper size, which is why the preview is sized
 * in millimetres too rather than scaled to look right on screen.
 */

export interface LabelLayout {
  /** Sticker dimensions in millimetres; also the printed page size. */
  widthMm: number;
  heightMm: number;
  /** Barcode sizing tuned to the sticker — a narrow one cannot take 12 mm bars. */
  moduleMm: number;
  barHeightMm: number;
  /**
   * Quiet space inside the sticker, in millimetres. Thermal stickers are
   * die-cut with a gap of their own, so this only has to keep the print off
   * the cut edge.
   */
  paddingXMm: number;
  paddingYMm: number;
  /**
   * Space above and below the bars, so the shop name and the number read as
   * their own lines rather than as part of the symbol.
   */
  gapMm: number;
  /** Type sizes in points, scaled with the sticker so the block does not overflow. */
  headingPt: number;
  numberPt: number;
  detailPt: number;
  pricePt: number;
  /** The price when it is the only detail on the sticker, centred under the number. */
  soloPricePt: number;
}

/** The roll the shop stocks. */
export const DEFAULT_LABEL_SIZE = { widthMm: 38, heightMm: 25 } as const;

/**
 * What the size fields accept.
 *
 * The width floor is the barcode, not taste. An EAN-13 with its quiet zones is
 * 113 modules, and 0.264 mm (80% of nominal) is the narrowest module that
 * still scans reliably, so the symbol alone needs 29.8 mm plus the padding.
 * Narrower than that and the only way to fit is to shrink the bars further —
 * exactly how a label stops scanning. The height floor is what the bars and
 * the text stack under them need.
 */
export const LABEL_SIZE_LIMITS = {
  widthMm: { min: 34, max: 100 },
  heightMm: { min: 20, max: 100 },
} as const;

const EAN13_MODULES = 113;
const MIN_MODULE_MM = 0.264;
const MAX_MODULE_MM = 0.33;
const PADDING_X_MM = 2;
const PADDING_Y_MM = 1.2;

/** Round down to `step`, so a rounded size never outgrows the one it came from. */
function floorTo(value: number, step: number): number {
  return Math.floor(value / step + 1e-9) * step;
}

/**
 * The layout for a sticker of the given size.
 *
 * Tuned on 38 x 25 mm and scaled from there. The bars take the widest module
 * the sticker allows, up to the nominal 0.33 mm; the type and bar height grow
 * with whichever dimension is tighter, so a wide-but-short sticker does not
 * get text that overflows its height.
 */
export function thermalLayout(widthMm: number, heightMm: number): LabelLayout {
  const usableMm = widthMm - PADDING_X_MM * 2;
  const moduleMm = Math.min(MAX_MODULE_MM, floorTo(usableMm / EAN13_MODULES, 0.001));
  const scale = Math.min(
    2,
    heightMm / DEFAULT_LABEL_SIZE.heightMm,
    widthMm / DEFAULT_LABEL_SIZE.widthMm,
  );
  return {
    widthMm,
    heightMm,
    moduleMm: Math.max(MIN_MODULE_MM, moduleMm),
    barHeightMm: floorTo(8 * scale, 0.1),
    paddingXMm: PADDING_X_MM,
    paddingYMm: PADDING_Y_MM,
    gapMm: floorTo(0.8 * scale, 0.1),
    headingPt: floorTo(6 * scale, 0.1),
    numberPt: floorTo(7 * scale, 0.1),
    detailPt: floorTo(4.5 * scale, 0.1),
    pricePt: floorTo(7.5 * scale, 0.1),
    soloPricePt: floorTo(11 * scale, 0.1),
  };
}

/** Read one size field: the millimetres, or what to tell the user. */
export function parseLabelDimension(
  raw: string,
  limits: { min: number; max: number },
): { value: number; error: null } | { value: null; error: string } {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) {
    return { value: null, error: "Enter a size in millimetres." };
  }
  if (value < limits.min || value > limits.max) {
    return { value: null, error: `Between ${limits.min} and ${limits.max} mm.` };
  }
  return { value, error: null };
}

/**
 * The variant as one line per attribute — "Size M", "Colour Black".
 *
 * Deliberately not `variant.label`, which is those same values joined into a
 * single "M / Black" string. That string cannot be split back apart safely (a
 * value may itself contain a slash) and, more to the point, it drops the
 * attribute *names*, so a label reads "M / Black" where it should read
 * "Size M" and "Colour Black". Whoever is holding the garment needs to know
 * which is which.
 *
 * Falls back to the joined label for a variant whose attributes did not come
 * down — an older cached response, or a variant with a free-text name.
 */
export function variantLines(variant: PickableVariant): string[] {
  const attributes = variant.attributes ?? [];
  if (attributes.length) {
    return attributes.map((entry) => `${entry.attribute_name} ${entry.label}`.trim());
  }
  return variant.label ? [variant.label] : [];
}

/** A variant's newest "labels printed" mark at the branch. */
export interface LabelStatus {
  /** False is an un-mark: someone ticked it and then took the tick back. */
  printed: boolean;
  quantity: number;
  /** The branch's stock when it was marked, read by the server. */
  on_hand: number;
  marked_at: string;
  marked_by: string;
  /** Units purchased in since the labels were printed: they have no sticker. */
  received_since: number;
}

/** A variant as `GET /products/{id}/labels/` sends it. */
export interface SheetVariant extends PickableVariant {
  status: string;
  stock: { on_hand: number; reserved: number; available: number } | null;
  label_status: LabelStatus | null;
  /**
   * How many stickers the server suggests: one per unit on hand until the
   * variant is marked printed, then one per unit delivered since.
   */
  suggested_labels: number;
}

export interface LabelSheetPayload {
  product: { id: string; name: string; brand_name: string; status: string };
  /** The branch the stock was read from, and the one a mark is recorded against. */
  branch: { id: string; name: string; code: string };
  variants: SheetVariant[];
}

export interface Row {
  variant: SheetVariant;
  quantity: number;
  /** Filled in once a variant without a barcode has been given one. */
  barcode: string | null;
  assigning: boolean;
  /** A mark or un-mark is on its way to the server. */
  marking: boolean;
  error: string | null;
}

interface Group {
  product: LabelSheetPayload["product"];
  branch: LabelSheetPayload["branch"];
  rows: Row[];
}

/** The server's own ceiling per mark (`inventory.labels.MAX_LABELS`). */
export const MAX_QUANTITY = 500;

export function clampQuantity(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_QUANTITY, Math.max(0, Math.trunc(value))) : 0;
}

/**
 * A barcode that is not a printable EAN-13 is the awkward case: the variant
 * *has* one, so nothing will be minted, but the renderer refuses to draw it.
 * Goods that arrived under an EAN-8 or a Code 128 land here. Say so, rather
 * than dropping the row from the sheet with no explanation.
 */
function barcodeProblem(barcode: string | null): string | null {
  if (barcode && !isValidEan13(barcode)) {
    return `${barcode} is not a valid EAN-13, so it cannot be drawn as one. Scanning still works — this screen only prints EAN-13.`;
  }
  return null;
}

/** Every variant of a product just added, each at the count the server suggests. */
export function rowsFromSheet(variants: SheetVariant[]): Row[] {
  return variants.map((variant) => ({
    variant,
    quantity: clampQuantity(variant.suggested_labels),
    barcode: variant.barcode,
    assigning: false,
    marking: false,
    error: barcodeProblem(variant.barcode),
  }));
}

/**
 * Fold a sheet the server sent back into the rows on screen.
 *
 * The stock and the ticks are the server's, so they are always replaced. The
 * label counts are the user's -- typing them is the point of the screen -- so
 * only the rows just marked or un-marked (`touched`) are reset, to what the
 * server now suggests: nothing more for a variant just finished, its stock for
 * one just reopened. A variant created since the product was added joins.
 */
export function mergeSheet(
  rows: Row[],
  variants: SheetVariant[],
  touched: ReadonlySet<string>,
): Row[] {
  const fresh = new Map(variants.map((variant) => [variant.id, variant]));
  const merged = rows.map((row) => {
    const variant = fresh.get(row.variant.id);
    if (!variant) return row;
    const reset = touched.has(variant.id);
    return {
      ...row,
      variant,
      barcode: variant.barcode ?? row.barcode,
      quantity: reset ? clampQuantity(variant.suggested_labels) : row.quantity,
      marking: reset ? false : row.marking,
      error: reset ? barcodeProblem(variant.barcode ?? row.barcode) : row.error,
    };
  });
  const known = new Set(rows.map((row) => row.variant.id));
  return [...merged, ...rowsFromSheet(variants.filter((variant) => !known.has(variant.id)))];
}

/**
 * The lines under a variant's tick: what was printed, by whom and when, and
 * whether stock has arrived since that has no sticker. Text, not colour, says
 * which (WCAG 1.4.1).
 */
export function describeLabelStatus(
  status: LabelStatus | null,
): { summary: string; reopened: string | null } | null {
  if (!status) return null;
  const by = status.marked_by ? ` by ${status.marked_by}` : "";
  if (!status.printed) {
    return { summary: `Marked not printed ${dateTime(status.marked_at)}${by}`, reopened: null };
  }
  return {
    summary: `${status.quantity} printed ${dateTime(status.marked_at)}${by}`,
    reopened:
      status.received_since > 0
        ? `${status.received_since} more received since — they need labels`
        : null,
  };
}

/** What a variant is called on the sheet; a single-version product has no options. */
function variantName(variant: PickableVariant): string {
  return variant.label || "Single version";
}

export function LabelSheet({
  canAssign,
  canMark,
  shopName,
}: {
  /** `products.update`: mint a barcode for a variant that has none. */
  canAssign: boolean;
  /** `products.update`: tick a variant's labels off as printed. */
  canMark: boolean;
  /** The organization's own name, which heads every label. */
  shopName: string;
}) {
  // One group per product: picking any variant brings in all of its siblings.
  const [groups, setGroups] = useState<Group[]>([]);
  /** The product whose variants are on their way, by name. */
  const [loading, setLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  // Strings, so a half-typed "3" on the way to "38" is not rejected mid-keystroke.
  const [widthInput, setWidthInput] = useState(String(DEFAULT_LABEL_SIZE.widthMm));
  const [heightInput, setHeightInput] = useState(String(DEFAULT_LABEL_SIZE.heightMm));
  // Shop and price by default: what a customer reads off a 38 mm sticker. The
  // product details are there for stock that needs telling apart on the rail.
  const [showPrice, setShowPrice] = useState(true);
  const [showSku, setShowSku] = useState(false);
  const [showName, setShowName] = useState(false);
  const [showShopName, setShowShopName] = useState(true);
  const [showBrand, setShowBrand] = useState(false);

  const width = parseLabelDimension(widthInput, LABEL_SIZE_LIMITS.widthMm);
  const height = parseLabelDimension(heightInput, LABEL_SIZE_LIMITS.heightMm);
  const sizeValid = width.value !== null && height.value !== null;
  const layout = thermalLayout(
    width.value ?? DEFAULT_LABEL_SIZE.widthMm,
    height.value ?? DEFAULT_LABEL_SIZE.heightMm,
  );
  const isDefaultSize =
    width.value === DEFAULT_LABEL_SIZE.widthMm && height.value === DEFAULT_LABEL_SIZE.heightMm;

  /**
   * Whether anything sits beside the price. Asked per variant, not per
   * checkbox: "Brand" ticked on a product with no brand prints nothing, and
   * that sticker should get the large centred price like any other.
   */
  function hasDetails(variant: PickableVariant): boolean {
    return Boolean((showBrand && variant.brand_name) || showName || showSku);
  }

  function updateRows(
    productId: string,
    variantIds: ReadonlySet<string>,
    change: (row: Row) => Partial<Row>,
  ) {
    setGroups((current) =>
      current.map((group) =>
        group.product.id !== productId
          ? group
          : {
              ...group,
              rows: group.rows.map((row) =>
                variantIds.has(row.variant.id) ? { ...row, ...change(row) } : row,
              ),
            },
      ),
    );
  }

  function updateRow(productId: string, variantId: string, change: Partial<Row>) {
    updateRows(productId, new Set([variantId]), () => change);
  }

  /**
   * A variant with no barcode cannot be labelled, so mint one before anything
   * is printed — the number has to be on screen before it is on paper.
   */
  async function assignBarcode(productId: string, variantId: string) {
    if (!canAssign) return;
    updateRow(productId, variantId, { assigning: true, error: null });
    try {
      const result = await apiClient<{ barcode: string }>(`/variants/${variantId}/barcode/`, {
        method: "POST",
      });
      updateRow(productId, variantId, { barcode: result.barcode, assigning: false });
    } catch (caught) {
      updateRow(productId, variantId, {
        assigning: false,
        error: caught instanceof ApiError ? caught.message : "Could not assign a barcode.",
      });
    }
  }

  /**
   * Scanning one variant brings in the whole product: every size and colour,
   * each with the stock this branch holds as the hint for how many stickers it
   * needs, and whether it has already been printed.
   */
  async function add(picked: PickableVariant) {
    const productId = picked.product;
    if (!productId) {
      setNotice({ tone: "error", text: `Could not tell which product ${picked.sku} belongs to.` });
      return;
    }
    if (groups.some((group) => group.product.id === productId)) {
      setNotice({
        tone: "info",
        text: `${picked.product_name} is already on the sheet, with all of its variants.`,
      });
      document.getElementById(rowDomId(picked.id))?.scrollIntoView({ block: "nearest" });
      return;
    }

    setNotice(null);
    setLoading(picked.product_name);
    try {
      const sheet = await apiClient<LabelSheetPayload>(`/products/${productId}/labels/`);
      setGroups((current) =>
        // Two quick scans of one product both fetch; only the first lands.
        current.some((group) => group.product.id === productId)
          ? current
          : [
              ...current,
              { product: sheet.product, branch: sheet.branch, rows: rowsFromSheet(sheet.variants) },
            ],
      );
      // The variant that was actually scanned gets its barcode straight away,
      // as it always has; its siblings wait to be asked.
      if (!picked.barcode) await assignBarcode(productId, picked.id);
    } catch (caught) {
      setNotice({
        tone: "error",
        text:
          caught instanceof ApiError
            ? caught.message
            : `Could not load the variants of ${picked.product_name}. Try again.`,
      });
    } finally {
      setLoading(null);
    }
  }

  /**
   * Tick variants off as printed, or take the tick back. The server records a
   * new mark for each and answers with the whole sheet, which replaces the
   * stock and the ticks on screen; the counts typed elsewhere are kept.
   */
  async function mark(group: Group, entries: { row: Row; printed: boolean }[]): Promise<void> {
    if (!entries.length) return;
    const ids = new Set(entries.map(({ row }) => row.variant.id));
    updateRows(group.product.id, ids, () => ({ marking: true, error: null }));
    try {
      const sheet = await apiClient<LabelSheetPayload>(`/products/${group.product.id}/labels/`, {
        method: "POST",
        body: {
          // The branch the stock on screen came from, so the mark lands there.
          branch: group.branch.id,
          marks: entries.map(({ row, printed }) => ({
            variant: row.variant.id,
            printed,
            quantity: printed ? row.quantity : 0,
          })),
        },
      });
      setGroups((current) =>
        current.map((candidate) =>
          candidate.product.id !== group.product.id
            ? candidate
            : { ...candidate, branch: sheet.branch, rows: mergeSheet(candidate.rows, sheet.variants, ids) },
        ),
      );
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not save the mark. Try again.";
      updateRows(group.product.id, ids, () => ({ marking: false, error: message }));
    }
  }

  const printable = groups.flatMap((group) =>
    group.rows
      .filter((row) => row.quantity > 0 && row.barcode && isValidEan13(row.barcode))
      .map((row) => ({ group, row })),
  );
  const labels = printable.flatMap(({ row }) =>
    Array.from({ length: row.quantity }, (_, index) => ({ row, key: `${row.variant.id}-${index}` })),
  );

  async function markSheetPrinted() {
    setMarkingAll(true);
    try {
      await Promise.all(
        groups.map((group) =>
          mark(
            group,
            printable
              .filter((entry) => entry.group.product.id === group.product.id)
              .map(({ row }) => ({ row, printed: true })),
          ),
        ),
      );
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="no-print p-5">
        <VariantPicker onPick={add} label="Add a product to the sheet" autoFocus />

        {notice && (
          <p
            className={
              notice.tone === "error"
                ? "mt-3 flex items-center gap-1.5 text-body-sm text-[var(--error)]"
                : "mt-3 text-body-sm text-muted"
            }
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.tone === "error" && <TriangleAlert className="size-4 shrink-0" aria-hidden />}
            {notice.text}
          </p>
        )}

        {loading && (
          <p className="mt-4 flex items-center gap-2 text-body-sm text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading every variant of {loading}…
          </p>
        )}

        {groups.length === 0 && !loading && (
          <p className="mt-4 text-body-sm text-muted">
            Scan or search for any size or colour. Every variant of that product is listed with
            the stock this branch holds — one label per unit is filled in for you — and you tick
            each one off once its labels are printed.
          </p>
        )}

        {groups.map((group) => (
          <LabelGroup
            key={group.product.id}
            group={group}
            canAssign={canAssign}
            canMark={canMark}
            onQuantity={(row, quantity) =>
              updateRow(group.product.id, row.variant.id, { quantity: clampQuantity(quantity) })
            }
            onAssign={(row) => assignBarcode(group.product.id, row.variant.id)}
            onMark={(row, printed) => mark(group, [{ row, printed }])}
            onRemove={() =>
              setGroups((current) =>
                current.filter((candidate) => candidate.product.id !== group.product.id),
              )
            }
          />
        ))}
      </Card>

      <Card className="no-print p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="space-y-2">
            <legend className="text-body-sm font-medium">Sticker size — thermal roll</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Width (mm)" htmlFor="label-width" error={width.error ?? undefined}>
                <Input
                  id="label-width"
                  type="number"
                  inputMode="decimal"
                  step={0.1}
                  min={LABEL_SIZE_LIMITS.widthMm.min}
                  max={LABEL_SIZE_LIMITS.widthMm.max}
                  value={widthInput}
                  onChange={(event) => setWidthInput(event.target.value)}
                  invalid={width.error !== null}
                  aria-describedby={width.error ? "label-width-error" : undefined}
                />
              </Field>
              <Field label="Height (mm)" htmlFor="label-height" error={height.error ?? undefined}>
                <Input
                  id="label-height"
                  type="number"
                  inputMode="decimal"
                  step={0.1}
                  min={LABEL_SIZE_LIMITS.heightMm.min}
                  max={LABEL_SIZE_LIMITS.heightMm.max}
                  value={heightInput}
                  onChange={(event) => setHeightInput(event.target.value)}
                  invalid={height.error !== null}
                  aria-describedby={height.error ? "label-height-error" : undefined}
                />
              </Field>
            </div>
            {isDefaultSize ? (
              <p className="text-caption text-muted">
                One sticker per page. Change the size only if your roll is not{" "}
                {DEFAULT_LABEL_SIZE.widthMm} × {DEFAULT_LABEL_SIZE.heightMm} mm.
              </p>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setWidthInput(String(DEFAULT_LABEL_SIZE.widthMm));
                  setHeightInput(String(DEFAULT_LABEL_SIZE.heightMm));
                }}
              >
                <RotateCcw aria-hidden /> Back to {DEFAULT_LABEL_SIZE.widthMm} ×{" "}
                {DEFAULT_LABEL_SIZE.heightMm} mm
              </Button>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-body-sm font-medium">Show on each label</legend>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={showShopName}
                onChange={(event) => setShowShopName(event.target.checked)}
              />
              Shop name
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={showBrand}
                onChange={(event) => setShowBrand(event.target.checked)}
              />
              Brand
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={showName}
                onChange={(event) => setShowName(event.target.checked)}
              />
              Product name and variant
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={showSku}
                onChange={(event) => setShowSku(event.target.checked)}
              />
              SKU
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={showPrice}
                onChange={(event) => setShowPrice(event.target.checked)}
              />
              Price
            </label>
          </fieldset>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-body-sm text-muted" role="status" aria-live="polite">
            {labels.length === 0
              ? "Nothing to print yet."
              : `${labels.length} sticker${labels.length === 1 ? "" : "s"} for ${
                  printable.length
                } variant${printable.length === 1 ? "" : "s"} · ${layout.widthMm} × ${
                  layout.heightMm
                } mm`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/*
              After the roll comes out, one click ticks off everything that was
              on it. Separate from Print on purpose: a jammed printer or a
              cancelled dialog must not mark anything done.
            */}
            {canMark && printable.length > 0 && (
              <Button
                variant="secondary"
                size="lg"
                onClick={markSheetPrinted}
                disabled={markingAll}
              >
                {markingAll ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <CheckCheck aria-hidden />
                )}
                Mark {printable.length} as printed
              </Button>
            )}
            <Button
              size="lg"
              onClick={() => window.print()}
              disabled={labels.length === 0 || !sizeValid}
            >
              <Printer aria-hidden /> Print
            </Button>
          </div>
        </div>

        <p className="mt-3 text-caption text-muted">
          Print at 100% scale with &ldquo;fit to page&rdquo; turned off. Any scaling changes the
          bar widths, and a resized barcode is the usual reason a label will not scan.
        </p>
      </Card>

      {labels.length > 0 && sizeValid && (
        <>
          {/*
            The paper is the sticker. Set here rather than in globals.css
            because the size is the user's, and the rule only exists while this
            screen is mounted, so receipts and invoices keep their own pages.
          */}
          <style>{`@media print { @page { size: ${layout.widthMm}mm ${layout.heightMm}mm; margin: 0; } }`}</style>
          <h2 className="no-print text-h4">Preview</h2>
          <div
            className="print-labels flex flex-col gap-2 print:gap-0"
            // Millimetres, not pixels: the preview is the printed roll.
            style={{ width: `${layout.widthMm}mm` }}
          >
            {labels.map(({ row, key }) => (
              <div
                key={key}
                className="print-label outline-dashed outline-1 outline-neutral-300 print:outline-none"
                style={{
                  background: "#fff",
                  width: `${layout.widthMm}mm`,
                  height: `${layout.heightMm}mm`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  color: "#000",
                  padding: `${layout.paddingYMm}mm ${layout.paddingXMm}mm`,
                  boxSizing: "border-box",
                }}
              >
                {/*
                  The shop heads the label, not the garment's brand. On a rail
                  of mixed stock the question a label answers first is "whose
                  shop is this", and the brand is a detail of the product like
                  its size — so it sits with the rest of them below.
                */}
                {showShopName && shopName && (
                  <span
                    style={{
                      fontSize: `${layout.headingPt}pt`,
                      fontWeight: 700,
                      lineHeight: 1.15,
                      marginBottom: `${layout.gapMm}mm`,
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {shopName}
                  </span>
                )}

                {/*
                  The symbol draws without its own digits, and the number is
                  set below it in HTML instead. The specification's own 1/6/6
                  split at the foot of the bars is small by design; a counter
                  reading a code out to key it in wants it large, which is how
                  retail labels are actually printed.
                */}
                <BarcodeSvg
                  value={row.barcode as string}
                  moduleMm={layout.moduleMm}
                  heightMm={layout.barHeightMm}
                  showDigits={false}
                />
                <span
                  style={{
                    fontSize: `${layout.numberPt}pt`,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    letterSpacing: "0.04em",
                    fontFamily: "monospace",
                    marginTop: `${layout.gapMm}mm`,
                  }}
                >
                  {row.barcode}
                </span>

                {/*
                  Details left, price right — the price is what a customer
                  looks for and the details are what staff pick from, so they
                  do not compete for the same corner. With no details there is
                  no corner to share: the price takes the middle, large.
                */}
                {showPrice && !hasDetails(row.variant) ? (
                  <span
                    style={{
                      fontSize: `${layout.soloPricePt}pt`,
                      fontWeight: 700,
                      lineHeight: 1.1,
                      whiteSpace: "nowrap",
                      marginTop: `${layout.gapMm}mm`,
                    }}
                  >
                    {money(row.variant.price)}
                  </span>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-end",
                      justifyContent: "space-between",
                      gap: "1mm",
                      width: "100%",
                      marginTop: "0.4mm",
                    }}
                  >
                    <div style={{ minWidth: 0, textAlign: "left" }}>
                      {showBrand && row.variant.brand_name && (
                        <div
                          style={{
                            fontSize: `${layout.detailPt}pt`,
                            fontWeight: 700,
                            lineHeight: 1.25,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.variant.brand_name}
                        </div>
                      )}
                      {showName && (
                        <div
                          style={{
                            fontSize: `${layout.detailPt}pt`,
                            lineHeight: 1.25,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.variant.product_name}
                        </div>
                      )}
                      {showName &&
                        variantLines(row.variant).map((line) => (
                          <div
                            key={line}
                            style={{
                              fontSize: `${layout.detailPt}pt`,
                              lineHeight: 1.25,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {line}
                          </div>
                        ))}
                      {showSku && (
                        <div
                          style={{
                            fontSize: `${layout.detailPt}pt`,
                            lineHeight: 1.25,
                            fontFamily: "monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.variant.sku}
                        </div>
                      )}
                    </div>
  
                    {showPrice && (
                      <span
                        style={{
                          fontSize: `${layout.pricePt}pt`,
                          fontWeight: 700,
                          lineHeight: 1.1,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {money(row.variant.price)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function rowDomId(variantId: string): string {
  return `label-row-${variantId}`;
}

/**
 * One product on the sheet: every variant, its stock, its label count and its
 * tick. A table, because the admin is dense and tabular by design and these
 * are rows to be read across — variant, stock, labels, done.
 */
function LabelGroup({
  group,
  canAssign,
  canMark,
  onQuantity,
  onAssign,
  onMark,
  onRemove,
}: {
  group: Group;
  canAssign: boolean;
  canMark: boolean;
  onQuantity: (row: Row, quantity: number) => void;
  onAssign: (row: Row) => void;
  onMark: (row: Row, printed: boolean) => void;
  onRemove: () => void;
}) {
  const headingId = `label-group-${group.product.id}`;
  const done = group.rows.filter((row) => row.variant.label_status?.printed).length;
  const missing = group.rows.filter((row) => !row.barcode && !row.assigning);

  return (
    <section aria-labelledby={headingId} className="mt-6 border-t border-border pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-body font-semibold">
            {group.product.name}
            {group.product.brand_name && (
              <span className="font-normal text-muted"> · {group.product.brand_name}</span>
            )}
          </h2>
          <p className="text-caption text-muted">
            {done} of {group.rows.length} variant{group.rows.length === 1 ? "" : "s"} printed ·
            stock at {group.branch.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canAssign && missing.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => missing.forEach((row) => onAssign(row))}
            >
              Assign {missing.length} barcode{missing.length === 1 ? "" : "s"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${group.product.name} from the sheet`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden /> Remove
          </Button>
        </div>
      </div>

      {group.rows.length === 0 ? (
        <p className="mt-3 text-body-sm text-muted">This product has no variants yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-body-sm">
            <caption className="sr-only">
              Variants of {group.product.name}, with stock and label status
            </caption>
            <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Variant
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  In stock
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Labels to print
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Printed
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {group.rows.map((row) => (
                <LabelRow
                  key={row.variant.id}
                  row={row}
                  canAssign={canAssign}
                  canMark={canMark}
                  onQuantity={(quantity) => onQuantity(row, quantity)}
                  onAssign={() => onAssign(row)}
                  onMark={(printed) => onMark(row, printed)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LabelRow({
  row,
  canAssign,
  canMark,
  onQuantity,
  onAssign,
  onMark,
}: {
  row: Row;
  canAssign: boolean;
  canMark: boolean;
  onQuantity: (quantity: number) => void;
  onAssign: () => void;
  onMark: (printed: boolean) => void;
}) {
  const { variant } = row;
  const name = variantName(variant);
  const onHand = variant.stock?.on_hand ?? 0;
  const printed = Boolean(variant.label_status?.printed);
  const status = describeLabelStatus(variant.label_status);
  const statusId = `label-status-${variant.id}`;
  const suggested = clampQuantity(variant.suggested_labels);

  return (
    <tr id={rowDomId(variant.id)} className="align-top">
      <td className="px-3 py-2.5">
        <p className="font-medium">
          {name}
          {variant.status && variant.status !== "ACTIVE" && (
            <Badge className="ml-2 align-middle">{humanise(variant.status)}</Badge>
          )}
        </p>
        <p className="tabular text-caption text-muted">
          {variant.sku}
          {row.barcode ? ` · ${row.barcode}` : row.assigning ? " · assigning a barcode…" : ""}
        </p>
        {!row.barcode && !row.assigning && !row.error && (
          <p className="mt-1 text-caption text-muted">
            No barcode yet, so nothing to print.{" "}
            {canAssign ? (
              <button
                type="button"
                onClick={onAssign}
                className="font-medium text-brand-700 underline-offset-4 hover:underline"
              >
                Assign one
              </button>
            ) : (
              "Assigning one needs the products.update permission."
            )}
          </p>
        )}
        {row.error && (
          <p className="mt-1 flex items-start gap-1.5 text-caption text-[var(--error)]" role="alert">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {row.error}
          </p>
        )}
      </td>

      <td className="tabular px-3 py-2.5 text-right">
        <span className={onHand > 0 ? "font-medium" : "text-muted"}>{onHand}</span>
      </td>

      <td className="px-3 py-2.5">
        {row.assigning ? (
          <Loader2 className="size-5 animate-spin text-muted" aria-hidden />
        ) : (
          <div className="inline-flex items-center rounded-md border border-neutral-300">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`One fewer label for ${variant.sku}`}
              onClick={() => onQuantity(row.quantity - 1)}
              disabled={row.quantity <= 0}
            >
              <Minus aria-hidden />
            </Button>
            <Input
              aria-label={`Labels for ${name} (${variant.sku})`}
              className="w-16 border-0 text-center"
              type="number"
              min={0}
              max={MAX_QUANTITY}
              value={row.quantity}
              onChange={(event) => onQuantity(Number(event.target.value))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`One more label for ${variant.sku}`}
              onClick={() => onQuantity(row.quantity + 1)}
              disabled={row.quantity >= MAX_QUANTITY}
            >
              <Plus aria-hidden />
            </Button>
          </div>
        )}
        {!row.assigning && row.quantity !== suggested && (
          <button
            type="button"
            onClick={() => onQuantity(suggested)}
            className="mt-1 block text-caption font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            {printed ? `Use ${suggested} (received since printing)` : `Use ${suggested} (in stock)`}
          </button>
        )}
      </td>

      <td className="px-3 py-2.5">
        {canMark ? (
          <label className="inline-flex items-center gap-2">
            <Checkbox
              checked={printed}
              disabled={row.marking}
              onChange={(event) => onMark(event.target.checked)}
              aria-label={`Labels printed for ${name} (${variant.sku})`}
              aria-describedby={status ? statusId : undefined}
            />
            <span aria-hidden>{row.marking ? "Saving…" : printed ? "Printed" : "Not yet"}</span>
          </label>
        ) : (
          <Badge tone={printed ? "success" : "neutral"}>{printed ? "Printed" : "Not printed"}</Badge>
        )}
        {status && (
          <div id={statusId}>
            <p className="mt-1 text-caption text-muted">{status.summary}</p>
            {status.reopened && (
              <p className="mt-0.5 flex items-start gap-1 text-caption font-medium text-[var(--warning-text)]">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {status.reopened}
              </p>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
