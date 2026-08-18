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

import { ACCESS_COOKIE, ApiError, type ApiErrorBody } from "./client";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";

interface ServerRequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** ISR revalidation window in seconds; omit for dynamic data. */
  revalidate?: number | false;
  tags?: string[];
  auth?: boolean;
  cartToken?: string;
  idempotencyKey?: string;
}

/**
 * Fetch from a server component or route handler, over the private network,
 * attaching the caller's access token from the httpOnly cookie.
 */
export async function apiServer<T>(path: string, options: ServerRequestOptions = {}): Promise<T> {
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
    next: revalidate === undefined || revalidate === false ? { tags } : { revalidate, tags },
    cache: revalidate === undefined || revalidate === false ? "no-store" : undefined,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const errorBody = payload as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      errorBody?.error?.code ?? "SERVER_ERROR",
      errorBody?.error?.message ?? `Request failed with status ${response.status}`,
      errorBody?.error?.details,
    );
  }
  return payload as T;
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
