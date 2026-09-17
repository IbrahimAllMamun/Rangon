/**
 * The CSP nonce and static rendering are mutually exclusive (D74).
 *
 * `src/middleware.ts` mints a nonce per request and sends
 * `script-src 'self' 'nonce-…' 'strict-dynamic'`. Next stamps that nonce onto
 * its script tags at *render* time, so a page prerendered at build time carries
 * none while the response it is served with still demands one. Every script is
 * then refused: the chunk `<script src>` tags, because `'strict-dynamic'` makes
 * browsers ignore `'self'`, and the inline `self.__next_f.push(...)` tags
 * carrying the RSC payload, which no host-source expression can allow.
 *
 * That shipped. `/`, `/login`, `/cart`, `/checkout`, `/about`, `/brand`,
 * `/contact` and `/policies/*` were all statically prerendered and inert in the
 * browser — 32 refusals on `/login` alone, and no sign-in form at all, so there
 * was no way into `/admin`. `export const dynamic = "force-dynamic"` in the
 * root layout is what holds it together.
 *
 * These specs fail loudly if anyone makes a page static again while the nonce
 * is in place. A unit test cannot catch it: it only exists in the interaction
 * between the build's rendering mode and an enforced header in a real browser.
 */
import { expect, test, type Page } from "@playwright/test";

/** Pages that were statically prerendered, and therefore dead, before D74. */
const PREVIOUSLY_STATIC = [
  "/",
  "/login",
  "/cart",
  "/checkout",
  "/about",
  "/contact",
  "/brand",
  "/policies/shipping",
];

/** Console messages a browser emits when the policy refuses something. */
function collectRefusals(page: Page): string[] {
  const refusals: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|execute)/i.test(text)) refusals.push(text);
  });
  return refusals;
}

test.describe("Content Security Policy", () => {
  test("the sign-in form is usable, which is how D74 was noticed", async ({ page }) => {
    const refusals = collectRefusals(page);

    await page.goto("/login");

    // The symptom, stated the way it was reported: a white screen, no form.
    const form = page.locator("form");
    await expect(form.getByLabel("Email address")).toBeVisible();
    await expect(form.getByLabel("Password")).toBeVisible();
    await expect(form.getByRole("button", { name: "Sign in" })).toBeVisible();

    expect(refusals, `CSP refused ${refusals.length} script(s):\n${refusals.join("\n")}`).toEqual(
      [],
    );
  });

  for (const path of PREVIOUSLY_STATIC) {
    test(`${path} loads its scripts rather than having them refused`, async ({ page }) => {
      const refusals = collectRefusals(page);

      await page.goto(path, { waitUntil: "networkidle" });

      // The refusal count is the signal, not anything on screen: a refused
      // bundle still leaves the server-rendered markup visible, so asserting on
      // text would pass against the bug. Measured at 32 refusals on `/login`
      // with the page static, and 0 once it renders per request.
      expect(
        refusals,
        `${path} had ${refusals.length} CSP refusal(s):\n${refusals.join("\n")}`,
      ).toEqual([]);
    });
  }

  test("every script carries the nonce the response header asks for", async ({ page }) => {
    const response = await page.goto("/login");
    const header = response?.headers()["content-security-policy"] ?? "";
    const wanted = header.match(/'nonce-([^']+)'/)?.[1];

    expect(wanted, `no nonce in the CSP header: ${header}`).toBeTruthy();

    // Read the nonce off the *wire*, not the DOM. Browsers deliberately blank
    // the `nonce` content attribute once an element is parsed, so
    // `getAttribute("nonce")` returns "" for every script no matter how healthy
    // the page is — it stops a CSS attribute-selector from exfiltrating the
    // value. Asserting on the DOM therefore fails against a working page, which
    // is exactly what it did when this spec was first written.
    const html = (await response?.text()) ?? "";
    const stamped = Array.from(html.matchAll(/<script[^>]*\snonce="([^"]*)"/g), (m) => m[1]);

    expect(stamped.length, "no script in the HTML carries a nonce").toBeGreaterThan(0);
    expect(new Set(stamped)).toEqual(new Set([wanted]));
  });
});
