import { NextResponse } from "next/server";

/**
 * The landing point for the Track-your-order form (D67).
 *
 * `/track` is a plain `<form action="/order" method="get">`, so submitting it
 * asks for `/order?number=RGN-WEB-000123&token=…`. The only route that has ever
 * existed is `/order/[number]`, which reads the number from a *path* segment —
 * so every submission 404'd, from the day the form was written. The footer
 * links to `/track` on every page of the storefront, and this is the last step
 * of it.
 *
 * A route handler rather than a client-side `router.push`: the form keeps
 * working with JavaScript disabled, and the redirect is one hop the browser
 * makes itself.
 *
 * Two forgivenesses worth having, because the number is copied off a receipt or
 * an SMS by hand: surrounding whitespace is trimmed, and the number is
 * upper-cased. `Order.number` is matched exactly by the API, and Postgres
 * compares case-sensitively, so `rgn-web-000123` would otherwise be "not
 * found" in a way that reads as the order having been lost.
 */

/** `RGN-WEB-000123` and friends: the shape `core.services.next_number()` emits. */
const ORDER_NUMBER = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const number = (params.get("number") ?? "").trim().toUpperCase();
  const token = (params.get("token") ?? "").trim();

  // Anything that is not a plausible order number goes back to the form rather
  // than into a path segment. This is a redirect target built from user input,
  // so the shape is checked before it is used, not merely encoded.
  if (!ORDER_NUMBER.test(number)) {
    return NextResponse.redirect(new URL("/track?e=number", request.url));
  }

  const next = new URL(`/order/${encodeURIComponent(number)}`, request.url);
  if (token) next.searchParams.set("token", token);
  return NextResponse.redirect(next);
}
