import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import { StockCountSheet } from "@/components/admin/stock-count-sheet";
import { Badge, Card, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser, StockCount, StockCountStatus } from "@/lib/api/types";
import { dateTime } from "@/lib/format";

const TONE: Record<StockCountStatus, "warning" | "success" | "neutral"> = {
  DRAFT: "neutral",
  COUNTING: "warning",
  APPLIED: "success",
  CANCELLED: "neutral",
};

export default async function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/inventory/counts/${id}`);

  const canCount =
    user.permissions.includes("*") || user.permissions.includes("inventory.count");

  let count: StockCount | null = null;
  let error: string | null = null;
  try {
    count = await apiServer<StockCount>(`/stock-counts/${id}/`);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    error = caught instanceof Error ? caught.message : "Could not load this count.";
  }

  if (error || !count) {
    return (
      <Card>
        <ErrorState title="Could not load this count" description={error ?? undefined} />
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={count.number}
        description={
          count.status === "APPLIED"
            ? "Applied. The adjustments are in the ledger and this sheet is now history."
            : count.status === "CANCELLED"
              ? "Cancelled. Nothing was written to the ledger."
              : "Type what is actually on the shelf. Nothing moves until the sheet is applied."
        }
        actions={
          <div className="flex items-center gap-3">
            <Badge tone={TONE[count.status] ?? "neutral"}>{count.status}</Badge>
            <Link
              href="/admin/inventory/counts"
              className="text-body-sm text-brand-600 hover:underline"
            >
              ← All counts
            </Link>
          </div>
        }
      />

      <dl className="mb-6 grid gap-4 text-body-sm sm:grid-cols-3">
        <div>
          <dt className="text-caption uppercase text-muted">Branch</dt>
          <dd className="font-medium">{count.branch_code}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase text-muted">Opened</dt>
          <dd className="font-medium">{dateTime(count.created_at)}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase text-muted">Applied</dt>
          <dd className="font-medium">{count.applied_at ? dateTime(count.applied_at) : "—"}</dd>
        </div>
      </dl>

      <StockCountSheet count={count} canCount={canCount} />
    </>
  );
}
