import { LogoLoaderScreen } from "@/components/brand/logo-loader-screen";

/** Shown while the category, its products and its facets are fetched. */
export default function CategoryLoading() {
  return <LogoLoaderScreen label="Loading products" />;
}
