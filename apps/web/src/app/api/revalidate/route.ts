import { revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Cache invalidation from the Django side.
 *
 * A merchandiser edits the menu; without this the storefront keeps serving the
 * old one until the ISR window elapses (docs/architecture/navigation.md §3).
 *
 * Authenticated by a shared secret, compared in constant time. With no secret
 * configured the endpoint refuses everything rather than allowing anonymous
 * cache-busting — an open endpoint here is a cheap denial-of-service.
 */
const SECRET = process.env.REVALIDATE_SECRET ?? "";

/** Only tags the storefront actually uses; an arbitrary tag is a typo, not a request. */
const ALLOWED_TAGS = new Set(["navigation", "categories", "home", "products"]);

/**
 * One product page, by slug.
 *
 * `products` was on the allow-list from the start but nothing emitted it, while
 * the product page tagged `product:<slug>`, which the allow-list refused — so
 * the product page was the one page this endpoint could not bust, and a
 * merchandiser changing a price had no way to force it. The page now emits
 * both, and this pattern admits the targeted form.
 *
 * The slug is bounded to the shape a slug can take: it reaches `revalidateTag`,
 * so "any string starting with product:" would be an arbitrary-tag hole in an
 * allow-list that exists to prevent exactly that.
 */
const PRODUCT_TAG = /^product:[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isAllowed(tag: string): boolean {
  return ALLOWED_TAGS.has(tag) || PRODUCT_TAG.test(tag);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function POST(request: NextRequest) {
  if (!SECRET || !timingSafeEqual(request.headers.get("x-revalidate-secret") ?? "", SECRET)) {
    return NextResponse.json(
      { error: { code: "AUTHENTICATION_REQUIRED", message: "Invalid secret.", details: {} } },
      { status: 401 },
    );
  }

  let tags: unknown;
  try {
    tags = (await request.json())?.tags;
  } catch {
    tags = null;
  }
  if (!Array.isArray(tags)) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "`tags` must be an array.", details: {} } },
      { status: 400 },
    );
  }

  const revalidated = tags.filter(
    (tag): tag is string => typeof tag === "string" && isAllowed(tag),
  );
  for (const tag of revalidated) revalidateTag(tag);

  return NextResponse.json({ revalidated });
}
