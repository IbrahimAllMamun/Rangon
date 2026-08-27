import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ReturnActions, ReturnProgress } from "@/components/admin/return-actions";
import { PageHeader } from "@/components/admin/shell";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorState } from "@/components/ui/primitives";
import { ApiError, type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { Account, ReturnRequest, ReturnStatus, SessionUser } from "@/lib/api/types";
import { dateTime, humanise, money } from "@/lib/format";

const STATUS_TONE: Record<ReturnStatus, "warning" | "info" | "success" | "error"> = {
  REQUESTED: "warning",
  APPROVED: "info",
  RECEIVED: "info",
  COMPLETED: "success",
  REJECTED: "error",
};

const RESTOCK_TONE: Record<string, "success" | "error" | "warning"> = {
  RESTOCK: "success",
  DAMAGED: "error",
  QUARANTINE: "warning",
};

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=/admin/returns/${id}`);

  const canAct = user.permissions.includes("*") || user.permissions.includes("sales.refund");

  let request: ReturnRequest | null = null;
  let accounts: Account[] = [];
  let error: string | null = null;
  try {
    request = await apiServer<ReturnRequest>(`/returns/${id}/`);
    if (canAct) {
      const page = await apiServer<Paginated<Account>>("/accounts/?page_size=100");
      accounts = page.results;
    }
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    error = caught instanceof Error ? caught.message : "Could not load this return.";
  }

  if (error || !request) {
    return (
      <Card>
        <ErrorState title="Could not load this return" description={error ?? undefined} />
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={request.number}
        description={`${humanise(request.reason)} · order ${request.order_number}`}
        actions={
          <div className="flex items-center gap-3">
            <Badge tone={STATUS_TONE[request.status] ?? "neutral"}>
              {humanise(request.status)}
            </Badge>
            <Link href="/admin/returns" className="text-body-sm text-brand-600 hover:underline">
              ← All returns
            </Link>
          </div>
        }
      />

      <ReturnProgress request={request} />

      <dl className="mb-6 grid gap-4 text-body-sm sm:grid-cols-4">
        <div>
          <dt className="text-caption uppercase text-muted">Customer</dt>
          <dd className="font-medium">{request.customer_name || "—"}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase text-muted">Requested</dt>
          <dd className="font-medium">{dateTime(request.created_at)}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase text-muted">Refund requested</dt>
          <dd className="tabular font-medium">{money(request.refund_amount)}</dd>
        </div>
        <div>
          <dt className="text-caption uppercase text-muted">Shipping refunded</dt>
          <dd className="font-medium">{request.refund_shipping ? "Yes" : "No"}</dd>
        </div>
      </dl>

      {(request.customer_comment || request.staff_comment) && (
        <Card className="mb-6">
          <CardContent className="space-y-2 p-4 text-body-sm">
            {request.customer_comment && (
              <p>
                <span className="text-muted">Customer:</span> {request.customer_comment}
              </p>
            )}
            {request.staff_comment && (
              <p>
                <span className="text-muted">Staff:</span> {request.staff_comment}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Lines on return {request.number}</caption>
              <thead className="border-y border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Qty</th>
                  <th scope="col" className="px-4 py-2 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {request.items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-2">
                      <span className="block font-medium">{item.product_name}</span>
                      <span className="block font-mono text-caption text-muted">{item.sku}</span>
                      {item.condition_note && (
                        <span className="block text-caption text-muted">{item.condition_note}</span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{item.quantity}</td>
                    <td className="px-4 py-2">
                      <Badge tone={RESTOCK_TONE[item.restock_decision] ?? "neutral"}>
                        {humanise(item.restock_decision)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-4 py-2 text-caption text-muted">
              {request.status === "REQUESTED" || request.status === "APPROVED"
                ? "Decisions are confirmed when the goods are received — they are provisional until then."
                : "Only lines marked back on the shelf returned to sellable stock."}
            </p>
          </CardContent>
        </Card>

        <ReturnActions request={request} accounts={accounts} canAct={canAct} />
      </div>
    </>
  );
}
