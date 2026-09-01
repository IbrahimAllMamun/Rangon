import { Download, Receipt, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, ErrorState } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";
import { dateOnly, money, percent } from "@/lib/format";

export const metadata = { title: "Business summary" };

interface ExpenseRow {
  category_id: string;
  category: string;
  code: string;
  total: string;
  count: number;
  share: string;
}

interface BusinessSummary {
  period: { start: string; end: string; label: string };
  revenue: {
    goods: string;
    refunds: string;
    net: string;
    shipping_charged: string;
    discounts_given: string;
    vat_collected: string;
  };
  cost_of_goods: { sold: string; recovered_from_returns: string; net: string };
  gross_profit: string;
  gross_margin_percent: string;
  expenses: { total: string; count: number; by_category: ExpenseRow[] };
  net_profit: string;
  net_margin_percent: string;
  volume: {
    orders: number;
    units: number;
    returns: number;
    average_order_value: string;
  };
}

const RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "year", label: "This year" },
];

type Search = Promise<{ range?: string }>;

/** A statement line. `level` drives indentation; `weight` marks a subtotal. */
interface Line {
  label: string;
  amount: string;
  /** Rendered as a deduction: shown in parentheses and subtracted. */
  negative?: boolean;
  emphasis?: "total" | "subtotal";
  note?: string;
}

