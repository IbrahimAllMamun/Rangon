import { Download, Landmark, Receipt, Undo2 } from "lucide-react";
import Link from "next/link";

import { DateRangeTabs, resolveRange } from "@/components/admin/date-range-tabs";
import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
} from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";
import { vatRatePercent } from "@/lib/commerce/vat";
import { calendarDate, dateOnly, money } from "@/lib/format";

export const metadata = { title: "VAT return" };

interface RateRow {
  rate: string;
  mode: string;
  taxable: string;
  vat: string;
  orders: number;
}

interface MonthRow {
  month: string;
  output_vat: string;
  credit_vat: string;
  input_vat: string;
  net_payable: string;
}

interface VatReturn {
  period: { start: string; end: string; label: string };
  output: {
    /** The base the tax was computed on, never the period's whole turnover. */
    taxable_sales: string;
    zero_rated_sales: string;
    vat: string;
    orders: number;
  };
  credits: { taxable_returns: string; vat: string; returns: number };
  input: {
    taxable_purchases: string;
    zero_rated_purchases: string;
    /** Already net of goods sent back to suppliers. */
    vat: string;
    vat_on_purchases: string;
    purchases: number;
    returned_to_suppliers: string;
    vat_given_back: string;
    returns: number;
  };
  net_payable: string;
  by_rate: RateRow[];
  monthly: MonthRow[];
}

type Search = Promise<{ range?: string }>;

/** A statement line. `negative` means "taken away" and is shown in parentheses. */
interface Line {
  label: string;
  amount: string;
  negative?: boolean;
  emphasis?: "total" | "subtotal";
  note?: string;
}

