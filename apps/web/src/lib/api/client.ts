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

  /**
   * Field errors from a VALIDATION_ERROR, flattened for form display.
   *
   * Only a VALIDATION_ERROR carries per-field messages. Every other
   * `BusinessError` puts *diagnostic context* in `details` — an
   * `INSUFFICIENT_FUNDS` sends `{account_id, account, balance, requested}`,
   * and `INSUFFICIENT_STOCK` sends `{sku, available, requested}`. Rendering
   * those as field errors printed a list of raw values ("65450.00",
   * "100000.00") where the human message belonged, and linked each to a
   * form field that does not exist.
   *
   * Returning nothing for those codes is what makes callers fall back to
   * `error.message`, which is the sentence the service actually wrote.
   */
  fieldErrors(): { field: string; message: string }[] {
    if (this.code !== "VALIDATION_ERROR") return [];
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

/**
 * Parse a response body that is *supposed* to be JSON but might not be.
 *
 * It might not be whenever something other than the API answers: Django's own
 * 404 page, an nginx 502, a proxy that routed the path to the wrong upstream.
 * All of those are HTML.
 *
 * Parsing before checking the status turned every one of those into
 * `SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON`,
 * thrown from deep inside a bundled chunk — which says nothing about the
 * status, the URL, or which upstream answered. Checking the status first, and
 * treating an unparseable body as "no structured detail", turns it back into
 * the ordinary ApiError every caller already handles.
 */
export function parseApiResponse<T>(
  status: number,
  ok: boolean,
  text: string,
  contentType: string | null,
  path: string,
): T {
  let payload: unknown = null;
  let parsed = false;
  if (text) {
    try {
      payload = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
  } else {
    parsed = true;
  }

  if (!ok) {
    const body = parsed ? (payload as ApiErrorBody | null) : null;
    throw new ApiError(
      status,
      body?.error?.code ?? "SERVER_ERROR",
      body?.error?.message ?? `Request failed with status ${status}: ${path}`,
      body?.error?.details,
    );
  }

  if (!parsed) {
    // A 2xx that is not JSON means the request reached something that is not
    // the API. Naming the content type and the path is the whole point.
    throw new ApiError(
      502,
      "UPSTREAM_NOT_JSON",
      `Expected JSON from ${path} but received ${contentType ?? "an unknown content type"}. ` +
        "Something other than the API answered this request.",
      { path, contentType, preview: text.slice(0, 120) },
    );
  }

  return payload as T;
}

async function handle<T>(response: Response, path = ""): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  return parseApiResponse<T>(
    response.status,
    response.ok,
    text,
    response.headers.get("content-type"),
    path,
  );
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

  return handle<T>(response, path);
}

/**
 * Multipart upload from the browser (product images).
 *
 * Deliberately separate from `apiClient`: that helper forces
 * `Content-Type: application/json`, and a multipart body must carry the
 * boundary the browser generates, which means letting `fetch` set the header
 * itself. The proxy forwards content-type and the raw bytes untouched.
 */
export async function apiUpload<T>(path: string, form: FormData, method = "POST"): Promise<T> {
  const [pathname, query = ""] = path.split("?");
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  const response = await fetch(`/api/proxy${trimmed}${query ? `?${query}` : ""}`, {
    method,
    body: form,
  });

  return handle<T>(response, path);
}
