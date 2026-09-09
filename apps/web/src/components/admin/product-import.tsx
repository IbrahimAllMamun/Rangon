"use client";

import { AlertTriangle, ArrowLeft, Check, FileUp, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorSummary,
  Field,
  Input,
} from "@/components/ui/primitives";
import { ApiError, apiUpload } from "@/lib/api/client";

/** One bad cell, addressed to the person looking at the spreadsheet. */
interface RowError {
  line: number;
  column: string;
  message: string;
}

interface ImportResult {
  dry_run: boolean;
  ok: boolean;
  products_created: string[];
  products_updated: string[];
  variants_created: string[];
  variants_updated: string[];
  categories_created: string[];
  brands_created: string[];
  stock_receipts: number;
  ignored_columns: string[];
  errors: RowError[];
}

const TEMPLATE_COLUMNS =
  "product_name,category,brand,sku,size,color,price,cost,opening_stock,barcode,description,published";

const TEMPLATE_ROWS = [
  "Classic Kurti,Women > Ethnic,Rangon,KUR-M-MAR,M,Maroon,1290,600,12,,Cotton kurti with side slits,yes",
  "Classic Kurti,Women > Ethnic,Rangon,KUR-L-MAR,L,Maroon,1290,600,8,,Cotton kurti with side slits,yes",
];

/**
 * Load a catalogue from a spreadsheet.
 *
 * Two steps, and the first is not skippable: the file is checked and the result
 * shown before anything is written. An import is the one action in this admin
 * that can create several hundred rows from a single click, so the preview is
 * the screen, and committing is a second, deliberate press.
 *
 * The preview is worth reading rather than clicking past. It names every
 * category and brand the file would invent, which is where a typo shows up —
 * `Wonen > Ethnic` becomes a new top-level category, and nothing later will
 * tell you it was a mistake.
 */
export function ProductImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);

  function pick(next: File | null) {
    setFile(next);
    // A new file invalidates the preview: committing the old plan with the new
    // file would import something nobody looked at.
    setPreview(null);
    setDone(null);
    setErrors([]);
  }

  async function send(dryRun: boolean) {
    if (!file) {
      setErrors([{ field: "file", message: "Choose a CSV file first." }]);
      return;
    }
    setBusy(dryRun ? "check" : "import");
    setErrors([]);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("dry_run", dryRun ? "true" : "false");
      const result = await apiUpload<ImportResult>("/products/import/", form);
      if (dryRun) {
        setPreview(result);
      } else {
        setDone(result);
        setPreview(null);
        router.refresh();
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        // A file the server refused whole — a missing column, a binary file —
        // arrives as a message rather than per-row errors.
        const fieldErrors = caught.fieldErrors();
        setErrors(
          fieldErrors.length ? fieldErrors : [{ field: "file", message: caught.message }],
        );
      } else {
        setErrors([{ field: "file", message: "Could not read the file. Please try again." }]);
      }
    } finally {
      setBusy(null);
    }
  }

  function downloadTemplate() {
    const body = [TEMPLATE_COLUMNS, ...TEMPLATE_ROWS].join("\n");
    // A BOM so Excel opens the Bengali and the ৳ correctly instead of as mojibake.
    const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "rangon-product-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (done) {
    return <Imported result={done} onAgain={() => pick(null)} />;
  }

  return (
    <div className="space-y-6">
      <ErrorSummary errors={errors} title="Could not read this file" />

      <Card>
        <CardHeader>
          <CardTitle>1. Choose the file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-body-sm text-muted">
            One row per variant, with the product columns repeated. Two rows sharing a{" "}
            <code className="font-mono">product_name</code> become one product with two variants.
            Required columns: <code className="font-mono">product_name</code>,{" "}
            <code className="font-mono">sku</code>, <code className="font-mono">price</code>.
          </p>

          <Field label="CSV file" htmlFor="import-file" required error={errors[0]?.message}>
            <Input
              id="import-file"
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => pick(event.target.files?.[0] ?? null)}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => send(true)} loading={busy === "check"}>
              <FileUp className="size-4" aria-hidden />
              Check the file
            </Button>
            <Button type="button" variant="ghost" onClick={downloadTemplate}>
              Download a template
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview && <Preview result={preview} onImport={() => send(false)} busy={busy === "import"} />}
    </div>
  );
}

