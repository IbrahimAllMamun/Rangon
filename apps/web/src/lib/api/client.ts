/**
 * Browser-safe API access.
 *
 * SAFE TO IMPORT ANYWHERE. Nothing here touches `next/headers`, so a
 * `"use client"` component can import it without dragging server-only code
 * into the browser bundle.
 *
 * Server components and route handlers use `apiServer` from ./server, which
 * reads the httpOnly access-token cookie and calls the API over the private
 * network (ADR-0005). The browser never sees a token: it calls the same-origin
 * /api/proxy route handler, which attaches it.
 */

export const ACCESS_COOKIE = "rangon_access";
export const REFRESH_COOKIE = "rangon_refresh";
export const CART_COOKIE = "rangon_cart";

export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field errors from a VALIDATION_ERROR, flattened for form display. */
  fieldErrors(): { field: string; message: string }[] {
    if (!this.details || typeof this.details !== "object") return [];
    return Object.entries(this.details as Record<string, unknown>).map(([field, value]) => ({
      field,
      message: Array.isArray(value) ? String(value[0]) : String(value),
    }));
  }
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** ISR revalidation window in seconds; omit for dynamic data. */
  revalidate?: number | false;
  tags?: string[];
  auth?: boolean;
  cartToken?: string;
  idempotencyKey?: string;
}

async function handle<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "SERVER_ERROR",
      body?.error?.message ?? `Request failed with status ${response.status}`,
      body?.error?.details,
    );
  }
  return payload as T;
}

/**
 * Browser-side fetch, routed through Next so the token stays in an httpOnly
 * cookie. `path` is an API path such as "/shop/cart/".
 */
export async function apiClient<T>(
  path: string,
  options: Omit<RequestOptions, "revalidate" | "tags" | "auth"> = {},
): Promise<T> {
  const { body, cartToken, idempotencyKey, ...rest } = options;

  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  if (cartToken) headers.set("X-Cart-Token", cartToken);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  // Next redirects trailing-slash URLs (308), so sending "/pos/sales/" here
  // would cost an extra round trip on every call. Strip it: the proxy route
  // re-adds the slash Django requires when it forwards.
  const [pathname, query = ""] = path.split("?");
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const url = `/api/proxy${trimmed}${query ? `?${query}` : ""}`;

  const response = await fetch(url, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return handle<T>(response);
}
