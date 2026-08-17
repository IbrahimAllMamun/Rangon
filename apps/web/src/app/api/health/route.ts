import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Container liveness probe (see apps/web/Dockerfile HEALTHCHECK). */
export function GET() {
  return NextResponse.json({ status: "ok" });
}
