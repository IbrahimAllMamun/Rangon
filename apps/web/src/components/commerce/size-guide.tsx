"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Ruler, X } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import type { ShopSizeChart } from "@/lib/api/types";
import { cn } from "@/lib/cn";

/**
 * The product's size chart, opened from beside its size options.
 *
 * A dialog rather than a section further down the page, because the question
 * it answers — "which of these is mine?" — is asked while choosing, and the
 * answer should not cost the shopper their place. Radix supplies the focus
 * trap, Escape, and focus returned to the trigger on close.
 *
 * A wide chart scrolls sideways inside its own box, never the page, with the
 * size column pinned so every row stays labelled. The shopper's current pick
 * is tinted *and* labelled "Selected", so colour is never the only signal
 * (CLAUDE.md §11). Nothing in the table is focusable, so the pinned column
 * can never cover a focused control.
 */
export function SizeGuide({
  chart,
  selectedValue,
  productName,
  className,
}: {
  chart: ShopSizeChart;
  /** The value (not label) of the size currently picked, if any. */
  selectedValue?: string;
  productName: string;
  className?: string;
}) {
  const heading = chart.system ? `${chart.name} · ${chart.system} sizing` : chart.name;

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={cn(
            // 44px tall: a touch target, though it reads as a link.
            "inline-flex min-h-11 items-center gap-1.5 rounded-md text-body-sm font-medium text-brand-700",
            "underline-offset-4 hover:underline",
            "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
            className,
          )}
        >
          <Ruler className="size-4" aria-hidden />
          Size guide
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/50 animate-fade-in motion-reduce:animate-none" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(44rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-surface p-5 shadow-lg animate-fade-in focus:outline-none motion-reduce:animate-none sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-display text-h4">Size guide</Dialog.Title>
              <p className="mt-1 text-body-sm text-muted">{heading}</p>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close size guide">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            What each {chart.attribute_name.toLowerCase()} of {productName} measures.
          </Dialog.Description>

          {/* A phone shows the size column and about two more. Without this a
              five-column chart looks like a two-column one, because the
              table's own border reads as its end. */}
          {chart.columns.length > 2 && (
            <p className="mt-4 text-caption text-muted sm:hidden">
              Swipe the table sideways to see all {chart.columns.length} columns.
            </p>
          )}

          <div
            className={cn(
              "overflow-x-auto rounded-lg border border-border",
              chart.columns.length > 2 ? "mt-2 sm:mt-5" : "mt-5",
            )}
          >
            <table className="w-full border-collapse text-body-sm">
              <caption className="sr-only">
                {heading}: one row per {chart.attribute_name.toLowerCase()}
              </caption>
              <thead>
                <tr className="bg-neutral-50">
                  <th
                    scope="col"
                    className="sticky left-0 z-10 border-b border-r border-border bg-neutral-50 px-4 py-3 text-left font-semibold"
                  >
                    {chart.attribute_name}
                  </th>
                  {chart.columns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="whitespace-nowrap border-b border-border px-4 py-3 text-left font-semibold"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chart.rows.map((row) => {
                  const picked = row.value === selectedValue;
                  return (
                    <tr
                      key={row.value}
                      className={cn(
                        "border-b border-border last:border-b-0",
                        picked && "bg-brand-50",
                      )}
                    >
                      <th
                        scope="row"
                        className={cn(
                          "sticky left-0 z-10 whitespace-nowrap border-r border-border px-4 py-3 text-left font-semibold",
                          picked ? "bg-brand-50" : "bg-surface",
                        )}
                      >
                        {row.label}
                        {picked && (
                          <span className="ml-2 text-caption font-medium text-brand-700">
                            Selected
                          </span>
                        )}
                      </th>
                      {row.cells.map((cell, index) => (
                        <td key={index} className="tabular whitespace-nowrap px-4 py-3">
                          {cell || <span className="text-muted">—</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {chart.notes && (
            <div className="mt-5">
              <h3 className="text-body-sm font-semibold">How to measure</h3>
              <p className="mt-1 whitespace-pre-line text-body-sm text-neutral-700">{chart.notes}</p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
