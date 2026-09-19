/**
 * Change your own password.
 *
 * Not a trip through `/api/proxy`: a successful change revokes every token the
 * account holds, this session's included, and the API answers with a fresh
 * pair. The proxy would hand that pair to browser JavaScript; this stores it in
 * the httpOnly cookies and echoes nothing (ADR-0005), so the person who changed
 * the password stays signed in and every other session is not.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/api/client";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";
const SECURE = process.env.NODE_ENV === "production";
const SHARED = { httpOnly: true, sameSite: "lax" as const, secure: SECURE, path: "/" };

function change(access: string | undefined, body: string) {
  return fetch(`${INTERNAL_URL}/auth/password/change/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    body,
    cache: "no-store",
  });
}

type Pair = { access: string; refresh: string };

async function refreshed(refresh: string | undefined): Promise<Pair | null> {
  if (!refresh) return null;
  const response = await fetch(`${INTERNAL_URL}/auth/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh }),
    cache: "no-store",
  });
  return response.ok ? response.json() : null;
}

function withSession(response: NextResponse, pair: Pair | null): NextResponse {
  if (pair) {
    response.cookies.set(ACCESS_COOKIE, pair.access, { ...SHARED, maxAge: 60 * 30 });
    response.cookies.set(REFRESH_COOKIE, pair.refresh, { ...SHARED, maxAge: 60 * 60 * 24 * 14 });
  }
  return response;
}

export async function POST(request: Request) {
  const store = await cookies();
  const input = await request.json().catch(() => ({}));
  const body = JSON.stringify({
    current_password: input.current_password ?? "",
    new_password: input.new_password ?? "",
  });

  let upstream = await change(store.get(ACCESS_COOKIE)?.value, body);
  // A form left open past the access token's half hour is still a signed-in
  // person; refresh once and try again, as the proxy would. Refreshing rotates
  // the pair, so the new one has to be stored whatever the change then says --
  // dropping it after a wrong current password would sign the person out.
  let rotated: Pair | null = null;
  if (upstream.status === 401) {
    rotated = await refreshed(store.get(REFRESH_COOKIE)?.value);
    if (rotated) upstream = await change(rotated.access, body);
  }

  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    return withSession(
      NextResponse.json(
        payload ?? {
          error: { code: "UPSTREAM_ERROR", message: "Could not change the password.", details: {} },
        },
        { status: upstream.status },
      ),
      rotated,
    );
  }

  // Deliberately does not echo the tokens back to the client.
  return withSession(NextResponse.json({ ok: true }), payload);
}