export default async function BusinessSummaryPage({ searchParams }: { searchParams: Search }) {
  const { range = "30d" } = await searchParams;

  let summary: BusinessSummary | null = null;
  let error: string | null = null;
  try {
    summary = await apiServer<BusinessSummary>(`/reports/business-summary/?range=${range}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the business summary.";
  }

  const profitTone = (value: string) => (Number.parseFloat(value) < 0 ? "error" : "success");

  return (
    <>
      <PageHeader
        title="Business summary"
        description="Revenue through to net profit. Costs come from the price frozen on each order line at sale time, so history does not move when today's prices do."
        actions={
          <div
            className="flex rounded-md border border-border bg-surface p-0.5"
            role="group"
            aria-label="Date range"
          >
            {RANGES.map((option) => (
              <Link
                key={option.value}
                href={`/admin/reports/business?range=${option.value}`}
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

      {error || !summary ? (
        <ErrorState
          title="Could not load the business summary"
          description={error ?? "The report returned nothing."}
        />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Net profit"
              value={money(summary.net_profit)}
              context={`${percent(summary.net_margin_percent)} of net revenue`}
              icon={
                Number.parseFloat(summary.net_profit) < 0 ? (
                  <TrendingDown className="size-4" aria-hidden />
                ) : (
                  <TrendingUp className="size-4" aria-hidden />
                )
              }
              tone={profitTone(summary.net_profit)}
            />
            <StatCard
              label="Gross profit"
              value={money(summary.gross_profit)}
              context={`${percent(summary.gross_margin_percent)} margin`}
              icon={<Wallet className="size-4" aria-hidden />}
              tone={profitTone(summary.gross_profit)}
            />
            <StatCard
              label="Net revenue"
              value={money(summary.revenue.net)}
              context={`${summary.volume.orders} orders · ${summary.volume.units} units`}
            />
            <StatCard
              label="Expenses"
              value={money(summary.expenses.total)}
              context={`${summary.expenses.count} recorded`}
              icon={<Receipt className="size-4" aria-hidden />}
            />
          </div>

          <Card className="mb-6">
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle>
                Statement — {dateOnly(summary.period.start)} to {dateOnly(summary.period.end)}
              </CardTitle>
              <a
                href={`/api/proxy/reports/business-summary/?range=${range}&format=csv`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
              >
                <Download className="size-4" aria-hidden /> CSV
              </a>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-body-sm">
                  <caption className="sr-only">
                    Profit and loss for the selected period. Deductions are shown in parentheses.
                  </caption>
                  <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Line
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {statementLines(summary).map((line) => (
                      <StatementRow key={line.label} line={line} />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Expenses by category</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {summary.expenses.by_category.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-body-sm">
                      <caption className="sr-only">Expenses grouped by category</caption>
                      <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                        <tr>
                          <th scope="col" className="px-4 py-2.5 font-medium">
                            Category
                          </th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">
                            Count
                          </th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">
                            Total
                          </th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">
                            Share
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {summary.expenses.by_category.map((row) => (
                          <tr key={row.category_id}>
                            <td className="px-4 py-2.5 font-medium">{row.category}</td>
                            <td className="tabular px-4 py-2.5 text-right text-muted">
                              {row.count}
                            </td>
                            <td className="tabular px-4 py-2.5 text-right">{money(row.total)}</td>
                            <td className="tabular px-4 py-2.5 text-right text-muted">
                              {percent(row.share)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="p-6 text-body-sm text-muted">
                    No expenses recorded in this period.{" "}
                    <Link href="/admin/expenses" className="text-brand-600 hover:underline">
                      Record one
                    </Link>
                    .
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Trade in the period</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-body-sm">
                  <dt className="text-muted">Orders</dt>
                  <dd className="tabular text-right font-medium">{summary.volume.orders}</dd>
                  <dt className="text-muted">Units sold</dt>
                  <dd className="tabular text-right font-medium">{summary.volume.units}</dd>
                  <dt className="text-muted">Average order value</dt>
                  <dd className="tabular text-right font-medium">
                    {money(summary.volume.average_order_value)}
                  </dd>
                  <dt className="text-muted">Returns completed</dt>
                  <dd className="tabular text-right font-medium">{summary.volume.returns}</dd>
                  <dt className="text-muted">Discounts given</dt>
                  <dd className="tabular text-right font-medium">
                    {money(summary.revenue.discounts_given)}
                  </dd>
                  <dt className="text-muted">Delivery charged</dt>
                  <dd className="tabular text-right font-medium">
                    {money(summary.revenue.shipping_charged)}
                  </dd>
                </dl>
                <p className="mt-4 border-t border-border pt-3 text-caption text-muted">
                  <strong className="font-medium text-neutral-700">
                    VAT collected {money(summary.revenue.vat_collected)}
                  </strong>{" "}
                  is held for the government, not income, so it appears in neither revenue nor
                  profit above.
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function statementLines(summary: BusinessSummary): Line[] {
  return [
    { label: "Revenue from goods", amount: summary.revenue.goods, note: "net of VAT" },
    { label: "Refunds on completed returns", amount: summary.revenue.refunds, negative: true },
    { label: "Net revenue", amount: summary.revenue.net, emphasis: "subtotal" },
    { label: "Cost of goods sold", amount: summary.cost_of_goods.sold, negative: true },
    {
      label: "Cost recovered from restocked returns",
      amount: summary.cost_of_goods.recovered_from_returns,
      note: "damaged and quarantined stock stays a cost",
    },
    { label: "Gross profit", amount: summary.gross_profit, emphasis: "subtotal" },
    { label: "Operating expenses", amount: summary.expenses.total, negative: true },
    { label: "Net profit", amount: summary.net_profit, emphasis: "total" },
  ];
}

function StatementRow({ line }: { line: Line }) {
  const value = Number.parseFloat(line.amount);
  const isTotal = line.emphasis === "total";
  const isLoss = value < 0;
  // One convention per table: parentheses mean "taken away". A deduction line
  // is always shown that way, and so is a total that came out negative --
  // rendering a loss as "-79,865" beside "(1,320)" would put two notations for
  // the same idea in one column.
  const inParentheses = line.negative || isLoss;
  const magnitude = isLoss ? line.amount.replace("-", "") : line.amount;

  return (
    <tr className={line.emphasis ? "bg-neutral-50" : undefined}>
      <th
        scope="row"
        className={`px-4 py-2.5 text-left font-normal ${
          line.emphasis ? "font-semibold" : ""
        } ${line.negative ? "pl-8 text-muted" : ""}`}
      >
        {line.label}
        {line.note && <span className="ml-1.5 text-caption text-muted">({line.note})</span>}
      </th>
      <td
        className={`tabular px-4 py-2.5 text-right ${
          isTotal ? "text-body font-bold" : line.emphasis ? "font-semibold" : ""
        } ${isTotal && isLoss ? "text-[var(--error)]" : ""}`}
      >
        {/* Parentheses, not colour alone, carry "this is taken away" — the
            statement has to read correctly in greyscale (WCAG 1.4.1). */}
        {inParentheses ? `(${money(magnitude)})` : money(magnitude)}
        {isTotal && isLoss && <span className="sr-only"> loss</span>}
      </td>
    </tr>
  );
}
