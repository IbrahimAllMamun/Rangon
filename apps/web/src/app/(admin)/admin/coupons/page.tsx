import { redirect } from "next/navigation";

import type { CouponRow } from "@/components/admin/coupon-form";
import { CouponManager } from "@/components/admin/coupon-manager";
import { Pagination } from "@/components/admin/pagination";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { applyPaging, readPaging } from "@/lib/paging";

export const metadata = { title: "Coupons" };

type Search = Promise<Record<string, string | undefined>>;

export default async function CouponsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const paging = readPaging(params);
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/coupons");

  const canManage =
    user.permissions.includes("*") || user.permissions.includes("content.coupons_manage");

  let coupons: CouponRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const query = applyPaging(new URLSearchParams(), paging);
    const page = await apiServer<Paginated<CouponRow>>(`/coupons/?${query.toString()}`);
    coupons = page.results;
    total = page.count;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load coupons.";
  }

  // Only the rows actually fetched can be counted, so this is scoped to the page
  // rather than quietly claiming to describe every coupon.
  const live = coupons.filter((row) => row.is_active && !row.is_exhausted).length;

  return (
    <>
      <PageHeader
        title="Coupons"
        description={
          error
            ? undefined
            : `${total} coupon${total === 1 ? "" : "s"}, ${live} of the ${coupons.length} shown here still redeemable. The server prices every discount — the shopper only ever sends a code.`
        }
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load coupons" description={error} />
        </Card>
      ) : (
        <>
          <CouponManager coupons={coupons} canManage={canManage} />
          <Card className="mt-4 overflow-hidden">
            <Pagination
              count={total}
              page={paging.page}
              pageSize={paging.pageSize}
              query={params}
              unit="coupons"
              className="border-t-0"
            />
          </Card>
        </>
      )}
    </>
  );
}
