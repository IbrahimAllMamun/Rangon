import { redirect } from "next/navigation";

import { Couriers, type CourierRow } from "@/components/admin/couriers";
import { PageHeader } from "@/components/admin/shell";
import { ShippingZones, type ShippingZoneRow } from "@/components/admin/shipping-zones";
import { Card, ErrorState } from "@/components/ui/primitives";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Shipping" };

export default async function ShippingPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/shipping");

  const canManage =
    user.permissions.includes("*") || user.permissions.includes("settings.manage");

  // Both endpoints are unpaginated (`pagination_class = None`), so these come
  // back as plain arrays rather than a paginated envelope.
  let zones: ShippingZoneRow[] = [];
  let couriers: CourierRow[] = [];
  let error: string | null = null;
  try {
    [zones, couriers] = await Promise.all([
      apiServer<ShippingZoneRow[]>("/shipping-zones/"),
      apiServer<CourierRow[]>("/couriers/").catch(() => []),
    ]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load shipping settings.";
  }

  return (
    <>
      <PageHeader
        title="Shipping"
        description="Checkout offers the methods inside whichever zone matches the delivery city. Prices are computed by the server, never sent by the browser."
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load shipping settings" description={error} />
        </Card>
      ) : (
        <div className="space-y-6">
          <ShippingZones zones={zones} canManage={canManage} />
          <Couriers couriers={couriers} canManage={canManage} />
        </div>
      )}
    </>
  );
}
