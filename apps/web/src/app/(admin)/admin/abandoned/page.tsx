import { redirect } from "next/navigation";
import Link from "next/link";

import {
  AbandonedCheckouts,
  type AbandonedCheckoutRow,
} from "@/components/admin/abandoned-checkouts";
import { PageHeader } from "@/components/admin/shell";
import { StatCard } from "@/components/admin/stat-card";
import { Card, ErrorState } from "@/components/ui/primitives";
import { apiServer, currentUser, type Paginated } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { money } from "@/lib/format";

export const metadata = { title: "Call-back list" };

type Search = Promise<{ status?: string }>;

const TABS = [
  { value: "OPEN", label: "To call" },
  { value: "RECOVERED", label: "Bought" },
  { value: "LOST", label: "Written off" },
] as const;

function resolveStatus(value: string | undefined): string {
  return TABS.some((tab) => tab.value === value) ? (value as string) : "OPEN";
}

export default async function AbandonedCheckoutsPage({ searchParams }: { searchParams: Search }) {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/abandoned");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);
  const canManage = can("customers.update");

  const status = resolveStatus((await searchParams).status);

  let leads: AbandonedCheckoutRow[] = [];
  let open = 0;
  let recovered = 0;
  let openValue = 0;
  let error: string | null = null;

  try {
    // Three calls rather than one, because the counters describe the whole
    // list and the table shows one tab of it. The API paginates, so counting
    // the rows on screen would report "25" forever.
    const [page, openPage, recoveredPage] = await Promise.all([
      apiServer<Paginated<AbandonedCheckoutRow>>(`/abandoned-checkouts/?status=${status}`),
      apiServer<Paginated<AbandonedCheckoutRow>>("/abandoned-checkouts/?status=OPEN"),
      apiServer<Paginated<AbandonedCheckoutRow>>("/abandoned-checkouts/?status=RECOVERED"),
    ]);
    leads = page.results;
    open = openPage.count;
    recovered = recoveredPage.count;
    openValue = openPage.results.reduce(
      (sum: number, lead: AbandonedCheckoutRow) => sum + Number(lead.cart_total),
      0,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the call-back list.";
  }

  const chased = open + recovered;
  const rate = chased ? Math.round((recovered / chased) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Call-back list"
        description="Shoppers who typed their number at checkout and did not finish. For cash on delivery the recovery action is a phone call, so the number is the button."
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load the call-back list" description={error} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="To call"
              value={String(open)}
              context={`${money(String(openValue))} in baskets on this page`}
              tone={open > 0 ? "warning" : "neutral"}
            />
            <StatCard label="Recovered" value={String(recovered)} tone="success" />
            <StatCard
              label="Recovery rate"
              value={`${rate}%`}
              context={`of ${chased} lead${chased === 1 ? "" : "s"}`}
            />
          </div>

          <div
            className="mt-6 flex flex-wrap rounded-md border border-border bg-surface p-0.5"
            role="group"
            aria-label="Lead status"
          >
            {TABS.map((tab) => (
              <Link
                key={tab.value}
                href={`/admin/abandoned?status=${tab.value}`}
                aria-current={status === tab.value ? "true" : undefined}
                className={`rounded px-3 py-1.5 text-body-sm font-medium focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] ${
                  status === tab.value
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </div>

          <div className="mt-4">
            <AbandonedCheckouts leads={leads} canManage={canManage} />
          </div>
        </>
      )}
    </>
  );
}
