import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import { SizeChartEditor } from "@/components/admin/size-chart-editor";
import { Card, ErrorState } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";
import { loadSizeAttribute } from "@/lib/commerce/size-chart-page";

export const metadata = { title: "New size chart" };

type SearchParams = Promise<{ attribute?: string }>;

export default async function NewSizeChartPage({ searchParams }: { searchParams: SearchParams }) {
  const { attribute: attributeId = "" } = await searchParams;

  const user = await currentUser<SessionUser>();
  if (!user) {
    const here = `/admin/taxonomy/size-charts/new${attributeId ? `?attribute=${attributeId}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);

  const refuse = (title: string, description: string) => (
    <>
      <PageHeader title="New size chart" />
      <Card>
        <ErrorState title={title} description={description} />
      </Card>
      <p className="mt-4 text-body-sm">
        <Link href="/admin/taxonomy#attributes" className="text-brand-700 hover:underline">
          ← Categories &amp; brands
        </Link>
      </p>
    </>
  );

  if (!can("products.create")) {
    return refuse(
      "You cannot create size charts",
      "Creating a size chart needs the products.create permission. Ask an owner or admin.",
    );
  }
  if (!attributeId) {
    return refuse(
      "Which sizes is this chart for?",
      "Start a chart from a Size attribute under Categories & brands → Attributes.",
    );
  }

  let loaded: Awaited<ReturnType<typeof loadSizeAttribute>>;
  try {
    loaded = await loadSizeAttribute(attributeId);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) {
      return refuse("That attribute no longer exists", "It may have been deleted. Go back and pick another.");
    }
    return refuse(
      "Could not load the attribute",
      caught instanceof Error ? caught.message : "Try again in a moment.",
    );
  }

  if (loaded.attribute.kind !== "SIZE") {
    return refuse(
      "Only a Size attribute can have a size chart",
      `${loaded.attribute.name} is not a Size attribute. Change its kind to Size first, or pick another.`,
    );
  }

  return (
    <>
      <PageHeader
        title="New size chart"
        description={`For ${loaded.attribute.name}. Products then pick it on their own page, and shoppers see it as the Size guide.`}
      />
      <p className="mb-4 text-body-sm">
        <Link href="/admin/taxonomy#attributes" className="text-brand-700 hover:underline">
          ← Categories &amp; brands
        </Link>
      </p>
      <SizeChartEditor
        attribute={loaded.attribute}
        sizes={loaded.sizes}
        chart={null}
        canManage
        canDelete={false}
      />
    </>
  );
}
