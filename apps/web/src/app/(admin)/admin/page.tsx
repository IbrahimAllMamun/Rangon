import { AlertTriangle, Package, ShoppingCart, TrendingUp, Undo2, Wallet } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/admin/shell";
import { SalesChart } from "@/components/admin/sales-chart";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/client";
import type { DashboardData } from "@/lib/api/types";
import { humanise, money, moneyCompact, percent } from "@/lib/format";

type Search = Promise<{ range?: string }>;

const RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export default async function DashboardPage({ searchParams }: { searchParams: Search }) {
  const { range = "30d" } = await searchParams;

  let data: DashboardData | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<DashboardData>(`/reports/dashboard/?range=${range}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the dashboard.";
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <CardContent>
            <p role="alert" className="text-body-sm text-[var(--error)]">
              {error ?? "Could not load the dashboard."}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const kpis = data.kpis;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything below is aggregated in the database, not in the browser."
        actions={
          <div className="flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Date range">
            {RANGES.map((option) => (
              <Link
                key={option.value}
                href={`/admin?range=${option.value}`}
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue"
          value={money(kpis.revenue)}
          context={`${kpis.orders} order${kpis.orders === 1 ? "" : "s"}`}
          icon={<Wallet className="size-4" aria-hidden />}
        />
        <StatCard
          label="Gross profit"
          value={money(kpis.gross_profit)}
          context={`${percent(kpis.margin_percent)} margin`}
          icon={<TrendingUp className="size-4" aria-hidden />}
          tone="success"
        />
        <StatCard
          label="Items sold"
          value={String(kpis.units_sold)}
          context={`Avg order ${moneyCompact(kpis.average_order_value)}`}
          icon={<ShoppingCart className="size-4" aria-hidden />}
        />
        <StatCard
          label="Stock value"
          value={money(kpis.inventory_value)}
          context={`${kpis.inventory_units} units at cost`}
          icon={<Package className="size-4" aria-hidden />}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Pending online orders"
          value={String(kpis.pending_online_orders)}
          context="Awaiting fulfilment"
          href="/admin/orders?status=CONFIRMED"
          tone={kpis.pending_online_orders > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Low stock"
          value={String(kpis.low_stock_products)}
          context="At or below reorder point"
          href="/admin/inventory?filter=low-stock"
          icon={<AlertTriangle className="size-4" aria-hidden />}
          tone={kpis.low_stock_products > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Returns"
          value={String(kpis.returns)}
          context="In this period"
          href="/admin/returns"
          icon={<Undo2 className="size-4" aria-hidden />}
        />
        <StatCard
          label="Refunded"
          value={money(kpis.refunded_total)}
          context={`Discounts ${moneyCompact(kpis.discount_total)}`}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Sales over time</CardTitle>
          </CardHeader>
          <CardContent>
            <SalesChart data={data.sales_over_time} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By channel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.by_channel.length === 0 && <p className="text-body-sm text-muted">No sales yet.</p>}
            {data.by_channel.map((row) => {
              const total = data.by_channel.reduce((sum, item) => sum + Number(item.revenue), 0);
              const share = total ? (Number(row.revenue) / total) * 100 : 0;
              return (
                <div key={row.channel}>
                  <div className="flex items-baseline justify-between text-body-sm">
                    <span className="font-medium">{humanise(row.channel)}</span>
                    <span className="tabular">{money(row.revenue)}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-100">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-caption text-muted">
                    {row.orders} orders · {share.toFixed(0)}%
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-body-sm">
              <thead className="border-b border-border text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Units</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.top_products.map((row) => (
                  <tr key={row.sku}>
                    <td className="px-4 py-2">
                      <span className="block font-medium">{row.product_name}</span>
                      <span className="text-caption text-muted">{row.sku}</span>
                    </td>
                    <td className="tabular px-4 py-2 text-right">{row.units}</td>
                    <td className="tabular px-4 py-2 text-right">{money(row.revenue)}</td>
                  </tr>
                ))}
                {data.top_products.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted">
                      No sales in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment methods</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-body-sm">
              <thead className="border-b border-border text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Method</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Count</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.payment_methods.map((row) => (
                  <tr key={row.method}>
                    <td className="px-4 py-2">{humanise(row.method)}</td>
                    <td className="tabular px-4 py-2 text-right">{row.count}</td>
                    <td className="tabular px-4 py-2 text-right">{money(row.amount)}</td>
                  </tr>
                ))}
                {data.payment_methods.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted">
                      No payments in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
