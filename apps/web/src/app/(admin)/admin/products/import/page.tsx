import { redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import { ProductImport } from "@/components/admin/product-import";
import { Card, ErrorState } from "@/components/ui/primitives";
import { currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Import products" };

/**
 * The only admin screen that used to render its form to anyone signed in (D66).
 *
 * `POST /products/import/` requires **both** `products.create` and
 * `inventory.adjust` — an import creates products and can receive opening
 * stock, so either one alone is not enough. The API refuses correctly, so this
 * was never a way in; it was a screen that let a cashier pick a file, map its
 * columns and press the button before telling them no. Every sibling page under
 * `/admin/products` checks first, and now so does this one.
 */
export default async function ProductImportPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/products/import");

  const can = (code: string) => user.permissions.includes("*") || user.permissions.includes(code);
  const allowed = can("products.create") && can("inventory.adjust");

  if (!allowed) {
    return (
      <>
        <PageHeader title="Import products" />
        <Card>
          <ErrorState
            title="You cannot import products"
            description="An import creates products and receives opening stock, so it needs both the products.create and inventory.adjust permissions. Ask an owner or admin."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Import products"
        description="Load a catalogue from a spreadsheet. Nothing is written until you have seen what it would do."
      />
      <ProductImport />
    </>
  );
}
