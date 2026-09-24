/**
 * Refuse a state-changing request that a browser sent from another origin
 * (CSRF, D101).
 *
 * The session lives in httpOnly cookies on this origin, and every route under
 * `/api/proxy` and `/api/auth` acts with them. `SameSite=Lax` keeps them off a
 * request from another *site* — but not from another origin on the same site,
 * a subdomain, and it is the whole defence only where the browser honours it.
 * `security.md` claimed a double-submit token as well; none was ever built.
 * Measured 2026-09-24 against a production build: with the owner's cookies, a
 * PATCH carrying `Origin: https://blog.shop.example` changed an account (200),
 * and a sign-in from another origin set a session.
 *
 * Browsers attach `Origin` to every cross-origin POST, PATCH, PUT and DELETE,
 * and page script can neither remove nor forge it. So a state-changing request
 * whose `Origin` is not this site's is refused. One with no `Origin` at all is
 * not a browser's cross-origin request — a server, a script, a health check —
 * and passes: it carries no one's cookies but its own.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The configured public origin — what a browser behind Nginx reports. */
function configuredOrigin(): string | null {
  try {
    return process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL).origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins this request may come from: the configured site, and the one it
 * arrived on. Nginx forwards `Host $host`, which drops a non-default port, so
 * the configured origin covers the proxied case; `Host` covers direct access
 * (development, CI), where it carries the port.
 */
export function siteOrigins(request: Request): Set<string> {
  const origins = new Set<string>();
  const configured = configuredOrigin();
  if (configured) origins.add(configured);

  const host = request.headers.get("host");
  if (host) {
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwarded || new URL(request.url).protocol.replace(/:$/, "");
    origins.add(`${protocol}://${host}`);
  }
  return origins;
}

/** A 403 in the API's error envelope, or null when the request may proceed. */
export function refuseCrossOrigin(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.get("origin");
  if (origin === null) return null;
  if (siteOrigins(request).has(origin)) return null;

  return new Response(
    JSON.stringify({
      error: {
        code: "CROSS_ORIGIN_REFUSED",
        message: "This request came from another website, so it was refused.",
        details: {},
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
