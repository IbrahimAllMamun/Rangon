import { redirect } from "next/navigation";

import type { CouponRow } from "@/components/admin/coupon-form";
import { CouponManager } from "@/components/admin/coupon-manager";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Coupons" };

export default async function CouponsPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/coupons");

  const canManage =
    user.permissions.includes("*") || user.permissions.includes("content.coupons_manage");

  let coupons: CouponRow[] = [];
  let error: string | null = null;
  try {
    const page = await apiServer<Paginated<CouponRow>>("/coupons/?page_size=100");
    coupons = page.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load coupons.";
  }

  const live = coupons.filter((row) => row.is_active && !row.is_exhausted).length;

  return (
    <>
      <PageHeader
        title="Coupons"
        description={
          error
            ? undefined
            : `${coupons.length} coupon${coupons.length === 1 ? "" : "s"}, ${live} still redeemable. The server prices every discount — the shopper only ever sends a code.`
        }
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load coupons" description={error} />
        </Card>
      ) : (
        <CouponManager coupons={coupons} canManage={canManage} />
      )}
    </>
  );
}
