/**
 * The public origin of the storefront, and how to make a URL absolute against
 * it.
 *
 * Media URLs from the API are origin-relative on purpose (`/media/products/...`
 * — see `apps/api/core/media.py`), which is what `next/image`, `<img>` and
 * `metadataBase`-resolved Open Graph tags all want. Two consumers do not
 * resolve relative URLs for us and need a real one:
 *
 *   * JSON-LD, where schema.org requires absolute `image` values;
 *   * anything handed to a crawler or a third party rather than the browser.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export function absoluteUrl(path: string): string {
  if (!path) return "";
  try {
    // Already absolute (object storage returns fully-qualified URLs) — keep it.
    return new URL(path, SITE_URL).toString();
  } catch {
    return path;
  }
}