export default async function VatReturnPage({ searchParams }: { searchParams: Search }) {
  const range = resolveRange((await searchParams).range);

  let report: VatReturn | null = null;
  let error: string | null = null;
  try {
    report = await apiServer<VatReturn>(`/reports/vat/?range=${range}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the VAT return.";
  }

  // Nothing was charged and nothing was reclaimed. That is the shipped state —
  // default_tax_rate is 0.0000 — so the page says why rather than showing a
  // column of zeroes and leaving the owner to work out whether it is broken.
  const nothingToFile =
    report !== null &&
    Number(report.output.vat) === 0 &&
    Number(report.credits.vat) === 0 &&
    Number(report.input.vat) === 0;

  const payable = report ? Number(report.net_payable) : 0;

  return (
    <>
      <PageHeader
        title="VAT return"
        description="Output VAT less credits on returns, less input VAT paid to suppliers. Every figure reads the rate and treatment frozen on the order, so a filed period keeps its answer after the setting changes."
        actions={<DateRangeTabs basePath="/admin/reports/vat" active={range} />}
      />

      {error || !report ? (
        <ErrorState
          title="Could not load the VAT return"
          description={error ?? "The report returned nothing."}
        />
      ) : nothingToFile ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={<Landmark className="size-8" aria-hidden />}
              title="No VAT in this period"
              description="Nothing was charged on sales and nothing was reclaimed on purchases. The organisation's rate is set at Settings, and a supplier's VAT is entered on the purchase order that records their invoice."
              action={
                <Link
                  href="/admin/settings"
                  className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
                >
                  Open VAT settings
                </Link>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={payable < 0 ? "Reclaimable" : "Net VAT payable"}
              value={money(Math.abs(payable).toFixed(2))}
              context={
                payable < 0
                  ? "more reclaimed than collected"
                  : `${dateOnly(report.period.start)} to ${dateOnly(report.period.end)}`
              }
              icon={<Landmark className="size-4" aria-hidden />}
              tone={payable < 0 ? "success" : "neutral"}
            />
            <StatCard
              label="Output VAT"
              value={money(report.output.vat)}
              context={`${report.output.orders} orders`}
              icon={<Receipt className="size-4" aria-hidden />}
            />
            <StatCard
              label="Credited on returns"
              value={money(report.credits.vat)}
              context={`${report.credits.returns} completed`}
              icon={<Undo2 className="size-4" aria-hidden />}
            />
            <StatCard
              label="Input VAT"
              value={money(report.input.vat)}
              context={
                Number(report.input.vat_given_back) > 0
                  ? `${report.input.purchases} purchases, ${report.input.returns} returned`
                  : `${report.input.purchases} purchases`
              }
            />
          </div>

          <Card className="mb-6">
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle>
                Return — {dateOnly(report.period.start)} to {dateOnly(report.period.end)}
              </CardTitle>
              <a
                href={`/api/proxy/reports/vat/?range=${range}&format=csv`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
              >
                <Download className="size-4" aria-hidden /> CSV
              </a>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-body-sm">
                  <caption className="sr-only">
                    VAT collected, credited and reclaimed for the selected period. Deductions are
                    shown in parentheses.
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
                    {statementLines(report).map((line) => (
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
                <CardTitle>Output VAT by rate</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-body-sm">
                    <caption className="sr-only">
                      Sales split by the rate each order was priced at
                    </caption>
                    <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                      <tr>
                        <th scope="col" className="px-4 py-2.5 font-medium">
                          Rate
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          Orders
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          Taxable
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          VAT
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {report.by_rate.map((row) => (
                        <tr key={`${row.rate}-${row.mode}`}>
                          <th scope="row" className="px-4 py-2.5 text-left font-medium">
                            {vatRatePercent(row.rate)}%
                            <span className="ml-1.5 text-caption font-normal text-muted">
                              {row.mode === "INCLUSIVE" ? "inclusive" : "exclusive"}
                            </span>
                          </th>
                          <td className="tabular px-4 py-2.5 text-right text-muted">
                            {row.orders}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">{money(row.taxable)}</td>
                          <td className="tabular px-4 py-2.5 text-right">{money(row.vat)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-border px-4 py-3 text-caption text-muted">
                  A category can override the organisation rate, so one period can hold several. The
                  rate shown is the one frozen on the order, not today&rsquo;s setting. Zero-rated
                  supply — {money(report.output.zero_rated_sales)} of sales and{" "}
                  {money(report.input.zero_rated_purchases)} of purchases — is listed here but
                  stays out of the taxable base above, so the base and the tax read at the rate
                  they were charged at.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Month by month</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-body-sm">
                    <caption className="sr-only">
                      The same subtraction broken down by calendar month
                    </caption>
                    <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                      <tr>
                        <th scope="col" className="px-4 py-2.5 font-medium">
                          Month
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          Output
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          Credits
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          Input
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-medium">
                          Payable
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {report.monthly.map((row) => (
                        <tr key={row.month}>
                          <th scope="row" className="px-4 py-2.5 text-left font-medium">
                            {calendarDate(row.month, { month: "long", year: "numeric" })}
                          </th>
                          <td className="tabular px-4 py-2.5 text-right">
                            {money(row.output_vat)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right text-muted">
                            {money(row.credit_vat)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right text-muted">
                            {money(row.input_vat)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right font-semibold">
                            {/* Parentheses, like the statement above: one
                                convention per screen, and a raw "-750.00"
                                beside "(750.00)" reads as two different ideas. */}
                            {monthPayable(row.net_payable)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-border px-4 py-3 text-caption text-muted">
                  A filing is per month whatever range is selected above, so the months are what the
                  CSV export writes.
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/** A month's net, in the statement's notation: reclaimable reads as a deduction. */
function monthPayable(amount: string): string {
  const value = Number.parseFloat(amount);
  return value < 0 ? `(${money(amount.replace("-", ""))})` : money(amount);
}

function statementLines(report: VatReturn): Line[] {
  return [
    {
      label: "Taxable sales",
      amount: report.output.taxable_sales,
      note: "excluding VAT and delivery",
    },
    { label: "Output VAT charged", amount: report.output.vat, emphasis: "subtotal" },
    {
      label: "VAT credited on completed returns",
      amount: report.credits.vat,
      negative: true,
      note: "the tax frozen on the returned lines",
    },
    {
      label: "Input VAT paid to suppliers",
      amount: report.input.vat_on_purchases,
      negative: true,
      note: "draft and cancelled purchases excluded",
    },
    // Only when there is one. A shop that sent nothing back should not read a
    // line about goods it never returned.
    ...(Number(report.input.vat_given_back) > 0
      ? [
          {
            label: "VAT given back on goods returned to suppliers",
            amount: report.input.vat_given_back,
            note: "no longer reclaimable",
          } satisfies Line,
        ]
      : []),
    { label: "Net VAT payable", amount: report.net_payable, emphasis: "total" },
  ];
}

function StatementRow({ line }: { line: Line }) {
  const value = Number.parseFloat(line.amount);
  const isTotal = line.emphasis === "total";
  const isReclaim = value < 0;
  // One convention per table, the same as the business summary: parentheses mean
  // "taken away". A net figure that came out negative is money owed *to* the
  // shop, so it reads the same way rather than as a minus sign beside brackets.
  const inParentheses = line.negative || isReclaim;
  const magnitude = isReclaim ? line.amount.replace("-", "") : line.amount;

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
        } ${isTotal && isReclaim ? "text-[var(--success)]" : ""}`}
      >
        {/* Parentheses, not colour alone, carry "this is taken away" — the
            statement has to read correctly in greyscale (WCAG 1.4.1). */}
        {inParentheses ? `(${money(magnitude)})` : money(magnitude)}
        {isTotal && isReclaim && <span className="sr-only"> reclaimable</span>}
      </td>
    </tr>
  );
}
