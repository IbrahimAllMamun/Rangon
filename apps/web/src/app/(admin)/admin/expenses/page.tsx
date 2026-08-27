import { Download, Receipt, TrendingDown, Wallet } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ExpenseForm, VoidExpenseButton } from "@/components/admin/expense-forms";
import { type Column, ResourceTable } from "@/components/admin/resource-table";
import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type {
  Account,
  Expense,
  ExpenseCategory,
  ExpenseTotals,
  SessionUser,
} from "@/lib/api/types";
import { dateOnly, money, percent } from "@/lib/format";

export const metadata = { title: "Expenses" };

const RANGES = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
  { value: "year", label: "This year", days: 0 },
] as const;

/**
 * The window, as plain `YYYY-MM-DD` dates.
 *
 * Deliberately dates rather than timestamps: the API widens `date_to` to cover
 * all of that day, so the screen and its CSV export cannot disagree about
 * whether this afternoon's spending counts.
 */
function windowFor(range: string) {
  const preset = RANGES.find((option) => option.value === range) ?? RANGES[1];
  const end = new Date();
  const start = new Date(end);
  if (preset.value === "year") start.setMonth(0, 1);
  else start.setDate(end.getDate() - preset.days);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { range: preset.value, date_from: iso(start), date_to: iso(end) };
}

type Search = Promise<{ range?: string }>;

