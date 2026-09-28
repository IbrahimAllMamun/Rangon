import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import { SizeChartEditor } from "@/components/admin/size-chart-editor";
import { Card, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { type SizeChartData, chartTitle } from "@/lib/commerce/size-chart";
import { loadSizeAttribute } from "@/lib/commerce/size-chart-page";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  try {
    const chart = await apiServer<SizeChartData>(`/size-charts/${id}/`);
    return { title: `${chart.name} · size chart` };
  } catch {
    return { title: "Size chart" };
  }
}

export default async function EditSizeChartPage({ params }: { params: Params }) {
  const { id } = await params;

  const user = await currentUser<SessionUser>();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/admin/taxonomy/size-charts/${id}`)}`);

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  let chart: SizeChartData;
  let loaded: Awaited<ReturnType<typeof loadSizeAttribute>>;
  try {
    chart = await apiServer<SizeChartData>(`/size-charts/${id}/`);
    loaded = await loadSizeAttribute(chart.attribute);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    return (
      <>
        <PageHeader title="Size chart" />
        <Card>
          <ErrorState
            title="Could not load this size chart"
            description={caught instanceof Error ? caught.message : "Try again in a moment."}
          />
        </Card>
      </>
    );
  }

  const used = chart.product_count;
  return (
    <>
      <PageHeader
        title={chartTitle(chart)}
        description={`Describes ${loaded.attribute.name} · used by ${used} product${used === 1 ? "" : "s"}`}
      />
      <p className="mb-4 text-body-sm">
        <Link href="/admin/taxonomy#attributes" className="text-brand-700 hover:underline">
          ← Categories &amp; brands
        </Link>
      </p>
      <SizeChartEditor
        attribute={loaded.attribute}
        sizes={loaded.sizes}
        chart={chart}
        canManage={can("products.update")}
        canDelete={can("products.delete")}
      />
    </>
  );
}
