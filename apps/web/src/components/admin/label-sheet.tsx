"use client";

import { Loader2, Minus, Plus, Printer, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { type PickableVariant, VariantPicker } from "@/components/admin/variant-picker";
import { BarcodeSvg } from "@/components/barcode/barcode-svg";
import { Button, Card, Checkbox, Field, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { isValidEan13 } from "@/lib/barcode/ean13";
import { money } from "@/lib/format";

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

interface Row {
  variant: PickableVariant;
  quantity: number;
  /** Filled in once a variant without a barcode has been given one. */
  barcode: string | null;
  assigning: boolean;
  error: string | null;
}

const MAX_QUANTITY = 500;

export function LabelSheet({
  canAssign,
  shopName,
}: {
  canAssign: boolean;
  /** The organization's own name, which heads every label. */
  shopName: string;
}) {
  const [rows, setRows] = useState<Row[]>([]);
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

  function update(id: string, change: Partial<Row>) {
    setRows((current) =>
      current.map((row) => (row.variant.id === id ? { ...row, ...change } : row)),
    );
  }

  async function add(variant: PickableVariant) {
    if (rows.some((row) => row.variant.id === variant.id)) return;
    setRows((current) => [
      ...current,
      {
        variant,
        quantity: 1,
        barcode: variant.barcode,
        assigning: !variant.barcode,
        error: null,
      },
    ]);

    // A barcode that is not a printable EAN-13 is the awkward case: the
    // variant *has* one, so nothing will be minted, but the renderer refuses
    // to draw it. Goods that arrived under an EAN-8 or a Code 128 land here.
    // Say so, rather than dropping the row from the sheet with no explanation.
    if (variant.barcode && !isValidEan13(variant.barcode)) {
      update(variant.id, {
        assigning: false,
        error: `${variant.barcode} is not a valid EAN-13, so it cannot be drawn as one. Scanning still works — this screen only prints EAN-13.`,
      });
      return;
    }

    // A variant with no barcode cannot be labelled, so mint one now rather than
    // at print time — the number has to be on screen before it is on paper.
    if (!variant.barcode) {
      if (!canAssign) {
        update(variant.id, {
          assigning: false,
          error: "This product has no barcode, and assigning one needs the products.update permission.",
        });
        return;
      }
      try {
        const result = await apiClient<{ barcode: string }>(
          `/variants/${variant.id}/barcode/`,
          { method: "POST" },
        );
        update(variant.id, { barcode: result.barcode, assigning: false });
      } catch (caught) {
        update(variant.id, {
          assigning: false,
          error:
            caught instanceof ApiError ? caught.message : "Could not assign a barcode.",
        });
      }
    }
  }

  const printable = rows.filter((row) => row.barcode && isValidEan13(row.barcode));
  const labels = printable.flatMap((row) =>
    Array.from({ length: row.quantity }, (_, index) => ({ row, key: `${row.variant.id}-${index}` })),
  );

  return (
    <div className="space-y-6">
      <Card className="no-print p-5">
        <VariantPicker onPick={add} label="Add a product to the sheet" autoFocus />

        {rows.length > 0 && (
          <ul className="mt-4 divide-y divide-border">
            {rows.map((row) => (
              <li key={row.variant.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium">
                    {row.variant.product_name}{" "}
                    <span className="text-muted">{row.variant.label}</span>
                  </p>
                  <p className="tabular text-body-sm text-muted">
                    {row.variant.sku}
                    {row.assigning && " · assigning a barcode…"}
                    {row.barcode && ` · ${row.barcode}`}
                  </p>
                  {row.error && (
                    <p className="mt-1 flex items-center gap-1.5 text-caption text-[var(--error)]">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                      {row.error}
                    </p>
                  )}
                </div>

                {row.assigning ? (
                  <Loader2 className="size-5 animate-spin text-muted" aria-hidden />
                ) : (
                  <div className="inline-flex items-center rounded-md border border-neutral-300">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`One fewer label for ${row.variant.sku}`}
                      onClick={() =>
                        update(row.variant.id, { quantity: Math.max(1, row.quantity - 1) })
                      }
                    >
                      <Minus aria-hidden />
                    </Button>
                    <Input
                      aria-label={`Labels for ${row.variant.sku}`}
                      className="w-16 border-0 text-center"
                      type="number"
                      min={1}
                      max={MAX_QUANTITY}
                      value={row.quantity}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        update(row.variant.id, {
                          quantity: Number.isFinite(next)
                            ? Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(next)))
                            : 1,
                        });
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`One more label for ${row.variant.sku}`}
                      onClick={() =>
                        update(row.variant.id, {
                          quantity: Math.min(MAX_QUANTITY, row.quantity + 1),
                        })
                      }
                    >
                      <Plus aria-hidden />
                    </Button>
                  </div>
                )}

                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.variant.sku} from the sheet`}
                  onClick={() =>
                    setRows((current) =>
                      current.filter((entry) => entry.variant.id !== row.variant.id),
                    )
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
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
              : `${labels.length} sticker${labels.length === 1 ? "" : "s"} · ${layout.widthMm} × ${
                  layout.heightMm
                } mm`}
          </p>
          <Button
            size="lg"
            onClick={() => window.print()}
            disabled={labels.length === 0 || !sizeValid}
          >
            <Printer aria-hidden /> Print
          </Button>
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
