/**
 * Same-origin proxy for client components.
 *
 * The browser calls /api/proxy/shop/cart/ ; this handler attaches the access
 * token from the httpOnly cookie and forwards to the API. On a 401 it refreshes
 * once and retries, so a component never has to think about token lifetime.
 */
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { ACCESS_COOKIE, CART_COOKIE, REFRESH_COOKIE } from "@/lib/api/client";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";
const SECURE = process.env.NODE_ENV === "production";
const FORWARD_HEADERS = ["content-type", "x-cart-token", "idempotency-key", "accept"];

async function refreshAccess(refresh: string): Promise<{ access: string; refresh: string } | null> {
  const response = await fetch(`${INTERNAL_URL}/auth/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh }),
    cache: "no-store",
  });
  if (!response.ok) return null;
  return response.json();
}

async function forward(request: NextRequest, path: string[]) {
  const store = await cookies();

  // Next hands the catch-all over as path *segments*, so a trailing slash is
  // lost: "/pos/sales/" arrives as ["pos","sales"]. The Django API is
  // trailing-slash throughout, and APPEND_SLASH cannot redirect a POST without
  // discarding the body - it raises instead. So restore the slash here.
  const segments = path.join("/");
  const normalised = segments.endsWith("/") ? segments : `${segments}/`;
  const target = `${INTERNAL_URL}/${normalised}${request.nextUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("x-cart-token")) {
    const cartToken = store.get(CART_COOKIE)?.value;
    if (cartToken) headers.set("x-cart-token", cartToken);
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();

  const send = (token?: string) =>
    fetch(target, {
      method: request.method,
      headers: token ? new Headers([...headers, ["authorization", `Bearer ${token}`]]) : headers,
      body,
      cache: "no-store",
    });

  let access = store.get(ACCESS_COOKIE)?.value;
  let upstream = await send(access);
  let rotated: { access: string; refresh: string } | null = null;

  if (upstream.status === 401) {
    const refresh = store.get(REFRESH_COOKIE)?.value;
    if (refresh) {
      rotated = await refreshAccess(refresh);
      if (rotated) {
        access = rotated.access;
        upstream = await send(access);
      }
    }
  }

  const text = await upstream.text();
  const response = new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });

  // A guest cart token is minted by the API; persist it so the basket survives
  // a page reload.
  const cartToken = upstream.headers.get("x-cart-token");
  if (cartToken) {
    response.cookies.set(CART_COOKIE, cartToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: SECURE,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    response.headers.set("X-Cart-Token", cartToken);
  }

  if (rotated) {
    const shared = { httpOnly: true, sameSite: "lax" as const, secure: SECURE, path: "/" };
    response.cookies.set(ACCESS_COOKIE, rotated.access, { ...shared, maxAge: 60 * 30 });
    response.cookies.set(REFRESH_COOKIE, rotated.refresh, {
      ...shared,
      maxAge: 60 * 60 * 24 * 14,
    });
  }

  return response;
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: Context) {
  return forward(request, (await params).path);
}
export async function POST(request: NextRequest, { params }: Context) {
  return forward(request, (await params).path);
}
export async function PATCH(request: NextRequest, { params }: Context) {
  return forward(request, (await params).path);
}
export async function PUT(request: NextRequest, { params }: Context) {
  return forward(request, (await params).path);
}
export async function DELETE(request: NextRequest, { params }: Context) {
  return forward(request, (await params).path);
}
