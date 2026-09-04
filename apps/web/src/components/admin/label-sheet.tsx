"use client";

import { Loader2, Minus, Plus, Printer, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { type PickableVariant, VariantPicker } from "@/components/admin/variant-picker";
import { BarcodeSvg } from "@/components/barcode/barcode-svg";
import { Button, Card, Checkbox, Field, Input, Select } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { isValidEan13 } from "@/lib/barcode/ean13";
import { money } from "@/lib/format";

/**
 * Barcode label sheets — the printable half of phase 24.
 *
 * The server already minted the *numbers*; nothing had ever drawn them. This
 * turns a set of variants into labels you can put on stock, and the register's
 * existing scan field reads them back.
 *
 * The layouts below are real label stock, so the grid must match the physical
 * sheet in the printer or every label is offset. They are stated in
 * millimetres and printed with `@page` margins that match the sheet's own,
 * which is why the preview is sized in millimetres too rather than scaled to
 * look right on screen.
 */

export interface LabelLayout {
  id: string;
  name: string;
  /** Label dimensions in millimetres. */
  widthMm: number;
  heightMm: number;
  columns: number;
  /** Rows per page; the thermal roll is one label per page. */
  rows: number;
  /** Page margins in millimetres. */
  pageMarginTopMm: number;
  pageMarginLeftMm: number;
  /** Barcode sizing tuned to the label — a 38 mm label cannot take 12 mm bars. */
  moduleMm: number;
  barHeightMm: number;
  /** A small label has no room for the product name as well. */
  allowName: boolean;
  pageWidthMm: number;
  pageHeightMm: number;
}

/**
 * Presets, all measured from the label stock rather than invented.
 *
 * An EAN-13 with its quiet zones is 113 modules wide, so at 0.264 mm per
 * module the symbol alone needs about 29.8 mm. That is what rules out anything
 * narrower than the 38.1 mm sheet: shrinking the module further to fit is
 * exactly how a label stops scanning.
 */
export const LAYOUTS: LabelLayout[] = [
  {
    id: "a4-65",
    name: "A4 sheet — 65 labels (38.1 × 21.2 mm)",
    widthMm: 38.1,
    heightMm: 21.2,
    columns: 5,
    rows: 13,
    pageMarginTopMm: 10.7,
    pageMarginLeftMm: 4.75,
    moduleMm: 0.264,
    barHeightMm: 8,
    allowName: false,
    pageWidthMm: 210,
    pageHeightMm: 297,
  },
  {
    id: "a4-40",
    name: "A4 sheet — 40 labels (52.5 × 29.7 mm)",
    widthMm: 52.5,
    heightMm: 29.7,
    columns: 4,
    rows: 10,
    pageMarginTopMm: 0,
    pageMarginLeftMm: 0,
    moduleMm: 0.33,
    barHeightMm: 11,
    allowName: true,
    pageWidthMm: 210,
    pageHeightMm: 297,
  },
  {
    id: "a4-24",
    name: "A4 sheet — 24 labels (70 × 37 mm)",
    widthMm: 70,
    heightMm: 37,
    columns: 3,
    rows: 8,
    pageMarginTopMm: 4.5,
    pageMarginLeftMm: 0,
    moduleMm: 0.4,
    barHeightMm: 14,
    allowName: true,
    pageWidthMm: 210,
    pageHeightMm: 297,
  },
  {
    id: "thermal-50",
    name: "Thermal roll — one label (50 × 25 mm)",
    widthMm: 50,
    heightMm: 25,
    columns: 1,
    rows: 1,
    pageMarginTopMm: 0,
    pageMarginLeftMm: 0,
    moduleMm: 0.33,
    barHeightMm: 10,
    allowName: false,
    pageWidthMm: 50,
    pageHeightMm: 25,
  },
];

interface Row {
  variant: PickableVariant;
  quantity: number;
  /** Filled in once a variant without a barcode has been given one. */
  barcode: string | null;
  assigning: boolean;
  error: string | null;
}

const MAX_QUANTITY = 500;

export function LabelSheet({ canAssign }: { canAssign: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [layoutId, setLayoutId] = useState(LAYOUTS[0].id);
  const [showPrice, setShowPrice] = useState(true);
  const [showSku, setShowSku] = useState(true);
  const [showName, setShowName] = useState(true);

  const layout = LAYOUTS.find((entry) => entry.id === layoutId) ?? LAYOUTS[0];
  const nameVisible = showName && layout.allowName;

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
  const perPage = layout.columns * layout.rows;
  const pages = Math.ceil(labels.length / perPage) || 0;

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
          <Field label="Label stock" htmlFor="label-layout">
            <Select
              id="label-layout"
              value={layoutId}
              onChange={(event) => setLayoutId(event.target.value)}
            >
              {LAYOUTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-body-sm font-medium">Show on each label</legend>
            <label className="flex items-center gap-2 text-body-sm">
              <Checkbox
                checked={nameVisible}
                disabled={!layout.allowName}
                onChange={(event) => setShowName(event.target.checked)}
              />
              Product name
              {!layout.allowName && (
                <span className="text-caption text-muted">— no room on this label size</span>
              )}
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
              : `${labels.length} label${labels.length === 1 ? "" : "s"} · ${pages} page${
                  pages === 1 ? "" : "s"
                } of ${layout.name.split("—")[0].trim()}`}
          </p>
          <Button size="lg" onClick={() => window.print()} disabled={labels.length === 0}>
            <Printer aria-hidden /> Print
          </Button>
        </div>

        <p className="mt-3 text-caption text-muted">
          Print at 100% scale with &ldquo;fit to page&rdquo; turned off. Any scaling changes the
          bar widths, and a resized barcode is the usual reason a label will not scan.
        </p>
      </Card>

      {labels.length > 0 && (
        <>
          <h2 className="no-print text-h4">Preview</h2>
          <div
            className="print-labels"
            style={{
              // Millimetres, not pixels: the preview is the printed sheet.
              width: `${layout.pageWidthMm}mm`,
              paddingTop: `${layout.pageMarginTopMm}mm`,
              paddingLeft: `${layout.pageMarginLeftMm}mm`,
              display: "grid",
              gridTemplateColumns: `repeat(${layout.columns}, ${layout.widthMm}mm)`,
              background: "#fff",
            }}
          >
            {labels.map(({ row, key }) => (
              <div
                key={key}
                className="print-label"
                style={{
                  width: `${layout.widthMm}mm`,
                  height: `${layout.heightMm}mm`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  color: "#000",
                }}
              >
                {nameVisible && (
                  <span
                    style={{
                      fontSize: "6pt",
                      lineHeight: 1.1,
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.variant.product_name} {row.variant.label}
                  </span>
                )}
                <BarcodeSvg
                  value={row.barcode as string}
                  moduleMm={layout.moduleMm}
                  heightMm={layout.barHeightMm}
                />
                <span style={{ fontSize: "6pt", lineHeight: 1.2 }}>
                  {showSku && row.variant.sku}
                  {showSku && showPrice && " · "}
                  {showPrice && money(row.variant.price)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
