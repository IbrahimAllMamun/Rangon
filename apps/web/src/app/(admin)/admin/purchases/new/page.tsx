import Link from "next/link";
import { redirect } from "next/navigation";

import { PurchaseOrderForm } from "@/components/admin/purchase-order-form";
import type { SupplierRow } from "@/components/admin/supplier-form";
import type { PickableVariant } from "@/components/admin/variant-picker";
import { PageHeader } from "@/components/admin/shell";
import { Card, ErrorState } from "@/components/ui/primitives";
import { type Paginated } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import { getProductFormData, type ProductFormData } from "@/lib/commerce/product-form-data";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "New purchase order" };

type Search = Promise<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Enough for any real "buy these" link; a longer list is not a link someone clicked. */
const MAX_PREFILL = 50;

/**
 * The variants a "Raise a purchase order" link asked for, as order lines.
 *
 * `?variants=a,b` comes from a product with nothing received yet, or from a
 * stock row that cannot be counted upwards (business-rules.md § 4.0a). One
 * that cannot be loaded is dropped rather than failing the page: the buyer
 * can still add it by hand, and the page says how many went missing.
 */
async function prefill(raw: string | undefined): Promise<{
  variants: PickableVariant[];
  missing: number;
}> {
  const ids = [...new Set((raw ?? "").split(",").map((id) => id.trim()))]
    .filter((id) => UUID.test(id))
    .slice(0, MAX_PREFILL);
  if (!ids.length) return { variants: [], missing: 0 };

  const loaded = await Promise.allSettled(
    ids.map((id) => apiServer<PickableVariant>(`/variants/${id}/`)),
  );
  const variants = loaded.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  return { variants, missing: ids.length - variants.length };
}

export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/purchases/new");

  const allowed = user.permissions.includes("*") || user.permissions.includes("purchases.create");
  if (!allowed) {
    return (
      <>
        <PageHeader title="New purchase order" />
        <Card>
          <ErrorState
            title="You cannot raise purchase orders"
            description="This needs the purchases.create permission. Ask an owner or admin."
          />
        </Card>
      </>
    );
  }

  let suppliers: SupplierRow[] = [];
  let error: string | null = null;
  try {
    const page = await apiServer<Paginated<SupplierRow>>("/suppliers/?page_size=100");
    suppliers = page.results;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load suppliers.";
  }

  // Categories, brands and variant axes, so a product the catalogue has never
  // carried can be created without leaving this order.
  //
  // Allowed to fail on its own: a buyer without `products.create` — or a
  // reference list that will not load — still gets a working order form, minus
  // the option to invent a product. The API refuses the write either way.
  const canCreateProducts =
    user.permissions.includes("*") || user.permissions.includes("products.create");
  let reference: ProductFormData | null = null;
  if (canCreateProducts) {
    try {
      reference = await getProductFormData();
    } catch {
      reference = null;
    }
  }

  const lines = await prefill(params.variants);

  if (error) {
    return (
      <>
        <PageHeader title="New purchase order" />
        <Card>
          <ErrorState title="Could not load suppliers" description={error} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New purchase order"
        description="Raising an order does not move stock — that happens when the goods are received."
      />

      <p className="mb-4 flex flex-wrap gap-4 text-body-sm">
        <Link href="/admin/purchases" className="text-brand-700 hover:underline">
          ← Purchase orders
        </Link>
        <Link href="/admin/suppliers" className="text-brand-700 hover:underline">
          Manage suppliers
        </Link>
      </p>

      {lines.missing > 0 && (
        <p role="status" className="mb-4 text-body-sm text-muted">
          {lines.missing} of the products this link asked for could not be loaded, so{" "}
          {lines.missing === 1 ? "it is" : "they are"} not on the order. Search for{" "}
          {lines.missing === 1 ? "it" : "them"} below.
        </p>
      )}

      <PurchaseOrderForm
        suppliers={suppliers}
        defaultBranchLabel={user.branch ? `${user.branch.name} (${user.branch.code})` : "Default branch"}
        // Only when the reference data loaded: without brands and attributes
        // the inline form would offer less than it should, silently.
        canCreateProducts={canCreateProducts && reference !== null}
        categories={reference?.categories ?? []}
        brands={reference?.brands ?? []}
        attributes={reference?.attributes ?? []}
        initialVariants={lines.variants}
      />
    </>
  );
}
