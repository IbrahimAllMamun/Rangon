import Link from "next/link";
import { redirect } from "next/navigation";

import { ReviewModeration, type ReviewRow } from "@/components/admin/review-moderation";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { cn } from "@/lib/cn";

export const metadata = { title: "Reviews" };

const TABS = [
  { value: "PENDING", label: "Awaiting moderation" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "", label: "All" },
];

type Search = Promise<Record<string, string | undefined>>;

export default async function ReviewsPage({ searchParams }: { searchParams: Search }) {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/reviews");

  const canModerate =
    user.permissions.includes("*") || user.permissions.includes("content.review_moderate");

  const params = await searchParams;
  // Pending first: it is the only state that needs anybody to do something.
  const status = params.status ?? "PENDING";

  const query = new URLSearchParams({ page_size: "50" });
  if (status) query.set("status", status);
  if (params.page) query.set("page", params.page);

  let data: Paginated<ReviewRow> | null = null;
  let error: string | null = null;
  try {
    data = await apiServer<Paginated<ReviewRow>>(`/reviews/?${query.toString()}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load reviews.";
  }

  return (
    <>
      <PageHeader
        title="Reviews"
        description="Nothing a customer writes reaches the storefront until it is approved here, and only approved reviews count towards a product's rating."
      />

      <nav aria-label="Filter reviews by status" className="mb-6 flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const active = status === tab.value;
          return (
            <Link
              key={tab.value || "all"}
              href={tab.value ? `/admin/reviews?status=${tab.value}` : "/admin/reviews?status="}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-body-sm transition-colors duration-fast",
                active
                  ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
                  : "border-neutral-300 text-neutral-700 hover:bg-neutral-100",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {error ? (
        <Card>
          <ErrorState title="Could not load reviews" description={error} />
        </Card>
      ) : (
        <>
          {data && data.count > 0 && (
            <p className="mb-4 text-body-sm text-muted">
              {data.count} review{data.count === 1 ? "" : "s"}
              {status ? ` ${TABS.find((tab) => tab.value === status)?.label.toLowerCase()}` : ""}.
            </p>
          )}
          <ReviewModeration
            reviews={data?.results ?? []}
            canModerate={canModerate}
            status={status}
          />
        </>
      )}
    </>
  );
}
