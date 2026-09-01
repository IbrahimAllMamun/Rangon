import { redirect } from "next/navigation";

import { PageHeader } from "@/components/admin/shell";
import {
  type AttributeRow,
  AttributeList,
  BrandManager,
  type BrandRow,
  CategoryManager,
  type CategoryRow,
} from "@/components/admin/taxonomy-manager";
import { Card, ErrorState } from "@/components/ui/primitives";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Categories & brands" };

/** These endpoints answer unpaginated (`pagination_class = None`). */
type MaybePaged<T> = T[] | { results: T[] };

function rows<T>(payload: MaybePaged<T> | null): T[] {
  if (!payload) return [];
  return Array.isArray(payload) ? payload : (payload.results ?? []);
}

/** The tree comes back nested; the table wants one row per category. */
function flatten(tree: (CategoryRow & { children?: CategoryRow[] })[]): CategoryRow[] {
  const out: CategoryRow[] = [];
  const walk = (nodes: (CategoryRow & { children?: CategoryRow[] })[]) => {
    for (const node of nodes) {
      const { children, ...row } = node;
      out.push(row as CategoryRow);
      if (children?.length) walk(children as (CategoryRow & { children?: CategoryRow[] })[]);
    }
  };
  walk(tree);
  return out;
}

export default async function TaxonomyPage() {
  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin/taxonomy");

  const can = (permission: string) =>
    user.permissions.includes("*") || user.permissions.includes(permission);
  const canManage = can("products.update");

  let categories: CategoryRow[] = [];
  let brands: BrandRow[] = [];
  let attributes: AttributeRow[] = [];
  let error: string | null = null;

  try {
    const [categoryPayload, brandPayload, attributePayload] = await Promise.all([
      apiServer<MaybePaged<CategoryRow & { children?: CategoryRow[] }>>("/categories/"),
      apiServer<MaybePaged<BrandRow>>("/brands/"),
      apiServer<MaybePaged<AttributeRow>>("/attributes/"),
    ]);
    categories = flatten(rows(categoryPayload));
    brands = rows(brandPayload);
    attributes = rows(attributePayload);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load the taxonomy.";
  }

  return (
    <>
      <PageHeader
        title="Categories &amp; brands"
        description="How the catalogue is organised, and what the storefront menu is built from. A category's VAT override replaces the organisation rate for everything inside it."
      />

      {error ? (
        <Card>
          <ErrorState title="Could not load the taxonomy" description={error} />
        </Card>
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="categories">
            <h2 id="categories" className="mb-3 text-h4 font-semibold">
              Categories
            </h2>
            <CategoryManager categories={categories} canManage={canManage} />
          </section>

          <section aria-labelledby="brands">
            <h2 id="brands" className="mb-3 text-h4 font-semibold">
              Brands
            </h2>
            <BrandManager brands={brands} canManage={canManage} />
          </section>

          <section aria-labelledby="attributes">
            <h2 id="attributes" className="mb-3 text-h4 font-semibold">
              Attributes
            </h2>
            <AttributeList attributes={attributes} />
          </section>
        </div>
      )}
    </>
  );
}
