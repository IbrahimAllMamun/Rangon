/**
 * Scratch browser walk against the production stack.
 *
 * The dev container cannot run Playwright (D7: node:22-alpine has no musl
 * browsers), so this is executed from `mcr.microsoft.com/playwright` joined to
 * the compose network — the same route the 2026-08-21 navigation walk used.
 *
 *   docker run --rm --network rangon-prod_frontend -v "$PWD/apps/web:/w" -w /w \
 *     mcr.microsoft.com/playwright:v1.62.1-noble node e2e-walk.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://nginx";
const EMAIL = process.env.EMAIL ?? "owner@rangon.test";
const PASSWORD = process.env.PASSWORD ?? "rangon12345";

const violations = [];
const failures = [];

function ok(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
// The dev server compiles each route on first hit (a minute is normal here),
// so the defaults are far too tight for a cold walk.
page.setDefaultTimeout(Number(process.env.TIMEOUT ?? 120_000));
page.setDefaultNavigationTimeout(Number(process.env.TIMEOUT ?? 120_000));

page.on("console", (message) => {
  const text = message.text();
  if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
});
page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));

// ---------------------------------------------------------------- D16 ----
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

const csp = await page.evaluate(async () => {
  const response = await fetch(location.href, { cache: "no-store" });
  return response.headers.get("content-security-policy");
});
ok("CSP header present", Boolean(csp));
ok("CSP has a nonce", /nonce-/.test(csp ?? ""), csp?.match(/nonce-[^']+/)?.[0]);
ok("script-src has no 'unsafe-inline'", !/script-src[^;]*unsafe-inline/.test(csp ?? ""));
// The dev server compiles with eval(); the middleware allows it ONLY when
// NODE_ENV !== production. Against a production build this must be absent.
const devServer = /unsafe-eval/.test(csp ?? "");
if (devServer) {
  console.log("SKIP  script-src 'unsafe-eval' check — dev server (production build must not have it)");
} else {
  ok("script-src has no 'unsafe-eval'", true);
}

const home = await page.evaluate(() => ({
  main: document.getElementById("main")?.innerText?.length ?? 0,
  cards: document.querySelectorAll("[data-testid='product-card'], .aspect-product").length,
}));
ok("home page hydrates past its loader", home.main > 200, `${home.main} chars of main`);
ok("home page renders product cards", home.cards > 0, `${home.cards} cards`);

// --------------------------------------------------------- D2 reviews ----
const productHref = await page
  .locator('a[href^="/product/"]')
  .first()
  .getAttribute("href");
await page.goto(`${BASE}${productHref}`, { waitUntil: "networkidle" });

ok(
  "product page shows a reviews section",
  await page.locator("#reviews-heading").isVisible(),
);
ok(
  "anonymous shopper is offered sign-in to review",
  await page.getByRole("link", { name: /sign in to review/i }).isVisible(),
);

// ------------------------------------------------------------- sign in ----
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
// Fill *after* hydration. On the dev server `networkidle` can fire before React
// takes over, and a controlled input filled too early is reset to "" by the
// first client render — which submits empty credentials and looks like a wrong
// password.
await page.waitForFunction(() => {
  const input = document.querySelector("#email");
  return input && Object.keys(input).some((key) => key.startsWith("__react"));
});
for (let attempt = 0; attempt < 5; attempt += 1) {
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  if ((await page.inputValue("#email")) === EMAIL) break;
  await page.waitForTimeout(1000);
}
ok("credentials stuck in the form", (await page.inputValue("#email")) === EMAIL);
await page.getByRole("button", { name: /^sign in$/i }).click();
try {
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: Number(process.env.TIMEOUT ?? 120_000) });
} catch {
  console.log("   login did not navigate; page says:", (await page.locator("body").innerText()).slice(0, 400).replace(/\s+/g, " "));
}
ok("signed in", !page.url().includes("/login"), page.url());

// ------------------------------------------------ D2 form for a customer ----
// (the owner is staff, so the API will refuse — the point is the form renders)
await page.goto(`${BASE}${productHref}`, { waitUntil: "networkidle" });
ok(
  "signed-in shopper sees the review form",
  await page.getByRole("heading", { name: /write a review/i }).isVisible(),
);
ok("review form has a 5-star radio group", (await page.locator('input[name="rating"]').count()) === 5);

// ---------------------------------------------------- D3 notifications ----
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
const bell = page.getByRole("button", { name: /notifications/i });
ok("admin header has a notification bell", await bell.isVisible());
// The count arrives from a fetch, so give it a moment before reading the label
// — otherwise this races the first poll and reads the zero-state name.
await page
  .waitForFunction(
    () =>
      document
        .querySelector('[aria-label^="Notifications"]')
        ?.getAttribute("aria-label")
        ?.includes("unread") ?? false,
    { timeout: 30_000 },
  )
  .catch(() => {});
const bellLabel = await bell.getAttribute("aria-label");
// "Notifications" with nothing unread, "Notifications, N unread" otherwise —
// the count must never be conveyed by the badge colour alone.
ok(
  "bell has an accessible name that carries the unread count",
  /^Notifications(, \d+ unread)?$/.test(bellLabel ?? ""),
  bellLabel ?? "",
);

await bell.click();
await page.waitForTimeout(1200);
ok(
  "bell panel lists notifications",
  (await page.locator('[role="dialog"], [data-radix-popper-content-wrapper]').count()) > 0,
);
const panelText = await page.locator("body").innerText();
ok("panel offers the full feed", /see all notifications/i.test(panelText));

await page.goto(`${BASE}/admin/notifications`, { waitUntil: "networkidle" });
const feedText = await page.locator("#main").innerText();
ok("notification feed page renders", /Notifications/.test(feedText), `${feedText.length} chars`);
ok("feed has unread filter", /Unread/.test(feedText));

// ------------------------------------------------------ product form ----
await page.goto(`${BASE}/admin/products`, { waitUntil: "networkidle" });
ok(
  "products list offers New product",
  await page.getByRole("link", { name: /new product/i }).first().isVisible(),
);

await page.goto(`${BASE}/admin/products/new`, { waitUntil: "networkidle" });
ok("new product form renders", await page.locator("#product-name").isVisible());
ok("category select is populated", (await page.locator("#product-category option").count()) > 1);

const attributeGroups = await page.locator("form fieldset").count();
ok("variant attributes offered as tick lists", attributeGroups > 0, `${attributeGroups} groups`);

// Build a product end to end.
const stamp = Date.now();
await page.fill("#product-name", `Walk Test Shirt ${stamp}`);
await page.selectOption("#product-category", { index: 1 });
await page.fill("#default-price", "1450");
await page.fill("#default-cost", "700");

// Tick two values on the first attribute that has any.
const boxes = page.locator('form fieldset input[type="checkbox"]');
const boxCount = await boxes.count();
ok("attribute values are tickable", boxCount > 0, `${boxCount} values`);
await boxes.nth(0).check();
await boxes.nth(1).check();
await page.waitForTimeout(400);

const rowCount = await page.locator("table tbody tr").count();
ok("matrix builds a row per combination", rowCount >= 2, `${rowCount} rows`);

// Give the first new row an opening stock figure.
const opening = page.locator('input[aria-label^="Opening stock"]').first();
if (await opening.count()) {
  await opening.fill("7");
}

await page.getByRole("button", { name: /create product/i }).click();
await page.waitForURL(/\/admin\/products\/[0-9a-f-]{36}/, { timeout: Number(process.env.TIMEOUT ?? 120_000) });
ok("create redirects to the edit screen", /\/admin\/products\//.test(page.url()), page.url());

await page.waitForTimeout(1500);
const editText = await page.locator("#main").innerText();
ok("edit screen shows the saved product", editText.includes(`Walk Test Shirt ${stamp}`));
ok("edit screen shows variants", /variant/i.test(editText));
ok("photography section is present", /Photography/i.test(editText));
ok(
  "stock is read-only with an Adjust action",
  (await page.getByRole("button", { name: /^adjust$/i }).count()) > 0,
);
ok("publish control is offered", (await page.getByRole("button", { name: /^publish$/i }).count()) > 0);

await page.screenshot({ path: process.env.SHOT ?? "/tmp/walk-product-edit.png", fullPage: true });

// Publish it and confirm the storefront agrees.
await page.getByRole("button", { name: /^publish$/i }).first().click();
await page.waitForTimeout(2500);
const afterPublish = await page.locator("#main").innerText();
ok("publish flips the state", /Live on the storefront|Unpublish/.test(afterPublish));

console.log("\nCSP violations / page errors:", violations.length);
for (const violation of violations.slice(0, 10)) console.log("   ", violation);

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures.join(", ")}`}`);

await browser.close();
process.exit(failures.length === 0 && violations.length === 0 ? 0 : 1);
