/**
 * Browser walk for the purchasing screens (roadmap phase 07 frontend).
 *
 * Raise a purchase order from nothing — create a supplier, add a line, send it,
 * receive part of it, then the rest — and check the state moved each time.
 *
 * Run it the same way as `browser-walk.mjs`; see that file's header for the
 * container command. It writes real rows, so point it at a demo database.
 *
 *   docker run --rm --network rangon_frontend  *     -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e BASE=http://web:3000  *     -e TIMEOUT=180000 -v "$PWD/apps/web/e2e:/w" -w /w  *     mcr.microsoft.com/playwright:v1.49.0-noble  *     sh -c "npm i --silent playwright@1.49.0 && node purchasing-walk.mjs"
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://web:3000";
const EMAIL = process.env.EMAIL ?? "owner@rangon.test";
const PASSWORD = process.env.PASSWORD ?? "rangon12345";
const TIMEOUT = Number(process.env.TIMEOUT ?? 180_000);

const violations = [];
const failures = [];
function ok(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

/** Wait for the server-rendered page to actually show something. */
async function waitForMain(source, label) {
  try {
    await page.waitForFunction(
      (re) => new RegExp(re, "i").test(document.getElementById("main")?.innerText ?? ""),
      source,
      { timeout: TIMEOUT },
    );
    ok(label, true);
  } catch {
    const seen = (await page.locator("#main").innerText()).replace(/\s+/g, " ").slice(0, 200);
    ok(label, false, `#main said: ${seen}`);
  }
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(TIMEOUT);
page.setDefaultNavigationTimeout(TIMEOUT);
page.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
});
page.on("pageerror", (e) => violations.push("pageerror: " + e.message));

