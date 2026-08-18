import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { StockBadge } from "@/components/admin/status-badge";
import { Card, EmptyState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer } from "@/lib/api/server";
import type { InventoryRow } from "@/lib/api/types";
import { money } from "@/lib/format";

export const metadata = { title: "Inventory" };

type Search = Promise<Record<string, string | undefined>>;

const FILTERS = [
  { value: "", label: "All stock" },
  { value: "low-stock", label: "Low stock" },
  { value: "out-of-stock", label: "Out of stock" },
  { value: "expiring", label: "Expiring" },
];

export default async function InventoryPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["filter", "search", "category", "page"]) {
    if (params[key]) query.set(key, params[key]!);
  }

  let rows: Paginated<InventoryRow> | null = null;
  let error: string | null = null;
  try {
    rows = await apiServer<Paginated<InventoryRow>>(`/inventory/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load inventory.";
  }

  const totalValue = (rows?.results ?? []).reduce(
    (sum, row) => sum + Number(row.stock_value ?? 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Every figure here comes from the ledger. Stock changes only through an adjustment, a sale, a return or a receipt."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const active = (params.filter ?? "") === filter.value;
          const search = new URLSearchParams();
          if (filter.value) search.set("filter", filter.value);
          return (
            <Link
              key={filter.value || "all"}
              href={`/admin/inventory${search.toString() ? `?${search}` : ""}`}
              aria-current={active ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 text-body-sm font-medium ${
                active
                  ? "bg-neutral-900 text-white"
                  : "border border-border bg-surface hover:bg-neutral-100"
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <p role="alert" className="p-6 text-body-sm text-[var(--error)]">
            {error}
          </p>
        ) : !rows || rows.results.length === 0 ? (
          <EmptyState
            title="Nothing to show"
            description="No stock rows match this filter."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Stock by product variant</caption>
                <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Product</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">SKU</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">On hand</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Reserved</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Available</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Avg cost</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Value</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.results.map((row) => (
                    <tr key={row.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-2.5">
                        <span className="block font-medium">{row.product_name}</span>
                        <span className="block text-caption text-muted">
                          {row.variant_label} · {row.category}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-caption">{row.sku}</td>
                      <td className="tabular px-4 py-2.5 text-right">{row.on_hand}</td>
                      <td className="tabular px-4 py-2.5 text-right text-muted">{row.reserved}</td>
                      <td className="tabular px-4 py-2.5 text-right font-medium">{row.available}</td>
                      <td className="tabular px-4 py-2.5 text-right">{money(row.average_cost)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{money(row.stock_value)}</td>
                      <td className="px-4 py-2.5">
                        <StockBadge available={row.available} reorderPoint={row.reorder_point} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-border bg-neutral-50">
                  <tr>
                    <td colSpan={6} className="px-4 py-2.5 text-right font-medium">
                      Value on this page
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-bold">{money(totalValue)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="border-t border-border px-4 py-2 text-caption text-muted">
              Showing {rows.results.length} of {rows.count} stock rows.
            </p>
          </>
        )}
      </Card>
    </>
  );
}