function Preview({
  result,
  onImport,
  busy,
}: {
  result: ImportResult;
  onImport: () => void;
  busy: boolean;
}) {
  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-[var(--warning)]" aria-hidden />
            {result.errors.length} problem{result.errors.length === 1 ? "" : "s"} to fix first
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-body-sm text-muted">
            Nothing has been imported. Line numbers match the spreadsheet, counting the header as
            line 1.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Problems found in the file</caption>
              <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    Line
                  </th>
                  <th scope="col" className="px-4 py-2">
                    Column
                  </th>
                  <th scope="col" className="px-4 py-2">
                    Problem
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.errors.map((error, index) => (
                  <tr key={`${error.line}-${error.column}-${index}`}>
                    <td className="tabular px-4 py-2">{error.line}</td>
                    <td className="px-4 py-2 font-mono text-caption">{error.column || "—"}</td>
                    <td className="px-4 py-2">{error.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Check what this would do</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tally label="Products created" value={result.products_created.length} />
          <Tally label="Products updated" value={result.products_updated.length} />
          <Tally label="Variants created" value={result.variants_created.length} />
          <Tally label="Variants updated" value={result.variants_updated.length} />
        </dl>

        {result.stock_receipts > 0 && (
          <p className="text-body-sm text-muted">
            {result.stock_receipts} of the new variants carry opening stock, which is received into
            your branch and written to the inventory ledger. Variants that already exist keep the
            stock they have — correct those on the inventory screen, where the count is attributed.
          </p>
        )}

        {(result.categories_created.length > 0 || result.brands_created.length > 0) && (
          <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-4">
            <p className="text-body-sm font-medium">These do not exist yet and would be created</p>
            <p className="mt-1 text-body-sm text-muted">
              Read the list. A misspelling here becomes a real category or brand, and nothing later
              will tell you it was a typo.
            </p>
            {result.categories_created.length > 0 && (
              <p className="mt-3 text-body-sm">
                <span className="text-muted">Categories: </span>
                {result.categories_created.join(", ")}
              </p>
            )}
            {result.brands_created.length > 0 && (
              <p className="mt-1 text-body-sm">
                <span className="text-muted">Brands: </span>
                {result.brands_created.join(", ")}
              </p>
            )}
          </div>
        )}

        {result.ignored_columns.length > 0 && (
          <p className="text-body-sm text-muted">
            Columns that will be ignored: {result.ignored_columns.join(", ")}. If one of those is a
            misspelling of a real column, fix it before importing.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button type="button" onClick={onImport} loading={busy}>
            <Upload className="size-4" aria-hidden />
            Import {result.variants_created.length + result.variants_updated.length} variants
          </Button>
          <span className="text-body-sm text-muted">
            Nothing has been written yet. This is the step that writes.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function Imported({ result, onAgain }: { result: ImportResult; onAgain: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Check className="size-4 text-[var(--success)]" aria-hidden />
          Catalogue imported
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tally label="Products created" value={result.products_created.length} />
          <Tally label="Products updated" value={result.products_updated.length} />
          <Tally label="Variants created" value={result.variants_created.length} />
          <Tally label="Stock receipts" value={result.stock_receipts} />
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link href="/admin/products">
              <ArrowLeft className="size-4" aria-hidden />
              Back to products
            </Link>
          </Button>
          <Button type="button" variant="ghost" onClick={onAgain}>
            Import another file
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Tally({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption uppercase text-muted">{label}</dt>
      <dd className="tabular mt-1 text-h3 font-medium">{value}</dd>
    </div>
  );
}
