/**
 * Per-request CSP nonce (D16).
 *
 * The App Router streams its RSC payload through inline <script> tags. A static
 * `script-src 'self'` therefore blocks React from ever hydrating and the
 * production build renders a blank page — which is exactly what shipped in
 * `infrastructure/docker/nginx/conf.d/rangon.conf` and blocked deployment.
 *
 * The fix is a nonce minted here, per request. Next reads it off the
 * `content-security-policy` REQUEST header and stamps it onto every script tag
 * it emits, so the response header can stay strict without `'unsafe-inline'`.
 *
 * Nginx must NOT also send a CSP header: `add_header` appends rather than
 * replaces, and a browser enforces the intersection of every policy it is
 * given, so a second header would re-break the page. Both nginx configs have
 * had the directive removed and point here instead.
 */
import { NextRequest, NextResponse } from "next/server";

const DEV = process.env.NODE_ENV !== "production";

/** 128 bits of randomness, base64. `Buffer` does not exist on the Edge runtime. */
function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function policy(nonce: string): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    // Styles stay 'unsafe-inline': Next emits inline <style> for critical CSS
    // without a nonce, and a style nonce would break every `style={{…}}` prop.
    "style-src 'self' 'unsafe-inline'",
    // 'strict-dynamic' lets the nonced bootstrap script load its own chunks, so
    // the chunk URLs do not each need listing. Browsers that honour it ignore
    // 'self' in this directive; older ones fall back to it.
    // The dev server compiles with eval(), which production never does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ""}`,
    "font-src 'self' data:",
    // The browser only ever talks to its own origin: /api/proxy/* forwards to
    // the API over the private network (ADR-0005).
    `connect-src 'self'${DEV ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const nonce = makeNonce();
  const header = policy(nonce);

  // Next looks for the nonce on the *request* header; `x-nonce` is what a
  // component reads if it ever needs to nonce a script of its own.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", header);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", header);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every document request, and nothing else:
     *   - /api/*        JSON, no scripts to protect
     *   - /_next/static build output, immutable and hashed
     *   - /_next/image  optimised images
     *   - files with an extension (favicon.ico, logo.svg, robots.txt …)
     * Prefetches are skipped too: they return the same document from the cache
     * and would otherwise burn a nonce that never reaches a browser.
     */
    {
      source: "/((?!api|_next/static|_next/image|.*\.[\w]+$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
