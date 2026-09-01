import { ArrowRight, Download } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";
import { money, percent } from "@/lib/format";

export const metadata = { title: "Reports" };

interface ProductRow {
  sku: string;
  product_name: string;
  variant_label: string;
  units: number;
  revenue: string;
  cost: string;
  gross_profit: string;
  margin_percent: string;
  returned: number;
}

const RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

/** Every report the API exposes, so nothing is hidden behind a URL you must know. */
const REPORTS = [
  { path: "/reports/sales/", label: "Sales", description: "Every order with totals, channel and payment status" },
  { path: "/reports/products/performance/", label: "Product performance", description: "Units, revenue, COGS, margin" },
  { path: "/reports/inventory/valuation/", label: "Inventory valuation", description: "Stock at weighted average cost" },
  { path: "/reports/inventory/movement/", label: "Inventory movement", description: "Ledger totals by transaction type" },
  { path: "/reports/purchases/", label: "Purchases", description: "Purchase orders and supplier balances" },
  { path: "/reports/returns/", label: "Returns", description: "Reasons, quantities and refunds" },
  { path: "/reports/profit/", label: "Profit", description: "Revenue minus frozen COGS, by day" },
  { path: "/reports/expenses/", label: "Expenses", description: "Spending by category, with each category's share" },
  { path: "/reports/business-summary/", label: "Business summary", description: "Revenue, COGS, expenses and net profit as a statement" },
];

type Search = Promise<{ range?: string }>;

export default async function ReportsPage({ searchParams }: { searchParams: Search }) {
  const { range = "30d" } = await searchParams;

  let rows: ProductRow[] = [];
  let error: string | null = null;
  try {
    const data = await apiServer<{ results: ProductRow[] }>(
      `/reports/products/performance/?range=${range}`,
    );
    rows = data.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the report.";
  }

  const columns: Column<ProductRow>[] = [
    {
      header: "Product",
      cell: (row) => (
        <>
          <span className="block font-medium">{row.product_name}</span>
          <span className="block text-caption text-muted">
            {row.variant_label} · {row.sku}
          </span>
        </>
      ),
    },
    { header: "Units", numeric: true, cell: (row) => row.units },
    { header: "Returned", numeric: true, cell: (row) => row.returned || "—" },
    { header: "Revenue", numeric: true, cell: (row) => money(row.revenue) },
    { header: "Cost", numeric: true, cell: (row) => money(row.cost) },
    { header: "Gross profit", numeric: true, cell: (row) => money(row.gross_profit) },
    { header: "Margin", numeric: true, cell: (row) => percent(row.margin_percent) },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        description="Profit uses the cost frozen on each order line at sale time, so history does not move when prices change."
        actions={
          <div className="flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Date range">
            {RANGES.map((option) => (
              <Link
                key={option.value}
                href={`/admin/reports?range=${option.value}`}
                aria-current={range === option.value ? "true" : undefined}
                className={`rounded px-3 py-1.5 text-body-sm font-medium ${
                  range === option.value
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {option.label}
              </Link>
            ))}
          </div>
        }
      />

      <Link
        href={`/admin/reports/business?range=${range}`}
        className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-4 transition-colors duration-fast hover:border-neutral-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
      >
        <span>
          <span className="block text-body font-semibold">Business summary</span>
          <span className="block text-body-sm text-muted">
            The whole statement — revenue, refunds, cost of goods, expenses and net profit.
          </span>
        </span>
        <ArrowRight className="size-5 shrink-0 text-neutral-400" aria-hidden />
      </Link>

      <div className="mb-6">
        <h2 className="mb-2 text-h4">Product performance</h2>
        <ResourceTable
          rows={rows}
          columns={columns}
          caption="Product performance"
          error={error}
          emptyTitle="No sales in this period"
          emptyDescription="Choose a wider date range, or record a sale."
          rowKey={(row) => row.sku}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Download a report</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {REPORTS.map((report) => (
              <li key={report.path} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-body-sm font-medium">{report.label}</p>
                  <p className="text-caption text-muted">{report.description}</p>
                </div>
                <a
                  href={`/api/proxy${report.path}?range=${range}&format=csv`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
                >
                  <Download className="size-4" aria-hidden /> CSV
                </a>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <p className="mt-2 text-caption text-muted">
        CSV export needs the <code>reports.export</code> permission; financial reports additionally
        need <code>reports.financial</code>.
      </p>
    </>
  );
}
