import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import {
  type StockExceptionRow,
  StockExceptionTable,
} from "@/components/admin/stock-exception-table";
import { Card, ErrorState } from "@/components/ui/primitives";
import type { Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Oversell exceptions" };

type Search = Promise<Record<string, string | undefined>>;

const TABS = [
  { value: "OPEN", label: "Open" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "", label: "All" },
] as const;

/**
 * The oversell report.
 *
 * `docs/architecture/offline-pos.md` names this screen as the precondition for
 * offline selling: stock may go below zero only where somebody is guaranteed
 * to be shown it. Every row here is a movement the ledger allowed through with
 * a negative balance behind it, and none of them can be deleted — the only way
 * off this list is for a manager to say what happened.
 */
export default async function StockExceptionsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/inventory/exceptions");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  const status = TABS.some((tab) => tab.value === params.status) ? params.status! : "OPEN";
  const query = new URLSearchParams({ page_size: "100" });
  if (status) query.set("status", status);

  let rows: StockExceptionRow[] = [];
  let counts = { open: 0, resolved: 0 };
  let error: string | null = null;

  try {
    const [page, summary] = await Promise.all([
      apiServer<Paginated<StockExceptionRow>>(`/stock-exceptions/?${query.toString()}`),
      apiServer<{ open: number; resolved: number }>("/stock-exceptions/summary/").catch(() => null),
    ]);
    rows = page.results ?? [];
    if (summary) counts = summary;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load oversell exceptions.";
  }

  return (
    <>
      <PageHeader
        title="Oversell exceptions"
        description="Movements that took stock below zero. Selling below zero is only permitted where a sale has already happened at the counter — every one of those lands here for a manager to answer for."
        actions={
          <Link
            href="/admin/inventory"
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
          >
            <ArrowLeft className="size-4" aria-hidden /> Inventory
          </Link>
        }
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load oversell exceptions" description={error} />
        </Card>
      ) : (
        <>
          <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2">
            {TABS.map((tab) => {
              const active = tab.value === status;
              const count =
                tab.value === "OPEN"
                  ? counts.open
                  : tab.value === "RESOLVED"
                    ? counts.resolved
                    : counts.open + counts.resolved;
              return (
                <Link
                  key={tab.value || "all"}
                  href={
                    tab.value
                      ? `/admin/inventory/exceptions?status=${tab.value}`
                      : "/admin/inventory/exceptions?status="
                  }
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "rounded-md bg-neutral-900 px-3 py-1.5 text-body-sm font-medium text-white"
                      : "rounded-md border border-neutral-300 px-3 py-1.5 text-body-sm font-medium hover:bg-neutral-100"
                  }
                >
                  {tab.label}
                  <span className="ml-1.5 text-caption opacity-70">{count}</span>
                </Link>
              );
            })}
          </nav>

          <StockExceptionTable rows={rows} canResolve={can("inventory.adjust")} />

          <p className="mt-3 text-caption text-muted">
            Rows are written by the inventory engine at the one point every stock movement passes
            through, so nothing can go negative without appearing here. They cannot be created or
            deleted through the app — resolving records a conclusion, it does not move stock.
          </p>
        </>
      )}
    </>
  );
}
