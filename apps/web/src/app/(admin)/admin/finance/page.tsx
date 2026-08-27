import { Banknote, Landmark, Smartphone, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountManager } from "@/components/admin/account-manager";
import { CashBook } from "@/components/admin/cash-book";
import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type {
  Account,
  AccountKind,
  AccountTransaction,
  CashPosition,
  SessionUser,
} from "@/lib/api/types";
import { money } from "@/lib/format";

export const metadata = { title: "Finance" };

const KIND_META: Record<AccountKind, { label: string; icon: typeof Wallet }> = {
  CASH: { label: "Cash", icon: Banknote },
  BANK: { label: "Bank", icon: Landmark },
  MFS: { label: "Mobile money", icon: Smartphone },
  OTHER: { label: "Other", icon: Wallet },
};

export default async function FinancePage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/finance");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  let accounts: Account[] = [];
  let position: CashPosition | null = null;
  let recent: AccountTransaction[] = [];
  let recentTotal = 0;
  let error: string | null = null;

  try {
    const [accountPage, cashPosition, ledger] = await Promise.all([
      apiServer<Paginated<Account>>("/accounts/?page_size=100"),
      apiServer<CashPosition>("/accounts/cash-position/"),
      apiServer<Paginated<AccountTransaction>>("/account-transactions/?page_size=15"),
    ]);
    accounts = accountPage.results;
    position = cashPosition;
    recent = ledger.results;
    recentTotal = ledger.count;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load finance data.";
  }

  const branchId = user.branch?.id ?? accounts[0]?.branch ?? "";
  const unposted = accounts.length === 0;

  return (
    <>
      <PageHeader
        title="Finance"
        description="Every figure here comes from the cash book. A balance changes only when a movement is recorded against it — never by editing a number."
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load finance data" description={error} />
        </Card>
      ) : (
        <div className="space-y-8">
          {position && (
            <section aria-labelledby="cash-position">
              <h2 id="cash-position" className="mb-3 text-h4 font-semibold">
                Cash position
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Total held"
                  value={money(position.total)}
                  context={`Across ${position.accounts.length} account${
                    position.accounts.length === 1 ? "" : "s"
                  }`}
                  icon={<Wallet className="size-4" aria-hidden />}
                />
                {position.by_kind.map((row) => {
                  const meta = KIND_META[row.kind] ?? KIND_META.OTHER;
                  const Icon = meta.icon;
                  return (
                    <StatCard
                      key={row.kind}
                      label={meta.label}
                      value={money(row.total)}
                      tone={Number(row.total) < 0 ? "error" : "neutral"}
                      icon={<Icon className="size-4" aria-hidden />}
                    />
                  );
                })}
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <StatCard
                  label="Money in"
                  value={money(position.movements.money_in)}
                  context="All time, excluding transfers between our own accounts"
                  tone="success"
                  icon={<TrendingUp className="size-4" aria-hidden />}
                />
                <StatCard
                  label="Money out"
                  value={money(position.movements.money_out)}
                  context="Refunds, supplier payments and expenses"
                  tone="warning"
                  icon={<TrendingDown className="size-4" aria-hidden />}
                />
                <StatCard
                  label="Net movement"
                  value={money(position.movements.net)}
                  context="Cash in minus cash out — not profit, which also needs stock cost"
                  tone={Number(position.movements.net) < 0 ? "error" : "neutral"}
                />
              </div>
            </section>
          )}

          {unposted && (
            <Card>
              <div className="p-4 text-body-sm">
                <p className="font-medium">No accounts exist yet.</p>
                <p className="mt-1 text-muted">
                  Sales still work — but each one records only the method the customer paid by, not
                  where the money went. Open an account and every payment from then on lands
                  somewhere nameable. Run{" "}
                  <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-caption">
                    manage.py verify_accounts
                  </code>{" "}
                  to see how many payments have posted nowhere so far.
                </p>
              </div>
            </Card>
          )}

          <section aria-labelledby="accounts">
            <h2 id="accounts" className="mb-3 text-h4 font-semibold">
              Accounts
            </h2>
            <AccountManager
              accounts={accounts}
              branchId={branchId}
              canManage={can("finance.manage")}
              canTransfer={can("finance.transfer")}
              canAdjust={can("finance.adjust")}
            />
          </section>

          <section aria-labelledby="recent">
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2 id="recent" className="text-h4 font-semibold">
                Recent movements
              </h2>
              {accounts.length > 0 && (
                <Link
                  href={`/admin/finance/${accounts[0].id}`}
                  className="text-body-sm text-brand-600 hover:underline"
                >
                  Open a full cash book →
                </Link>
              )}
            </div>
            <CashBook rows={recent} total={recentTotal} showAccount />
          </section>
        </div>
      )}
    </>
  );
}
