/**
 * API access.
 *
 * Server components call the API directly over the private network using the
 * access token from an httpOnly cookie (ADR-0005). The browser never sees a
 * token: client components call same-origin Next.js route handlers under
 * /api/proxy, which attach it.
 */
import { cookies } from "next/headers";

export const ACCESS_COOKIE = "rangon_access";
export const REFRESH_COOKIE = "rangon_refresh";
export const CART_COOKIE = "rangon_cart";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";
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

/**
 * Server-side fetch. Only ever called from server components and route
 * handlers — importing `next/headers` makes that structural, not a convention.
 */
export async function apiServer<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, revalidate, tags, auth = true, cartToken, idempotencyKey, ...rest } = options;

  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");

  if (auth) {
    const store = await cookies();
    const token = store.get(ACCESS_COOKIE)?.value;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  if (cartToken) headers.set("X-Cart-Token", cartToken);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  const response = await fetch(`${INTERNAL_URL}${path}`, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    next:
      revalidate === undefined || revalidate === false
        ? { tags }
        : { revalidate, tags },
    cache: revalidate === undefined || revalidate === false ? "no-store" : undefined,
  });

  return handle<T>(response);
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

  const response = await fetch(`/api/proxy${path}`, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return handle<T>(response);
}

/** Is the visitor signed in? (Presence of the cookie, not a validity check.) */
export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return Boolean(store.get(ACCESS_COOKIE)?.value);
}

export async function currentUser<T = unknown>(): Promise<T | null> {
  try {
    return await apiServer<T>("/auth/me/");
  } catch {
    return null;
  }
}
