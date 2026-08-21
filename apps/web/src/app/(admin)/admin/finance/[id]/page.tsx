import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CashBook } from "@/components/admin/cash-book";
import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import { Badge, Card, ErrorState } from "@/components/ui/primitives";
import { ApiError, type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { Account, AccountTransaction, SessionUser } from "@/lib/api/types";
import { dateOnly, money } from "@/lib/format";

export const metadata = { title: "Cash book" };

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | undefined>>;

const TYPE_FILTERS = [
  { value: "", label: "Everything" },
  { value: "SALE_PAYMENT", label: "Sale payments" },
  { value: "REFUND", label: "Refunds" },
  { value: "SUPPLIER_PAYMENT", label: "Supplier payments" },
  { value: "TRANSFER_IN", label: "Transfers in" },
  { value: "TRANSFER_OUT", label: "Transfers out" },
  { value: "DEPOSIT", label: "Deposits" },
  { value: "WITHDRAWAL", label: "Withdrawals" },
  { value: "ADJUSTMENT", label: "Corrections" },
];

export default async function AccountCashBookPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const filters = await searchParams;

  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/finance/${id}`);

  const query = new URLSearchParams({ page_size: "50" });
  for (const key of ["transaction_type", "date_from", "date_to", "page"]) {
    if (filters[key]) query.set(key, filters[key]!);
  }

  let account: Account | null = null;
  let rows: AccountTransaction[] = [];
  let total = 0;
  let error: string | null = null;

  try {
    account = await apiServer<Account>(`/accounts/${id}/`);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    error = caught instanceof Error ? caught.message : "Could not load this account.";
  }

  if (account) {
    try {
      const page = await apiServer<Paginated<AccountTransaction>>(
        `/accounts/${id}/transactions/?${query.toString()}`,
      );
      rows = page.results;
      total = page.count;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not load the cash book.";
    }
  }

  const activeType = filters.transaction_type ?? "";

  return (
    <>
      <PageHeader
        title={account ? account.name : "Cash book"}
        description={
          account
            ? `${account.kind_display} at ${account.branch_code}. Every row below is immutable — a correction is a new entry, never an edit.`
            : undefined
        }
      />

      <p className="mb-4 text-body-sm text-muted">
        <Link href="/admin/finance" className="text-brand-600 hover:underline">
          ← All accounts
        </Link>
      </p>

      {error && !account ? (
        <Card>
          <ErrorState title="Could not load this account" description={error} />
        </Card>
      ) : (
        account && (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard
                label="Balance"
                value={money(account.balance)}
                tone={Number(account.balance) < 0 ? "error" : "neutral"}
                // `total` is the count of the *filtered* query. Saying
                // "recorded" beside an unfiltered balance would misread as the
                // account's whole history.
                context={
                  activeType
                    ? `${total} matching movement${total === 1 ? "" : "s"}`
                    : `${total} movement${total === 1 ? "" : "s"} recorded`
                }
              />
              <StatCard
                label="Opened"
                value={dateOnly(account.created_at)}
                context={
                  [account.bank_name, account.account_number].filter(Boolean).join(" · ") ||
                  undefined
                }
              />
              <div className="rounded-lg border border-border bg-surface p-4">
                <p className="text-body-sm text-muted">Status</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {account.is_active ? (
                    <Badge tone="success">Open</Badge>
                  ) : (
                    <Badge tone="neutral">Closed</Badge>
                  )}
                  {account.is_default && <Badge tone="info">Default</Badge>}
                  {account.allow_overdraft && <Badge tone="warning">Overdraft allowed</Badge>}
                </div>
                {account.notes && (
                  <p className="mt-2 text-caption text-muted">{account.notes}</p>
                )}
              </div>
            </div>

            <nav aria-label="Filter the cash book" className="flex flex-wrap gap-2">
              {TYPE_FILTERS.map((filter) => {
                const active = activeType === filter.value;
                const search = new URLSearchParams();
                if (filter.value) search.set("transaction_type", filter.value);
                return (
                  <Link
                    key={filter.value || "all"}
                    href={`/admin/finance/${id}${search.toString() ? `?${search}` : ""}`}
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
            </nav>

            {error ? (
              <Card>
                <ErrorState title="Could not load the cash book" description={error} />
              </Card>
            ) : (
              <CashBook
                rows={rows}
                total={total}
                emptyDescription={
                  activeType
                    ? "No movements of this kind on this account."
                    : "Nothing has moved through this account yet."
                }
              />
            )}
          </div>
        )
      )}
    </>
  );
}
