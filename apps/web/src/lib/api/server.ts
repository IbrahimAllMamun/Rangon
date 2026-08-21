/**
 * Server-side API access.
 *
 * SERVER ONLY. This module reads httpOnly cookies via `next/headers`, so it can
 * never be imported from a `"use client"` component — importing it into the
 * browser bundle is a build error, not a subtle bug.
 *
 * Browser code uses `apiClient` from ./client, which goes through the
 * same-origin /api/proxy route handler instead (ADR-0005).
 */
import { cookies } from "next/headers";

import { ACCESS_COOKIE, ApiError, parseApiResponse } from "./client";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";

/**
 * Deadline for reads that go through Next's data cache.
 *
 * When a cached fetch rejects, Next leaves the in-flight cache entry pending
 * and every later read of the same key waits on it forever. One unreachable
 * API call therefore wedges every render that shares the key: `next build`
 * hangs on the storefront pages, and a running server would stop serving them
 * after a momentary API outage. A deadline turns that permanent hang back into
 * the ordinary error each caller already handles. Mutations are never raced --
 * aborting a payment mid-flight is worse than waiting for it.
 */
const CACHED_READ_TIMEOUT_MS = 5_000;

function withDeadline<T>(request: Promise<T>, ms: number, path: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiError(504, "UPSTREAM_TIMEOUT", `Timed out after ${ms}ms: ${path}`)),
      ms,
    );
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
}

interface ServerRequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** ISR revalidation window in seconds; omit for dynamic data. */
  revalidate?: number | false;
  tags?: string[];
  auth?: boolean;
  cartToken?: string;
  idempotencyKey?: string;
  /** Override the deadline applied to cached reads. */
  timeoutMs?: number;
}

/**
 * Fetch from a server component or route handler, over the private network,
 * attaching the caller's access token from the httpOnly cookie.
 */
export async function apiServer<T>(path: string, options: ServerRequestOptions = {}): Promise<T> {
  const { body, revalidate, tags, auth = true, cartToken, idempotencyKey, timeoutMs, ...rest } =
    options;
  const cached = revalidate !== undefined && revalidate !== false;

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

  const request = fetch(`${INTERNAL_URL}${path}`, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    next: cached ? { revalidate, tags } : { tags },
    cache: cached ? undefined : "no-store",
  });

  const response = cached
    ? await withDeadline(request, timeoutMs ?? CACHED_READ_TIMEOUT_MS, path)
    : await request;

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  // Shared with the browser client so both surface an upstream that answers
  // with HTML (a Django 404 page, an nginx 502, a misrouted proxy) as an
  // ApiError naming the status and the path — not as a bare JSON SyntaxError
  // from inside a bundled chunk.
  return parseApiResponse<T>(
    response.status,
    response.ok,
    text,
    response.headers.get("content-type"),
    `${INTERNAL_URL}${path}`,
  );
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

export type { Paginated } from "./client";
