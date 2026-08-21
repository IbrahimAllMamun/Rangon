/**
 * Reference data the admin product form needs: categories, brands and the
 * attributes a variant can be built from.
 *
 * SERVER ONLY — it calls `apiServer`. Both `/admin/products/new` and
 * `/admin/products/[id]` load the same three lists, and all three endpoints are
 * unpaginated, so one helper keeps the two pages honest with each other.
 */
import { apiServer } from "@/lib/api/server";
import type { MatrixAttribute } from "@/lib/commerce/variant-matrix";

export interface CategoryOption {
  id: string;
  name: string;
  parent: string | null;
}

export interface BrandOption {
  id: string;
  name: string;
}

interface AttributeResponse {
  id: string;
  name: string;
  code: string;
  kind: string;
  is_variant_defining: boolean;
  values: { id: string; value: string; label: string; display: string; swatch: string }[];
}

export interface ProductFormData {
  categories: CategoryOption[];
  brands: BrandOption[];
  attributes: MatrixAttribute[];
  /** Attribute-value ids by `attributeCode:value`, for binding images to colours. */
  valueIds: Record<string, string>;
}

export async function getProductFormData(): Promise<ProductFormData> {
  const [categories, brands, attributes] = await Promise.all([
    apiServer<CategoryOption[]>("/categories/"),
    apiServer<BrandOption[]>("/brands/?is_active=true"),
    apiServer<AttributeResponse[]>("/attributes/"),
  ]);

  const valueIds: Record<string, string> = {};
  for (const attribute of attributes) {
    for (const value of attribute.values) {
      valueIds[`${attribute.code}:${value.value}`] = value.id;
    }
  }

  return {
    categories,
    brands,
    // Only variant-defining attributes generate SKUs; a spec such as "Material"
    // is stated once on the product, not multiplied into the matrix.
    attributes: attributes
      .filter((attribute) => attribute.is_variant_defining)
      .map((attribute) => ({
        code: attribute.code,
        name: attribute.name,
        kind: attribute.kind,
        values: attribute.values.map((value) => ({
          value: value.value,
          label: value.display || value.label || value.value,
          swatch: value.swatch,
        })),
      })),
    valueIds,
  };
}