export default async function ExpensesPage({ searchParams }: { searchParams: Search }) {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/expenses");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  const { range } = await searchParams;
  const period = windowFor(range ?? "30d");
  const query = `date_from=${period.date_from}&date_to=${period.date_to}`;

  let expenses: Expense[] = [];
  let categories: ExpenseCategory[] = [];
  let accounts: Account[] = [];
  let totals: ExpenseTotals | null = null;
  let error: string | null = null;

  try {
    const [list, summary, categoryPage, accountPage] = await Promise.all([
      apiServer<Paginated<Expense>>(`/expenses/?${query}&page_size=50`),
      apiServer<ExpenseTotals>(`/expenses/summary/?${query}`),
      apiServer<Paginated<ExpenseCategory>>("/expense-categories/?page_size=100"),
      apiServer<Paginated<Account>>("/accounts/?page_size=100"),
    ]);
    expenses = list.results;
    totals = summary;
    categories = categoryPage.results;
    accounts = accountPage.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load expenses.";
  }

  const branchId = user.branch?.id ?? accounts[0]?.branch ?? "";
  const canRecord = can("finance.expense");
  const largest = totals?.by_category[0];

  const columns: Column<Expense>[] = [
    {
      header: "Date",
      cell: (row) => (
        <>
          <span className="block whitespace-nowrap">{dateOnly(row.spent_at)}</span>
          <span className="block font-mono text-caption text-muted">{row.number}</span>
        </>
      ),
    },
    {
      header: "Spent on",
      cell: (row) => (
        <>
          <span className="block font-medium">{row.category_name}</span>
          {row.note && <span className="block text-caption text-muted">{row.note}</span>}
        </>
      ),
    },
    { header: "Paid from", cell: (row) => row.account_name },
    {
      header: "Amount",
      numeric: true,
      cell: (row) => (
        <span className={row.status === "VOID" ? "text-muted line-through" : ""}>
          {money(row.amount)}
        </span>
      ),
    },
    {
      header: "Status",
      cell: (row) =>
        row.status === "VOID" ? (
          <>
            <Badge tone="neutral">Voided</Badge>
            {row.void_reason && (
              <span className="mt-0.5 block text-caption text-muted">{row.void_reason}</span>
            )}
          </>
        ) : (
          <Badge tone="success">Recorded</Badge>
        ),
    },
    {
      header: "Receipt",
      cell: (row) =>
        row.attachment_url ? (
          <a
            href={row.attachment_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-600 hover:underline"
          >
            View
          </a>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      header: "",
      cell: (row) =>
        canRecord && row.status === "RECORDED" ? (
          <VoidExpenseButton
            expenseId={row.id}
            expenseNumber={row.number}
            amount={row.amount}
          />
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Money that left the business for something other than stock or a refund. Each one takes the amount out of a named account and writes a cash-book row, so spending and the balance can never disagree."
        actions={
          <div
            className="flex rounded-md border border-border bg-surface p-0.5"
            role="group"
            aria-label="Date range"
          >
            {RANGES.map((option) => (
              <Link
                key={option.value}
                href={`/admin/expenses?range=${option.value}`}
                aria-current={period.range === option.value ? "true" : undefined}
                className={`rounded px-3 py-1.5 text-body-sm font-medium ${
                  period.range === option.value
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

      {error ? (
        <Card>
          <ErrorState title="Could not load expenses" description={error} />
        </Card>
      ) : (
        <div className="space-y-8">
          {totals && (
            <section aria-labelledby="spend">
              <h2 id="spend" className="sr-only">
                Spending in this period
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard
                  label="Total spent"
                  value={money(totals.total)}
                  context={`${totals.count} expense${totals.count === 1 ? "" : "s"} in the last ${
                    RANGES.find((option) => option.value === period.range)?.label.toLowerCase() ??
                    "30 days"
                  }`}
                  tone={Number(totals.total) > 0 ? "warning" : "neutral"}
                  icon={<TrendingDown className="size-4" aria-hidden />}
                />
                <StatCard
                  label="Largest category"
                  value={largest ? largest.category : "—"}
                  context={
                    largest
                      ? `${money(largest.total)} · ${percent(largest.share)} of spending`
                      : "Nothing recorded in this period"
                  }
                  icon={<Receipt className="size-4" aria-hidden />}
                />
                <StatCard
                  label="Categories used"
                  value={String(totals.by_category.length)}
                  context={`of ${categories.filter((row) => row.is_active).length} in use`}
                  icon={<Wallet className="size-4" aria-hidden />}
                />
              </div>
            </section>
          )}

          {canRecord && (
            <section aria-labelledby="record">
              <h2 id="record" className="sr-only">
                Record an expense
              </h2>
              <ExpenseForm
                categories={categories}
                accounts={accounts.filter((row) => !branchId || row.branch === branchId)}
                branchId={branchId}
              />
            </section>
          )}

          {totals && totals.by_category.length > 0 && (
            <section aria-labelledby="by-category">
              <h2 id="by-category" className="mb-3 text-h4 font-semibold">
                Where it went
              </h2>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {totals.by_category.map((row) => (
                    <li key={row.category_id} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="text-body-sm font-medium">{row.category}</span>
                        <span className="tabular text-body-sm font-semibold">
                          {money(row.total)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3">
                        {/* The bar repeats the figure beside it; it is never the
                            only way the share is stated. */}
                        <div
                          className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100"
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-full bg-neutral-900"
                            style={{ width: `${Math.min(Number(row.share), 100)}%` }}
                          />
                        </div>
                        <span className="tabular shrink-0 text-caption text-muted">
                          {percent(row.share)} ·{" "}
                          {row.count === 1 ? "1 entry" : `${row.count} entries`}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          <section aria-labelledby="entries">
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2 id="entries" className="text-h4 font-semibold">
                Every expense
              </h2>
              {can("reports.export") && (
                <a
                  href={`/api/proxy/reports/expenses/?${query}&format=csv`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
                >
                  <Download className="size-4" aria-hidden /> CSV
                </a>
              )}
            </div>
            <ResourceTable
              rows={expenses}
              columns={columns}
              caption="Expenses in the selected period"
              emptyTitle="Nothing spent in this period"
              emptyDescription="Choose a wider date range, or record the first expense above."
              rowKey={(row) => row.id}
            />
            <p className="mt-2 text-caption text-muted">
              A voided expense stays on this list on purpose — the money went out and then came
              back, and both movements are in the cash book. Totals above exclude it.
            </p>
          </section>

          {can("finance.manage") && categories.length > 0 && (
            <section aria-labelledby="categories">
              <Card>
                <CardHeader>
                  <CardTitle id="categories">Categories</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <ul className="divide-y divide-border">
                    {categories.map((row) => (
                      <li
                        key={row.id}
                        className="flex items-center justify-between gap-4 px-4 py-2.5"
                      >
                        <div>
                          <p className="text-body-sm font-medium">
                            {row.name}
                            {!row.is_active && (
                              <Badge tone="neutral" className="ml-2">
                                Retired
                              </Badge>
                            )}
                          </p>
                          <p className="text-caption text-muted">
                            <span className="font-mono">{row.code}</span>
                            {row.description ? ` · ${row.description}` : ""}
                          </p>
                        </div>
                        <span className="tabular shrink-0 text-caption text-muted">
                          {row.expense_count} filed
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          )}
        </div>
      )}
    </>
  );
}