// ---- sign in -------------------------------------------------------------
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.waitForFunction(() => {
  const el = document.querySelector("#email");
  return el && Object.keys(el).some((k) => k.startsWith("__react"));
});
for (let i = 0; i < 5; i += 1) {
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  if ((await page.inputValue("#email")) === EMAIL) break;
  await page.waitForTimeout(1000);
}
await page.getByRole("button", { name: /^sign in$/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
ok("signed in", !page.url().includes("/login"), page.url());

// ---- suppliers -----------------------------------------------------------
await page.goto(`${BASE}/admin/suppliers`, { waitUntil: "networkidle" });
ok("suppliers screen renders", /Suppliers/.test(await page.locator("#main").innerText()));

const stamp = Date.now();
const supplierName = `Walk Supplier ${stamp}`;
await page.getByRole("button", { name: /new supplier/i }).first().click();
await page.waitForSelector("#sup-name");
await page.fill("#sup-name", supplierName);
await page.fill("#sup-phone", "+8801700000123");
await page.fill("#sup-lead", "3");
await page.getByRole("button", { name: /create supplier/i }).click();
await waitForMain(supplierName, "supplier created");
const supplierText = await page.locator("#main").innerText();
// Match the code belonging to THIS run's supplier. A loose /WALK-SUPPLIER-\d+/
// passes on a row left by an earlier walk, which is a false green.
// `unique_supplier_code` uppercases, hyphenates and truncates the base to 24
// characters so a `-2` collision suffix still fits `code`'s 32.
const expectedCode = `WALK-SUPPLIER-${stamp}`.slice(0, 24);
ok(
  "supplier code was derived, not typed",
  supplierText.includes(expectedCode),
  expectedCode,
);

// ---- raise a purchase order ---------------------------------------------
await page.goto(`${BASE}/admin/purchases/new`, { waitUntil: "networkidle" });
ok("new purchase order form renders", await page.locator("#po-supplier").isVisible());

await page.selectOption("#po-supplier", { label: supplierName });
await page.waitForTimeout(500);
ok(
  "expected date is suggested from the supplier lead time",
  (await page.inputValue("#po-expected")).length === 10,
  await page.inputValue("#po-expected"),
);

// Search for a product and add it as a line.
await page.fill("#variant-search", "shirt");
// The picker debounces 220ms and then waits on the network; count only once a
// result is actually on screen, or this races the request rather than testing it.
const options = page.locator('[role="option"] button:not([disabled])');
let optionCount = 0;
try {
  await options.first().waitFor({ state: "visible", timeout: TIMEOUT });
  optionCount = await options.count();
} catch {
  /* leave it at 0 and let the assertion report it */
}
ok("variant picker returns results", optionCount > 0, `${optionCount} options`);
await options.first().click();
await page.waitForTimeout(500);

let rows = await page.locator("table tbody tr").count();
ok("line added to the order", rows >= 1, `${rows} rows`);

const qty = page.locator('input[aria-label^="Quantity for"]').first();
await qty.fill("10");
const cost = page.locator('input[aria-label^="Unit cost for"]').first();
await cost.fill("450");
await page.fill("#po-shipping", "120");
await page.waitForTimeout(400);

const totalsText = await page.locator("#main").innerText();
ok("grand total previews 10x450 + 120", /4,620|4620/.test(totalsText.replace(/\s/g, "")));

// Adding the same variant twice must be blocked by the picker.
await page.fill("#variant-search", "shirt");
await page.waitForTimeout(1500);
const disabledCount = await page.locator('[role="option"] button[disabled]').count();
ok("a variant already on the order cannot be added twice", disabledCount > 0);
await page.keyboard.press("Escape");

await page.getByRole("checkbox").last().check(); // send straight away
await page.getByRole("button", { name: /create and send/i }).click();
await page.waitForURL(/\/admin\/purchases\/[0-9a-f-]{36}/);
ok("create redirects to the order", /\/admin\/purchases\//.test(page.url()), page.url());

await page.waitForTimeout(2000);
let detail = await page.locator("#main").innerText();
ok("order shows as sent", /Sent to supplier|Sent/.test(detail));
ok("order names the supplier", detail.includes(supplierName));

// ---- receive part of it --------------------------------------------------
await page.getByRole("button", { name: /receive goods/i }).click();
await page.waitForTimeout(800);
const receiveQty = page.locator('input[aria-label^="Quantity received for"]').first();
ok("receive defaults to the outstanding quantity", (await receiveQty.inputValue()) === "10");

await receiveQty.fill("4");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /receive .* of stock/i }).click();
// router.refresh() re-renders on the server; on the dev server that can take
// far longer than a fixed sleep, so wait for the state, not the clock.
await waitForMain("Partially received", "partial receipt leaves the order partially received");
await waitForMain("Posted to the ledger", "delivery is listed and posted");
detail = await page.locator("#main").innerText();

ok("outstanding drops to 6", /\b6\b/.test(detail));


// Over-receiving must be refused client-side.
await page.getByRole("button", { name: /receive goods/i }).click();
await page.waitForTimeout(800);
await page.locator('input[aria-label^="Quantity received for"]').first().fill("9");
await page.waitForTimeout(500);
const overText = await page.locator("#main").innerText();
ok("over-receiving is refused before the request", /Only 6 outstanding/i.test(overText));

// Receive the rest.
await page.locator('input[aria-label^="Quantity received for"]').first().fill("6");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /receive .* of stock/i }).click();
await page.waitForFunction(
  () => !/Partially received/i.test(document.getElementById("main")?.innerText ?? ""),
  undefined,
  { timeout: TIMEOUT },
);
detail = await page.locator("#main").innerText();
ok("order is fully received", /Received/.test(detail) && !/Partially/i.test(detail));
ok("receive button is gone once nothing is outstanding",
  (await page.getByRole("button", { name: /receive goods/i }).count()) === 0);

await page.screenshot({ path: process.env.SHOT ?? "/tmp/po-walk.png", fullPage: true });

console.log("\nCSP violations / page errors:", violations.length);
for (const v of violations.slice(0, 6)) console.log("   ", v.slice(0, 200));
console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures.join(", ")}`}`);
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
