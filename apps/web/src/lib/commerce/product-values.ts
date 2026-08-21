/**
 * The shape of the admin product form's fields.
 *
 * Deliberately a module with **no** `"use client"` directive and no server-only
 * import, because both sides need it: the form component is a client component,
 * and `/admin/products/new` is a server component that has to hand it a blank
 * starting value.
 *
 * This used to live in `components/admin/product-form.tsx`. That file is
 * `"use client"`, so calling `blankProduct()` from the server page threw
 * *at runtime* — "Attempted to call blankProduct() from the server but
 * blankProduct is on the client" — while `tsc` and `next build` both stayed
 * green, because neither executes the page. A type crosses the boundary for
 * free; a function does not.
 */

export interface ProductValues {
  name: string;
  slug: string;
  category: string;
  brand: string;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  featured: boolean;
  is_final_sale: boolean;
  seo_title: string;
  seo_description: string;
}

/** A new product starts as a draft: nothing is visible until it is published. */
export function blankProduct(): ProductValues {
  return {
    name: "",
    slug: "",
    category: "",
    brand: "",
    short_description: "",
    description: "",
    material: "",
    care_instructions: "",
    status: "DRAFT",
    featured: false,
    is_final_sale: false,
    seo_title: "",
    seo_description: "",
  };
}
