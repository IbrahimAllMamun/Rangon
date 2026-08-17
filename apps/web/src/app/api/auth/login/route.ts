/**
 * Login: exchange credentials for tokens and store them in httpOnly cookies.
 * The browser never receives a token in JavaScript (ADR-0005).
 */
import { NextResponse } from "next/server";

import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/api/client";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";
const SECURE = process.env.NODE_ENV === "production";

export async function POST(request: Request) {
  const body = await request.json();

  const upstream = await fetch(`${INTERNAL_URL}/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email, password: body.password }),
    cache: "no-store",
  });

  const payload = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    return NextResponse.json(
      payload ?? {
        error: { code: "AUTHENTICATION_REQUIRED", message: "Sign-in failed.", details: {} },
      },
      { status: upstream.status },
    );
  }

  // Deliberately does not echo the tokens back to the client.
  const response = NextResponse.json({ user: payload.user });
  const shared = { httpOnly: true, sameSite: "lax" as const, secure: SECURE, path: "/" };

  response.cookies.set(ACCESS_COOKIE, payload.access, { ...shared, maxAge: 60 * 30 });
  response.cookies.set(REFRESH_COOKIE, payload.refresh, {
    ...shared,
    maxAge: 60 * 60 * 24 * 14,
  });
  return response;
}
