import { redirect } from "next/navigation";

import { FilterTabs } from "@/components/admin/filter-tabs";
import { Pagination } from "@/components/admin/pagination";
import { ReviewModeration, type ReviewRow } from "@/components/admin/review-moderation";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { applyPaging, readPaging } from "@/lib/paging";

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

  const paging = readPaging(params);
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  applyPaging(query, paging);

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

      <FilterTabs
        label="Review status"
        className="mb-6"
        tabs={TABS.map((tab) => ({
          label: tab.label,
          // "All" is an explicit empty status: no status at all means Pending.
          href: `/admin/reviews?status=${tab.value}`,
          active: status === tab.value,
        }))}
      />

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
          {data && (
            <Card className="mt-4 overflow-hidden">
              <Pagination
                count={data.count}
                page={paging.page}
                pageSize={paging.pageSize}
                query={params}
                unit="reviews"
                className="border-t-0"
              />
            </Card>
          )}
        </>
      )}
    </>
  );
}
