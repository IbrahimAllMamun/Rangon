import { NextResponse } from "next/server";

import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/api/client";
import { refuseCrossOrigin } from "@/lib/api/same-origin";
import { cookies } from "next/headers";

const INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1";

export async function POST(request: Request) {
  // Another site must not be able to sign a shopper out mid-checkout (D101).
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  const store = await cookies();
  const refresh = store.get(REFRESH_COOKIE)?.value;
  const access = store.get(ACCESS_COOKIE)?.value;

  // Blacklist the refresh token server-side; a cleared cookie alone would leave
  // a usable token in the wild.
  if (refresh) {
    await fetch(`${INTERNAL_URL}/auth/logout/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
      },
      body: JSON.stringify({ refresh }),
      cache: "no-store",
    }).catch(() => undefined);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ACCESS_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  return response;
}
